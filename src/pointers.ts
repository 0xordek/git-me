import { execFile } from 'node:child_process';
import { open } from 'node:fs/promises';
import { join } from 'node:path';

export type LfsPointer = { path: string; oid: string; size: number };

const VERSION_LINE = 'version https://git-lfs.github.com/spec/v1';
const OID_LINE = /^oid sha256:([0-9a-fA-F]{64})$/;
const SIZE_LINE = /^size ([0-9]+)$/;
const MAX_POINTER_BYTES = 1024;

export function parsePointer(text: string, path: string): LfsPointer | null {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (lines.length !== 3 || lines[0] !== VERSION_LINE) return null;

  const oid = OID_LINE.exec(lines[1] ?? '')?.[1];
  const sizeText = SIZE_LINE.exec(lines[2] ?? '')?.[1];
  if (!oid || !sizeText) return null;
  const size = Number(sizeText);
  return Number.isSafeInteger(size) ? { path, oid: oid.toLowerCase(), size } : null;
}

export async function scanPointers(repoPath: string): Promise<LfsPointer[]> {
  const trackedPaths = await listTrackedFiles(repoPath);
  const pointers: LfsPointer[] = [];
  for (const trackedPath of trackedPaths) {
    const text = await readSmallUtf8File(join(repoPath, trackedPath));
    if (text === null) continue;
    const pointer = parsePointer(text, trackedPath);
    if (pointer) pointers.push(pointer);
  }
  return pointers;
}

async function listTrackedFiles(repoPath: string): Promise<string[]> {
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile('git', ['-C', repoPath, 'ls-files', '-z'], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }, (error, output, stderr) => {
      if (error) reject(new Error(`${error.message}\n${stderr}`));
      else resolve(output);
    });
  });
  return stdout.split('\0').filter(Boolean);
}

async function readSmallUtf8File(path: string): Promise<string | null> {
  let file: Awaited<ReturnType<typeof open>> | null = null;
  try {
    file = await open(path, 'r');
    const bytes = new Uint8Array(MAX_POINTER_BYTES);
    const { bytesRead } = await file.read(bytes, 0, bytes.byteLength, 0);
    const chunk = bytes.subarray(0, bytesRead);
    return chunk.includes(0) ? null : new TextDecoder('utf-8', { fatal: true }).decode(chunk);
  } catch {
    return null;
  } finally {
    await file?.close().catch(() => undefined);
  }
}
