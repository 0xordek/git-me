import { afterEach, describe, expect, test, vi } from 'vitest';
import { LfsClient, mergeActionHeaders, type HeaderMap } from '../src/lfs-client';

const nodeImport = <T>(specifier: string): Promise<T> => import(/* @vite-ignore */ specifier) as Promise<T>;

type FsPromises = {
  mkdtemp(prefix: string): Promise<string>;
  readFile(path: string): Promise<BufferLike>;
  rm(path: string, options: { recursive: boolean; force: boolean }): Promise<void>;
  writeFile(path: string, data: string | Uint8Array): Promise<void>;
};
type Os = { tmpdir(): string };
type Path = { join(...parts: string[]): string };
type BufferLike = { toString(encoding?: string): string; byteLength: number };

const objects = [{ oid: 'a'.repeat(64), size: 3 }];
const originalFetch = globalThis.fetch;
const tempDirs: string[] = [];

afterEach(async () => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
  const fs = await nodeImport<FsPromises>('node:fs/promises');
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function createTempFile(name: string, contents = ''): Promise<{ fs: FsPromises; path: string }> {
  const [fs, os, pathModule] = await Promise.all([
    nodeImport<FsPromises>('node:fs/promises'),
    nodeImport<Os>('node:os'),
    nodeImport<Path>('node:path'),
  ]);
  const dir = await fs.mkdtemp(pathModule.join(os.tmpdir(), 'git-me-lfs-client-'));
  tempDirs.push(dir);
  const path = pathModule.join(dir, name);
  if (contents.length > 0) await fs.writeFile(path, contents);
  return { fs, path };
}

function mockFetch(response: Response): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => response);
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function requestHeaders(init: RequestInit | undefined): Headers {
  return new Headers(init?.headers);
}

describe('mergeActionHeaders', () => {
  test('lets action headers override base headers', () => {
    expect(mergeActionHeaders({ Authorization: 'Bearer base', Accept: 'application/json' }, { Authorization: 'Bearer action' })).toEqual({
      Authorization: 'Bearer action',
      Accept: 'application/json',
    });
  });
});

describe('LfsClient.batch', () => {
  test.each([
    ['https://host', 'https://host/objects/batch'],
    ['https://host/custom', 'https://host/custom/objects/batch'],
  ])('posts to normalized batch URL for %s', async (baseUrl, expectedUrl) => {
    const fetchMock = mockFetch(Response.json({ transfer: 'basic', objects: [] }));

    await new LfsClient({ baseUrl }).batch('upload', objects);

    expect(fetchMock).toHaveBeenCalledWith(expectedUrl, expect.objectContaining({ method: 'POST' }));
  });

  test('sends LFS JSON headers and configured auth headers', async () => {
    const fetchMock = mockFetch(Response.json({ transfer: 'basic', objects: [] }));

    await new LfsClient({ baseUrl: 'https://host', headers: { Authorization: 'Bearer token', 'X-Trace': '1' } }).batch('download', objects);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = requestHeaders(init);
    expect(headers.get('Content-Type')).toBe('application/vnd.git-lfs+json');
    expect(headers.get('Accept')).toBe('application/vnd.git-lfs+json');
    expect(headers.get('Authorization')).toBe('Bearer token');
    expect(headers.get('X-Trace')).toBe('1');
    expect(JSON.parse(String(init.body))).toEqual({ operation: 'download', transfers: ['basic'], objects });
  });

  test('throws on non-2xx with status and body snippet', async () => {
    mockFetch(new Response('server exploded: ' + 'x'.repeat(300), { status: 503 }));

    await expect(new LfsClient({ baseUrl: 'https://host' }).batch('upload', objects)).rejects.toThrow(/503.*server exploded/s);
  });
});

describe('LfsClient file transfers', () => {
  test('downloadToFile streams response bytes to path', async () => {
    const { fs, path } = await createTempFile('download.bin');
    mockFetch(new Response(new Uint8Array([1, 2, 3]).buffer));

    await new LfsClient({ baseUrl: 'https://host', headers: { Authorization: 'Bearer base' } }).downloadToFile('https://host/objects/1', path, { 'X-Action': 'yes' });

    expect((await fs.readFile(path)).toString()).toBe('\x01\x02\x03');
  });

  test('downloadToFile omits base auth headers for cross-origin action URLs', async () => {
    const { path } = await createTempFile('download.bin');
    const fetchMock = mockFetch(new Response(new Uint8Array([1]).buffer));

    await new LfsClient({ baseUrl: 'https://lfs.example/repo', headers: { Authorization: 'Bearer base', 'X-Source': 'base' } }).downloadToFile('https://storage.example/object', path, { Authorization: 'Bearer action', 'X-Action': 'yes' });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = requestHeaders(init);
    expect(headers.get('Authorization')).toBe('Bearer action');
    expect(headers.get('X-Source')).toBeNull();
    expect(headers.get('X-Action')).toBe('yes');
  });

  test('uploadFromFile sends PUT with file body', async () => {
    const { path } = await createTempFile('upload.bin', 'payload');
    const fetchMock = mockFetch(new Response(null, { status: 200 }));

    await new LfsClient({ baseUrl: 'https://host', headers: { Authorization: 'Bearer base' } }).uploadFromFile('https://host/objects/1', path, { 'X-Action': 'yes' });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = requestHeaders(init);
    expect(url).toBe('https://host/objects/1');
    expect(init.method).toBe('PUT');
    expect(headers.get('Authorization')).toBe('Bearer base');
    expect(headers.get('X-Action')).toBe('yes');
    expect(headers.get('Content-Length')).toBe('7');
    expect(init.body).not.toBe('payload');
    expect(init.body).toBeTruthy();
  });

  test('uploadFromFile omits base auth headers for cross-origin action URLs', async () => {
    const { path } = await createTempFile('upload.bin', 'payload');
    const fetchMock = mockFetch(new Response(null, { status: 200 }));

    await new LfsClient({ baseUrl: 'https://lfs.example/repo', headers: { Authorization: 'Bearer base', 'X-Source': 'base' } }).uploadFromFile('https://storage.example/object', path, { Authorization: 'Bearer action', 'X-Action': 'yes' });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = requestHeaders(init);
    expect(headers.get('Authorization')).toBe('Bearer action');
    expect(headers.get('X-Source')).toBeNull();
    expect(headers.get('X-Action')).toBe('yes');
    expect(headers.get('Content-Length')).toBe('7');
  });
});
