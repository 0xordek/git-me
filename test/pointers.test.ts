import { afterEach, describe, expect, test } from 'vitest';
import { parsePointer, scanPointers } from '../src/pointers';

const oid = 'A1B2C3D4E5F6A1B2C3D4E5F6A1B2C3D4E5F6A1B2C3D4E5F6A1B2C3D4E5F6A1B2';
const normalizedOid = oid.toLowerCase();
const nodeImport = <T>(specifier: string): Promise<T> => import(/* @vite-ignore */ specifier) as Promise<T>;

type FsPromises = {
  mkdtemp(prefix: string): Promise<string>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  rm(path: string, options: { recursive: boolean; force: boolean }): Promise<void>;
  writeFile(path: string, data: string): Promise<void>;
};
type Os = { tmpdir(): string };
type Path = { join(...parts: string[]): string };
type ChildProcess = {
  execFile(
    file: string,
    args: readonly string[],
    options: { cwd?: string; encoding: 'utf8' },
    callback: (error: Error | null, stdout: string, stderr: string) => void,
  ): void;
};

const tempDirs: string[] = [];

afterEach(async () => {
  const fs = await nodeImport<FsPromises>('node:fs/promises');
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function pointerText(pointerOid = oid, size = '123'): string {
  return [
    'version https://git-lfs.github.com/spec/v1',
    `oid sha256:${pointerOid}`,
    `size ${size}`,
    '',
  ].join('\n');
}

async function createTempRepo(): Promise<{ repo: string; path: Path; fs: FsPromises }> {
  const [fs, os, path] = await Promise.all([
    nodeImport<FsPromises>('node:fs/promises'),
    nodeImport<Os>('node:os'),
    nodeImport<Path>('node:path'),
  ]);
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'git-me-pointers-'));
  tempDirs.push(repo);
  await execGit(repo, ['init']);
  return { repo, path, fs };
}

async function execGit(cwd: string, args: readonly string[]): Promise<void> {
  const childProcess = await nodeImport<ChildProcess>('node:child_process');
  await new Promise<void>((resolve, reject) => {
    childProcess.execFile('git', args, { cwd, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${error.message}\n${stdout}\n${stderr}`));
        return;
      }
      resolve();
    });
  });
}

describe('parsePointer', () => {
  test('parses valid pointer text and normalizes oid', () => {
    expect(parsePointer(pointerText(), 'asset.bin')).toEqual({ path: 'asset.bin', oid: normalizedOid, size: 123 });
  });

  test('returns null for non-pointer text', () => {
    expect(parsePointer('hello\n', 'note.txt')).toBeNull();
  });

  test('returns null for invalid oid', () => {
    expect(parsePointer(pointerText('not-a-sha', '123'), 'asset.bin')).toBeNull();
  });

  test('returns null for negative size', () => {
    expect(parsePointer(pointerText(oid, '-1'), 'asset.bin')).toBeNull();
  });

  test('returns null for non-integer size', () => {
    expect(parsePointer(pointerText(oid, '1.5'), 'asset.bin')).toBeNull();
  });
});

describe('scanPointers', () => {
  test('returns only tracked pointer files', async () => {
    const { repo, path, fs } = await createTempRepo();
    await fs.writeFile(path.join(repo, 'asset.bin'), pointerText());
    await fs.writeFile(path.join(repo, 'normal.txt'), 'hello\n');
    await execGit(repo, ['add', 'asset.bin', 'normal.txt']);

    await expect(scanPointers(repo)).resolves.toEqual([{ path: 'asset.bin', oid: normalizedOid, size: 123 }]);
  });

  test('returns duplicate oids for scanner caller to dedupe', async () => {
    const { repo, path, fs } = await createTempRepo();
    await fs.mkdir(path.join(repo, 'nested'));
    await fs.writeFile(path.join(repo, 'first.bin'), pointerText());
    await fs.writeFile(path.join(repo, 'nested', 'second.bin'), pointerText(oid, '456'));
    await execGit(repo, ['add', 'first.bin', 'nested/second.bin']);

    await expect(scanPointers(repo)).resolves.toEqual([
      { path: 'first.bin', oid: normalizedOid, size: 123 },
      { path: 'nested/second.bin', oid: normalizedOid, size: 456 },
    ]);
  });
});
