# TypeScript-only Worker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert `git-me` to a TypeScript-first Cloudflare Worker Git LFS utility and remove Go/TinyGo from the current tree.

**Architecture:** Keep a single Cloudflare Worker module with one `fetch` handler. Preserve existing Git LFS routes, R2/KV storage layout, bearer-token auth, and hash-verified uploads while adding TypeScript types and Vitest tests.

**Tech Stack:** TypeScript, Vitest, Cloudflare Workers types, Wrangler, Node.js 20+, Cloudflare R2, Cloudflare KV.

## Global Constraints

- Remove Go/TinyGo from HEAD only; do not rewrite git history.
- Do not create `docs/superpowers/*`.
- Keep routes unchanged: `POST /objects/batch`, `PUT /objects/:oid`, `GET /objects/:oid`.
- Keep R2 final object key `objects/<oid>`.
- Keep R2 temp upload key prefix `objects/.tmp/`.
- Keep KV metadata key `object:<oid>`.
- Keep auth header `Authorization: Bearer <GITME_AUTH_TOKEN>`.
- Preserve LFS JSON content type `application/vnd.git-lfs+json`.
- Do not add auth schemes, transfer adapters, storage backends, UI, or dashboard features.
- Do not commit unless user explicitly requests commits. Commit steps below are checkpoints for commit-enabled execution only.

---

## File Structure

- Create: `tsconfig.json` — TypeScript compiler config for Worker and tests.
- Modify: `package.json` — scripts and dev dependencies.
- Rename/modify: `src/worker.js` -> `src/worker.ts` — Worker runtime, types, routing, storage, hashing, responses.
- Rename/modify: `test/worker.test.js` -> `test/worker.test.ts` — Vitest tests and typed in-memory R2/KV mocks.
- Modify: `wrangler.toml` — point Worker entry to `src/worker.ts`, remove `make build` hook.
- Delete: `go.mod` — Go module removed from current tree.
- Delete: `cmd/` — Go Worker entry removed.
- Delete: `internal/` — Go packages removed.
- Delete: `Makefile` — TinyGo/Go commands removed.
- Modify: `.github/workflows/ci.yml` — Node-only verification.
- Modify: `.github/workflows/release.yml` — Node-only release validation, no wasm artifact.
- Modify: `README.md` — TypeScript/Worker setup and development instructions.
- Modify: `CONTRIBUTING.md` — Node/Wrangler contribution flow.
- Modify: `CHANGELOG.md` — note TS-only rewrite.
- Modify: `.gitignore` — remove Go/TinyGo-only ignores; keep Node/Cloudflare/local ignores.

---

### Task 1: Add TypeScript toolchain and typed Worker

**Files:**
- Create: `tsconfig.json`
- Modify: `package.json`
- Rename/modify: `src/worker.js` -> `src/worker.ts`
- Modify: `wrangler.toml`

**Interfaces:**
- Consumes: existing Worker behavior from `src/worker.js`.
- Produces:
  - `export interface Env { GITME_AUTH_TOKEN: string; GITME_R2: R2Bucket; GITME_KV: KVNamespace; }`
  - default Worker export compatible with `ExportedHandler<Env>`.
  - `wrangler.toml` entry `main = "src/worker.ts"`.

- [ ] **Step 1: Install dev dependencies**

Run:

```bash
npm install --save-dev typescript vitest @cloudflare/workers-types wrangler
```

Expected: `package-lock.json` created or updated and dependencies added to `package.json`.

- [ ] **Step 2: Replace `package.json` scripts**

Write `package.json` as:

```json
{
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "deploy:dry": "wrangler deploy --dry-run",
    "deploy": "wrangler deploy"
  },
  "devDependencies": {
    "@cloudflare/workers-types": "^4.20260707.0",
    "typescript": "^5.9.0",
    "vitest": "^3.2.0",
    "wrangler": "^4.24.0"
  }
}
```

If `npm install` wrote newer compatible versions, keep installed versions instead of downgrading.

- [ ] **Step 3: Create `tsconfig.json`**

Write:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022", "WebWorker"],
    "types": ["@cloudflare/workers-types", "vitest/globals"],
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "isolatedModules": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

- [ ] **Step 4: Rename Worker file**

Run:

```bash
```

Expected: `src/worker.js` removed and `src/worker.ts` tracked as rename.

- [ ] **Step 5: Replace `src/worker.ts` with typed Worker**

Write:

```ts
const LFS_CONTENT_TYPE = 'application/vnd.git-lfs+json';
const OBJECT_PREFIX = 'objects/';
const META_PREFIX = 'object:';
const OID_RE = /^[0-9a-fA-F]{64}$/;

export interface Env {
  GITME_AUTH_TOKEN: string;
  GITME_R2: R2Bucket;
  GITME_KV: KVNamespace;
}

type LfsOperation = 'upload' | 'download';

type LfsBatchObject = {
  oid: string;
  size: number;
};

type LfsBatchRequest = {
  operation?: string;
  transfers?: unknown;
  objects?: unknown;
};

type ObjectMeta = {
  oid: string;
  size: number;
  created_at: string;
  uploaded: true;
};

type DigestResult = {
  hex: string;
  size: number;
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      if (!env.GITME_AUTH_TOKEN) {
        return lfsError(500, 'configuration error');
      }
      const auth = request.headers.get('Authorization') || '';
      if (auth !== `Bearer ${env.GITME_AUTH_TOKEN}`) {
        return lfsError(401, 'authentication required');
      }

      const url = new URL(request.url);
      if (url.pathname === '/objects/batch') {
        return handleBatch(request, env);
      }
      if (url.pathname.startsWith('/objects/')) {
        const oid = url.pathname.slice('/objects/'.length);
        if (request.method === 'PUT') return handleUpload(request, env, oid);
        if (request.method === 'GET') return handleDownload(env, oid);
        return lfsError(405, 'method not allowed');
      }
      return new Response('not found\n', { status: 404 });
    } catch {
      return lfsError(500, 'internal server error');
    }
  },
} satisfies ExportedHandler<Env>;

async function handleBatch(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return lfsError(405, 'method not allowed');
  if (!isLfsContentType(request.headers.get('Content-Type'))) {
    return lfsError(415, 'content type must be ' + LFS_CONTENT_TYPE);
  }

  let body: LfsBatchRequest;
  try {
    body = (await request.json()) as LfsBatchRequest;
  } catch {
    return lfsError(400, 'invalid JSON');
  }

  const transfer = selectTransfer(body.transfers);
  if (!transfer) return lfsError(400, 'unsupported transfer adapter');
  if (!isLfsOperation(body.operation)) {
    return lfsError(400, 'lfs: unknown batch operation: ' + body.operation);
  }
  if (!Array.isArray(body.objects)) return lfsError(400, 'objects must be an array');

  const objects: LfsBatchObject[] = [];
  for (const obj of body.objects) {
    const validation = validateObject(obj);
    if (validation) return lfsError(400, validation);
    objects.push(obj);
  }

  const responseObjects = [];
  for (const obj of objects) {
    const href = new URL(`/objects/${obj.oid}`, request.url).href;
    if (body.operation === 'upload') {
      responseObjects.push({ oid: obj.oid, size: obj.size, actions: { upload: { href } } });
      continue;
    }

    const metaText = await env.GITME_KV.get(META_PREFIX + obj.oid);
    if (!metaText) {
      responseObjects.push(objectNotFound(obj));
      continue;
    }
    const meta = JSON.parse(metaText) as ObjectMeta;
    const head = await env.GITME_R2.head(OBJECT_PREFIX + obj.oid);
    if (!meta.uploaded || !head) {
      responseObjects.push(objectNotFound(obj));
      continue;
    }
    responseObjects.push({ oid: obj.oid, size: meta.size, actions: { download: { href } } });
  }

  return json(200, { transfer, objects: responseObjects });
}

async function handleUpload(request: Request, env: Env, oid: string): Promise<Response> {
  if (!OID_RE.test(oid)) return lfsError(400, 'invalid oid');
  if (!request.body) return lfsError(400, 'missing request body');

  const objectKey = OBJECT_PREFIX + oid;
  const tempKey = OBJECT_PREFIX + '.tmp/' + crypto.randomUUID();
  const [storeStream, digestStream] = request.body.tee();
  const putPromise = env.GITME_R2.put(tempKey, storeStream);
  const digest = await digestAndCount(digestStream);
  await putPromise;

  if (digest.hex.toLowerCase() !== oid.toLowerCase()) {
    await env.GITME_R2.delete(tempKey);
    return lfsError(400, 'upload hash mismatch');
  }

  const tempObject = await env.GITME_R2.get(tempKey);
  if (!tempObject?.body) return lfsError(500, 'internal server error');
  await env.GITME_R2.put(objectKey, tempObject.body);
  await env.GITME_R2.delete(tempKey);

  const meta: ObjectMeta = { oid, size: digest.size, created_at: new Date().toISOString(), uploaded: true };
  await env.GITME_KV.put(META_PREFIX + oid, JSON.stringify(meta));
  return new Response(null, { status: 200 });
}

async function handleDownload(env: Env, oid: string): Promise<Response> {
  if (!OID_RE.test(oid)) return lfsError(400, 'invalid oid');
  const metaText = await env.GITME_KV.get(META_PREFIX + oid);
  if (!metaText) return lfsError(404, 'object not found');
  const meta = JSON.parse(metaText) as ObjectMeta;
  if (!meta.uploaded) return lfsError(404, 'object not found');

  const object = await env.GITME_R2.get(OBJECT_PREFIX + oid);
  if (!object) return lfsError(404, 'object not found');

  return new Response(object.body, {
    status: 200,
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(meta.size),
    },
  });
}

function isLfsOperation(operation: unknown): operation is LfsOperation {
  return operation === 'upload' || operation === 'download';
}

function isLfsContentType(contentType: string | null): boolean {
  return (contentType || '').split(';', 1)[0].trim().toLowerCase() === LFS_CONTENT_TYPE;
}

function selectTransfer(transfers: unknown): string {
  if (transfers == null) return 'basic';
  if (!Array.isArray(transfers)) return '';
  if (transfers.length === 0) return 'basic';
  return transfers.includes('basic') ? 'basic' : '';
}

function validateObject(obj: unknown): string {
  if (!isObjectRecord(obj) || !OID_RE.test(String(obj.oid || ''))) return 'invalid oid';
  if (!Number.isInteger(obj.size) || obj.size < 0) return 'object size must not be negative';
  return '';
}

function isObjectRecord(value: unknown): value is LfsBatchObject {
  return typeof value === 'object' && value !== null && 'oid' in value && 'size' in value;
}

function objectNotFound(obj: LfsBatchObject): object {
  return { oid: obj.oid, size: obj.size, error: { code: 404, message: 'object not found' } };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body) + '\n', { status, headers: { 'Content-Type': LFS_CONTENT_TYPE } });
}

function lfsError(status: number, message: string): Response {
  return json(status, { message });
}

async function digestAndCount(stream: ReadableStream<Uint8Array>): Promise<DigestResult> {
  if (typeof DigestStream === 'function') {
    let size = 0;
    const counter = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        size += chunk.byteLength;
        controller.enqueue(chunk);
      },
    });
    const digester = new DigestStream('SHA-256');
    await stream.pipeThrough(counter).pipeTo(digester.writable);
    const digest = await digester.digest;
    return { hex: bytesToHex(new Uint8Array(digest)), size };
  }

  const buffer = await new Response(stream).arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return { hex: bytesToHex(new Uint8Array(digest)), size: buffer.byteLength };
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}
```

- [ ] **Step 6: Update `wrangler.toml`**

Replace it with:

```toml
name = "git-me"
main = "src/worker.ts"
compatibility_date = "2026-07-07"
workers_dev = true

[[r2_buckets]]
binding = "GITME_R2"
bucket_name = "git-me-objects"

[[kv_namespaces]]
binding = "GITME_KV"
id = "<kv_namespace_id>"
```

- [ ] **Step 7: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: PASS, no TypeScript errors.

- [ ] **Step 8: Commit checkpoint if commits are approved**

```bash
git add package.json package-lock.json tsconfig.json wrangler.toml src/worker.ts
git add -u src/worker.js
git commit -m "feat: migrate worker to typescript"
```

Expected: commit created only if user approved commits.

---

### Task 2: Convert tests to Vitest and TypeScript

**Files:**
- Rename/modify: `test/worker.test.js` -> `test/worker.test.ts`

**Interfaces:**
- Consumes: default Worker export and `Env` from `../src/worker`.
- Produces: typed behavioral tests for current Worker behavior.

- [ ] **Step 1: Rename test file**

Run:

```bash
```

Expected: JS test removed and TS test tracked as rename.

- [ ] **Step 2: Replace `test/worker.test.ts`**

Write:

```ts
import { describe, expect, test } from 'vitest';
import worker, { type Env } from '../src/worker';

const oid = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';

class MemoryR2 {
  readonly objects = new Map<string, Uint8Array>();

  async put(key: string, value: ReadableStream | string | ArrayBuffer | ArrayBufferView | Blob): Promise<void> {
    const bytes = new Uint8Array(await new Response(value as BodyInit).arrayBuffer());
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
```

- [ ] **Step 3: Run tests**

Run:

```bash
npm test
```

Expected: PASS with 9 tests.

- [ ] **Step 4: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: PASS, no TypeScript errors.

- [ ] **Step 5: Commit checkpoint if commits are approved**

```bash
git add test/worker.test.ts
git add -u test/worker.test.js
git commit -m "test: convert worker tests to typescript"
```

Expected: commit created only if user approved commits.

---

### Task 3: Remove Go/TinyGo source and build files from HEAD

**Files:**
- Delete: `go.mod`
- Delete: `cmd/`
- Delete: `internal/`
- Delete: `Makefile`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: TypeScript Worker and test suite from Tasks 1-2.
- Produces: current tree with no Go source, Go module, or TinyGo build command.

- [ ] **Step 1: Delete Go and TinyGo files**

Run:

```bash
```

Expected: deleted files staged.

- [ ] **Step 2: Replace `.gitignore`**

Write:

```gitignore
# Build output
/dist/

# Dependencies
/node_modules/

# IDE
.idea/
.vscode/
*.swp
*.swo

# OS
.DS_Store
Thumbs.db

# Cloudflare
.wrangler/

# Coverage
/coverage/

# Local secrets
.env
.env.*
.dev.vars
```

- [ ] **Step 3: Verify no Go files remain in current tree**

Run:

```bash
git ls-files "*.go" go.mod cmd internal Makefile
```

Expected: no output.

- [ ] **Step 4: Run TS gates**

Run:

```bash
npm test
npm run typecheck
```

Expected: both PASS.

- [ ] **Step 5: Commit checkpoint if commits are approved**

```bash
git add .gitignore
git add -u go.mod Makefile cmd internal
git commit -m "chore: remove go and tinygo sources"
```

Expected: commit created only if user approved commits.

---

### Task 4: Update CI and release workflows to Node-only

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/release.yml`

**Interfaces:**
- Consumes: `npm test`, `npm run typecheck`, `npm run deploy:dry` scripts from Task 1.
- Produces: workflows with no Go, TinyGo, `make build`, or wasm artifacts.

- [ ] **Step 1: Replace CI workflow**

Write `.github/workflows/ci.yml`:

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: npm
      - run: npm ci
      - run: npm test
      - run: npm run typecheck
      - run: npm run deploy:dry
```

- [ ] **Step 2: Replace release workflow**

Write `.github/workflows/release.yml`:

```yaml
name: Release

on:
  push:
    tags:
      - 'v*'

permissions:
  contents: write

jobs:
  verify-and-release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: npm
      - run: npm ci
      - run: npm test
      - run: npm run typecheck
      - run: npm run deploy:dry
      - uses: softprops/action-gh-release@v2
        with:
          generate_release_notes: true
```

- [ ] **Step 3: Verify workflow text has no Go/TinyGo remnants**

Run:

```bash
git grep -n "Go\|TinyGo\|go test\|go vet\|make build\|wasm" -- .github/workflows
```

Expected: no output.

- [ ] **Step 4: Commit checkpoint if commits are approved**

```bash
git add .github/workflows/ci.yml .github/workflows/release.yml
git commit -m "ci: switch workflows to node"
```

Expected: commit created only if user approved commits.

---

### Task 5: Update project docs for TypeScript-only Worker

**Files:**
- Modify: `README.md`
- Modify: `CONTRIBUTING.md`
- Modify: `CHANGELOG.md`
- Keep: `DESIGN.md`
- Keep: `PLAN.md`

**Interfaces:**
- Consumes: scripts, file paths, routes, and storage model from Tasks 1-4.
- Produces: docs with no stale Go/TinyGo development instructions.

- [ ] **Step 1: Replace `README.md`**

Write:

````md
# git-me

A small self-hosted Git LFS utility for Cloudflare Workers, R2, and KV.

Built as a TypeScript Cloudflare Worker.

## Requirements

- Node.js 20+
- Wrangler CLI or project-local `wrangler`
- Cloudflare account with Workers, R2, and KV enabled

## Quick Start

```bash
git clone git@github.com:0xordek/git-me.git
cd git-me
npm ci
npm test
npm run typecheck
npm run deploy:dry
```

## Cloudflare Setup

Create storage resources:

```bash
wrangler r2 bucket create git-me-objects
wrangler kv namespace create git-me-metadata
```

Wrangler prints the KV namespace id. Add it to `wrangler.toml` as `id = "..."` under `[[kv_namespaces]]` if your Wrangler version does not auto-provision or write the id for you.

Set the auth token as a secret:

```bash
wrangler secret put GITME_AUTH_TOKEN
```

Deploy:

```bash
npm run deploy:dry
npm run deploy
```

## Git LFS Client Setup

```bash
git lfs track "*.psd" "*.zip" "*.bin"
git add .gitattributes

git config lfs.url https://your-worker.workers.dev
git config http.https://your-worker.workers.dev.extraheader "Authorization: Bearer <token>"
git config lfs.http.https://your-worker.workers.dev.locksverify false
```

Then use `git push` and `git pull` as normal.

## API Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/objects/batch` | Git LFS Batch API |
| PUT | `/objects/{oid}` | Upload object bytes |
| GET | `/objects/{oid}` | Download object bytes |

Batch requests and error responses use `application/vnd.git-lfs+json`.

## Storage Layout

- R2 object key: `objects/<oid>`
- Temporary upload key prefix: `objects/.tmp/`
- KV metadata key: `object:<oid>`

## Development

```bash
npm ci
npm test
npm run typecheck
wrangler dev
```

## Security

Do not commit auth tokens. Use `wrangler secret put GITME_AUTH_TOKEN`.

Report vulnerabilities through GitHub Security Advisories. See `SECURITY.md`.

## Contributing

Small fixes and focused issues are welcome. See `CONTRIBUTING.md`.

## License

MIT — see `LICENSE`.
````

- [ ] **Step 2: Replace `CONTRIBUTING.md`**

Write:

````md
# Contributing

`git-me` is a small personal utility. Keep changes focused and easy to review.

## Setup

```bash
git clone git@github.com:0xordek/git-me.git
cd git-me
npm ci
npm test
npm run typecheck
npm run deploy:dry
```

## Guidelines

- Prefer small PRs.
- Keep Cloudflare runtime code in `src/worker.ts`.
- Keep behavior covered by tests in `test/worker.test.ts`.
- Never commit secrets. Use `wrangler secret put GITME_AUTH_TOKEN`.
- Add or update tests for behavior changes.

## Before opening a PR

Run:

```bash
npm test
npm run typecheck
npm run deploy:dry
```
````

- [ ] **Step 3: Replace `CHANGELOG.md`**

Write:

````md
# Changelog

All notable changes to this project will be documented in this file.

## Unreleased

- Rewrote the Worker runtime as TypeScript.
- Removed Go and TinyGo source/build files from the current tree without rewriting git history.
- Switched tests to Vitest with typed R2/KV mocks.
- Switched CI and release verification to Node, TypeScript, and Wrangler.
- Kept the Cloudflare Worker deployment path with R2/KV bindings.
- Kept bearer-token Git LFS client setup.
- Kept edge-case tests for Git LFS batch, upload, download, and auth behavior.
````

- [ ] **Step 4: Verify docs have no stale Go/TinyGo instructions**

Run:

```bash
git grep -n "Go\|TinyGo\|go test\|go vet\|make build\|wasm\|src/worker.js" -- README.md CONTRIBUTING.md CHANGELOG.md
```

Expected: no output, except `CHANGELOG.md` line stating `Removed Go and TinyGo source/build files` is acceptable.

- [ ] **Step 5: Commit checkpoint if commits are approved**

```bash
git add README.md CONTRIBUTING.md CHANGELOG.md DESIGN.md PLAN.md
git commit -m "docs: describe typescript worker"
```

Expected: commit created only if user approved commits.

---

### Task 6: Final verification and cleanup

**Files:**
- Inspect: all changed files.
- Modify only if verification finds stale references or broken checks.

**Interfaces:**
- Consumes: all prior tasks.
- Produces: verified TS-only current tree, no Go/TinyGo runtime/build files in HEAD.

- [ ] **Step 1: Run tests**

Run:

```bash
npm test
```

Expected: PASS with 9 tests.

- [ ] **Step 2: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: PASS, no TypeScript errors.

- [ ] **Step 3: Run Wrangler dry deploy**

Run:

```bash
npm run deploy:dry
```

Expected: PASS. If it fails because `wrangler.toml` still has placeholder `id = "<kv_namespace_id>"`, replace with a real KV namespace id or document that Cloudflare resource config is required before dry deploy.

- [ ] **Step 4: Verify no Go source/build files in HEAD**

Run:

```bash
git ls-files "*.go" go.mod cmd internal Makefile
```

Expected: no output.

- [ ] **Step 5: Verify no stale Go/TinyGo commands outside design/history notes**

Run:

```bash
git grep -n "Go\|TinyGo\|go test\|go vet\|make build\|tinygo\|wasm\|src/worker.js" -- . ':!DESIGN.md' ':!PLAN.md' ':!CHANGELOG.md'
```

Expected: no output.

- [ ] **Step 6: Inspect git diff**

Run:

```bash
git status --short
git diff --stat
git diff -- package.json tsconfig.json wrangler.toml src/worker.ts test/worker.test.ts README.md CONTRIBUTING.md CHANGELOG.md .github/workflows/ci.yml .github/workflows/release.yml .gitignore
```

Expected: only intended TS-only migration changes.

- [ ] **Step 7: Final commit checkpoint if commits are approved and prior commits were skipped**

```bash
git add .
git commit -m "feat: convert worker to typescript"
```

Expected: commit created only if user approved commits.

---

## Self-Review

- Spec coverage: covered TypeScript Worker migration, Vitest tests, Go/TinyGo HEAD deletion, Node-only CI/release, docs update, no history rewrite.
- Placeholder scan: no placeholder or undefined future work remains.
- Type consistency: `Env`, `ObjectMeta`, R2/KV key names, route names, and script names match across tasks.
- Scope check: single subsystem; no decomposition needed.
