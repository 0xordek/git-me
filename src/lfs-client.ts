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
const nodeImport = <T>(specifier: string): Promise<T> => import(/* @vite-ignore */ specifier) as Promise<T>;

type FsModule = {
  createReadStream(path: string): unknown;
  createWriteStream(path: string): unknown;
};
type StreamModule = { Readable: { fromWeb(stream: ReadableStream<Uint8Array>): unknown } };
type StreamPromises = { pipeline(source: unknown, destination: unknown): Promise<void> };

export function mergeActionHeaders(base: HeaderMap, actionHeaders?: HeaderMap): HeaderMap {
  return { ...base, ...(actionHeaders ?? {}) };
}

export class LfsClient {
  private readonly baseUrl: string;
  private readonly headers: HeaderMap;

  constructor(options: { baseUrl: string; headers?: HeaderMap }) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.headers = options.headers ?? {};
  }

  async batch(operation: 'upload' | 'download', objects: LfsObject[]): Promise<LfsBatchResponse> {
    const response = await fetch(`${this.baseUrl}/objects/batch`, {
      method: 'POST',
      headers: { ...this.headers, 'Content-Type': LFS_JSON, Accept: LFS_JSON },
      body: JSON.stringify({ operation, transfers: ['basic'], objects }),
    });

    await throwIfFailed(response, 'LFS batch');
    return await response.json() as LfsBatchResponse;
  }

  async downloadToFile(href: string, filePath: string, headers?: HeaderMap): Promise<void> {
    const response = await fetch(href, { method: 'GET', headers: mergeActionHeaders(this.headers, headers) });
    await throwIfFailed(response, 'LFS download');
    if (!response.body) throw new Error('LFS download failed: response body missing');

    const [fs, stream, streamPromises] = await Promise.all([
      nodeImport<FsModule>('node:fs'),
      nodeImport<StreamModule>('node:stream'),
      nodeImport<StreamPromises>('node:stream/promises'),
    ]);

    await streamPromises.pipeline(stream.Readable.fromWeb(response.body), fs.createWriteStream(filePath));
  }

  async uploadFromFile(href: string, filePath: string, headers?: HeaderMap): Promise<void> {
    const fs = await nodeImport<FsModule>('node:fs');
    const init = {
      method: 'PUT',
      headers: mergeActionHeaders(this.headers, headers),
      body: fs.createReadStream(filePath) as BodyInit,
      duplex: 'half',
    } as RequestInit;

    const response = await fetch(href, init);
    await throwIfFailed(response, 'LFS upload');
  }
}

async function throwIfFailed(response: Response, label: string): Promise<void> {
  if (response.ok) return;

  const body = await response.text().catch(() => '');
  const snippet = body.slice(0, ERROR_SNIPPET_BYTES);
  throw new Error(`${label} failed with status ${response.status}: ${snippet}`);
}
