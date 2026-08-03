import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { LfsClient, type HeaderMap, type LfsAction, type LfsBatchObject, type LfsObject } from './lfs-client';
import { scanPointers, type LfsPointer } from './pointers';
import { assertSafeUrl } from './url';

export type MigrateOptions = {
  repoPath: string;
  sourceUrl?: string;
  sourceHeaders: HeaderMap;
  targetUrl: string;
  targetToken: string;
  concurrency: number;
  dryRun: boolean;
  writeConfig: boolean;
};

export type MigrationResult = {
  scanned: number;
  unique: number;
  migrated: number;
  skipped: number;
  failed: Array<{ oid: string; reason: string }>;
};

type LfsClientLike = {
  batch(operation: 'upload' | 'download', objects: LfsObject[]): Promise<{ objects: LfsBatchObject[] }>;
  downloadToFile(href: string, filePath: string, headers?: HeaderMap): Promise<void>;
  uploadFromFile(href: string, filePath: string, headers?: HeaderMap): Promise<void>;
};

export type MigrateDeps = {
  scanPointers?: (repoPath: string) => Promise<LfsPointer[]>;
  createClient?: (options: { baseUrl: string; headers?: HeaderMap }) => LfsClientLike;
  createTempPath?: () => Promise<string>;
  removeFile?: (path: string) => Promise<void>;
  getGitConfig?: (repoPath: string, key: string) => Promise<string>;
  setGitConfig?: (repoPath: string, key: string, value: string) => Promise<void>;
};

type FileDigest = { hex: string; size: number };

export async function migrate(options: MigrateOptions, deps: MigrateDeps = {}): Promise<MigrationResult> {
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 16) throw new Error('invalid concurrency');
  const scan = deps.scanPointers ?? scanPointers;
  const createClient = deps.createClient ?? ((clientOptions) => new LfsClient(clientOptions));
  const createTempPath = deps.createTempPath ?? defaultCreateTempPath;
  const removeFile = deps.removeFile ?? defaultRemoveFile;
  const getGitConfig = deps.getGitConfig ?? getGitConfigValue;
  const setGitConfig = deps.setGitConfig ?? setGitConfigValue;

  assertSafeUrl(options.targetUrl, true);
  const pointers = await scan(options.repoPath);
  const { objects, conflicts } = classifyPointers(pointers);
  const unique = objects.length + conflicts.length;
  const result: MigrationResult = {
    scanned: pointers.length,
    unique,
    migrated: 0,
    skipped: pointers.length - unique,
    failed: conflicts,
  };
  if (options.dryRun) return result;

  const sourceUrl = (options.sourceUrl ?? await getGitConfig(options.repoPath, 'lfs.url')).trim();
  assertSafeUrl(sourceUrl, Object.keys(options.sourceHeaders).length > 0);
  const source = createClient({ baseUrl: sourceUrl, headers: options.sourceHeaders });
  const target = createClient({ baseUrl: options.targetUrl, headers: { Authorization: `Bearer ${options.targetToken}` } });

  await runPool(objects, options.concurrency, async (object) => {
    const tempPath = await createTempPath();
    try {
      const download = await batchAction(source, 'download', object, 'download');
      if (!download) throw new Error('download action missing');
      await source.downloadToFile(download.href, tempPath, download.header);
      const digest = await sha256File(tempPath);
      if (digest.hex !== object.oid) throw new Error('hash mismatch');
      if (digest.size !== object.size) throw new Error('download size mismatch');

      const upload = await batchAction(target, 'upload', object, 'upload');
      if (!upload) {
        result.skipped += 1;
        return;
      }

      await target.uploadFromFile(upload.href, tempPath, upload.header);
      if (!await batchAction(target, 'download', object, 'download')) throw new Error('target download action missing');
      result.migrated += 1;
    } catch (error) {
      result.failed.push({ oid: object.oid, reason: errorMessage(error) });
    } finally {
      await removeFile(tempPath).catch(() => undefined);
    }
  });

  result.failed.sort((left, right) => left.oid.localeCompare(right.oid));
  if (options.writeConfig && result.failed.length === 0) await setGitConfig(options.repoPath, 'lfs.url', options.targetUrl);
  return result;
}

function classifyPointers(pointers: LfsPointer[]): { objects: LfsObject[]; conflicts: MigrationResult['failed'] } {
  const sizes = new Map<string, number>();
  const conflicts = new Map<string, Set<number>>();
  for (const pointer of pointers) {
    const size = sizes.get(pointer.oid);
    if (size === undefined) sizes.set(pointer.oid, pointer.size);
    else if (size !== pointer.size) conflicts.set(pointer.oid, new Set([size, pointer.size, ...(conflicts.get(pointer.oid) ?? [])]));
  }
  return {
    objects: [...sizes].filter(([oid]) => !conflicts.has(oid)).map(([oid, size]) => ({ oid, size })),
    conflicts: [...conflicts].map(([oid, values]) => ({ oid, reason: `conflicting pointer sizes: ${[...values].sort((a, b) => a - b).join(', ')}` })),
  };
}

async function batchAction(client: LfsClientLike, operation: 'upload' | 'download', object: LfsObject, action: 'upload' | 'download'): Promise<LfsAction | null> {
  const response = await client.batch(operation, [object]);
  const responseObject = response.objects.find((item) => item.oid === object.oid);
  if (!responseObject) throw new Error(`${operation} batch missing object`);
  if (responseObject.error) throw new Error(responseObject.error.message);
  return responseObject.actions?.[action] ?? null;
}

async function runPool<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
  let index = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, async () => {
    while (index < items.length) {
      const item = items[index];
      index += 1;
      if (item !== undefined) await worker(item);
    }
  });
  await Promise.all(workers);
}

async function sha256File(path: string): Promise<FileDigest> {
  const hash = createHash('sha256');
  const stream = createReadStream(path);
  let size = 0;
  return await new Promise((resolve, reject) => {
    stream.on('data', (chunk) => {
      hash.update(chunk);
      size += chunk.length;
    });
    stream.on('error', reject);
    stream.on('end', () => resolve({ hex: hash.digest('hex'), size }));
  });
}

async function defaultCreateTempPath(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), 'git-me-migrate-')), 'object');
}

async function defaultRemoveFile(path: string): Promise<void> {
  await rm(dirname(path), { recursive: true, force: true });
}

async function getGitConfigValue(repoPath: string, key: string): Promise<string> {
  return (await execGit(repoPath, ['config', '--get', key])).trim();
}

async function setGitConfigValue(repoPath: string, key: string, value: string): Promise<void> {
  await execGit(repoPath, ['config', key, value]);
}

async function execGit(repoPath: string, args: readonly string[]): Promise<string> {
  return await new Promise((resolve, reject) => {
    execFile('git', ['-C', repoPath, ...args], { encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${error.message}\n${stderr}`));
      else resolve(stdout);
    });
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
