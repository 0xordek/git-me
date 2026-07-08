import { LfsClient, type HeaderMap, type LfsAction, type LfsBatchObject, type LfsObject } from './lfs-client';
import { scanPointers } from './pointers';
import type { LfsPointer } from './pointers';

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

const nodeImport = <T>(specifier: string): Promise<T> => import(/* @vite-ignore */ specifier) as Promise<T>;

type FsPromises = {
  rm(path: string, options: { force: boolean }): Promise<void>;
};
type FsModule = { createReadStream(path: string): ReadStreamLike };
type Hash = { update(data: Uint8Array): void; digest(encoding: 'hex'): string };
type CryptoModule = { createHash(algorithm: 'sha256'): Hash };
type ReadStreamLike = {
  on(event: 'data', listener: (chunk: Uint8Array) => void): ReadStreamLike;
  on(event: 'error', listener: (error: Error) => void): ReadStreamLike;
  on(event: 'end', listener: () => void): ReadStreamLike;
};
type Os = { tmpdir(): string };
type Path = { join(...parts: string[]): string };
type ChildProcess = {
  execFile(
    file: string,
    args: readonly string[],
    options: { encoding: 'utf8' },
    callback: (error: Error | null, stdout: string, stderr: string) => void,
  ): void;
};

export async function migrate(options: MigrateOptions, deps: MigrateDeps = {}): Promise<MigrationResult> {
  const scan = deps.scanPointers ?? scanPointers;
  const createClient = deps.createClient ?? ((clientOptions) => new LfsClient(clientOptions));
  const createTempPath = deps.createTempPath ?? defaultCreateTempPath;
  const removeFile = deps.removeFile ?? defaultRemoveFile;
  const getGitConfig = deps.getGitConfig ?? getGitConfigValue;
  const setGitConfig = deps.setGitConfig ?? setGitConfigValue;

  const pointers = await scan(options.repoPath);
  const uniqueObjects = uniqueLfsObjects(pointers);
  const result: MigrationResult = {
    scanned: pointers.length,
    unique: uniqueObjects.length,
    migrated: 0,
    skipped: pointers.length - uniqueObjects.length,
    failed: [],
  };

  if (options.dryRun) return result;

  const sourceUrl = options.sourceUrl ?? await getGitConfig(options.repoPath, 'lfs.url');
  const source = createClient({ baseUrl: sourceUrl.trim(), headers: options.sourceHeaders });
  const target = createClient({ baseUrl: options.targetUrl, headers: { Authorization: `Bearer ${options.targetToken}` } });

  await runPool(uniqueObjects, options.concurrency, async (object) => {
    const tempPath = await createTempPath();
    try {
      const download = await batchAction(source, 'download', object, 'download');
      if (!download) throw new Error('download action missing');
      await source.downloadToFile(download.href, tempPath, download.header);
      if (await sha256File(tempPath) !== object.oid) throw new Error('hash mismatch');

      const upload = await batchAction(target, 'upload', object, 'upload');
      if (!upload) {
        result.skipped += 1;
        return;
      }

      await target.uploadFromFile(upload.href, tempPath, upload.header);
      const targetDownload = await batchAction(target, 'download', object, 'download');
      if (!targetDownload) throw new Error('target download action missing');
      result.migrated += 1;
    } catch (error) {
      result.failed.push({ oid: object.oid, reason: errorMessage(error) });
    } finally {
      await removeFile(tempPath).catch(() => undefined);
    }
  });

  if (options.writeConfig && result.failed.length === 0) {
    await setGitConfig(options.repoPath, 'lfs.url', options.targetUrl);
  }

  return result;
}

function uniqueLfsObjects(pointers: LfsPointer[]): LfsObject[] {
  const seen = new Set<string>();
  const objects: LfsObject[] = [];
  for (const pointer of pointers) {
    if (seen.has(pointer.oid)) continue;
    seen.add(pointer.oid);
    objects.push({ oid: pointer.oid, size: pointer.size });
  }
  return objects;
}

async function batchAction(
  client: LfsClientLike,
  operation: 'upload' | 'download',
  object: LfsObject,
  action: 'upload' | 'download',
): Promise<LfsAction | null> {
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
      await worker(item);
    }
  });
  await Promise.all(workers);
}

async function sha256File(path: string): Promise<string> {
  const [fs, cryptoModule] = await Promise.all([nodeImport<FsModule>('node:fs'), nodeImport<CryptoModule>('node:crypto')]);
  const hash = cryptoModule.createHash('sha256');
  const stream = fs.createReadStream(path);

  return await new Promise((resolve, reject) => {
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function defaultCreateTempPath(): Promise<string> {
  const [os, path] = await Promise.all([nodeImport<Os>('node:os'), nodeImport<Path>('node:path')]);
  return path.join(os.tmpdir(), `git-me-migrate-${crypto.randomUUID()}`);
}

async function defaultRemoveFile(path: string): Promise<void> {
  const fs = await nodeImport<FsPromises>('node:fs/promises');
  await fs.rm(path, { force: true });
}

async function getGitConfigValue(repoPath: string, key: string): Promise<string> {
  return (await execGit(repoPath, ['config', '--get', key])).trim();
}

async function setGitConfigValue(repoPath: string, key: string, value: string): Promise<void> {
  await execGit(repoPath, ['config', key, value]);
}

async function execGit(repoPath: string, args: readonly string[]): Promise<string> {
  const childProcess = await nodeImport<ChildProcess>('node:child_process');
  return await new Promise((resolve, reject) => {
    childProcess.execFile('git', ['-C', repoPath, ...args], { encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${error.message}\n${stderr}`));
        return;
      }
      resolve(stdout);
    });
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
