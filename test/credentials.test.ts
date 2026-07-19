import { beforeEach, describe, expect, test, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  os: 'darwin',
  error: null as Error | null,
  calls: [] as Array<{ command: string; args: string[]; input: string; ended: boolean }>,
}));

vi.mock('node:os', () => ({ platform: () => mock.os }));
vi.mock('node:child_process', () => ({
  execFile: (command: string, args: string[], _options: unknown, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
    const call = { command, args, input: '', ended: false };
    mock.calls.push(call);
    queueMicrotask(() => callback(mock.error, mock.error ? '' : 'stored-secret\n', mock.error?.message ?? ''));
    return {
      stdin: {
        write: (value: string) => { call.input += value; },
        end: () => { call.ended = true; },
      },
    };
  },
}));

import { createCredentialStore } from '../src/credentials';

beforeEach(() => {
  mock.os = 'darwin';
  mock.error = null;
  mock.calls.length = 0;
});

describe('system credential store', () => {
  test('passes a macOS secret only through stdin with -w last', async () => {
    await createCredentialStore().set('profile', 'top-secret');
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]?.command).toBe('security');
    expect(mock.calls[0]?.args.at(-1)).toBe('-w');
    expect(mock.calls[0]?.args).not.toContain('top-secret');
    expect(mock.calls[0]).toMatchObject({ input: 'top-secret', ended: true });
  });

  test('treats missing lookup and delete entries as harmless', async () => {
    mock.error = new Error('not found');
    await expect(createCredentialStore().get('missing')).resolves.toBeNull();
    await expect(createCredentialStore().delete('missing')).resolves.toBeUndefined();
  });

  test('rejects unsupported operating systems', async () => {
    mock.os = 'freebsd';
    await expect(createCredentialStore().get('profile')).rejects.toThrow('unsupported on freebsd');
  });
});
