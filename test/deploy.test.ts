import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { deployWorker } from '../src/deploy';

describe('deployWorker', () => {
  test('creates resources, deploys the packaged bundle, stores the profile, and checks health', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'git-me-test-'));
    const commands: string[][] = [];
    const savedProfiles: unknown[] = [];
    const storedCredentials: string[] = [];
    let config = '';
    try {
      const runCommand = vi.fn(async (args: string[]) => {
        commands.push(args);
        const configPath = args[args.indexOf('--config') + 1];
        if (args[0] === 'deploy') return { stdout: 'https://worker.example.workers.dev\n', stderr: '' };
        if (args[0] === 'secret') config = await readFile(configPath, 'utf8');
        if (args[0] === 'kv') return { stdout: 'id = "1234567890abcdef1234567890abcdef"', stderr: '' };
        return { stdout: 'account 1234567890abcdef1234567890abcdef', stderr: '' };
      });
      const result = await deployWorker({ profile: 'default', workerName: 'worker' }, {
        runCommand,
        workerBundle: '/tmp/worker.js',
        createTempDirectory: async () => temp,
        generateSecret: () => 'admin-secret',
        fetch: vi.fn(async () => Response.json({ ok: true }, { status: 200 })),
        credentialStore: {
          get: vi.fn(async () => null),
          set: vi.fn(async (_key, value) => { storedCredentials.push(value); }),
          delete: vi.fn(async () => undefined),
        },
        profileStore: {
          get: vi.fn(async () => null),
          save: vi.fn(async (profile) => { savedProfiles.push(profile); }),
        },
        now: () => '2026-07-10T00:00:00.000Z',
      });

      expect(result).toMatchObject({ endpoint: 'https://worker.example.workers.dev', workerName: 'worker', kvNamespaceId: '1234567890abcdef1234567890abcdef' });
      expect(storedCredentials).toEqual(['admin-secret']);
      expect(savedProfiles).toEqual([expect.objectContaining({ endpoint: 'https://worker.example.workers.dev', bucketName: 'worker-objects' })]);
      expect(commands.map((args) => args.slice(0, 2))).toEqual([
        ['login'], ['whoami'], ['r2', 'bucket'], ['kv', 'namespace'], ['deploy', '--config'], ['secret', 'put'],
      ]);
      expect(config).toContain('account_id = "1234567890abcdef1234567890abcdef"');
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });

  test('refuses an existing profile before creating resources', async () => {
    const runCommand = vi.fn();
    await expect(deployWorker({ profile: 'default' }, {
      runCommand,
      profileStore: { get: vi.fn(async () => ({ name: 'default' } as never)), save: vi.fn() },
    })).rejects.toThrow('profile already exists: default');
    expect(runCommand).not.toHaveBeenCalled();
  });

  test('continues cleanup when a resource deletion fails', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'git-me-test-'));
    const commands: string[][] = [];
    try {
      await expect(deployWorker({ profile: 'default', workerName: 'worker' }, {
        createTempDirectory: async () => temp,
        fetch: vi.fn(),
        profileStore: { get: vi.fn(async () => null), save: vi.fn() },
        credentialStore: { get: vi.fn(async () => null), set: vi.fn(async () => undefined), delete: vi.fn(async () => undefined) },
        runCommand: vi.fn(async (args: string[]) => {
          commands.push(args);
          const configPath = args[args.indexOf('--config') + 1];
          if (args[0] === 'kv' && args[2] === 'create') return { stdout: 'id = "1234567890abcdef1234567890abcdef"', stderr: '' };
          if (args[0] === 'deploy') return { stdout: '', stderr: '' };
          if (args[0] === 'delete') throw new Error('delete failed');
          return { stdout: 'account 1234567890abcdef1234567890abcdef', stderr: '' };
        }),
      })).rejects.toThrow('Resources to verify');
      expect(commands).toContainEqual(['kv', 'namespace', 'delete', '1234567890abcdef1234567890abcdef', '--config', join(temp, 'wrangler.toml')]);
      expect(commands).toContainEqual(['r2', 'bucket', 'delete', 'worker-objects', '--config', join(temp, 'wrangler.toml')]);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });

});
