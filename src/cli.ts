import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createCredentialStore, type CredentialStore } from './credentials';
import { deployWorker, credentialKey, type DeployOptions, type DeployResult } from './deploy';
import { migrate, type MigrateOptions, type MigrationResult } from './migrate';
import { createProfileStore, type ProfileStore } from './profile';
import type { HeaderMap } from './lfs-client';

export type CliIO = {
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  cwd?: () => string;
  env?: Record<string, string | undefined>;
  readStdin?: () => Promise<string>;
  readPassword?: (prompt: string) => Promise<string>;
  confirm?: (prompt: string) => Promise<boolean>;
  migrate?: (options: MigrateOptions) => Promise<MigrationResult>;
  workerDeploy?: (options: DeployOptions) => Promise<DeployResult>;
  userRequest?: (options: UserOptions) => Promise<UserResult>;
  profileStore?: ProfileStore;
  credentialStore?: CredentialStore;
};

type UserAccess = 'read' | 'write';

export type UserOptions = {
  action: 'add' | 'delete' | 'list';
  targetUrl: string;
  token: string;
  username?: string;
  password?: string;
  access?: UserAccess;
  yes?: boolean;
  json?: boolean;
};

export type UserResult = {
  username?: string;
  access?: UserAccess;
  deleted?: boolean;
  users?: Array<{ username: string; access: UserAccess }>;
};

type SecretSource = { env: string } | { stdin: true } | { value: string };

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
  if (command === 'worker') return await runWorker(args, { ...io, stdout: out, stderr: err });

  err(`unknown command: ${command}\n\n${topLevelUsage()}`);
  return 2;
}

async function runUser(args: string[], io: Required<Pick<CliIO, 'stdout' | 'stderr'>> & CliIO): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    io.stdout(userUsage());
    return 0;
  }

  let parsed: Awaited<ReturnType<typeof parseUserArgs>>;
  try {
    parsed = await parseUserArgs(args, io);
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n\n${userUsage()}`);
    return 2;
  }
  if ('error' in parsed) {
    io.stderr(`${parsed.error}\n\n${userUsage()}`);
    return 2;
  }

  if (parsed.options.action === 'delete' && !parsed.options.yes && (io.confirm || !io.userRequest)) {
    const confirmed = await (io.confirm ?? confirmPrompt)(`Delete user "${parsed.options.username}"? [y/N] `);
    if (!confirmed) {
      io.stdout('Cancelled.\n');
      return 0;
    }
  }

  try {
    const result = await (io.userRequest ?? requestUser)(parsed.options);
    io.stdout(formatUserResult(result, parsed.options.json === true));
    return 0;
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

async function runWorker(args: string[], io: Required<Pick<CliIO, 'stdout' | 'stderr'>> & CliIO): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    io.stdout(workerUsage());
    return 0;
  }
  const parsed = await parseWorkerArgs(args, io);
  if ('error' in parsed) {
    io.stderr(`${parsed.error}\n\n${workerUsage()}`);
    return 2;
  }
  try {
    const result = await (io.workerDeploy ?? deployWorker)(parsed.options);
    io.stdout(`Deployed: ${result.endpoint}\nProfile: ${result.profile}\nLFS URL: ${result.endpoint}\n${result.warning ? `Warning: ${result.warning}\n` : ''}`);
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
  if (action !== 'add' && action !== 'delete' && action !== 'list') return { error: 'missing user action: add, list, or delete' };

  let targetUrl = '';
  let token: SecretSource | undefined;
  let username = '';
  let password: SecretSource | undefined;
  let access: string = action === 'add' ? 'read' : '';
  let profileName = 'default';
  let yes = false;
  let jsonOutput = false;

  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith('--')) {
      if (username) return { error: 'duplicate username' };
      username = arg;
      continue;
    }
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
    if (arg === '--yes') {
      yes = true;
      continue;
    }
    if (arg === '--json') {
      jsonOutput = true;
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
    else if (arg === '--access') {
      access = value;
    }
    else if (arg === '--profile') profileName = value;
    else return { error: `unknown option: ${arg}` };
  }

  const explicitTarget = Boolean(targetUrl);
  const profileStore = io.profileStore ?? createProfileStore(io.env ?? process.env);
  const profile = explicitTarget ? null : await profileStore.get(profileName);
  if (!targetUrl) targetUrl = profile?.endpoint || '';
  if (!token && profile) {
    const credentialStore = io.credentialStore ?? createCredentialStore();
    const storedToken = await credentialStore.get(credentialKey(profileName));
    if (storedToken) token = { value: storedToken };
  }

  if (!targetUrl) return { error: 'missing profile; deploy a worker first or provide --target' };
  if (!token) return { error: 'missing admin credential; provide --token-env or --token-stdin' };
  if (action !== 'list' && !username) return { error: 'missing username' };
  if (action === 'add' && access !== 'read' && access !== 'write') return { error: 'invalid --access read|write' };
  if (isStdinSecret(token) && password && isStdinSecret(password)) return { error: 'only one secret may use standard input' };

  try {
    let resolvedPassword: string | undefined;
    if (action === 'add') {
      resolvedPassword = password ? await readSecret(password, io) : await (io.readPassword ?? readPassword)('Password: ');
      if (!resolvedPassword) return { error: 'password is empty' };
    }
    return {
      options: {
        action,
        targetUrl,
        token: await readSecret(token, io),
        username: username || undefined,
        password: resolvedPassword,
        access: access as UserAccess || undefined,
        ...(yes ? { yes: true } : {}),
        ...(jsonOutput ? { json: true } : {}),
      },
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

async function requestUser(options: UserOptions): Promise<UserResult> {
  const path = options.action === 'list' ? '/admin/users' : `/admin/users/${encodeURIComponent(options.username || '')}`;
  const url = new URL(path, options.targetUrl.endsWith('/') ? options.targetUrl : `${options.targetUrl}/`);
  const res = await fetch(url, {
    method: options.action === 'add' ? 'PUT' : options.action === 'delete' ? 'DELETE' : 'GET',
    headers: {
      Authorization: `Bearer ${options.token}`,
      ...(options.action === 'add' ? { 'Content-Type': 'application/json' } : {}),
    },
    body: options.action === 'add' ? JSON.stringify({ password: options.password, access: options.access }) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(text.trim() || `request failed: ${res.status}`);
  const result = JSON.parse(text) as UserResult;
  if (options.action === 'list' && !Array.isArray(result.users)) throw new Error('invalid user list response');
  return result;
}

type WorkerCommand = { action: 'deploy'; options: DeployOptions };

async function parseWorkerArgs(args: string[], io: CliIO): Promise<WorkerCommand | { error: string }> {
  if (args[0] !== 'deploy') return { error: 'missing worker action: deploy' };
  let profile = 'default';
  let workerName: string | undefined;
  let accountId: string | undefined;
  let adminToken: SecretSource | undefined;
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--token-stdin') {
      if (adminToken) return { error: 'duplicate admin credential source' };
      adminToken = { stdin: true };
      continue;
    }
    const value = args[index + 1];
    if (!value || value.startsWith('--')) return { error: `missing value for ${arg}` };
    index += 1;
    if (arg === '--profile') profile = value;
    else if (arg === '--name') workerName = value;
    else if (arg === '--account-id') {
      if (!/^[0-9a-f]{32}$/i.test(value)) return { error: 'invalid --account-id' };
      accountId = value;
    }
    else if (arg === '--token-env') {
      if (adminToken) return { error: 'duplicate admin credential source' };
      const source = envSecret(value);
      if (!source) return { error: `invalid environment variable name: ${value}` };
      adminToken = source;
    }
    else return { error: `unknown option: ${arg}` };
  }
  let adminSecret: string | undefined;
  try {
    if (adminToken) adminSecret = await readSecret(adminToken, io);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  return { action: 'deploy', options: { profile, workerName, accountId, adminSecret } };
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
  if ('value' in source) return source.value;
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
  return `Usage: git-me <command>\n\nCommands:\n  worker   deploy a zero-config git-me Worker\n  user     manage git-me LFS users\n  migrate  migrate Git LFS objects to git-me\n`;
}

function migrateUsage(): string {
  return `Usage: git-me migrate --target <url> (--token-env <name>|--token-stdin) [options]\n\nOptions:\n  --repo <path>                  repository path (default: current directory)\n  --source-url <url>             source LFS URL (default: git config lfs.url)\n  --source-header-env <name>     env var containing name: value, repeatable\n  --concurrency <number>         concurrent transfers, 1..16 (default: 4)\n  --dry-run                      scan without transferring objects\n  --write-config                 update lfs.url after successful migration\n`;
}

function userUsage(): string {
  return `Usage: git-me user <add|delete> [username] [options]\n       git-me user list [options]\n\nOptions:\n  --profile <name>       local profile (default: default)\n  --target <url>         Worker URL (default: saved profile)\n  --token-env <name>     env var containing admin token\n  --token-stdin          read admin token from standard input\n  --password-env <name>  env var containing password for add\n  --password-stdin       read password for add from standard input\n  --access <read|write>  access for add (default: read)\n  --yes                  skip delete confirmation\n  --json                 output user list as JSON\n`;
}

function workerUsage(): string {
  return `Usage: git-me worker deploy [options]\n\nOptions:\n  --profile <name>       local profile name (default: default)\n  --name <name>          Worker name (default: generated)\n  --account-id <id>      Cloudflare account ID\n  --token-stdin          use an admin secret from standard input\n  --token-env <name>     use an admin secret from an environment variable\n`;
}

function formatResult(result: MigrationResult): string {
  const lines = [`scanned=${result.scanned} unique=${result.unique} migrated=${result.migrated} skipped=${result.skipped} failed=${result.failed.length}`];
  for (const failure of result.failed) lines.push(`${failure.oid}: ${failure.reason}`);
  return `${lines.join('\n')}\n`;
}

function formatUserResult(result: UserResult, jsonOutput = false): string {
  if (result.users) {
    if (jsonOutput) return `${JSON.stringify(result.users)}\n`;
    if (result.users.length === 0) return 'USERNAME  ACCESS\n';
    const width = Math.max('USERNAME'.length, ...result.users.map((user) => user.username.length));
    return [`${'USERNAME'.padEnd(width)}  ACCESS`, ...result.users.map((user) => `${user.username.padEnd(width)}  ${user.access}`)].join('\n') + '\n';
  }
  if (result.deleted) return `username=${result.username} deleted=true\n`;
  return `username=${result.username} access=${result.access}\n`;
}

async function confirmPrompt(prompt: string): Promise<boolean> {
  const value = await (ioReadLine(prompt));
  return /^y(?:es)?$/i.test(value.trim());
}

async function ioReadLine(prompt: string): Promise<string> {
  const readline = await import('node:readline/promises');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(prompt);
  } finally {
    rl.close();
  }
}

async function readPassword(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('password prompt unavailable; use --password-stdin');
  const stdin = process.stdin;
  const stdout = process.stdout;
  stdout.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  return await new Promise<string>((resolve, reject) => {
    const bytes: number[] = [];
    const onData = (chunk: Buffer) => {
      for (const byte of chunk) {
        if (byte === 3) {
          cleanup();
          reject(new Error('password prompt cancelled'));
          return;
        }
        if (byte === 13 || byte === 10) {
          cleanup();
          stdout.write('\n');
          resolve(Buffer.from(bytes).toString('utf8'));
          return;
        }
        if (byte === 127 || byte === 8) {
          removeLastUtf8CodePoint(bytes);
          continue;
        }
        bytes.push(byte);
      }
    };
    const cleanup = () => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
    };
    stdin.on('data', onData);
  });
}

function removeLastUtf8CodePoint(bytes: number[]): void {
  if (bytes.length === 0) return;
  let index = bytes.length - 1;
  while (index > 0 && (bytes[index] & 0xc0) === 0x80) index -= 1;
  bytes.splice(index);
}

function isMainEntry(): boolean {
  const argvPath = process.argv[1];
  if (!argvPath) return false;

  try {
    return realpathSync(argvPath) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainEntry()) {
  runCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  }, (error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
