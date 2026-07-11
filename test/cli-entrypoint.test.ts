import { spawnSync } from 'node:child_process';
import { mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const cliPath = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

function invoke(entrypoint: string, args: string[]) {
  return spawnSync(process.execPath, [entrypoint, ...args], { encoding: 'utf8' });
}

describe('CLI entrypoint', () => {
  test('runs when invoked directly', () => {
    const result = invoke(cliPath, ['--help']);

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Usage: git-me <command>');
    expect(result.stderr).toBe('');
  });

  test('runs through an npm-style symlink', async () => {
    if (process.platform === 'win32') return;

    const directory = await mkdtemp(join(tmpdir(), 'git-me-cli-'));
    const canonicalDirectory = await realpath(directory);
    const canonicalCliPath = await realpath(cliPath);
    const entrypoint = join(canonicalDirectory, 'git-me');

    try {
      await symlink(relative(canonicalDirectory, canonicalCliPath), entrypoint);

      const cases = [
        { args: [] as string[], usage: 'Usage: git-me <command>' },
        { args: ['--help'], usage: 'Usage: git-me <command>' },
        { args: ['worker', '--help'], usage: 'Usage: git-me worker deploy' },
        { args: ['user', '--help'], usage: 'Usage: git-me user <add|delete>' },
      ];

      for (const { args, usage } of cases) {
        const result = invoke(entrypoint, args);
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(0);
        expect(result.stdout).toContain(usage);
        expect(result.stderr).toBe('');
      }

      const invalid = invoke(entrypoint, ['worker', 'deploy', '--account-id', 'invalid']);
      expect(invalid.error).toBeUndefined();
      expect(invalid.status).toBe(2);
      expect(invalid.stderr).toContain('invalid --account-id');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
