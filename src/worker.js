const LFS_CONTENT_TYPE = 'application/vnd.git-lfs+json';
const OBJECT_PREFIX = 'objects/';
const META_PREFIX = 'object:';
const OID_RE = /^[0-9a-fA-F]{64}$/;

export default {
  async fetch(request, env) {
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
        if (request.method === 'GET') return handleDownload(request, env, oid);
        return lfsError(405, 'method not allowed');
      }
      return new Response('not found\n', { status: 404 });
    } catch (err) {
      return lfsError(500, 'internal server error');
    }
  },
};

async function handleBatch(request, env) {
  if (request.method !== 'POST') return lfsError(405, 'method not allowed');
  if (!isLfsContentType(request.headers.get('Content-Type'))) {
    return lfsError(415, 'content type must be ' + LFS_CONTENT_TYPE);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return lfsError(400, 'invalid JSON');
  }

  const transfer = selectTransfer(body.transfers);
  if (!transfer) return lfsError(400, 'unsupported transfer adapter');
  if (body.operation !== 'upload' && body.operation !== 'download') {
    return lfsError(400, 'lfs: unknown batch operation: ' + body.operation);
  }
  if (!Array.isArray(body.objects)) return lfsError(400, 'objects must be an array');

  for (const obj of body.objects) {
    const validation = validateObject(obj);
    if (validation) return lfsError(400, validation);
  }

  const objects = [];
  for (const obj of body.objects) {
    if (body.operation === 'upload') {
      objects.push({ oid: obj.oid, size: obj.size, actions: { upload: { href: `/objects/${obj.oid}` } } });
      continue;
    }

    const metaText = await env.GITME_KV.get(META_PREFIX + obj.oid);
    if (!metaText) {
      objects.push(objectNotFound(obj));
      continue;
    }
    const meta = JSON.parse(metaText);
    const head = await env.GITME_R2.head(OBJECT_PREFIX + obj.oid);
    if (!meta.uploaded || !head) {
      objects.push(objectNotFound(obj));
      continue;
    }
    objects.push({ oid: obj.oid, size: meta.size, actions: { download: { href: `/objects/${obj.oid}` } } });
  }

  return json(200, { transfer, objects });
}

async function handleUpload(request, env, oid) {
  if (!OID_RE.test(oid)) return lfsError(400, 'invalid oid');
  if (!request.body) return lfsError(400, 'missing request body');

  const [storeStream, digestStream] = request.body.tee();
  const putPromise = env.GITME_R2.put(OBJECT_PREFIX + oid, storeStream);
  const digest = await digestAndCount(digestStream);
  await putPromise;

  if (digest.hex.toLowerCase() !== oid.toLowerCase()) {
    await env.GITME_R2.delete(OBJECT_PREFIX + oid);
    return lfsError(400, 'upload hash mismatch');
  }

  const meta = { oid, size: digest.size, created_at: new Date().toISOString(), uploaded: true };
  await env.GITME_KV.put(META_PREFIX + oid, JSON.stringify(meta));
  return new Response(null, { status: 200 });
}

async function handleDownload(request, env, oid) {
  if (!OID_RE.test(oid)) return lfsError(400, 'invalid oid');
  const metaText = await env.GITME_KV.get(META_PREFIX + oid);
  if (!metaText) return lfsError(404, 'object not found');
  const meta = JSON.parse(metaText);
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

function isLfsContentType(contentType) {
  return (contentType || '').split(';', 1)[0].trim().toLowerCase() === LFS_CONTENT_TYPE;
}

function selectTransfer(transfers) {
  if (transfers == null) return 'basic';
  if (!Array.isArray(transfers)) return '';
  if (transfers.length === 0) return 'basic';
  return transfers.includes('basic') ? 'basic' : '';
}

function validateObject(obj) {
  if (!obj || !OID_RE.test(obj.oid || '')) return 'invalid oid';
  if (!Number.isInteger(obj.size) || obj.size < 0) return 'object size must not be negative';
  return '';
}

function objectNotFound(obj) {
  return { oid: obj.oid, size: obj.size, error: { code: 404, message: 'object not found' } };
}

function json(status, body) {
  return new Response(JSON.stringify(body) + '\n', { status, headers: { 'Content-Type': LFS_CONTENT_TYPE } });
}

function lfsError(status, message) {
  return json(status, { message });
}

async function digestAndCount(stream) {
  if (typeof DigestStream === 'function') {
    let size = 0;
    const counter = new TransformStream({
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

function bytesToHex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}
