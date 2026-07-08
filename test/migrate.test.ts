import { afterEach, describe, expect, test, vi } from 'vitest';
import { migrate, type MigrateDeps } from '../src/migrate';
import type { HeaderMap, LfsBatchResponse, LfsObject } from '../src/lfs-client';
import type { LfsPointer } from '../src/pointers';

const nodeImport = <T>(specifier: string): Promise<T> => import(/* @vite-ignore */ specifier) as Promise<T>;

type FsPromises = {
  access(path: string): Promise<void>;
  mkdtemp(prefix: string): Promise<string>;
  rm(path: string, options: { recursive: boolean; force: boolean }): Promise<void>;
  writeFile(path: string, data: Uint8Array | string): Promise<void>;
};
type Os = { tmpdir(): string };
type Path = { join(...parts: string[]): string };

const tempDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  const fs = await nodeImport<FsPromises>('node:fs/promises');
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function pointer(oid: string, size: number, path = `${oid.slice(0, 6)}.bin`): LfsPointer {
  return { oid, size, path };
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function tempPrefix(): Promise<string> {
  const [fs, os, path] = await Promise.all([nodeImport<FsPromises>('node:fs/promises'), nodeImport<Os>('node:os'), nodeImport<Path>('node:path')]);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'git-me-migrate-test-'));
  tempDirs.push(dir);
  return path.join(dir, 'object-');
}

function fakeDeps(pointers: LfsPointer[], clients: FakeLfsClient[], overrides: Partial<MigrateDeps> = {}): MigrateDeps {
  return {
    scanPointers: vi.fn(async () => pointers),
    createClient: vi.fn(({ baseUrl }) => {
      const client = clients.shift();
      if (!client) throw new Error(`unexpected client for ${baseUrl}`);
      return client;
    }),
    createTempPath: vi.fn(async () => `${await tempPrefix()}${crypto.randomUUID()}`),
    removeFile: vi.fn(async (path) => {
      const fs = await nodeImport<FsPromises>('node:fs/promises');
      await fs.rm(path, { recursive: false, force: true });
    }),
    getGitConfig: vi.fn(async () => 'https://source.example/lfs'),
    setGitConfig: vi.fn(async () => undefined),
    ...overrides,
  };
}

class FakeLfsClient {
  batchCalls: Array<{ operation: 'upload' | 'download'; objects: LfsObject[] }> = [];
  downloads: Array<{ href: string; filePath: string; headers?: HeaderMap }> = [];
  uploads: Array<{ href: string; filePath: string; headers?: HeaderMap }> = [];

  constructor(
    private readonly responses: Partial<Record<'upload' | 'download', LfsBatchResponse[]>>,
    private readonly bytes?: Uint8Array,
  ) {}

  async batch(operation: 'upload' | 'download', objects: LfsObject[]): Promise<LfsBatchResponse> {
    this.batchCalls.push({ operation, objects });
    const response = this.responses[operation]?.shift();
    if (!response) throw new Error(`missing ${operation} batch response`);
    return response;
  }

  async downloadToFile(href: string, filePath: string, headers?: HeaderMap): Promise<void> {
    this.downloads.push({ href, filePath, headers });
    const fs = await nodeImport<FsPromises>('node:fs/promises');
    await fs.writeFile(filePath, this.bytes ?? new Uint8Array());
  }

  async uploadFromFile(href: string, filePath: string, headers?: HeaderMap): Promise<void> {
    this.uploads.push({ href, filePath, headers });
  }
}

describe('migrate', () => {
  test('dry-run deduplicates pointer oids without LFS calls or config writes', async () => {
    const oid = 'a'.repeat(64);
    const source = new FakeLfsClient({});
    const target = new FakeLfsClient({});
    const deps = fakeDeps([pointer(oid, 3, 'one.bin'), pointer(oid, 3, 'two.bin')], [source, target]);

    await expect(migrate({
      repoPath: '/repo',
      sourceUrl: 'https://source.example/lfs',
      sourceHeaders: {},
      targetUrl: 'https://target.example/lfs',
      targetToken: 'target-token',
      concurrency: 4,
      dryRun: true,
      writeConfig: true,
    }, deps)).resolves.toEqual({ scanned: 2, unique: 1, migrated: 0, skipped: 1, failed: [] });

    expect(source.batchCalls).toEqual([]);
    expect(target.batchCalls).toEqual([]);
    expect(deps.createClient).not.toHaveBeenCalled();
    expect(deps.getGitConfig).not.toHaveBeenCalled();
    expect(deps.setGitConfig).not.toHaveBeenCalled();
  });

  test('dry-run does not need sourceUrl or git config lfs.url', async () => {
    const oid = 'c'.repeat(64);
    const deps = fakeDeps([pointer(oid, 5)], [], { getGitConfig: vi.fn(async () => { throw new Error('lfs.url missing'); }) });

    await expect(migrate({
      repoPath: '/repo',
      sourceHeaders: {},
      targetUrl: 'https://target.example/lfs',
      targetToken: 'target-token',
      concurrency: 4,
      dryRun: true,
      writeConfig: false,
    }, deps)).resolves.toEqual({ scanned: 1, unique: 1, migrated: 0, skipped: 0, failed: [] });

    expect(deps.getGitConfig).not.toHaveBeenCalled();
    expect(deps.createClient).not.toHaveBeenCalled();
  });

  test('downloads, verifies, uploads, then checks target download action', async () => {
    const bytes = new TextEncoder().encode('payload');
    const oid = await sha256Hex(bytes);
    const object = { oid, size: bytes.byteLength };
    const source = new FakeLfsClient({ download: [{ objects: [{ ...object, actions: { download: { href: 'https://source/object', header: { 'X-Source': '1' } } } }] }] }, bytes);
    const target = new FakeLfsClient({
      upload: [{ objects: [{ ...object, actions: { upload: { href: 'https://target/upload', header: { 'X-Upload': '1' } } } }] }],
      download: [{ objects: [{ ...object, actions: { download: { href: 'https://target/download' } } }] }],
    });
    const deps = fakeDeps([pointer(oid, bytes.byteLength)], [source, target]);

    await expect(migrate({
      repoPath: '/repo',
      sourceUrl: 'https://source.example/lfs',
      sourceHeaders: { Authorization: 'Bearer source' },
      targetUrl: 'https://target.example/lfs',
      targetToken: 'target-token',
      concurrency: 1,
      dryRun: false,
      writeConfig: false,
    }, deps)).resolves.toEqual({ scanned: 1, unique: 1, migrated: 1, skipped: 0, failed: [] });

    expect(source.batchCalls).toEqual([{ operation: 'download', objects: [object] }]);
    expect(source.downloads).toEqual([{ href: 'https://source/object', filePath: expect.any(String), headers: { 'X-Source': '1' } }]);
    expect(target.batchCalls).toEqual([{ operation: 'upload', objects: [object] }, { operation: 'download', objects: [object] }]);
    expect(target.uploads).toEqual([{ href: 'https://target/upload', filePath: expect.any(String), headers: { 'X-Upload': '1' } }]);
    await expectFileMissing(source.downloads[0].filePath);
  });

  test('records hash mismatch without uploading', async () => {
    const pointerOid = 'b'.repeat(64);
    const object = { oid: pointerOid, size: 7 };
    const source = new FakeLfsClient({ download: [{ objects: [{ ...object, actions: { download: { href: 'https://source/object' } } }] }] }, new TextEncoder().encode('different'));
    const target = new FakeLfsClient({ upload: [{ objects: [{ ...object, actions: { upload: { href: 'https://target/upload' } } }] }] });
    const deps = fakeDeps([pointer(pointerOid, 7)], [source, target]);

    await expect(migrate({
      repoPath: '/repo',
      sourceUrl: 'https://source.example/lfs',
      sourceHeaders: {},
      targetUrl: 'https://target.example/lfs',
      targetToken: 'target-token',
      concurrency: 1,
      dryRun: false,
      writeConfig: false,
    }, deps)).resolves.toEqual({ scanned: 1, unique: 1, migrated: 0, skipped: 0, failed: [{ oid: pointerOid, reason: 'hash mismatch' }] });

    expect(target.uploads).toEqual([]);
  });

  test('records target verification failure when download action is missing after upload', async () => {
    const bytes = new TextEncoder().encode('verified');
    const oid = await sha256Hex(bytes);
    const object = { oid, size: bytes.byteLength };
    const source = new FakeLfsClient({ download: [{ objects: [{ ...object, actions: { download: { href: 'https://source/object' } } }] }] }, bytes);
    const target = new FakeLfsClient({
      upload: [{ objects: [{ ...object, actions: { upload: { href: 'https://target/upload' } } }] }],
      download: [{ objects: [{ ...object, actions: {} }] }],
    });
    const deps = fakeDeps([pointer(oid, bytes.byteLength)], [source, target]);

    await expect(migrate({
      repoPath: '/repo',
      sourceUrl: 'https://source.example/lfs',
      sourceHeaders: {},
      targetUrl: 'https://target.example/lfs',
      targetToken: 'target-token',
      concurrency: 1,
      dryRun: false,
      writeConfig: false,
    }, deps)).resolves.toEqual({ scanned: 1, unique: 1, migrated: 0, skipped: 0, failed: [{ oid, reason: 'target download action missing' }] });

    expect(target.uploads).toEqual([{ href: 'https://target/upload', filePath: expect.any(String), headers: undefined }]);
  });

  test('writes target lfs.url only after non-dry migration completes with no failures', async () => {
    const bytes = new TextEncoder().encode('ok');
    const oid = await sha256Hex(bytes);
    const object = { oid, size: bytes.byteLength };
    const source = new FakeLfsClient({ download: [{ objects: [{ ...object, actions: { download: { href: 'https://source/object' } } }] }] }, bytes);
    const target = new FakeLfsClient({
      upload: [{ objects: [{ ...object, actions: { upload: { href: 'https://target/upload' } } }] }],
      download: [{ objects: [{ ...object, actions: { download: { href: 'https://target/download' } } }] }],
    });
    const deps = fakeDeps([pointer(oid, bytes.byteLength)], [source, target]);

    await migrate({
      repoPath: '/repo',
      sourceUrl: 'https://source.example/lfs',
      sourceHeaders: {},
      targetUrl: 'https://target.example/lfs',
      targetToken: 'target-token',
      concurrency: 1,
      dryRun: false,
      writeConfig: true,
    }, deps);

    expect(deps.setGitConfig).toHaveBeenCalledWith('/repo', 'lfs.url', 'https://target.example/lfs');
  });

  test('discovers source URL from git config when sourceUrl is missing for real migration', async () => {
    const deps = fakeDeps([], [new FakeLfsClient({}), new FakeLfsClient({})]);

    await migrate({
      repoPath: '/repo',
      sourceHeaders: {},
      targetUrl: 'https://target.example/lfs',
      targetToken: 'target-token',
      concurrency: 1,
      dryRun: false,
      writeConfig: false,
    }, deps);

    expect(deps.getGitConfig).toHaveBeenCalledWith('/repo', 'lfs.url');
    expect(deps.createClient).toHaveBeenCalledWith({ baseUrl: 'https://source.example/lfs', headers: {} });
  });
});

async function expectFileMissing(path: string): Promise<void> {
  const fs = await nodeImport<FsPromises>('node:fs/promises');
  await expect(fs.access(path)).rejects.toThrow();
}
