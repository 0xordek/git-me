import { pathToFileURL } from 'node:url';
import { migrate, type MigrateOptions, type MigrationResult } from './migrate';
import type { HeaderMap } from './lfs-client';

export type CliIO = {
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  cwd?: () => string;
  migrate?: (options: MigrateOptions) => Promise<MigrationResult>;
};

export async function runCli(argv: string[], io: CliIO = {}): Promise<number> {
  const out = io.stdout ?? ((text) => process.stdout.write(text));
  const err = io.stderr ?? ((text) => process.stderr.write(text));

  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    out(topLevelUsage());
    return 0;
  }

  const [command, ...args] = argv;
  if (command === 'migrate') return await runMigrate(args, { ...io, stdout: out, stderr: err });

  err(`unknown command: ${command}\n\n${topLevelUsage()}`);
  return 2;
}

async function runMigrate(args: string[], io: Required<Pick<CliIO, 'stdout' | 'stderr'>> & CliIO): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    io.stdout(migrateUsage());
    return 0;
  }

  const parsed = parseMigrateArgs(args, io.cwd?.() ?? process.cwd());
  if ('error' in parsed) {
    io.stderr(`${parsed.error}\n\n${migrateUsage()}`);
    return 2;
  }

  try {
    const result = await (io.migrate ?? migrate)(parsed.options);
    io.stdout(formatResult(result));
    return result.failed.length === 0 ? 0 : 1;
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

function parseMigrateArgs(args: string[], defaultRepoPath: string): { options: MigrateOptions } | { error: string } {
  const sourceHeaders: HeaderMap = {};
  let repoPath = defaultRepoPath;
  let sourceUrl: string | undefined;
  let targetUrl: string | undefined;
  let targetToken: string | undefined;
  let concurrency = 4;
  let dryRun = false;
  let writeConfig = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (arg === '--write-config') {
      writeConfig = true;
      continue;
    }

    const value = args[index + 1];
    if (!value || value.startsWith('--')) return { error: `missing value for ${arg}` };
    index += 1;

    if (arg === '--repo') repoPath = value;
    else if (arg === '--source-url') sourceUrl = value;
    else if (arg === '--target') targetUrl = value;
    else if (arg === '--token') targetToken = value;
    else if (arg === '--concurrency') {
      concurrency = Number(value);
      if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) return { error: 'invalid --concurrency' };
    } else if (arg === '--source-header') {
      const header = parseHeader(value);
      if (!header) return { error: 'invalid --source-header' };
      sourceHeaders[header.name] = header.value;
    } else return { error: `unknown option: ${arg}` };
  }

  if (!targetUrl) return { error: 'missing required option: --target' };
  if (!targetToken) return { error: 'missing required option: --token' };

  return { options: { repoPath, sourceUrl, sourceHeaders, targetUrl, targetToken, concurrency, dryRun, writeConfig } };
}

function parseHeader(input: string): { name: string; value: string } | null {
  const separator = input.includes(':') ? ':' : '=';
  const index = input.indexOf(separator);
  if (index < 1) return null;
  const name = input.slice(0, index).trim();
  const value = input.slice(index + 1).trim();
  return name && value ? { name, value } : null;
}

function topLevelUsage(): string {
  return `Usage: git-me <command>\n\nCommands:\n  migrate  migrate Git LFS objects to git-me\n`;
}

function migrateUsage(): string {
  return `Usage: git-me migrate --target <url> --token <token> [options]\n\nOptions:\n  --repo <path>                 repository path (default: current directory)\n  --source-url <url>            source LFS URL (default: git config lfs.url)\n  --source-header <name=value>  source LFS header, repeatable\n  --concurrency <number>        concurrent transfers, 1..16 (default: 4)\n  --dry-run                     scan without transferring objects\n  --write-config                update lfs.url after successful migration\n`;
}

function formatResult(result: MigrationResult): string {
  const lines = [`scanned=${result.scanned} unique=${result.unique} migrated=${result.migrated} skipped=${result.skipped} failed=${result.failed.length}`];
  for (const failure of result.failed) lines.push(`${failure.oid}: ${failure.reason}`);
  return `${lines.join('\n')}\n`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  }, (error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
