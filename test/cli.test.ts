import { describe, expect, test, vi } from 'vitest';
import { runCli, type CliIO } from '../src/cli';
import type { MigrateOptions, MigrationResult } from '../src/migrate';

function io(overrides: Partial<CliIO> = {}): CliIO & { out: string[]; err: string[]; calls: MigrateOptions[] } {
  const out: string[] = [];
  const err: string[] = [];
  const calls: MigrateOptions[] = [];
  return {
    cwd: () => '/repo',
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    migrate: vi.fn(async (options) => {
      calls.push(options);
      return { scanned: 1, unique: 1, migrated: 1, skipped: 0, failed: [] } satisfies MigrationResult;
    }),
    out,
    err,
    calls,
    ...overrides,
  };
}

describe('runCli', () => {
  test('prints top-level help and exits 0', async () => {
    const testIO = io();

    await expect(runCli(['--help'], testIO)).resolves.toBe(0);

    expect(testIO.out.join('')).toContain('Usage: git-me <command>');
    expect(testIO.err).toEqual([]);
  });

  test('prints migrate help and exits 0', async () => {
    const testIO = io();

    await expect(runCli(['migrate', '--help'], testIO)).resolves.toBe(0);

    expect(testIO.out.join('')).toContain('Usage: git-me migrate --target <url> --token <token>');
    expect(testIO.out.join('')).toContain('--source-url <url>');
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
      '--source-header', 'Authorization=Bearer source',
      '--source-header', 'X-Custom: value',
      '--dry-run',
      '--write-config',
    ], testIO)).resolves.toBe(0);

    expect(testIO.calls).toEqual([{ repoPath: '/work/repo', sourceUrl: 'https://source.example/lfs', sourceHeaders: { Authorization: 'Bearer source', 'X-Custom': 'value' }, targetUrl: 'https://target.example/lfs', targetToken: 'tok', concurrency: 3, dryRun: true, writeConfig: true }]);
  });
});
