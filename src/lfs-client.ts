import { createReadStream, createWriteStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { assertSafeUrl } from './url';

export type LfsObject = { oid: string; size: number };
export type HeaderMap = Record<string, string>;

export type LfsAction = {
  href: string;
  header?: HeaderMap;
  expires_in?: number;
  expires_at?: string;
};
export type LfsBatchObject = LfsObject & {
  actions?: { upload?: LfsAction; download?: LfsAction; verify?: LfsAction };
  error?: { code: number; message: string };
};
export type LfsBatchResponse = {
  transfer?: string;
  objects: LfsBatchObject[];
  hash_algo?: string;
};

const LFS_JSON = 'application/vnd.git-lfs+json';
const ERROR_SNIPPET_BYTES = 200;

export function mergeActionHeaders(base: HeaderMap, actionHeaders?: HeaderMap): HeaderMap {
  const result: HeaderMap = {};
  for (const [name, value] of Object.entries(base)) setHeader(result, name, value);
  for (const [name, value] of Object.entries(actionHeaders ?? {})) setHeader(result, name, value);
  return result;
}

export class LfsClient {
  private readonly baseUrl: string;
  private readonly baseOrigin: string;
  private readonly headers: HeaderMap;

  constructor(options: { baseUrl: string; headers?: HeaderMap }) {
    assertSafeUrl(options.baseUrl, Object.keys(options.headers ?? {}).length > 0);
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.baseOrigin = new URL(this.baseUrl).origin;
    this.headers = options.headers ?? {};
  }

  async batch(operation: 'upload' | 'download', objects: LfsObject[]): Promise<LfsBatchResponse> {
    const response = await fetch(`${this.baseUrl}/objects/batch`, {
      method: 'POST',
      headers: { ...this.headers, 'Content-Type': LFS_JSON, Accept: LFS_JSON },
      body: JSON.stringify({ operation, transfers: ['basic'], objects }),
    });

    await throwIfFailed(response, 'LFS batch');
    const body: unknown = await response.json();
    if (!isBatchResponse(body)) throw new Error('LFS batch response malformed');
    return body;
  }

  async downloadToFile(href: string, filePath: string, headers?: HeaderMap): Promise<void> {
    const response = await fetch(href, { method: 'GET', headers: this.actionHeaders(href, headers) });
    await throwIfFailed(response, 'LFS download');
    if (!response.body) throw new Error('LFS download failed: response body missing');
    await pipeline(Readable.fromWeb(response.body as NodeReadableStream), createWriteStream(filePath, { flags: 'wx', mode: 0o600 }));
  }

  async uploadFromFile(href: string, filePath: string, headers?: HeaderMap): Promise<void> {
    const size = (await stat(filePath)).size;
    const init = {
      method: 'PUT',
      headers: { ...this.actionHeaders(href, headers), 'Content-Length': String(size) },
      body: createReadStream(filePath) as never,
      duplex: 'half',
    } as RequestInit;

    const response = await fetch(href, init);
    await throwIfFailed(response, 'LFS upload');
  }

  private actionHeaders(href: string, headers?: HeaderMap): HeaderMap {
    const actionOrigin = new URL(href, this.baseUrl).origin;
    const result = actionOrigin === this.baseOrigin ? mergeActionHeaders(this.headers, headers) : headers ?? {};
    assertSafeUrl(new URL(href, this.baseUrl).href, true);
    return result;
  }
}

async function throwIfFailed(response: Response, label: string): Promise<void> {
  if (response.ok) return;
  const body = await response.text().catch(() => '');
  throw new Error(`${label} failed with status ${response.status}: ${body.slice(0, ERROR_SNIPPET_BYTES)}`);
}

function setHeader(headers: HeaderMap, name: string, value: string): void {
  const existing = Object.keys(headers).find((key) => key.toLowerCase() === name.toLowerCase());
  if (existing) delete headers[existing];
  headers[name] = value;
}

function isBatchResponse(value: unknown): value is LfsBatchResponse {
  return isRecord(value)
    && (value.transfer === undefined || typeof value.transfer === 'string')
    && Array.isArray(value.objects)
    && value.objects.every(isBatchObject);
}

function isBatchObject(value: unknown): value is LfsBatchObject {
  if (!isRecord(value) || typeof value.oid !== 'string' || typeof value.size !== 'number') return false;
  if (value.error !== undefined && (!isRecord(value.error) || typeof value.error.code !== 'number' || typeof value.error.message !== 'string')) return false;
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
