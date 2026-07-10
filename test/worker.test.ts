import { describe, expect, test } from 'vitest';
import { presignR2Url } from '../src/signing';
import worker, { type Env } from '../src/worker';
import type { R2SigningConfig } from '../src/config';

const oid = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';

const signing: R2SigningConfig = {
  accountId: 'test-account',
  accessKeyId: 'test-access-key',
  secretAccessKey: 'test-secret-key',
  bucketName: 'bucket',
};

class MemoryR2 {
  readonly objects = new Map<string, { bytes: Uint8Array<ArrayBuffer>; customMetadata?: Record<string, string> }>();

  async put(
    key: string,
    value: ReadableStream | string | ArrayBuffer | ArrayBufferView | Blob,
    options?: { customMetadata?: Record<string, string> },
  ): Promise<void> {
    const bytes: Uint8Array<ArrayBuffer> = new Uint8Array(await new Response(value as BodyInit).arrayBuffer());
    this.objects.set(key, { bytes, customMetadata: options?.customMetadata });
  }

  async get(key: string): Promise<{ body: ReadableStream; size: number; customMetadata?: Record<string, string> } | null> {
    const object = this.objects.get(key);
    if (!object) return null;
    return { body: new Blob([object.bytes]).stream(), size: object.bytes.byteLength, customMetadata: object.customMetadata };
  }

  async head(key: string): Promise<{ size: number; customMetadata?: Record<string, string> } | null> {
    const object = this.objects.get(key);
    if (!object) return null;
    return { size: object.bytes.byteLength, customMetadata: object.customMetadata };
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
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

type MemoryUser = { password: string; access: 'read' | 'write'; deleted?: boolean };

class MemoryAuth {
  readonly users = new Map<string, MemoryUser>();
  readonly index = new Map<string, 'read' | 'write'>();

  readonly namespace = {
    getByName: (username: string) => ({
      fetch: async (request: Request): Promise<Response> => {
        const body = await request.json() as { action: string; username?: string; password?: string; access?: 'read' | 'write' };
        if (username === 'admin:users') {
          if (body.action === 'list') return Response.json({ ok: true, users: [...this.index].map(([username, access]) => ({ username, access })).sort((left, right) => left.username.localeCompare(right.username)) });
          if (body.action === 'upsert' && body.access) {
            if (body.username) this.index.set(body.username, body.access);
            return Response.json({ ok: true });
          }
          if (body.action === 'remove') {
            if (body.username) this.index.delete(body.username);
            return Response.json({ ok: true });
          }
        }
        if (body.action === 'create' && body.password && body.access) {
          this.users.set(username, { password: body.password, access: body.access });
          this.index.set(username, body.access);
          return Response.json({ ok: true, access: body.access });
        }
        if (body.action === 'delete') {
          this.users.set(username, { password: '', access: 'read', deleted: true });
          this.index.delete(username);
          return Response.json({ ok: true });
        }
        const user = this.users.get(username);
        const ok = Boolean(user && !user.deleted && user.password === body.password);
        if (ok && user) this.index.set(username, user.access);
        return Response.json({ ok, access: user?.access });
      },
    }),
  } as DurableObjectNamespace;
}

type TestEnv = Env & {
  GITME_R2: MemoryR2;
  GITME_KV: MemoryKV;
};

function env(): TestEnv {
  return {
    GITME_AUTH_TOKEN: 'tok',
    GITME_R2: new MemoryR2() as R2Bucket & MemoryR2,
    GITME_KV: new MemoryKV() as KVNamespace & MemoryKV,
    GITME_AUTH: new MemoryAuth().namespace,
  };
}

function directEnv(): TestEnv {
  return {
    ...env(),
    GITME_TRANSFER_MODE: 'direct',
    GITME_R2_ACCOUNT_ID: signing.accountId,
    GITME_R2_ACCESS_KEY_ID: signing.accessKeyId,
    GITME_R2_SECRET_ACCESS_KEY: signing.secretAccessKey,
    GITME_R2_BUCKET_NAME: signing.bucketName,
  };
}

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: 'Bearer tok', ...extra };
}

function basicHeaders(username: string, password: string, extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: 'Basic ' + btoa(`${username}:${password}`), ...extra };
}

function signedUrlParams(url: string): URLSearchParams {
  return new URL(url).searchParams;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

describe('worker', () => {
  test('health returns ok in proxy mode without auth', async () => {
    const res = await worker.fetch(new Request('https://example.com/health', { method: 'GET' }), env(), {} as ExecutionContext);
    const body = await res.json() as { ok: boolean; transfer_mode: string };

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true, transfer_mode: 'proxy' });
  });

  test('health reports missing auth token', async () => {
    const e = env() as Partial<TestEnv>;
    delete e.GITME_AUTH_TOKEN;

    const res = await worker.fetch(new Request('https://example.com/health', { method: 'GET' }), e as Env, {} as ExecutionContext);
    const bodyText = await res.text();

    expect(res.status).toBe(500);
    expect(JSON.parse(bodyText)).toEqual({ ok: false });
    expect(bodyText).not.toContain('tok');
  });

  test('invalid transfer mode fails closed', async () => {
    const e = { ...env(), GITME_TRANSFER_MODE: 'weird' };
    const req = new Request('https://example.com/objects/batch', {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/vnd.git-lfs+json' }),
      body: JSON.stringify({ operation: 'upload', transfers: ['basic'], objects: [{ oid, size: 1 }] }),
    });

    const res = await worker.fetch(req, e, {} as ExecutionContext);
    const body = await res.json() as { message: string };

    expect(res.status).toBe(500);
    expect(res.headers.get('Content-Type')).toBe('application/vnd.git-lfs+json');
    expect(body).toEqual({ message: 'configuration error' });
  });

  test('batch upload returns upload action', async () => {
    const e = env();
    const req = new Request('https://example.com/objects/batch', {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/vnd.git-lfs+json; charset=utf-8' }),
      body: JSON.stringify({ operation: 'upload', transfers: ['basic'], objects: [{ oid, size: 1 }] }),
    });

    const res = await worker.fetch(req, e, {} as ExecutionContext);
    const body = await res.json() as { transfer: string; objects: Array<{ actions: { upload: { href: string } } }> };

    expect(res.status).toBe(200);
    expect(body.transfer).toBe('basic');
    expect(body.objects[0].actions.upload.href).toBe('https://example.com/objects/' + oid);
  });

  test('direct batch upload uses Worker proxy action and repairs unverified objects', async () => {
    const e = directEnv();
    await e.GITME_R2.put('objects/' + oid, 'x');
    const req = new Request('https://example.com/objects/batch', {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/vnd.git-lfs+json' }),
      body: JSON.stringify({ operation: 'upload', transfers: ['basic'], objects: [{ oid, size: 1 }] }),
    });

    const res = await worker.fetch(req, e, {} as ExecutionContext);
    const body = await res.json() as { objects: Array<{ actions: { upload: { href: string } } }> };

    expect(res.status).toBe(200);
    expect(body.objects[0].actions.upload.href).toBe('https://example.com/objects/' + oid);
  });

  test('batch object existence uses R2, not KV', async () => {
    const e = directEnv();
    await e.GITME_R2.put('objects/' + oid, 'x', { customMetadata: { sha256: oid } });
    const req = new Request('https://example.com/objects/batch', {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/vnd.git-lfs+json' }),
      body: JSON.stringify({ operation: 'upload', transfers: ['basic'], objects: [{ oid, size: 1 }] }),
    });

    const res = await worker.fetch(req, e, {} as ExecutionContext);
    const body = await res.json() as { objects: Array<{ oid: string; size: number; actions?: unknown }> };

    expect(res.status).toBe(200);
    expect(body.objects[0]).toEqual({ oid, size: 1 });
  });

  test('batch upload rejects existing object with wrong size', async () => {
    const e = directEnv();
    await e.GITME_R2.put('objects/' + oid, 'xx', { customMetadata: { sha256: oid } });
    const req = new Request('https://example.com/objects/batch', {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/vnd.git-lfs+json' }),
      body: JSON.stringify({ operation: 'upload', transfers: ['basic'], objects: [{ oid, size: 1 }] }),
    });

    const res = await worker.fetch(req, e, {} as ExecutionContext);
    const body = await res.json() as { objects: Array<{ error: { code: number }; actions?: { upload?: unknown } }> };

    expect(res.status).toBe(200);
    expect(body.objects[0].error.code).toBe(409);
    expect(body.objects[0].actions?.upload).toBeUndefined();
  });

  test('batch download signs only Worker-verified R2 objects', async () => {
    const e = env();
    await e.GITME_R2.put('objects/' + oid, 'x');
    const req = new Request('https://example.com/objects/batch', {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/vnd.git-lfs+json' }),
      body: JSON.stringify({ operation: 'download', transfers: ['basic'], objects: [{ oid, size: 1 }] }),
    });

    const res = await worker.fetch(req, e, {} as ExecutionContext);
    const body = await res.json() as { objects: Array<{ actions: { download: { href: string } } }> };

    expect(res.status).toBe(200);
    expect(body.objects[0].actions.download.href).toBe('https://example.com/objects/' + oid);

    const direct = directEnv();
    await direct.GITME_R2.put('objects/' + oid, 'x');
    const legacyReq = new Request('https://example.com/objects/batch', {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/vnd.git-lfs+json' }),
      body: JSON.stringify({ operation: 'download', transfers: ['basic'], objects: [{ oid, size: 1 }] }),
    });
    const legacyRes = await worker.fetch(legacyReq, direct, {} as ExecutionContext);
    const legacyBody = await legacyRes.json() as { objects: Array<{ actions: { download: { href: string } } }> };

    expect(legacyBody.objects[0].actions.download.href).toBe('https://example.com/objects/' + oid);

    const content = 'direct download';
    const verifiedOid = await sha256Hex(content);
    const upload = new Request('https://example.com/objects/' + verifiedOid, { method: 'PUT', headers: authHeaders(), body: content });
    await expect(worker.fetch(upload, direct, {} as ExecutionContext)).resolves.toMatchObject({ status: 200 });
    const directReq = new Request('https://example.com/objects/batch', {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/vnd.git-lfs+json' }),
      body: JSON.stringify({ operation: 'download', transfers: ['basic'], objects: [{ oid: verifiedOid, size: content.length }] }),
    });
    const directRes = await worker.fetch(directReq, direct, {} as ExecutionContext);
    const directBody = await directRes.json() as { objects: Array<{ actions: { download: { href: string; expires_in: number } } }> };
    const url = new URL(directBody.objects[0].actions.download.href);

    expect(url.host).toBe('test-account.r2.cloudflarestorage.com');
    expect(url.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
    expect(directBody.objects[0].actions.download.expires_in).toBe(900);
  });

  test('direct mode missing signing config returns configuration error', async () => {
    const e = { ...env(), GITME_TRANSFER_MODE: 'direct' };
    const req = new Request('https://example.com/objects/batch', {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/vnd.git-lfs+json' }),
      body: JSON.stringify({ operation: 'upload', transfers: ['basic'], objects: [{ oid, size: 1 }] }),
    });

    const res = await worker.fetch(req, e, {} as ExecutionContext);
    const body = await res.json() as { message: string };

    expect(res.status).toBe(500);
    expect(res.headers.get('Content-Type')).toBe('application/vnd.git-lfs+json');
    expect(body).toEqual({ message: 'configuration error' });
  });

  test('batch rejects non-array transfers', async () => {
    const e = env();
    const req = new Request('https://example.com/objects/batch', {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/vnd.git-lfs+json' }),
      body: JSON.stringify({ operation: 'upload', transfers: 'basic', objects: [{ oid, size: 1 }] }),
    });

    const res = await worker.fetch(req, e, {} as ExecutionContext);

    expect(res.status).toBe(400);
  });

  test('upload writes R2 object without KV object metadata', async () => {
    const e = env();
    const content = 'hello lfs';
    const realOID = await sha256Hex(content);
    const req = new Request('https://example.com/objects/' + realOID, {
      method: 'PUT',
      headers: authHeaders(),
      body: content,
    });

    const res = await worker.fetch(req, e, {} as ExecutionContext);

    expect(res.status).toBe(200);
    expect(await e.GITME_R2.get('objects/' + realOID)).toBeTruthy();
    expect(await e.GITME_KV.get('object:' + realOID)).toBeNull();
  });

  test('download returns bytes and headers', async () => {
    const e = env();
    const content = 'download me';
    const realOID = await sha256Hex(content);
    await e.GITME_R2.put('objects/' + realOID, content);
    const req = new Request('https://example.com/objects/' + realOID, { method: 'GET', headers: authHeaders() });

    const res = await worker.fetch(req, e, {} as ExecutionContext);

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/octet-stream');
    expect(res.headers.get('Content-Length')).toBe('11');
    expect(await res.text()).toBe(content);
  });

  test('auth is required', async () => {
    const e = env();
    const req = new Request('https://example.com/objects/batch', { method: 'POST' });

    const res = await worker.fetch(req, e, {} as ExecutionContext);
    const body = await res.json() as { message: string };

    expect(res.status).toBe(401);
    expect(res.headers.get('Content-Type')).toBe('application/vnd.git-lfs+json');
    expect(res.headers.get('WWW-Authenticate')).toBe('Basic realm="git-me"');
    expect(body.message).toBe('authentication required');
  });

  test('admin creates user and basic auth can upload', async () => {
    const e = env();
    const create = await worker.fetch(new Request('https://example.com/admin/users/alice', {
      method: 'PUT',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ password: 'correct horse', access: 'write' }),
    }), e, {} as ExecutionContext);
    const req = new Request('https://example.com/objects/batch', {
      method: 'POST',
      headers: basicHeaders('alice', 'correct horse', { 'Content-Type': 'application/vnd.git-lfs+json' }),
      body: JSON.stringify({ operation: 'upload', transfers: ['basic'], objects: [{ oid, size: 1 }] }),
    });

    const res = await worker.fetch(req, e, {} as ExecutionContext);
    expect(create.status).toBe(200);
    expect(res.status).toBe(200);
  });

  test('admin user registry retains concurrent mutations without password data', async () => {
    const e = env();
    const alice = worker.fetch(new Request('https://example.com/admin/users/alice', {
      method: 'PUT',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ password: 'correct horse alice', access: 'write' }),
    }), e, {} as ExecutionContext);
    const bob = worker.fetch(new Request('https://example.com/admin/users/bob', {
      method: 'PUT',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ password: 'correct horse bob', access: 'read' }),
    }), e, {} as ExecutionContext);
    await Promise.all([alice, bob]);

    const listed = await worker.fetch(new Request('https://example.com/admin/users', { headers: authHeaders() }), e, {} as ExecutionContext);
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({ users: [{ username: 'alice', access: 'write' }, { username: 'bob', access: 'read' }] });
    expect(await e.GITME_KV.get('admin:users')).toBeNull();

    await worker.fetch(new Request('https://example.com/admin/users/alice', { method: 'DELETE', headers: authHeaders() }), e, {} as ExecutionContext);
    const afterDelete = await worker.fetch(new Request('https://example.com/admin/users', { headers: authHeaders() }), e, {} as ExecutionContext);
    expect(await afterDelete.json()).toEqual({ users: [{ username: 'bob', access: 'read' }] });
  });

  test('read user can download but cannot upload', async () => {
    const e = env();
    await worker.fetch(new Request('https://example.com/admin/users/bob', {
      method: 'PUT',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ password: 'correct horse', access: 'read' }),
    }), e, {} as ExecutionContext);
    await e.GITME_R2.put('objects/' + oid, 'x');

    const upload = await worker.fetch(new Request('https://example.com/objects/batch', {
      method: 'POST',
      headers: basicHeaders('bob', 'correct horse', { 'Content-Type': 'application/vnd.git-lfs+json' }),
      body: JSON.stringify({ operation: 'upload', transfers: ['basic'], objects: [{ oid, size: 1 }] }),
    }), e, {} as ExecutionContext);
    const download = await worker.fetch(new Request('https://example.com/objects/batch', {
      method: 'POST',
      headers: basicHeaders('bob', 'correct horse', { 'Content-Type': 'application/vnd.git-lfs+json' }),
      body: JSON.stringify({ operation: 'download', transfers: ['basic'], objects: [{ oid, size: 1 }] }),
    }), e, {} as ExecutionContext);

    expect(upload.status).toBe(403);
    expect(download.status).toBe(200);
  });

  test('hash mismatch does not write object', async () => {
    const e = env();
    const req = new Request('https://example.com/objects/' + oid, {
      method: 'PUT',
      headers: authHeaders(),
      body: 'wrong bytes',
    });

    const res = await worker.fetch(req, e, {} as ExecutionContext);

    expect(res.status).toBe(400);
    expect(await e.GITME_R2.get('objects/' + oid)).toBeNull();
  });

  test('hash mismatch preserves existing object', async () => {
    const e = env();
    const content = 'existing bytes';
    const realOID = await sha256Hex(content);
    await e.GITME_R2.put('objects/' + realOID, content);
    const req = new Request('https://example.com/objects/' + realOID, {
      method: 'PUT',
      headers: authHeaders(),
      body: 'wrong bytes',
    });

    const res = await worker.fetch(req, e, {} as ExecutionContext);
    const object = await e.GITME_R2.get('objects/' + realOID);

    expect(res.status).toBe(400);
    expect(object).toBeTruthy();
    expect(await new Response(object?.body).text()).toBe(content);
  });

  test('batch download returns object error when R2 object missing', async () => {
    const e = env();
    const req = new Request('https://example.com/objects/batch', {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/vnd.git-lfs+json' }),
      body: JSON.stringify({ operation: 'download', transfers: ['basic'], objects: [{ oid, size: 1 }] }),
    });

    const res = await worker.fetch(req, e, {} as ExecutionContext);
    const body = await res.json() as { objects: Array<{ error: { code: number }; actions?: unknown }> };

    expect(res.status).toBe(200);
    expect(body.objects[0].error.code).toBe(404);
    expect(body.objects[0].actions).toBeUndefined();
  });
});

describe('presignR2Url', () => {
  test('returns R2 URL for GET', async () => {
    const url = new URL(await presignR2Url({ method: 'GET', key: 'objects/' + oid, expiresSeconds: 900, signing, now: new Date('2026-01-02T03:04:05.000Z') }));
    const params = signedUrlParams(url.href);

    expect(url.host).toBe('test-account.r2.cloudflarestorage.com');
    expect(url.pathname).toBe('/bucket/objects/' + oid);
    expect(params.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
    expect(params.get('X-Amz-Credential')).toContain('test-access-key/20260102/auto/s3/aws4_request');
    expect(params.get('X-Amz-Date')).toBe('20260102T030405Z');
    expect(params.get('X-Amz-Expires')).toBe('900');
    expect(params.get('X-Amz-SignedHeaders')).toBe('host');
    expect(params.get('X-Amz-Content-Sha256')).toBe('UNSIGNED-PAYLOAD');
    expect(params.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
  });

  test('encodes object keys by path segment', async () => {
    const url = new URL(await presignR2Url({ method: 'GET', key: 'objects/space file.bin', expiresSeconds: 60, signing, now: new Date('2026-01-02T03:04:05.000Z') }));

    expect(url.pathname).toBe('/bucket/objects/space%20file.bin');
  });

  test('signature is deterministic for fixed now', async () => {
    const input = { method: 'GET' as const, key: 'objects/' + oid, expiresSeconds: 600, signing, now: new Date('2026-01-02T03:04:05.000Z') };

    await expect(presignR2Url(input)).resolves.toBe(await presignR2Url(input));
  });
});
