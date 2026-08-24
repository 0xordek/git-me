import type { R2SigningConfig } from './config';

export type PresignR2UrlInput = {
  method: 'GET' | 'PUT';
  key: string;
  expiresSeconds: number;
  signing: R2SigningConfig;
  headers?: Record<string, string>;
  now?: Date;
};

const ALGORITHM = 'AWS4-HMAC-SHA256';
const REGION = 'auto';
const SERVICE = 's3';
const TERMINATOR = 'aws4_request';
const PAYLOAD_HASH = 'UNSIGNED-PAYLOAD';

export async function presignR2Url(input: PresignR2UrlInput): Promise<string> {
  const now = input.now ?? new Date();
  const amzDate = formatAmzDate(now);
  const dateStamp = amzDate.slice(0, 8);
  const credentialScope = `${dateStamp}/${REGION}/${SERVICE}/${TERMINATOR}`;
  const host = `${input.signing.accountId}.r2.cloudflarestorage.com`;
  const canonicalUri = `/${encodePathSegment(input.signing.bucketName)}/${encodePath(input.key)}`;
  const headers = new Map<string, string>([['host', host]]);
  for (const [name, value] of Object.entries(input.headers ?? {})) {
    const normalizedName = name.trim().toLowerCase();
    if (!normalizedName || normalizedName === 'host') throw new Error('invalid signed header');
    headers.set(normalizedName, value.trim().replace(/\s+/g, ' '));
  }
  const canonicalHeaderEntries = [...headers].sort(([a], [b]) => compareAscii(a, b));
  const canonicalHeaders = canonicalHeaderEntries.map(([name, value]) => `${name}:${value}\n`).join('');
  const signedHeaders = canonicalHeaderEntries.map(([name]) => name).join(';');

  const query: Array<[string, string]> = [
    ['X-Amz-Algorithm', ALGORITHM],
    ['X-Amz-Content-Sha256', PAYLOAD_HASH],
    ['X-Amz-Credential', `${input.signing.accessKeyId}/${credentialScope}`],
    ['X-Amz-Date', amzDate],
    ['X-Amz-Expires', String(input.expiresSeconds)],
    ['X-Amz-SignedHeaders', signedHeaders],
  ];
  const canonicalQuery = canonicalQueryString(query);
  const canonicalRequest = [
    input.method,
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    PAYLOAD_HASH,
  ].join('\n');
  const stringToSign = [ALGORITHM, amzDate, credentialScope, await sha256Hex(canonicalRequest)].join('\n');
  const signingKey = await deriveSigningKey(input.signing.secretAccessKey, dateStamp);
  const signature = await hmacHex(signingKey, stringToSign);

  return `https://${host}${canonicalUri}?${canonicalQueryString([...query, ['X-Amz-Signature', signature]])}`;
}

function canonicalQueryString(query: Array<[string, string]>): string {
  return query
    .map(([key, value]) => [encodeQueryPart(key), encodeQueryPart(value)] as const)
    .sort(([ak, av], [bk, bv]) => compareAscii(ak, bk) || compareAscii(av, bv))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
}

function compareAscii(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function encodePath(path: string): string {
  return path.split('/').map(encodePathSegment).join('/');
}

function encodePathSegment(segment: string): string {
  return encodeQueryPart(segment);
}

function encodeQueryPart(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) => '%' + char.charCodeAt(0).toString(16).toUpperCase());
}

function formatAmzDate(date: Date): string {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, '');
}

async function deriveSigningKey(secretAccessKey: string, dateStamp: string): Promise<CryptoKey> {
  const dateKey = await hmacBytes(textBytes('AWS4' + secretAccessKey), dateStamp);
  const regionKey = await hmacBytes(dateKey, REGION);
  const serviceKey = await hmacBytes(regionKey, SERVICE);
  const signingKeyBytes = await hmacBytes(serviceKey, TERMINATOR);
  return importHmacKey(signingKeyBytes);
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', toArrayBuffer(textBytes(value)));
  return bytesToHex(new Uint8Array(digest));
}

async function hmacBytes(keyBytes: Uint8Array, value: string): Promise<Uint8Array> {
  const key = await importHmacKey(keyBytes);
  const signature = await crypto.subtle.sign('HMAC', key, toArrayBuffer(textBytes(value)));
  return new Uint8Array(signature);
}

async function hmacHex(key: CryptoKey, value: string): Promise<string> {
  const signature = await crypto.subtle.sign('HMAC', key, toArrayBuffer(textBytes(value)));
  return bytesToHex(new Uint8Array(signature));
}

function importHmacKey(keyBytes: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', toArrayBuffer(keyBytes), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

function textBytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
