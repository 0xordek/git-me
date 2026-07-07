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
  readonly objects = new Map<string, Uint8Array<ArrayBuffer>>();

  async put(key: string, value: ReadableStream | string | ArrayBuffer | ArrayBufferView | Blob): Promise<void> {
    const bytes: Uint8Array<ArrayBuffer> = new Uint8Array(await new Response(value as BodyInit).arrayBuffer());
    this.objects.set(key, bytes);
  }

  async get(key: string): Promise<{ body: ReadableStream; size: number } | null> {
    const bytes = this.objects.get(key);
    if (!bytes) return null;
    return { body: new Blob([bytes]).stream(), size: bytes.byteLength };
  }

  async head(key: string): Promise<{ size: number } | null> {
    const bytes = this.objects.get(key);
    if (!bytes) return null;
    return { size: bytes.byteLength };
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

type TestEnv = Env & {
  GITME_R2: MemoryR2;
  GITME_KV: MemoryKV;
};

function env(): TestEnv {
  return { GITME_AUTH_TOKEN: 'tok', GITME_R2: new MemoryR2() as R2Bucket & MemoryR2, GITME_KV: new MemoryKV() as KVNamespace & MemoryKV };
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

  test('direct batch upload returns signed R2 PUT action and pending metadata', async () => {
    const e = directEnv();
    const req = new Request('https://example.com/objects/batch', {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/vnd.git-lfs+json' }),
      body: JSON.stringify({ operation: 'upload', transfers: ['basic'], objects: [{ oid, size: 1 }] }),
    });

    const res = await worker.fetch(req, e, {} as ExecutionContext);
    const body = await res.json() as { objects: Array<{ actions: { upload: { href: string; expires_in: number; method?: string } } }> };
    const action = body.objects[0].actions.upload;
    const url = new URL(action.href);
    const meta = JSON.parse((await e.GITME_KV.get('object:' + oid)) || '{}') as { oid: string; size: number; uploaded: boolean };

    expect(res.status).toBe(200);
    expect(url.host).toBe('test-account.r2.cloudflarestorage.com');
    expect(url.pathname).toBe('/bucket/objects/' + oid);
    expect(url.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
    expect(action.expires_in).toBe(900);
    expect(action.method).toBeUndefined();
    expect(meta).toMatchObject({ oid, size: 1, uploaded: false });
  });

  test('direct batch upload omits upload action for existing uploaded object when R2 size matches', async () => {
    const e = directEnv();
    const meta = { oid, size: 1, created_at: '2026-01-02T03:04:05.000Z', uploaded: true };
    await e.GITME_R2.put('objects/' + oid, 'x');
    await e.GITME_KV.put('object:' + oid, JSON.stringify(meta));
    const req = new Request('https://example.com/objects/batch', {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/vnd.git-lfs+json' }),
      body: JSON.stringify({ operation: 'upload', transfers: ['basic'], objects: [{ oid, size: 1 }] }),
    });

    const res = await worker.fetch(req, e, {} as ExecutionContext);
    const body = await res.json() as { objects: Array<{ oid: string; size: number; actions?: { upload?: unknown } }> };

    expect(res.status).toBe(200);
    expect(body.objects[0]).toEqual({ oid, size: 1 });
    expect(JSON.parse((await e.GITME_KV.get('object:' + oid)) || '{}')).toEqual(meta);
  });

  test('batch download returns absolute download action href', async () => {
    const e = env();
    await e.GITME_R2.put('objects/' + oid, 'x');
    await e.GITME_KV.put('object:' + oid, JSON.stringify({ oid, size: 1, created_at: new Date().toISOString(), uploaded: true }));
    const req = new Request('https://example.com/objects/batch', {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/vnd.git-lfs+json' }),
      body: JSON.stringify({ operation: 'download', transfers: ['basic'], objects: [{ oid, size: 1 }] }),
    });

    const res = await worker.fetch(req, e, {} as ExecutionContext);
    const body = await res.json() as { objects: Array<{ actions: { download: { href: string } } }> };

    expect(res.status).toBe(200);
    expect(body.objects[0].actions.download.href).toBe('https://example.com/objects/' + oid);
  });

  test('direct batch download finalizes pending metadata when R2 object exists', async () => {
    const e = directEnv();
    await e.GITME_R2.put('objects/' + oid, 'x');
    await e.GITME_KV.put('object:' + oid, JSON.stringify({ oid, size: 1, created_at: '2026-01-02T03:04:05.000Z', uploaded: false }));
    const req = new Request('https://example.com/objects/batch', {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/vnd.git-lfs+json' }),
      body: JSON.stringify({ operation: 'download', transfers: ['basic'], objects: [{ oid, size: 1 }] }),
    });

    const res = await worker.fetch(req, e, {} as ExecutionContext);
    const body = await res.json() as { objects: Array<{ actions: { download: { href: string; expires_in: number } } }> };
    const action = body.objects[0].actions.download;
    const url = new URL(action.href);
    const meta = JSON.parse((await e.GITME_KV.get('object:' + oid)) || '{}') as { uploaded: boolean };

    expect(res.status).toBe(200);
    expect(url.host).toBe('test-account.r2.cloudflarestorage.com');
    expect(url.pathname).toBe('/bucket/objects/' + oid);
    expect(url.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
    expect(action.expires_in).toBe(900);
    expect(meta.uploaded).toBe(true);
  });

  test('direct batch download returns object error when pending object missing from R2', async () => {
    const e = directEnv();
    await e.GITME_KV.put('object:' + oid, JSON.stringify({ oid, size: 1, created_at: '2026-01-02T03:04:05.000Z', uploaded: false }));
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

  test('direct batch download returns object error when pending R2 object size mismatches', async () => {
    const e = directEnv();
    await e.GITME_R2.put('objects/' + oid, 'x');
    await e.GITME_KV.put('object:' + oid, JSON.stringify({ oid, size: 10, created_at: '2026-01-02T03:04:05.000Z', uploaded: false }));
    const req = new Request('https://example.com/objects/batch', {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/vnd.git-lfs+json' }),
      body: JSON.stringify({ operation: 'download', transfers: ['basic'], objects: [{ oid, size: 10 }] }),
    });

    const res = await worker.fetch(req, e, {} as ExecutionContext);
    const body = await res.json() as { objects: Array<{ error: { code: number }; actions?: unknown }> };
    const meta = JSON.parse((await e.GITME_KV.get('object:' + oid)) || '{}') as { uploaded: boolean };

    expect(res.status).toBe(200);
    expect(body.objects[0].error.code).toBe(404);
    expect(body.objects[0].actions).toBeUndefined();
    expect(meta.uploaded).toBe(false);
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

  test('upload writes R2 object and KV metadata', async () => {
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
    const meta = JSON.parse((await e.GITME_KV.get('object:' + realOID)) || '{}') as { oid: string; size: number; uploaded: boolean };
    expect(meta.oid).toBe(realOID);
    expect(meta.size).toBe(9);
    expect(meta.uploaded).toBe(true);
  });

  test('download returns bytes and headers', async () => {
    const e = env();
    const content = 'download me';
    const realOID = await sha256Hex(content);
    await e.GITME_R2.put('objects/' + realOID, content);
    await e.GITME_KV.put('object:' + realOID, JSON.stringify({ oid: realOID, size: content.length, created_at: new Date().toISOString(), uploaded: true }));
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
    expect(body.message).toBe('authentication required');
  });

  test('hash mismatch does not write KV metadata', async () => {
    const e = env();
    const req = new Request('https://example.com/objects/' + oid, {
      method: 'PUT',
      headers: authHeaders(),
      body: 'wrong bytes',
    });

    const res = await worker.fetch(req, e, {} as ExecutionContext);

    expect(res.status).toBe(400);
    expect(await e.GITME_KV.get('object:' + oid)).toBeNull();
    expect(await e.GITME_R2.get('objects/' + oid)).toBeNull();
  });

  test('hash mismatch preserves existing object and metadata', async () => {
    const e = env();
    const content = 'existing bytes';
    const realOID = await sha256Hex(content);
    const meta = { oid: realOID, size: content.length, created_at: '2026-01-02T03:04:05.000Z', uploaded: true };
    await e.GITME_R2.put('objects/' + realOID, content);
    await e.GITME_KV.put('object:' + realOID, JSON.stringify(meta));
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
    expect(JSON.parse((await e.GITME_KV.get('object:' + realOID)) || '{}')).toEqual(meta);
  });

  test('batch download returns object error when R2 object missing', async () => {
    const e = env();
    await e.GITME_KV.put('object:' + oid, JSON.stringify({ oid, size: 1, created_at: new Date().toISOString(), uploaded: true }));
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
  test('returns R2 URL for PUT', async () => {
    const url = new URL(await presignR2Url({ method: 'PUT', key: 'objects/' + oid, expiresSeconds: 900, signing, now: new Date('2026-01-02T03:04:05.000Z') }));
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
