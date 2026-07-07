import { describe, expect, test } from 'vitest';
import worker, { type Env } from '../src/worker';

const oid = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';

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

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: 'Bearer tok', ...extra };
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

describe('worker', () => {
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
