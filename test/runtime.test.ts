import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { describe, expect, test } from 'vitest';
import { MAX_PBKDF2_ITERATIONS, PBKDF2_ITERATIONS } from '../src/auth-do';

const LFS_JSON = 'application/vnd.git-lfs+json';
const adminHeaders = { Authorization: 'Bearer tok' };
const LEGACY_PBKDF2_ITERATIONS = 600_000;
const RECORD_KEY = 'record';

type StoredRecord = { version: 1; access: 'read' | 'write'; salt: string; hash: string; iterations?: number; indexed?: true };

function basic(username: string, password: string): string {
  const bytes = new TextEncoder().encode(`${username}:${password}`);
  return `Basic ${btoa(String.fromCharCode(...bytes))}`;
}

async function oidFor(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function pbkdf2(password: string, salt: string, iterations: number): Promise<string> {
  const bytes = Uint8Array.from(atob(salt), (char) => char.charCodeAt(0));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: bytes.slice().buffer, iterations }, key, 256);
  return btoa(String.fromCharCode(...new Uint8Array(bits)));
}

async function createUser(username: string, password: string, access: 'read' | 'write'): Promise<Response> {
  return SELF.fetch(`https://example.com/admin/users/${username}`, {
    method: 'PUT',
    headers: { ...adminHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ password, access }),
  });
}

function batch(username: string, password: string): Promise<Response> {
  return SELF.fetch('https://example.com/objects/batch', {
    method: 'POST',
    headers: { Authorization: basic(username, password), 'Content-Type': LFS_JSON },
    body: JSON.stringify({ operation: 'download', objects: [] }),
  });
}

describe('Workers runtime integration', () => {
  test('uses real Durable Object, KV, R2, DigestStream, and UTF-8 Basic auth', async () => {
    const password = 'pässwörd-非常-secret';
    const create = await SELF.fetch('https://example.com/admin/users/unicode', {
      method: 'PUT',
      headers: { ...adminHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ password, access: 'write' }),
    });
    expect(create.status).toBe(200);

    const content = 'runtime upload';
    const oid = await oidFor(content);
    const batch = await SELF.fetch('https://example.com/objects/batch', {
      method: 'POST',
      headers: { Authorization: basic('unicode', password), 'Content-Type': LFS_JSON },
      body: JSON.stringify({ operation: 'upload', transfers: ['basic'], objects: [{ oid, size: content.length }] }),
    });
    expect(batch.status).toBe(200);

    const upload = await SELF.fetch(`https://example.com/objects/${oid}`, {
      method: 'PUT',
      headers: { Authorization: basic('unicode', password) },
      body: content,
    });
    expect(upload.status).toBe(200);
    expect((await env.GITME_R2.list({ prefix: 'objects/.tmp/' })).objects).toHaveLength(0);

    const download = await SELF.fetch(`https://example.com/objects/${oid}`, { headers: { Authorization: basic('unicode', password) } });
    expect(new TextDecoder().decode(await download.arrayBuffer())).toBe(content);

    await Promise.all(['alice', 'bob', 'carol'].map((username) => SELF.fetch(`https://example.com/admin/users/${username}`, {
      method: 'PUT',
      headers: { ...adminHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: `correct horse ${username}`, access: 'read' }),
    })));
    const listed = await SELF.fetch('https://example.com/admin/users', { headers: adminHeaders });
    const users = await listed.json<{ users: Array<{ username: string }> }>();
    expect(users.users.map((user) => user.username)).toEqual(['alice', 'bob', 'carol', 'unicode']);

    const deleted = await SELF.fetch('https://example.com/admin/users/unicode', { method: 'DELETE', headers: adminHeaders });
    expect(deleted.status).toBe(200);
    const denied = await SELF.fetch('https://example.com/objects/batch', {
      method: 'POST',
      headers: { Authorization: basic('unicode', password), 'Content-Type': LFS_JSON },
      body: JSON.stringify({ operation: 'download', objects: [{ oid, size: content.length }] }),
    });
    expect(denied.status).toBe(401);
  });

  test('locks a username and source after five failures', async () => {
    const password = 'correct horse lockout';
    await SELF.fetch('https://example.com/admin/users/locked', {
      method: 'PUT',
      headers: { ...adminHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ password, access: 'read' }),
    });
    const request = (candidate: string) => SELF.fetch('https://example.com/objects/batch', {
      method: 'POST',
      headers: { Authorization: basic('locked', candidate), 'Content-Type': LFS_JSON },
      body: JSON.stringify({ operation: 'download', objects: [] }),
    });
    for (let attempt = 0; attempt < 5; attempt += 1) expect((await request('wrong password')).status).toBe(401);
    expect((await request(password)).status).toBe(401);
  });

  test('stores iterations within the Workers PBKDF2 ceiling and still verifies pre-0.5.1 records', async () => {
    expect(PBKDF2_ITERATIONS).toBeLessThanOrEqual(MAX_PBKDF2_ITERATIONS);

    const password = 'correct horse iterations';
    expect((await createUser('iterations', password, 'read')).status).toBe(200);

    const stub = env.GITME_AUTH.getByName('iterations');
    const record = await runInDurableObject(stub, (_instance, state) => state.storage.get<StoredRecord>(RECORD_KEY));
    expect(record?.iterations).toBe(PBKDF2_ITERATIONS);
    expect((await batch('iterations', password)).status).toBe(200);

    const legacy: StoredRecord = {
      version: 1,
      access: 'read',
      salt: record!.salt,
      hash: await pbkdf2(password, record!.salt, LEGACY_PBKDF2_ITERATIONS),
      indexed: true,
    };
    await runInDurableObject(stub, (_instance, state) => state.storage.put(RECORD_KEY, legacy));

    expect((await batch('iterations', password)).status).toBe(200);
    expect((await batch('iterations', 'wrong password entirely')).status).toBe(401);
  });
});
