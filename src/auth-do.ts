import { DurableObject } from 'cloudflare:workers';
import { updateUserIndex, type IndexedUser, type UserAccess } from './auth';
import type { Env } from './worker';
import { timingSafeEqual } from './crypto';

const RECORD_KEY = 'record';
const USERS_KEY = 'users';
const ATTEMPTS_PREFIX = 'attempts:';
// Workers WebCrypto rejects PBKDF2 above 100,000 iterations, so this is the
// ceiling rather than a tuning choice. Records written before 0.5.1 carry no
// iteration count and were derived with LEGACY_PBKDF2_ITERATIONS.
export const PBKDF2_ITERATIONS = 100_000;
export const MAX_PBKDF2_ITERATIONS = 100_000;
const LEGACY_PBKDF2_ITERATIONS = 600_000;
const MAX_FAILURES = 5;
const FAILURE_WINDOW_MS = 60_000;
const LOCKOUT_MS = 60_000;

type UserRecord = {
  version: 1;
  access: UserAccess;
  salt: string;
  hash: string;
  iterations?: number;
  indexed?: true;
};

type DeletedRecord = { version: 1; deleted: true };
type StoredRecord = UserRecord | DeletedRecord;
type Attempts = { count: number; windowStartedAt: number; lockedUntil: number };
type LegacyUserRecord = { password_sha256?: unknown; access?: unknown };

export class AuthUser extends DurableObject<Env> {
  async create(username: string, password: string, access: UserAccess): Promise<void> {
    if (password.length < 12 || password.length > 1024) throw new Error('invalid password');
    const record = await createRecord(password, access);
    await this.ctx.storage.put(RECORD_KEY, record);
    await this.env.GITME_KV.delete(`user:${username}`);
    await updateUserIndex(this.env, username, access);
    await this.markIndexed(record);
  }

  async delete(username: string): Promise<void> {
    await this.ctx.storage.put(RECORD_KEY, { version: 1, deleted: true } satisfies DeletedRecord);
    await this.env.GITME_KV.delete(`user:${username}`);
    await updateUserIndex(this.env, username);
  }

  async authenticate(username: string, password: string, source: string): Promise<{ ok: boolean; access?: UserAccess }> {
    if (!source || source.length > 64 || await this.isLocked(source)) return { ok: false };

    const stored = await this.ctx.storage.get<StoredRecord>(RECORD_KEY);
    if (stored && !('deleted' in stored)) {
      if (await verifyPassword(password, stored) && await this.acceptCurrentRecord(stored, source)) {
        if (!stored.indexed) {
          await updateUserIndex(this.env, username, stored.access);
          await this.markIndexed(stored);
        }
        return { ok: true, access: stored.access };
      }
      await this.recordFailure(source);
      return { ok: false };
    }
    if (stored) return { ok: false };

    const legacy = await this.legacyRecord(username);
    if (legacy && await legacyPasswordMatches(password, legacy.password_sha256)) {
      const access = legacy.access === 'write' ? 'write' : legacy.access === 'read' ? 'read' : null;
      if (access) {
        const record = await createRecord(password, access);
        const migrated = await this.ctx.storage.transaction(async (transaction) => {
          if (await transaction.get<StoredRecord>(RECORD_KEY)) return false;
          await transaction.put(RECORD_KEY, record);
          await transaction.delete(attemptKey(source));
          return true;
        });
        if (!migrated) return { ok: false };
        await this.env.GITME_KV.delete(`user:${username}`);
        await updateUserIndex(this.env, username, access);
        await this.markIndexed(record);
        return { ok: true, access };
      }
    }

    if (legacy) await this.recordFailure(source);
    return { ok: false };
  }

  async upsertIndexedUser(username: string, access: UserAccess): Promise<void> {
    await this.ctx.storage.transaction(async (transaction) => {
      const users = await readUsers(transaction);
      const existing = users.findIndex((user) => user.username === username);
      if (existing >= 0) users[existing] = { username, access };
      else users.push({ username, access });
      users.sort(compareUsers);
      await transaction.put(USERS_KEY, users);
    });
  }

  async removeIndexedUser(username: string): Promise<void> {
    await this.ctx.storage.transaction(async (transaction) => {
      const users = await readUsers(transaction);
      const filtered = users.filter((user) => user.username !== username);
      if (filtered.length !== users.length) await transaction.put(USERS_KEY, filtered);
    });
  }

  async listIndexedUsers(): Promise<IndexedUser[]> {
    return await readUsers(this.ctx.storage);
  }

  private async acceptCurrentRecord(record: UserRecord, source: string): Promise<boolean> {
    return await this.ctx.storage.transaction(async (transaction) => {
      const current = await transaction.get<StoredRecord>(RECORD_KEY);
      if (!isSameRecord(current, record)) return false;
      await transaction.delete(attemptKey(source));
      return true;
    });
  }

  private async markIndexed(record: UserRecord): Promise<void> {
    await this.ctx.storage.transaction(async (transaction) => {
      const current = await transaction.get<StoredRecord>(RECORD_KEY);
      if (isSameRecord(current, record)) await transaction.put(RECORD_KEY, { ...current, indexed: true });
    });
  }

  private async legacyRecord(username: string): Promise<LegacyUserRecord | null> {
    const raw = await this.env.GITME_KV.get(`user:${username}`);
    if (!raw) return null;
    try {
      const value: unknown = JSON.parse(raw);
      return isRecord(value) ? value : null;
    } catch {
      return null;
    }
  }

  private async isLocked(source: string): Promise<boolean> {
    const attempts = await this.ctx.storage.get<Attempts>(attemptKey(source));
    return Boolean(attempts && attempts.lockedUntil > Date.now());
  }

  private async recordFailure(source: string): Promise<void> {
    await this.ctx.storage.transaction(async (transaction) => {
      const now = Date.now();
      const key = attemptKey(source);
      const previous = await transaction.get<Attempts>(key);
      const attempts = !previous || previous.windowStartedAt + FAILURE_WINDOW_MS <= now
        ? { count: 1, windowStartedAt: now, lockedUntil: 0 }
        : { ...previous, count: previous.count + 1 };
      if (attempts.count >= MAX_FAILURES) attempts.lockedUntil = now + LOCKOUT_MS;
      await transaction.put(key, attempts);
    });
  }
}

type StorageReader = Pick<DurableObjectStorage, 'get'> | Pick<DurableObjectTransaction, 'get'>;

async function readUsers(storage: StorageReader): Promise<IndexedUser[]> {
  const users = await storage.get<unknown>(USERS_KEY);
  return Array.isArray(users) ? users.filter(isIndexedUser).sort(compareUsers) : [];
}

function compareUsers(left: IndexedUser, right: IndexedUser): number {
  return left.username.localeCompare(right.username);
}

function isSameRecord(value: StoredRecord | undefined, expected: UserRecord): value is UserRecord {
  return Boolean(value && !('deleted' in value) && value.salt === expected.salt && value.hash === expected.hash && value.access === expected.access);
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
  return {
    version: 1,
    access,
    salt: bytesToBase64(salt),
    hash: await passwordHash(password, salt, PBKDF2_ITERATIONS),
    iterations: PBKDF2_ITERATIONS,
  };
}

async function verifyPassword(password: string, record: UserRecord): Promise<boolean> {
  const iterations = recordIterations(record);
  if (!iterations) return false;
  try {
    return timingSafeEqual(base64ToBytes(await passwordHash(password, base64ToBytes(record.salt), iterations)), base64ToBytes(record.hash));
  } catch {
    return false;
  }
}

function recordIterations(record: UserRecord): number | null {
  if (record.iterations === undefined) return LEGACY_PBKDF2_ITERATIONS;
  return Number.isInteger(record.iterations) && record.iterations > 0 ? record.iterations : null;
}

async function passwordHash(password: string, salt: Uint8Array, iterations: number): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: salt.slice().buffer, iterations }, key, 256);
  return bytesToBase64(new Uint8Array(bits));
}

async function legacyPasswordMatches(password: string, hash: unknown): Promise<boolean> {
  if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/i.test(hash)) return false;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(password)));
  return timingSafeEqual(digest, hexToBytes(hash));
}

function bytesToBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function base64ToBytes(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

function hexToBytes(value: string): Uint8Array {
  return Uint8Array.from(value.match(/../g) ?? [], (byte) => Number.parseInt(byte, 16));
}
