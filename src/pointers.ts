import { execFile } from 'node:child_process';
import { open } from 'node:fs/promises';
import { join } from 'node:path';

export type LfsPointer = { path: string; oid: string; size: number };

const VERSION_LINE = 'version https://git-lfs.github.com/spec/v1';
const OID_LINE = /^oid sha256:([0-9a-fA-F]{64})$/;
const SIZE_LINE = /^size ([0-9]+)$/;
const MAX_POINTER_BYTES = 1024;
const POINTER_KEY = /^[a-z0-9.-]+$/;

export function parsePointer(text: string, path: string): LfsPointer | null {
  if (new TextEncoder().encode(text).byteLength > MAX_POINTER_BYTES) return null;
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (lines.length < 3 || lines[0] !== VERSION_LINE) return null;

  let previousKey = '';
  let oid: string | undefined;
  let sizeText: string | undefined;
  const keys = new Set<string>(['version']);
  for (const line of lines.slice(1)) {
    const separator = line.indexOf(' ');
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1);
    if (separator < 1 || !POINTER_KEY.test(key) || !value || (previousKey && key <= previousKey) || keys.has(key)) return null;
    previousKey = key;
    keys.add(key);
    if (key === 'oid') oid = OID_LINE.exec(line)?.[1];
    if (key === 'size') sizeText = SIZE_LINE.exec(line)?.[1];
  }
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
    const bytes = new Uint8Array(MAX_POINTER_BYTES + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.byteLength, 0);
    if (bytesRead > MAX_POINTER_BYTES) return null;
    const chunk = bytes.subarray(0, bytesRead);
    return chunk.includes(0) ? null : new TextDecoder('utf-8', { fatal: true }).decode(chunk);
  } catch {
    return null;
  } finally {
    await file?.close().catch(() => undefined);
  }
}
