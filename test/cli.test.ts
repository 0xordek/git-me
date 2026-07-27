import { describe, expect, test, vi } from 'vitest';
import { runCli, type CliIO } from '../src/cli';
import type { MigrateOptions, MigrationResult } from '../src/migrate';

type UserCall = Parameters<NonNullable<CliIO['userRequest']>>[0];

function io(overrides: Partial<CliIO> = {}): CliIO & { out: string[]; err: string[]; calls: MigrateOptions[]; userCalls: UserCall[] } {
  const out: string[] = [];
  const err: string[] = [];
  const calls: MigrateOptions[] = [];
  const userCalls: UserCall[] = [];
  return {
    cwd: () => '/repo',
    env: {
      TOKEN: 'tok',
      ADMIN_TOKEN: 'admin',
      PASSWORD: 'secret-password',
      SOURCE_AUTH: 'Authorization: Bearer source',
      SOURCE_CUSTOM: 'X-Custom: value',
      SOURCE_INVALID: 'Authorization=Bearer source',
    },
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    migrate: vi.fn(async (options) => {
      calls.push(options);
      return { scanned: 1, unique: 1, migrated: 1, skipped: 0, failed: [] } satisfies MigrationResult;
    }),
    userRequest: vi.fn(async (options) => {
      userCalls.push(options);
      return options.action === 'delete' ? { username: options.username, deleted: true } : { username: options.username, access: options.access };
    }),
    out,
    err,
    calls,
    userCalls,
    ...overrides,
  };
}

describe('runCli', () => {
  test('prints top-level help and exits 0', async () => {
    const testIO = io();

    await expect(runCli(['--help'], testIO)).resolves.toBe(0);

    expect(testIO.out.join('')).toContain('Usage: git-me <command>');
    expect(testIO.out.join('')).toContain('user     manage git-me LFS users');
    expect(testIO.err).toEqual([]);
  });

  test('prints user help and exits 0', async () => {
    const testIO = io();

    await expect(runCli(['user', '--help'], testIO)).resolves.toBe(0);

    expect(testIO.out.join('')).toContain('Usage: git-me user <add|delete>');
    expect(testIO.err).toEqual([]);
  });

  test('prints migrate help and exits 0', async () => {
    const testIO = io();

    await expect(runCli(['migrate', '--help'], testIO)).resolves.toBe(0);

    expect(testIO.out.join('')).toContain('Usage: git-me migrate --target <url> (--token-env <name>|--token-stdin)');
    expect(testIO.out.join('')).toContain('--source-url <url>');
    expect(testIO.out.join('')).toContain('--source-header-env <name>');
    expect(testIO.err).toEqual([]);
  });

  test('unknown command exits 2', async () => {
    const testIO = io();

    await expect(runCli(['unknown'], testIO)).resolves.toBe(2);

    expect(testIO.err.join('')).toContain('unknown command: unknown');
  });

  test('missing target or token exits 2', async () => {
    const missingTarget = io();
    const missingToken = io();

    await expect(runCli(['migrate', '--token-env', 'TOKEN'], missingTarget)).resolves.toBe(2);
    await expect(runCli(['migrate', '--target', 'https://target.example/lfs'], missingToken)).resolves.toBe(2);

    expect(missingTarget.err.join('')).toContain('missing required option: --target');
    expect(missingToken.err.join('')).toContain('missing required option: --token-env or --token-stdin');
  });

  test('invalid concurrency exits 2', async () => {
    const testIO = io();

    await expect(runCli(['migrate', '--target', 'https://target.example/lfs', '--token-env', 'TOKEN', '--concurrency', '0'], testIO)).resolves.toBe(2);

    expect(testIO.err.join('')).toContain('invalid --concurrency');
  });

  test('concurrency above 16 exits 2', async () => {
    const testIO = io();

    await expect(runCli(['migrate', '--target', 'https://target.example/lfs', '--token-env', 'TOKEN', '--concurrency', '17'], testIO)).resolves.toBe(2);

    expect(testIO.err.join('')).toContain('invalid --concurrency');
  });

  test('parses migrate options and repeated source headers', async () => {
    const testIO = io();

    await expect(runCli([
      'migrate',
      '--repo', '/work/repo',
      '--source-url', 'https://source.example/lfs',
      '--target', 'https://target.example/lfs',
      '--token-env', 'TOKEN',
      '--concurrency', '3',
      '--source-header-env', 'SOURCE_AUTH',
      '--source-header-env', 'SOURCE_CUSTOM',
      '--dry-run',
      '--write-config',
    ], testIO)).resolves.toBe(0);

    expect(testIO.calls).toEqual([{ repoPath: '/work/repo', sourceUrl: 'https://source.example/lfs', sourceHeaders: { Authorization: 'Bearer source', 'X-Custom': 'value' }, targetUrl: 'https://target.example/lfs', targetToken: 'tok', concurrency: 3, dryRun: true, writeConfig: true }]);
  });

  test('rejects source headers without colon separator', async () => {
    const testIO = io();

    await expect(runCli([
      'migrate',
      '--target', 'https://target.example/lfs',
      '--token-env', 'TOKEN',
      '--source-header-env', 'SOURCE_INVALID',
    ], testIO)).resolves.toBe(2);

    expect(testIO.err.join('')).toContain('invalid --source-header-env value');
  });

  test('adds admin-managed user', async () => {
    const testIO = io();

    await expect(runCli([
      'user', 'add',
      '--target', 'https://worker.example',
      '--token-env', 'ADMIN_TOKEN',
      '--username', 'alice',
      '--password-env', 'PASSWORD',
      '--access', 'write',
    ], testIO)).resolves.toBe(0);

    expect(testIO.userCalls).toEqual([{ action: 'add', targetUrl: 'https://worker.example', token: 'admin', username: 'alice', password: 'secret-password', access: 'write' }]);
    expect(testIO.out.join('')).toBe('username=alice access=write\n');
  });

  test('reads a user password from standard input', async () => {
    const testIO = io({ readStdin: async () => 'secret-password\n' });

    await expect(runCli([
      'user', 'add',
      '--target', 'https://worker.example',
      '--token-env', 'ADMIN_TOKEN',
      '--username', 'alice',
      '--password-stdin',
      '--access', 'write',
    ], testIO)).resolves.toBe(0);

    expect(testIO.userCalls[0]?.password).toBe('secret-password');
  });

  test('rejects plaintext secret arguments', async () => {
    const testIO = io();

    await expect(runCli(['migrate', '--target', 'https://target.example/lfs', '--token', 'tok'], testIO)).resolves.toBe(2);

    expect(testIO.err.join('')).toContain('unknown option: --token');
  });

  test('deletes admin-managed user', async () => {
    const testIO = io();

    await expect(runCli([
      'user', 'delete',
      '--target', 'https://worker.example',
      '--token-env', 'ADMIN_TOKEN',
      '--username', 'alice',
    ], testIO)).resolves.toBe(0);

    expect(testIO.userCalls).toEqual([{ action: 'delete', targetUrl: 'https://worker.example', token: 'admin', username: 'alice', password: undefined, access: undefined }]);
    expect(testIO.out.join('')).toBe('username=alice deleted=true\n');
  });

  test('defaults explicit-target user add to read access', async () => {
    const testIO = io();

    await expect(runCli([
      'user', 'add',
      '--target', 'https://worker.example',
      '--token-env', 'ADMIN_TOKEN',
      '--username', 'alice',
      '--password-env', 'PASSWORD',
    ], testIO)).resolves.toBe(0);

    expect(testIO.userCalls[0]?.access).toBe('read');
  });

  test('uses the saved profile for user list JSON output', async () => {
    const userCalls: UserCall[] = [];
    const testIO = io({
      profileStore: {
        get: vi.fn(async () => ({ name: 'default', endpoint: 'https://worker.example', workerName: 'worker', createdAt: '2026-01-01T00:00:00.000Z' })),
        save: vi.fn(async () => undefined),
      },
      credentialStore: {
        get: vi.fn(async () => 'admin-secret'),
        set: vi.fn(async () => undefined),
        delete: vi.fn(async () => undefined),
      },
      userRequest: vi.fn(async (options) => {
        userCalls.push(options);
        return { users: [{ username: 'alice', access: 'read' as const }] };
      }),
    });

    await expect(runCli(['user', 'list', '--json'], testIO)).resolves.toBe(0);

    expect(userCalls).toEqual([{ action: 'list', targetUrl: 'https://worker.example', token: 'admin-secret', username: undefined, password: undefined, access: undefined, json: true }]);
    expect(testIO.out.join('')).toBe('[{"username":"alice","access":"read"}]\n');
  });

  test('requires an explicit token for a custom target', async () => {
    const credentialStore = {
      get: vi.fn(async () => 'admin-secret'),
      set: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    };
    const testIO = io({
      profileStore: {
        get: vi.fn(async () => ({ name: 'default', endpoint: 'https://worker.example', workerName: 'worker', createdAt: '2026-01-01T00:00:00.000Z' })),
        save: vi.fn(async () => undefined),
      },
      credentialStore,
    });

    await expect(runCli(['user', 'list', '--target', 'https://untrusted.example'], testIO)).resolves.toBe(2);

    expect(credentialStore.get).not.toHaveBeenCalled();
    expect(testIO.err.join('')).toContain('missing admin credential');
  });

  test('rejects secret-bearing HTTP targets except on loopback', async () => {
    const insecure = io();
    const loopback = io();
    await expect(runCli(['user', 'list', '--target', 'http://example.com', '--token-env', 'ADMIN_TOKEN'], insecure)).resolves.toBe(2);
    await expect(runCli(['user', 'list', '--target', 'http://127.0.0.1:8787', '--token-env', 'ADMIN_TOKEN'], loopback)).resolves.toBe(0);
    expect(insecure.err.join('')).toContain('must use HTTPS');
  });

  test('deploys a worker and prints the saved profile endpoint', async () => {
    const testIO = io({
      workerDeploy: vi.fn(async (options) => ({ profile: options.profile, endpoint: 'https://worker.example', workerName: options.workerName || 'generated', bucketName: 'bucket' })),
    });

    await expect(runCli(['worker', 'deploy', '--name', 'worker', '--profile', 'team'], testIO)).resolves.toBe(0);

    expect(testIO.out.join('')).toBe('Deployed: https://worker.example\nProfile: team\nLFS URL: https://worker.example\n');
  });
});
