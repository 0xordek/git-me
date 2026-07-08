export type LfsPointer = { path: string; oid: string; size: number };

const VERSION_LINE = 'version https://git-lfs.github.com/spec/v1';
const OID_LINE = /^oid sha256:([0-9a-fA-F]{64})$/;
const SIZE_LINE = /^size ([0-9]+)$/;
const MAX_POINTER_BYTES = 1024;
const nodeImport = <T>(specifier: string): Promise<T> => import(/* @vite-ignore */ specifier) as Promise<T>;

type FileHandle = {
  read(buffer: Uint8Array, offset: number, length: number, position: number): Promise<{ bytesRead: number }>;
  close(): Promise<void>;
};
type FsPromises = { open(path: string, flags: 'r'): Promise<FileHandle> };
type Path = { join(...parts: string[]): string };
type ChildProcess = {
  execFile(
    file: string,
    args: readonly string[],
    options: { encoding: 'utf8'; maxBuffer: number },
    callback: (error: Error | null, stdout: string, stderr: string) => void,
  ): void;
};

export function parsePointer(text: string, path: string): LfsPointer | null {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();

  if (lines.length !== 3 || lines[0] !== VERSION_LINE) return null;

  const oid = OID_LINE.exec(lines[1])?.[1];
  if (!oid) return null;

  const sizeText = SIZE_LINE.exec(lines[2])?.[1];
  if (!sizeText) return null;

  const size = Number(sizeText);
  if (!Number.isSafeInteger(size)) return null;

  return { path, oid: oid.toLowerCase(), size };
}

export async function scanPointers(repoPath: string): Promise<LfsPointer[]> {
  const trackedPaths = await listTrackedFiles(repoPath);
  const [fs, path] = await Promise.all([nodeImport<FsPromises>('node:fs/promises'), nodeImport<Path>('node:path')]);
  const pointers: LfsPointer[] = [];

  for (const trackedPath of trackedPaths) {
    const text = await readSmallUtf8File(fs, path.join(repoPath, trackedPath));
    if (text === null) continue;

    const pointer = parsePointer(text, trackedPath);
    if (pointer) pointers.push(pointer);
  }

  return pointers;
}

async function listTrackedFiles(repoPath: string): Promise<string[]> {
  const childProcess = await nodeImport<ChildProcess>('node:child_process');
  const stdout = await new Promise<string>((resolve, reject) => {
    childProcess.execFile('git', ['-C', repoPath, 'ls-files', '-z'], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }, (error, output, stderr) => {
      if (error) {
        reject(new Error(`${error.message}\n${stderr}`));
        return;
      }
      resolve(output);
    });
  });

  return stdout.split('\0').filter((trackedPath) => trackedPath.length > 0);
}

async function readSmallUtf8File(fs: FsPromises, path: string): Promise<string | null> {
  let file: FileHandle | null = null;
  try {
    file = await fs.open(path, 'r');
    const bytes = new Uint8Array(MAX_POINTER_BYTES);
    const { bytesRead } = await file.read(bytes, 0, bytes.byteLength, 0);
    const chunk = bytes.subarray(0, bytesRead);
    if (chunk.includes(0)) return null;
    return new TextDecoder('utf-8', { fatal: true }).decode(chunk);
  } catch {
    return null;
  } finally {
    await file?.close().catch(() => undefined);
  }
}
