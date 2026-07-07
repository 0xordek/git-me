import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';

const oid = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';

class MemoryR2 {
  constructor() {
    this.objects = new Map();
  }
  async put(key, value) {
    const bytes = value instanceof ReadableStream
      ? new Uint8Array(await new Response(value).arrayBuffer())
      : new Uint8Array(await new Response(value).arrayBuffer());
    this.objects.set(key, bytes);
  }
  async get(key) {
    const bytes = this.objects.get(key);
    if (!bytes) return null;
    return { body: new Blob([bytes]).stream(), size: bytes.byteLength };
  }
  async head(key) {
    const bytes = this.objects.get(key);
    if (!bytes) return null;
    return { size: bytes.byteLength };
  }
  async delete(key) {
    this.objects.delete(key);
  }
}

class MemoryKV {
  constructor() {
    this.values = new Map();
  }
  async get(key) {
    return this.values.get(key) ?? null;
  }
  async put(key, value) {
    this.values.set(key, value);
  }
  async delete(key) {
    this.values.delete(key);
  }
}

function env() {
  return { GITME_AUTH_TOKEN: 'tok', GITME_R2: new MemoryR2(), GITME_KV: new MemoryKV() };
}

function authHeaders(extra = {}) {
  return { Authorization: 'Bearer tok', ...extra };
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

test('batch upload returns upload action', async () => {
  const e = env();
  const req = new Request('https://example.com/objects/batch', {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/vnd.git-lfs+json; charset=utf-8' }),
    body: JSON.stringify({ operation: 'upload', transfers: ['basic'], objects: [{ oid, size: 1 }] }),
  });

  const res = await worker.fetch(req, e);
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.transfer, 'basic');
  assert.equal(body.objects[0].actions.upload.href, '/objects/' + oid);
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

  const res = await worker.fetch(req, e);

  assert.equal(res.status, 200);
  assert.ok(await e.GITME_R2.get('objects/' + realOID));
  const meta = JSON.parse(await e.GITME_KV.get('object:' + realOID));
  assert.equal(meta.oid, realOID);
  assert.equal(meta.size, 9);
  assert.equal(meta.uploaded, true);
});

test('download returns bytes and headers', async () => {
  const e = env();
  const content = 'download me';
  const realOID = await sha256Hex(content);
  await e.GITME_R2.put('objects/' + realOID, content);
  await e.GITME_KV.put('object:' + realOID, JSON.stringify({ oid: realOID, size: content.length, created_at: new Date().toISOString(), uploaded: true }));
  const req = new Request('https://example.com/objects/' + realOID, { method: 'GET', headers: authHeaders() });

  const res = await worker.fetch(req, e);

  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Content-Type'), 'application/octet-stream');
  assert.equal(res.headers.get('Content-Length'), '11');
  assert.equal(await res.text(), content);
});

test('auth is required', async () => {
  const e = env();
  const req = new Request('https://example.com/objects/batch', { method: 'POST' });

  const res = await worker.fetch(req, e);
  const body = await res.json();

  assert.equal(res.status, 401);
  assert.equal(res.headers.get('Content-Type'), 'application/vnd.git-lfs+json');
  assert.equal(body.message, 'authentication required');
});

test('hash mismatch does not write KV metadata', async () => {
  const e = env();
  const req = new Request('https://example.com/objects/' + oid, {
    method: 'PUT',
    headers: authHeaders(),
    body: 'wrong bytes',
  });

  const res = await worker.fetch(req, e);

  assert.equal(res.status, 400);
  assert.equal(await e.GITME_KV.get('object:' + oid), null);
  assert.equal(await e.GITME_R2.get('objects/' + oid), null);
});

test('batch download returns object error when R2 object missing', async () => {
  const e = env();
  await e.GITME_KV.put('object:' + oid, JSON.stringify({ oid, size: 1, created_at: new Date().toISOString(), uploaded: true }));
  const req = new Request('https://example.com/objects/batch', {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/vnd.git-lfs+json' }),
    body: JSON.stringify({ operation: 'download', transfers: ['basic'], objects: [{ oid, size: 1 }] }),
  });

  const res = await worker.fetch(req, e);
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.objects[0].error.code, 404);
  assert.equal(body.objects[0].actions, undefined);
});
