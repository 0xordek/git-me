import { pathToFileURL } from 'node:url';
import { migrate, type MigrateOptions, type MigrationResult } from './migrate';
import type { HeaderMap } from './lfs-client';

export type CliIO = {
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  cwd?: () => string;
  env?: Record<string, string | undefined>;
  readStdin?: () => Promise<string>;
  migrate?: (options: MigrateOptions) => Promise<MigrationResult>;
  userRequest?: (options: UserOptions) => Promise<UserResult>;
};

type UserAccess = 'read' | 'write';

type UserOptions = {
  action: 'add' | 'delete';
  targetUrl: string;
  token: string;
  username: string;
  password?: string;
  access?: UserAccess;
};

type UserResult = {
  username: string;
  access?: UserAccess;
  deleted?: boolean;
};

type SecretSource = { env: string } | { stdin: true };

export async function runCli(argv: string[], io: CliIO = {}): Promise<number> {
  const out = io.stdout ?? ((text) => process.stdout.write(text));
  const err = io.stderr ?? ((text) => process.stderr.write(text));

  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    out(topLevelUsage());
    return 0;
  }

  const [command, ...args] = argv;
  if (command === 'migrate') return await runMigrate(args, { ...io, stdout: out, stderr: err });
  if (command === 'user') return await runUser(args, { ...io, stdout: out, stderr: err });

  err(`unknown command: ${command}\n\n${topLevelUsage()}`);
  return 2;
}

async function runUser(args: string[], io: Required<Pick<CliIO, 'stdout' | 'stderr'>> & CliIO): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    io.stdout(userUsage());
    return 0;
  }

  const parsed = await parseUserArgs(args, io);
  if ('error' in parsed) {
    io.stderr(`${parsed.error}\n\n${userUsage()}`);
    return 2;
  }

  try {
    const result = await (io.userRequest ?? requestUser)(parsed.options);
    io.stdout(formatUserResult(result));
    return 0;
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

async function runMigrate(args: string[], io: Required<Pick<CliIO, 'stdout' | 'stderr'>> & CliIO): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    io.stdout(migrateUsage());
    return 0;
  }

  const parsed = await parseMigrateArgs(args, io.cwd?.() ?? process.cwd(), io);
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

async function parseUserArgs(args: string[], io: CliIO): Promise<{ options: UserOptions } | { error: string }> {
  const action = args[0];
  if (action !== 'add' && action !== 'delete') return { error: 'missing user action: add or delete' };

  let targetUrl = '';
  let token: SecretSource | undefined;
  let username = '';
  let password: SecretSource | undefined;
  let access = '';

  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--token-stdin') {
      if (token) return { error: 'duplicate token source' };
      token = { stdin: true };
      continue;
    }
    if (arg === '--password-stdin') {
      if (password) return { error: 'duplicate password source' };
      password = { stdin: true };
      continue;
    }
    const value = args[index + 1];
    if (!value || value.startsWith('--')) return { error: `missing value for ${arg}` };
    index += 1;

    if (arg === '--target') targetUrl = value;
    else if (arg === '--token-env') {
      if (token) return { error: 'duplicate token source' };
      const source = envSecret(value);
      if (!source) return { error: `invalid environment variable name: ${value}` };
      token = source;
    }
    else if (arg === '--username') username = value;
    else if (arg === '--password-env') {
      if (password) return { error: 'duplicate password source' };
      const source = envSecret(value);
      if (!source) return { error: `invalid environment variable name: ${value}` };
      password = source;
    }
    else if (arg === '--access') access = value;
    else return { error: `unknown option: ${arg}` };
  }

  if (!targetUrl) return { error: 'missing required option: --target' };
  if (!token) return { error: 'missing required option: --token-env or --token-stdin' };
  if (!username) return { error: 'missing required option: --username' };
  if (action === 'add' && !password) return { error: 'missing required option: --password-env or --password-stdin' };
  if (action === 'add' && access !== 'read' && access !== 'write') return { error: 'missing required option: --access read|write' };
  if (isStdinSecret(token) && password && isStdinSecret(password)) return { error: 'only one secret may use standard input' };

  try {
    return {
      options: {
        action,
        targetUrl,
        token: await readSecret(token, io),
        username,
        password: password ? await readSecret(password, io) : undefined,
        access: access as UserAccess || undefined,
      },
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

async function requestUser(options: UserOptions): Promise<UserResult> {
  const url = new URL(`/admin/users/${encodeURIComponent(options.username)}`, options.targetUrl.endsWith('/') ? options.targetUrl : `${options.targetUrl}/`);
  const res = await fetch(url, {
    method: options.action === 'add' ? 'PUT' : 'DELETE',
    headers: {
      Authorization: `Bearer ${options.token}`,
      ...(options.action === 'add' ? { 'Content-Type': 'application/json' } : {}),
    },
    body: options.action === 'add' ? JSON.stringify({ password: options.password, access: options.access }) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(text.trim() || `request failed: ${res.status}`);
  return JSON.parse(text) as UserResult;
}

async function parseMigrateArgs(args: string[], defaultRepoPath: string, io: CliIO): Promise<{ options: MigrateOptions } | { error: string }> {
  const sourceHeaderSources: SecretSource[] = [];
  let repoPath = defaultRepoPath;
  let sourceUrl: string | undefined;
  let targetUrl: string | undefined;
  let targetToken: SecretSource | undefined;
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
    if (arg === '--token-stdin') {
      if (targetToken) return { error: 'duplicate token source' };
      targetToken = { stdin: true };
      continue;
    }

    const value = args[index + 1];
    if (!value || value.startsWith('--')) return { error: `missing value for ${arg}` };
    index += 1;

    if (arg === '--repo') repoPath = value;
    else if (arg === '--source-url') sourceUrl = value;
    else if (arg === '--target') targetUrl = value;
    else if (arg === '--token-env') {
      if (targetToken) return { error: 'duplicate token source' };
      const source = envSecret(value);
      if (!source) return { error: `invalid environment variable name: ${value}` };
      targetToken = source;
    }
    else if (arg === '--concurrency') {
      concurrency = Number(value);
      if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) return { error: 'invalid --concurrency' };
    } else if (arg === '--source-header-env') {
      const source = envSecret(value);
      if (!source) return { error: `invalid environment variable name: ${value}` };
      sourceHeaderSources.push(source);
    } else return { error: `unknown option: ${arg}` };
  }

  if (!targetUrl) return { error: 'missing required option: --target' };
  if (!targetToken) return { error: 'missing required option: --token-env or --token-stdin' };

  try {
    const sourceHeaders: HeaderMap = {};
    for (const source of sourceHeaderSources) {
      const header = parseHeader(await readSecret(source, io));
      if (!header) return { error: 'invalid --source-header-env value' };
      sourceHeaders[header.name] = header.value;
    }
    return { options: { repoPath, sourceUrl, sourceHeaders, targetUrl, targetToken: await readSecret(targetToken, io), concurrency, dryRun, writeConfig } };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function envSecret(name: string): SecretSource | null {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? { env: name } : null;
}

function isStdinSecret(source: SecretSource): source is { stdin: true } {
  return 'stdin' in source;
}

async function readSecret(source: SecretSource, io: CliIO): Promise<string> {
  if ('env' in source) {
    const value = (io.env ?? process.env)[source.env];
    if (!value) throw new Error(`missing environment variable: ${source.env}`);
    return value;
  }
  const value = await (io.readStdin ?? readStdin)();
  const secret = value.replace(/\r?\n$/, '');
  if (!secret) throw new Error('standard input secret is empty');
  return secret;
}

async function readStdin(): Promise<string> {
  let value = '';
  for await (const chunk of process.stdin) value += String(chunk);
  return value;
}

function parseHeader(input: string): { name: string; value: string } | null {
  const index = input.indexOf(':');
  if (index < 1) return null;
  const name = input.slice(0, index).trim();
  const value = input.slice(index + 1).trim();
  return name && value ? { name, value } : null;
}

function topLevelUsage(): string {
  return `Usage: git-me <command>\n\nCommands:\n  migrate  migrate Git LFS objects to git-me\n  user     manage git-me LFS users\n`;
}

function migrateUsage(): string {
  return `Usage: git-me migrate --target <url> (--token-env <name>|--token-stdin) [options]\n\nOptions:\n  --repo <path>                  repository path (default: current directory)\n  --source-url <url>             source LFS URL (default: git config lfs.url)\n  --source-header-env <name>     env var containing name: value, repeatable\n  --concurrency <number>         concurrent transfers, 1..16 (default: 4)\n  --dry-run                      scan without transferring objects\n  --write-config                 update lfs.url after successful migration\n`;
}

function userUsage(): string {
  return `Usage: git-me user <add|delete> --target <url> (--token-env <name>|--token-stdin) --username <name> [options]\n\nOptions:\n  --password-env <name>  env var containing password for add\n  --password-stdin       read password for add from standard input\n  --access <read|write>  access for add\n`;
}

function formatResult(result: MigrationResult): string {
  const lines = [`scanned=${result.scanned} unique=${result.unique} migrated=${result.migrated} skipped=${result.skipped} failed=${result.failed.length}`];
  for (const failure of result.failed) lines.push(`${failure.oid}: ${failure.reason}`);
  return `${lines.join('\n')}\n`;
}

function formatUserResult(result: UserResult): string {
  if (result.deleted) return `username=${result.username} deleted=true\n`;
  return `username=${result.username} access=${result.access}\n`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  }, (error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
