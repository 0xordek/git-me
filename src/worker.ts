import { ConfigError, healthResponse, loadConfig } from './config';
import type { AppConfig } from './config';
import { presignR2Url } from './signing';

const LFS_CONTENT_TYPE = 'application/vnd.git-lfs+json';
const OBJECT_PREFIX = 'objects/';
const META_PREFIX = 'object:';
const OID_RE = /^[0-9a-fA-F]{64}$/;

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
      const auth = request.headers.get('Authorization') || '';
      if (auth !== `Bearer ${config.authToken}`) {
        return lfsError(401, 'authentication required');
      }

      if (url.pathname === '/objects/batch') {
        return handleBatch(request, env, config);
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

async function handleBatch(request: Request, env: Env, config: AppConfig): Promise<Response> {
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
        if (existingMeta?.uploaded && existingHead?.size === obj.size) {
          responseObjects.push({ oid: obj.oid, size: obj.size });
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
    await stream.pipeThrough(counter).pipeTo(digester);
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
