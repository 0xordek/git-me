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

    expect(testIO.out.join('')).toContain('Usage: git-me migrate --target <url> --token <token>');
    expect(testIO.out.join('')).toContain('--source-url <url>');
    expect(testIO.out.join('')).toContain('--source-header <name: value>');
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

    await expect(runCli(['migrate', '--token', 'tok'], missingTarget)).resolves.toBe(2);
    await expect(runCli(['migrate', '--target', 'https://target.example/lfs'], missingToken)).resolves.toBe(2);

    expect(missingTarget.err.join('')).toContain('missing required option: --target');
    expect(missingToken.err.join('')).toContain('missing required option: --token');
  });

  test('invalid concurrency exits 2', async () => {
    const testIO = io();

    await expect(runCli(['migrate', '--target', 'https://target.example/lfs', '--token', 'tok', '--concurrency', '0'], testIO)).resolves.toBe(2);

    expect(testIO.err.join('')).toContain('invalid --concurrency');
  });

  test('concurrency above 16 exits 2', async () => {
    const testIO = io();

    await expect(runCli(['migrate', '--target', 'https://target.example/lfs', '--token', 'tok', '--concurrency', '17'], testIO)).resolves.toBe(2);

    expect(testIO.err.join('')).toContain('invalid --concurrency');
  });

  test('parses migrate options and repeated source headers', async () => {
    const testIO = io();

    await expect(runCli([
      'migrate',
      '--repo', '/work/repo',
      '--source-url', 'https://source.example/lfs',
      '--target', 'https://target.example/lfs',
      '--token', 'tok',
      '--concurrency', '3',
      '--source-header', 'Authorization: Bearer source',
      '--source-header', 'X-Custom: value',
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
      '--token', 'tok',
      '--source-header', 'Authorization=Bearer source',
    ], testIO)).resolves.toBe(2);

    expect(testIO.err.join('')).toContain('invalid --source-header');
  });

  test('adds admin-managed user', async () => {
    const testIO = io();

    await expect(runCli([
      'user', 'add',
      '--target', 'https://worker.example',
      '--token', 'admin',
      '--username', 'alice',
      '--password', 'secret-password',
      '--access', 'write',
    ], testIO)).resolves.toBe(0);

    expect(testIO.userCalls).toEqual([{ action: 'add', targetUrl: 'https://worker.example', token: 'admin', username: 'alice', password: 'secret-password', access: 'write' }]);
    expect(testIO.out.join('')).toBe('username=alice access=write\n');
  });

  test('deletes admin-managed user', async () => {
    const testIO = io();

    await expect(runCli([
      'user', 'delete',
      '--target', 'https://worker.example',
      '--token', 'admin',
      '--username', 'alice',
    ], testIO)).resolves.toBe(0);

    expect(testIO.userCalls).toEqual([{ action: 'delete', targetUrl: 'https://worker.example', token: 'admin', username: 'alice', password: undefined, access: undefined }]);
    expect(testIO.out.join('')).toBe('username=alice deleted=true\n');
  });

  test('rejects user add without access', async () => {
    const testIO = io();

    await expect(runCli([
      'user', 'add',
      '--target', 'https://worker.example',
      '--token', 'admin',
      '--username', 'alice',
      '--password', 'secret-password',
    ], testIO)).resolves.toBe(2);

    expect(testIO.err.join('')).toContain('missing required option: --access read|write');
  });
});
