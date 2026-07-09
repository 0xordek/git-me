import { ConfigError, healthResponse, loadConfig } from './config';
import type { AppConfig } from './config';
import { presignR2Url } from './signing';

const LFS_CONTENT_TYPE = 'application/vnd.git-lfs+json';
const OBJECT_PREFIX = 'objects/';
const META_PREFIX = 'object:';
const USER_PREFIX = 'user:';
const OID_RE = /^[0-9a-fA-F]{64}$/;
const USERNAME_RE = /^[a-z0-9][a-z0-9_.-]{0,62}$/;

export interface Env {
  GITME_AUTH_TOKEN?: string;
  GITME_TRANSFER_MODE?: string;
  GITME_SIGNED_URL_TTL_SECONDS?: string;
  GITME_R2_ACCOUNT_ID?: string;
  GITME_R2_ACCESS_KEY_ID?: string;
  GITME_R2_SECRET_ACCESS_KEY?: string;
  GITME_R2_BUCKET_NAME?: string;
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
  uploaded: boolean;
};

type DigestResult = {
  hex: string;
  size: number;
};

type UserAccess = 'read' | 'write';

type UserRecord = {
  password_sha256: string;
  access: UserAccess;
  created_at: string;
};

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (request.method === 'GET' && url.pathname === '/health') {
        return healthResponse(env);
      }

      let config: AppConfig;
      try {
        config = loadConfig(env);
      } catch (error) {
        if (error instanceof ConfigError) return lfsError(500, 'configuration error');
        throw error;
      }
      if (url.pathname.startsWith('/admin/users/')) return handleAdminUser(request, env, config, url.pathname.slice('/admin/users/'.length));

      if (url.pathname === '/objects/batch') {
        return handleBatch(request, env, config);
      }
      if (url.pathname.startsWith('/objects/')) {
        const oid = url.pathname.slice('/objects/'.length);
        if (request.method === 'PUT') {
          const auth = await requireLfsAccess(request, env, config, 'write');
          if (auth) return auth;
          return handleUpload(request, env, oid);
        }
        if (request.method === 'GET') {
          const auth = await requireLfsAccess(request, env, config, 'read');
          if (auth) return auth;
          return handleDownload(env, oid);
        }
        return lfsError(405, 'method not allowed');
      }
      return new Response('not found\n', { status: 404 });
    } catch {
      return lfsError(500, 'internal server error');
    }
  },
} satisfies ExportedHandler<Env>;

async function handleBatch(request: Request, env: Env, config: AppConfig): Promise<Response> {
  if (request.method !== 'POST') return lfsError(405, 'method not allowed');
  const auth = await authenticateLfs(request, env, config);
  if ('response' in auth) return auth.response;
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
  if (!canAccess(auth.access, body.operation === 'upload' ? 'write' : 'read')) return lfsError(403, 'forbidden');
  if (!Array.isArray(body.objects)) return lfsError(400, 'objects must be an array');

  const objects: LfsBatchObject[] = [];
  for (const obj of body.objects) {
    const validation = validateObject(obj);
    if (validation) return lfsError(400, validation);
    objects.push(obj as LfsBatchObject);
  }

  const responseObjects = [];
  for (const obj of objects) {
    const href = new URL(`/objects/${obj.oid}`, request.url).href;
    if (body.operation === 'upload') {
      if (config.transferMode === 'direct' && config.r2Signing) {
        const existingMetaText = await env.GITME_KV.get(META_PREFIX + obj.oid);
        const existingMeta = existingMetaText ? JSON.parse(existingMetaText) as ObjectMeta : null;
        const existingHead = existingMeta?.uploaded ? await env.GITME_R2.head(OBJECT_PREFIX + obj.oid) : null;
        if (existingMeta?.uploaded) {
          responseObjects.push(existingHead?.size === existingMeta.size && existingMeta.size === obj.size ? { oid: obj.oid, size: obj.size } : objectNotFound(obj));
          continue;
        }
        const meta: ObjectMeta = { oid: obj.oid, size: obj.size, created_at: new Date().toISOString(), uploaded: false };
        await env.GITME_KV.put(META_PREFIX + obj.oid, JSON.stringify(meta));
        responseObjects.push({
          oid: obj.oid,
          size: obj.size,
          actions: {
            upload: {
              href: await presignR2Url({
                method: 'PUT',
                key: OBJECT_PREFIX + obj.oid,
                expiresSeconds: config.signedUrlTtlSeconds,
                signing: config.r2Signing,
              }),
              expires_in: config.signedUrlTtlSeconds,
            },
          },
        });
        continue;
      }
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
    if (!head || head.size !== meta.size) {
      responseObjects.push(objectNotFound(obj));
      continue;
    }
    if (!meta.uploaded) {
      meta.uploaded = true;
      await env.GITME_KV.put(META_PREFIX + obj.oid, JSON.stringify(meta));
    }
    if (config.transferMode === 'direct' && config.r2Signing) {
      responseObjects.push({
        oid: obj.oid,
        size: meta.size,
        actions: {
          download: {
            href: await presignR2Url({
              method: 'GET',
              key: OBJECT_PREFIX + obj.oid,
              expiresSeconds: config.signedUrlTtlSeconds,
              signing: config.r2Signing,
            }),
            expires_in: config.signedUrlTtlSeconds,
          },
        },
      });
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

async function handleAdminUser(request: Request, env: Env, config: AppConfig, rawUsername: string): Promise<Response> {
  if (request.headers.get('Authorization') !== `Bearer ${config.authToken}`) return appJson(401, { message: 'authentication required' });
  const username = normalizeUsername(decodeURIComponent(rawUsername));
  if (!username) return appJson(400, { message: 'invalid username' });

  if (request.method === 'PUT') {
    let body: { password?: unknown; access?: unknown };
    try {
      body = await request.json() as { password?: unknown; access?: unknown };
    } catch {
      return appJson(400, { message: 'invalid JSON' });
    }
    if (typeof body.password !== 'string' || body.password.length < 8) return appJson(400, { message: 'password must be at least 8 characters' });
    const access = body.access === 'read' || body.access === 'write' ? body.access : '';
    if (!access) return appJson(400, { message: 'access must be read or write' });
    const record: UserRecord = { password_sha256: await sha256Hex(body.password), access, created_at: new Date().toISOString() };
    await env.GITME_KV.put(USER_PREFIX + username, JSON.stringify(record));
    return appJson(200, { username, access });
  }

  if (request.method === 'DELETE') {
    await env.GITME_KV.delete(USER_PREFIX + username);
    return appJson(200, { username, deleted: true });
  }

  return appJson(405, { message: 'method not allowed' });
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

function lfsAuthError(): Response {
  const res = lfsError(401, 'authentication required');
  res.headers.set('WWW-Authenticate', 'Basic realm="git-me"');
  return res;
}

function appJson(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body) + '\n', { status, headers: { 'Content-Type': 'application/json' } });
}

async function requireLfsAccess(request: Request, env: Env, config: AppConfig, needed: UserAccess): Promise<Response | null> {
  const auth = await authenticateLfs(request, env, config);
  if ('response' in auth) return auth.response;
  return canAccess(auth.access, needed) ? null : lfsError(403, 'forbidden');
}

async function authenticateLfs(request: Request, env: Env, config: AppConfig): Promise<{ access: UserAccess } | { response: Response }> {
  const auth = request.headers.get('Authorization') || '';
  if (auth === `Bearer ${config.authToken}`) return { access: 'write' };
  if (!auth.startsWith('Basic ')) return { response: lfsAuthError() };

  const credentials = decodeBasicAuth(auth.slice('Basic '.length));
  if (!credentials) return { response: lfsAuthError() };
  const username = normalizeUsername(credentials.username);
  if (!username) return { response: lfsAuthError() };

  const rawRecord = await env.GITME_KV.get(USER_PREFIX + username);
  const record = rawRecord ? JSON.parse(rawRecord) as UserRecord : null;
  if (!record || await sha256Hex(credentials.password) !== record.password_sha256) return { response: lfsAuthError() };
  return { access: record.access };
}

function decodeBasicAuth(encoded: string): { username: string; password: string } | null {
  try {
    const decoded = atob(encoded);
    const separator = decoded.indexOf(':');
    if (separator < 1) return null;
    return { username: decoded.slice(0, separator), password: decoded.slice(separator + 1) };
  } catch {
    return null;
  }
}

function normalizeUsername(username: string): string {
  const normalized = username.trim().toLowerCase();
  return USERNAME_RE.test(normalized) ? normalized : '';
}

function canAccess(actual: UserAccess, needed: UserAccess): boolean {
  return actual === 'write' || needed === 'read';
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
    await stream.pipeThrough(counter).pipeTo(digester);
    const digest = await digester.digest;
    return { hex: bytesToHex(new Uint8Array(digest)), size };
  }

  const buffer = await new Response(stream).arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return { hex: bytesToHex(new Uint8Array(digest)), size: buffer.byteLength };
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return bytesToHex(new Uint8Array(digest));
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}
