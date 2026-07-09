import { describe, expect, test } from 'vitest';
import { AuthUser } from '../src/auth-do';
import type { Env } from '../src/worker';

class MemoryStorage {
  readonly values = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.values.set(key, value);
  }

  async delete(key: string): Promise<boolean> {
    return this.values.delete(key);
  }
}

class MemoryKV {
  readonly values = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async put(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }
}

function makeAuth(): { auth: AuthUser; storage: MemoryStorage; kv: MemoryKV } {
  const storage = new MemoryStorage();
  const kv = new MemoryKV();
  const env: Env = {
    GITME_AUTH_TOKEN: 'token',
    GITME_R2: {} as R2Bucket,
    GITME_KV: kv as unknown as KVNamespace,
    GITME_AUTH: {} as DurableObjectNamespace,
  };
  const state = { storage, blockConcurrencyWhile: async <T>(callback: () => Promise<T>) => await callback() } as unknown as DurableObjectState;
  return { auth: new AuthUser(state, env), storage, kv };
}

async function call(auth: AuthUser, body: Record<string, unknown>): Promise<{ ok: boolean; access?: string }> {
  const input = body.action === 'authenticate' ? { ...body, source: 'test' } : body;
  const response = await auth.fetch(new Request('https://auth.internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  }));
  return await response.json() as { ok: boolean; access?: string };
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

describe('AuthUser', () => {
  test('stores salted PBKDF2 records and authenticates them', async () => {
    const { auth, storage, kv } = makeAuth();
    const password = 'correct horse battery staple';

    await expect(call(auth, { action: 'create', username: 'alice', password, access: 'write' })).resolves.toEqual({ ok: true, access: 'write' });
    const record = storage.values.get('record') as { salt: string; hash: string; password?: string; password_sha256?: string };

    expect(record.salt).not.toBe(record.hash);
    expect(record.password).toBeUndefined();
    expect(record.password_sha256).toBeUndefined();
    expect(kv.values.has('user:alice')).toBe(false);
    await expect(call(auth, { action: 'authenticate', username: 'alice', password })).resolves.toEqual({ ok: true, access: 'write' });
    await expect(call(auth, { action: 'authenticate', username: 'alice', password: 'wrong password' })).resolves.toEqual({ ok: false });
  });

  test('upgrades one successful legacy login and tombstones deleted users', async () => {
    const { auth, storage, kv } = makeAuth();
    const password = 'correct horse battery staple';
    await kv.put('user:alice', JSON.stringify({ password_sha256: await sha256Hex(password), access: 'read' }));

    await expect(call(auth, { action: 'authenticate', username: 'alice', password })).resolves.toEqual({ ok: true, access: 'read' });
    expect(storage.values.get('record')).toMatchObject({ version: 1, access: 'read' });
    expect(kv.values.has('user:alice')).toBe(false);

    await expect(call(auth, { action: 'delete', username: 'alice' })).resolves.toEqual({ ok: true });
    await kv.put('user:alice', JSON.stringify({ password_sha256: await sha256Hex(password), access: 'read' }));
    await expect(call(auth, { action: 'authenticate', username: 'alice', password })).resolves.toEqual({ ok: false });
  });

  test('locks legacy credentials after five failed attempts', async () => {
    const { auth, kv } = makeAuth();
    const password = 'correct horse battery staple';
    await kv.put('user:alice', JSON.stringify({ password_sha256: await sha256Hex(password), access: 'read' }));

    for (let index = 0; index < 5; index += 1) {
      await expect(call(auth, { action: 'authenticate', username: 'alice', password: 'wrong password' })).resolves.toEqual({ ok: false });
    }
    await expect(call(auth, { action: 'authenticate', username: 'alice', password })).resolves.toEqual({ ok: false });
  });
});
