import { ConfigError, healthResponse, loadConfig } from './config';
import type { AppConfig } from './config';
import { presignR2Url } from './signing';
import { authenticateUser, createUser, deleteUser, listUsers, type UserAccess } from './auth';
import { createDigestStream, timingSafeEqual } from './crypto';

export { AuthUser } from './auth-do';

const LFS_CONTENT_TYPE = 'application/vnd.git-lfs+json';
const OBJECT_PREFIX = 'objects/';
const OID_RE = /^[0-9a-fA-F]{64}$/;
const USERNAME_RE = /^[a-z0-9][a-z0-9_.-]{0,62}$/;

export interface Env extends CloudflareBindings {
  GITME_AUTH_TOKEN?: string;
  GITME_TRANSFER_MODE?: string;
  GITME_SIGNED_URL_TTL_SECONDS?: string;
  GITME_R2_ACCOUNT_ID?: string;
  GITME_R2_ACCESS_KEY_ID?: string;
  GITME_R2_SECRET_ACCESS_KEY?: string;
  GITME_R2_BUCKET_NAME?: string;
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

type DigestResult = {
  hex: string;
  size: number;
};

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const requestId = crypto.randomUUID();
    let path = '';
    try {
      const url = new URL(request.url);
      path = url.pathname;
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
      if (url.pathname === '/admin/users') return await handleAdminUsers(request, env, config);
      if (url.pathname.startsWith('/admin/users/')) return await handleAdminUser(request, env, config, url.pathname.slice('/admin/users/'.length));

      if (url.pathname === '/objects/batch') {
        return await handleBatch(request, env, config);
      }
      if (url.pathname.startsWith('/objects/')) {
        const oid = url.pathname.slice('/objects/'.length);
        if (request.method === 'PUT') {
          const auth = await requireLfsAccess(request, env, config, 'write');
          if (auth) return auth;
          return await handleUpload(request, env, oid);
        }
        if (request.method === 'GET') {
          const auth = await requireLfsAccess(request, env, config, 'read');
          if (auth) return auth;
          return await handleDownload(env, oid);
        }
        return lfsError(405, 'method not allowed');
      }
      return new Response('not found\n', { status: 404 });
    } catch (error) {
      console.error(JSON.stringify({
        message: 'git-me request failed',
        requestId,
        method: request.method,
        path,
        error: error instanceof Error ? error.message : String(error),
      }));
      const response = lfsError(500, 'internal server error');
      response.headers.set('X-Request-Id', requestId);
      return response;
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
      const existing = await env.GITME_R2.head(OBJECT_PREFIX + obj.oid);
      if (existing?.customMetadata?.sha256 === obj.oid.toLowerCase()) {
        responseObjects.push(existing.size === obj.size ? { oid: obj.oid, size: obj.size } : objectConflict(obj));
        continue;
      }
      responseObjects.push({ oid: obj.oid, size: obj.size, actions: { upload: { href } } });
      continue;
    }

    const head = await env.GITME_R2.head(OBJECT_PREFIX + obj.oid);
    if (!head || head.size !== obj.size) {
      responseObjects.push(objectNotFound(obj));
      continue;
    }
    if (config.transferMode === 'direct' && config.r2Signing) {
      if (head.customMetadata?.sha256 !== obj.oid.toLowerCase()) {
        responseObjects.push({ oid: obj.oid, size: head.size, actions: { download: { href } } });
        continue;
      }
      responseObjects.push({
        oid: obj.oid,
        size: head.size,
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
    responseObjects.push({ oid: obj.oid, size: head.size, actions: { download: { href } } });
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
  let operationFailed = false;
  try {
    const [stored, digested] = await Promise.allSettled([putPromise, digestAndCount(digestStream)]);
    if (stored.status === 'rejected') throw stored.reason;
    if (digested.status === 'rejected') throw digested.reason;
    if (digested.value.hex.toLowerCase() !== oid.toLowerCase()) return lfsError(400, 'upload hash mismatch');
    const declaredSize = request.headers.get('Content-Length');
    if (declaredSize !== null && Number(declaredSize) !== digested.value.size) return lfsError(400, 'upload size mismatch');

    const tempObject = await env.GITME_R2.get(tempKey);
    if (!tempObject?.body) throw new Error('temporary upload missing');
    await env.GITME_R2.put(objectKey, tempObject.body, { customMetadata: { sha256: oid.toLowerCase() } });
    return new Response(null, { status: 200 });
  } catch (error) {
    operationFailed = true;
    throw error;
  } finally {
    try {
      await env.GITME_R2.delete(tempKey);
    } catch (error) {
      console.error(JSON.stringify({ message: 'temporary upload cleanup failed', key: tempKey, error: error instanceof Error ? error.message : String(error) }));
      if (!operationFailed) throw error;
    }
  }
}

async function handleAdminUser(request: Request, env: Env, config: AppConfig, rawUsername: string): Promise<Response> {
  if (!await bearerMatches(request, config.authToken)) return appJson(401, { message: 'authentication required' });
  let username = '';
  try {
    username = normalizeUsername(decodeURIComponent(rawUsername));
  } catch {
    return appJson(400, { message: 'invalid username' });
  }
  if (!username) return appJson(400, { message: 'invalid username' });

  if (request.method === 'PUT') {
    let body: { password?: unknown; access?: unknown };
    try {
      body = await request.json() as { password?: unknown; access?: unknown };
    } catch {
      return appJson(400, { message: 'invalid JSON' });
    }
    if (typeof body.password !== 'string' || body.password.length < 12 || body.password.length > 1024) return appJson(400, { message: 'password must be between 12 and 1024 characters' });
    const access = body.access === 'read' || body.access === 'write' ? body.access : '';
    if (!access) return appJson(400, { message: 'access must be read or write' });
    await createUser(env, username, body.password, access);
    return appJson(200, { username, access });
  }

  if (request.method === 'DELETE') {
    await deleteUser(env, username);
    return appJson(200, { username, deleted: true });
  }

  return appJson(405, { message: 'method not allowed' });
}

async function handleAdminUsers(request: Request, env: Env, config: AppConfig): Promise<Response> {
  if (!await bearerMatches(request, config.authToken)) return appJson(401, { message: 'authentication required' });
  if (request.method !== 'GET') return appJson(405, { message: 'method not allowed' });
  return appJson(200, { users: await listUsers(env) });
}

async function handleDownload(env: Env, oid: string): Promise<Response> {
  if (!OID_RE.test(oid)) return lfsError(400, 'invalid oid');
  const object = await env.GITME_R2.get(OBJECT_PREFIX + oid);
  if (!object) return lfsError(404, 'object not found');

  return new Response(object.body, {
    status: 200,
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(object.size),
    },
  });
}

function isLfsOperation(operation: unknown): operation is LfsOperation {
  return operation === 'upload' || operation === 'download';
}

function isLfsContentType(contentType: string | null): boolean {
  return ((contentType || '').split(';', 1)[0] ?? '').trim().toLowerCase() === LFS_CONTENT_TYPE;
}

function selectTransfer(transfers: unknown): string {
  if (transfers == null) return 'basic';
  if (!Array.isArray(transfers)) return '';
  if (transfers.length === 0) return 'basic';
  return transfers.includes('basic') ? 'basic' : '';
}

function validateObject(obj: unknown): string {
  if (!isObjectRecord(obj) || !OID_RE.test(String(obj.oid || ''))) return 'invalid oid';
  if (!Number.isSafeInteger(obj.size) || obj.size < 0) return 'object size must be a non-negative safe integer';
  return '';
}

function isObjectRecord(value: unknown): value is LfsBatchObject {
  return typeof value === 'object' && value !== null && 'oid' in value && 'size' in value;
}

function objectNotFound(obj: LfsBatchObject): object {
  return { oid: obj.oid, size: obj.size, error: { code: 404, message: 'object not found' } };
}

function objectConflict(obj: LfsBatchObject): object {
  return { oid: obj.oid, size: obj.size, error: { code: 409, message: 'object size mismatch' } };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body) + '\n', { status, headers: { 'Content-Type': LFS_CONTENT_TYPE } });
}

function lfsError(status: number, message: string): Response {
  return json(status, { message });
}

function lfsAuthError(): Response {
  const res = lfsError(401, 'authentication required');
  res.headers.set('WWW-Authenticate', 'Basic realm="git-me", charset="UTF-8"');
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
  if (await secureTextEqual(auth, `Bearer ${config.authToken}`)) return { access: 'write' };
  if (!auth.startsWith('Basic ')) return { response: lfsAuthError() };

  const credentials = decodeBasicAuth(auth.slice('Basic '.length));
  if (!credentials) return { response: lfsAuthError() };
  const username = normalizeUsername(credentials.username);
  if (!username) return { response: lfsAuthError() };

  const result = await authenticateUser(env, username, credentials.password, clientSource(request));
  if (!result.ok || !result.access) return { response: lfsAuthError() };
  return { access: result.access };
}

function decodeBasicAuth(encoded: string): { username: string; password: string } | null {
  try {
    const bytes = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
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

function clientSource(request: Request): string {
  const source = request.headers.get('CF-Connecting-IP') || 'unknown';
  return /^[0-9a-fA-F:.]{1,45}$/.test(source) ? source : 'unknown';
}

function canAccess(actual: UserAccess, needed: UserAccess): boolean {
  return actual === 'write' || needed === 'read';
}

async function digestAndCount(stream: ReadableStream<Uint8Array>): Promise<DigestResult> {
  const digester = createDigestStream('SHA-256');
  await stream.pipeTo(digester);
  return { hex: bytesToHex(new Uint8Array(await digester.digest)), size: Number(digester.bytesWritten) };
}

async function bearerMatches(request: Request, token: string): Promise<boolean> {
  return await secureTextEqual(request.headers.get('Authorization') || '', `Bearer ${token}`);
}

async function secureTextEqual(left: string, right: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [leftHash, rightHash] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(left)),
    crypto.subtle.digest('SHA-256', encoder.encode(right)),
  ]);
  return timingSafeEqual(leftHash, rightHash);
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}
