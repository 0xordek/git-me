import { updateUserIndex, type UserAccess } from './auth';
import type { Env } from './worker';

const RECORD_KEY = 'record';
const USERS_KEY = 'users';
const ATTEMPTS_PREFIX = 'attempts:';
const PBKDF2_ITERATIONS = 600_000;
const MAX_FAILURES = 5;
const FAILURE_WINDOW_MS = 60_000;
const LOCKOUT_MS = 60_000;

type UserRecord = {
  version: 1;
  access: UserAccess;
  salt: string;
  hash: string;
  indexed?: true;
};

type DeletedRecord = { version: 1; deleted: true };
type StoredRecord = UserRecord | DeletedRecord;
type Attempts = { count: number; windowStartedAt: number; lockedUntil: number };
type AuthRequest =
  | { action: 'create'; username: string; password: string; access: UserAccess }
  | { action: 'delete'; username: string }
  | { action: 'authenticate'; username: string; password: string; source: string }
  | { action: 'upsert'; username: string; access: UserAccess }
  | { action: 'remove'; username: string }
  | { action: 'list' };

type IndexedUser = { username: string; access: UserAccess };

type LegacyUserRecord = { password_sha256?: unknown; access?: unknown };

export class AuthUser {
  constructor(private readonly state: DurableObjectState, private readonly env: Env) {}

  async fetch(request: Request): Promise<Response> {
    return await this.state.blockConcurrencyWhile(async () => await this.handle(request));
  }

  private async handle(request: Request): Promise<Response> {
    if (request.method !== 'POST') return response(405, { ok: false });

    let input: AuthRequest;
    try {
      input = await request.json() as AuthRequest;
    } catch {
      return response(400, { ok: false });
    }

    if (!isAuthRequest(input)) return response(400, { ok: false });
    if (input.action === 'list') return response(200, { ok: true, users: await this.readUsers() });
    if (input.action === 'upsert' || input.action === 'remove') return await this.updateUsers(input);
    if (input.action === 'create') return await this.create(input);
    if (input.action === 'delete') return await this.remove(input);
    return await this.authenticate(input);
  }

  private async create(input: Extract<AuthRequest, { action: 'create' }>): Promise<Response> {
    if (input.password.length < 12 || input.password.length > 1024) return response(400, { ok: false });
    const record = await createRecord(input.password, input.access);
    await this.state.storage.put(RECORD_KEY, record);
    await this.env.GITME_KV.delete(`user:${input.username}`);
    await updateUserIndex(this.env, input.username, input.access);
    await this.state.storage.put(RECORD_KEY, { ...record, indexed: true });
    return response(200, { ok: true, access: input.access });
  }

  private async remove(input: Extract<AuthRequest, { action: 'delete' }>): Promise<Response> {
    await this.state.storage.put(RECORD_KEY, { version: 1, deleted: true } satisfies DeletedRecord);
    await this.env.GITME_KV.delete(`user:${input.username}`);
    await updateUserIndex(this.env, input.username);
    return response(200, { ok: true });
  }

  private async authenticate(input: Extract<AuthRequest, { action: 'authenticate' }>): Promise<Response> {
    if (await this.isLocked(input.source)) return response(200, { ok: false });

    const stored = await this.state.storage.get<StoredRecord>(RECORD_KEY);
    if (stored && !('deleted' in stored)) {
      if (await verifyPassword(input.password, stored)) {
        await this.state.storage.delete(attemptKey(input.source));
        if (!stored.indexed) {
          await updateUserIndex(this.env, input.username, stored.access);
          await this.state.storage.put(RECORD_KEY, { ...stored, indexed: true });
        }
        return response(200, { ok: true, access: stored.access });
      }
      await this.recordFailure(input.source);
      return response(200, { ok: false });
    }
    if (stored) return response(200, { ok: false });

    const legacy = await this.legacyRecord(input.username);
    if (legacy && await legacyPasswordMatches(input.password, legacy.password_sha256)) {
      const access = legacy.access === 'write' ? 'write' : legacy.access === 'read' ? 'read' : null;
      if (access) {
        const record = await createRecord(input.password, access);
        await this.state.storage.put(RECORD_KEY, record);
        await this.state.storage.delete(attemptKey(input.source));
        await this.env.GITME_KV.delete(`user:${input.username}`);
        await updateUserIndex(this.env, input.username, access);
        await this.state.storage.put(RECORD_KEY, { ...record, indexed: true });
        return response(200, { ok: true, access });
      }
    }

    if (legacy) await this.recordFailure(input.source);
    return response(200, { ok: false });
  }

  private async updateUsers(input: Extract<AuthRequest, { action: 'upsert' | 'remove' }>): Promise<Response> {
    const users = await this.readUsers();
    const existing = users.findIndex((user) => user.username === input.username);
    if (input.action === 'remove') {
      if (existing >= 0) users.splice(existing, 1);
    } else if (existing >= 0) {
      users[existing] = { username: input.username, access: input.access };
    } else {
      users.push({ username: input.username, access: input.access });
    }
    users.sort((left, right) => left.username.localeCompare(right.username));
    await this.state.storage.put(USERS_KEY, users);
    return response(200, { ok: true });
  }

  private async readUsers(): Promise<IndexedUser[]> {
    const users = await this.state.storage.get<unknown>(USERS_KEY);
    return Array.isArray(users) ? users.filter(isIndexedUser).sort((left, right) => left.username.localeCompare(right.username)) : [];
  }

  private async legacyRecord(username: string): Promise<LegacyUserRecord | null> {
    const raw = await this.env.GITME_KV.get(`user:${username}`);
    if (!raw) return null;
    try {
      const value = JSON.parse(raw) as LegacyUserRecord;
      return typeof value === 'object' && value ? value : null;
    } catch {
      return null;
    }
  }

  private async isLocked(source: string): Promise<boolean> {
    const attempts = await this.state.storage.get<Attempts>(attemptKey(source));
    return Boolean(attempts && attempts.lockedUntil > Date.now());
  }

  private async recordFailure(source: string): Promise<void> {
    const now = Date.now();
    const key = attemptKey(source);
    const previous = await this.state.storage.get<Attempts>(key);
    const attempts = !previous || previous.windowStartedAt + FAILURE_WINDOW_MS <= now
      ? { count: 1, windowStartedAt: now, lockedUntil: 0 }
      : { ...previous, count: previous.count + 1 };
    if (attempts.count >= MAX_FAILURES) attempts.lockedUntil = now + LOCKOUT_MS;
    await this.state.storage.put(key, attempts);
  }
}

function isAuthRequest(value: unknown): value is AuthRequest {
  if (!isRecord(value) || typeof value.action !== 'string') return false;
  if (value.action === 'list') return true;
  if (typeof value.username !== 'string') return false;
  if (value.action === 'remove') return true;
  if (value.action === 'upsert') return value.access === 'read' || value.access === 'write';
  if (value.action === 'delete') return true;
  if (value.action === 'authenticate') return typeof value.password === 'string' && typeof value.source === 'string' && value.source.length > 0 && value.source.length <= 64;
  return value.action === 'create' && typeof value.password === 'string' && (value.access === 'read' || value.access === 'write');
}

function isIndexedUser(value: unknown): value is IndexedUser {
  return isRecord(value) && typeof value.username === 'string' && (value.access === 'read' || value.access === 'write');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function attemptKey(source: string): string {
  return ATTEMPTS_PREFIX + source;
}

async function createRecord(password: string, access: UserAccess): Promise<UserRecord> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return { version: 1, access, salt: bytesToBase64(salt), hash: await passwordHash(password, salt) };
}

async function verifyPassword(password: string, record: UserRecord): Promise<boolean> {
  try {
    return constantTimeEqual(await passwordHash(password, base64ToBytes(record.salt)), record.hash);
  } catch {
    return false;
  }
}

async function passwordHash(password: string, salt: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: toArrayBuffer(salt), iterations: PBKDF2_ITERATIONS }, key, 256);
  return bytesToBase64(new Uint8Array(bits));
}

async function legacyPasswordMatches(password: string, hash: unknown): Promise<boolean> {
  if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/i.test(hash)) return false;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(password));
  return constantTimeEqual(bytesToHex(new Uint8Array(digest)), hash.toLowerCase());
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

function bytesToBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function base64ToBytes(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
