import { randomBytes } from 'node:crypto';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { createCredentialStore, type CredentialStore } from './credentials';
import { createProfileStore, type ProfileStore, type WorkerProfile } from './profile';

export type DeployOptions = {
  profile: string;
  workerName?: string;
  accountId?: string;
  adminSecret?: string;
};

export type DeployResult = {
  profile: string;
  endpoint: string;
  workerName: string;
  accountId?: string;
  bucketName: string;
  kvNamespaceId?: string;
  warning?: string;
};

type CommandResult = { stdout: string; stderr: string };
type CommandRunner = (args: string[], options?: { input?: string; interactive?: boolean }) => Promise<CommandResult>;

export type DeployDeps = {
  runCommand?: CommandRunner;
  profileStore?: ProfileStore;
  credentialStore?: CredentialStore;
  workerBundle?: string;
  createTempDirectory?: () => Promise<string>;
  generateSecret?: () => string;
  fetch?: typeof fetch;
  now?: () => string;
};

const COMPATIBILITY_DATE = '2026-07-07';
const require = createRequire(import.meta.url);

export async function deployWorker(options: DeployOptions, deps: DeployDeps = {}): Promise<DeployResult> {
  const runCommand = deps.runCommand ?? runWrangler;
  const profileStore = deps.profileStore ?? createProfileStore();
  const credentialStore = deps.credentialStore ?? createCredentialStore();
  const createTempDirectory = deps.createTempDirectory ?? (() => mkdtemp(join(tmpdir(), 'git-me-deploy-')));
  const generateSecret = deps.generateSecret ?? (() => randomBytes(32).toString('base64url'));
  const fetchImpl = deps.fetch ?? fetch;
  const workerName = options.workerName || defaultWorkerName();
  const workerNameGenerated = !options.workerName;
  const bucketName = `${workerName}-objects`;
  const kvName = `${workerName}-metadata`;
  const adminSecret = options.adminSecret ?? generateSecret();
  if (await profileStore.get(options.profile)) throw new Error(`profile already exists: ${options.profile}`);
  let storedCredential = false;
  if (!options.adminSecret) {
    try {
      await credentialStore.set(credentialKey(options.profile), adminSecret);
      storedCredential = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${message}; re-run with --token-stdin if the OS credential store is unavailable`);
    }
  }
  const tempDirectory = await createTempDirectory();
  const configPath = join(tempDirectory, 'wrangler.toml');
  const workerBundle = deps.workerBundle ?? defaultWorkerBundle();
  let bucketCreated = false;
  let kvCreated = false;
  let workerDeployed = false;
  let kvNamespaceId: string | undefined;

  try {
    await writeFile(configPath, initialConfig(workerName, workerBundle));
    await runCommand(['login'], { interactive: true });
    const whoami = await runCommand(['whoami']);
    const accountId = options.accountId ?? accountIdFromOutput(`${whoami.stdout}\n${whoami.stderr}`);
    if (!accountId) throw new Error('Cloudflare did not report an account ID');
    await writeFile(configPath, initialConfig(workerName, workerBundle, accountId));

    await runCommand(['r2', 'bucket', 'create', bucketName, '--config', configPath]);
    bucketCreated = true;
    await appendFile(configPath, r2Binding(bucketName));
    const kvOutput = await runCommand(['kv', 'namespace', 'create', kvName, '--config', configPath]);
    kvCreated = true;
    kvNamespaceId = kvNamespaceIdFromOutput(`${kvOutput.stdout}\n${kvOutput.stderr}`);
    if (!kvNamespaceId) throw new Error('Cloudflare did not report a KV namespace ID');
    await appendFile(configPath, kvBinding(kvNamespaceId));
    const deployOutput = await runCommand(['deploy', '--config', configPath, '--no-bundle']);
    workerDeployed = true;
    const endpoint = endpointFromOutput(`${deployOutput.stdout}\n${deployOutput.stderr}`);
    if (!endpoint) throw new Error('Cloudflare did not report a Workers URL after deploy');

    await runCommand(['secret', 'put', 'GITME_AUTH_TOKEN', '--config', configPath], { input: adminSecret });
    await waitForHealth(endpoint, fetchImpl);
    let warning: string | undefined;
    if (options.adminSecret) {
      try {
        await credentialStore.set(credentialKey(options.profile), adminSecret);
      } catch {
        warning = 'Admin credential was not saved to the OS credential store; use --token-stdin for user commands.';
      }
    }

    const result: DeployResult = {
      profile: options.profile,
      endpoint,
      workerName,
      accountId,
      bucketName,
      kvNamespaceId,
      warning,
    };
    const profile: WorkerProfile = {
      name: options.profile,
      endpoint,
      workerName,
      accountId: result.accountId,
      bucketName,
      kvNamespaceId,
      createdAt: (deps.now ?? (() => new Date().toISOString()))(),
    };
    await profileStore.save(profile);
    return result;
  } catch (error) {
    if (storedCredential) await credentialStore.delete(credentialKey(options.profile)).catch(() => undefined);
    const cleanup: string[] = [];
    if (workerDeployed && workerNameGenerated) await runCommand(['delete', workerName, '--config', configPath, '--force']).catch(() => cleanup.push(`Worker ${workerName}`));
    else if (workerDeployed) cleanup.push(`Worker ${workerName}`);
    if (kvCreated && kvNamespaceId) await runCommand(['kv', 'namespace', 'delete', kvNamespaceId, '--config', configPath]).catch(() => cleanup.push(`KV namespace ${kvName}`));
    else if (kvCreated) cleanup.push(`KV namespace ${kvName}`);
    if (bucketCreated) await runCommand(['r2', 'bucket', 'delete', bucketName, '--config', configPath]).catch(() => cleanup.push(`R2 bucket ${bucketName}`));
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(cleanup.length > 0 ? `${message}. Resources to verify: ${cleanup.join(', ')}` : message);
  } finally {
    await rm(tempDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function credentialKey(profile: string): string {
  return `git-me:${profile}:admin`;
}

function defaultWorkerName(): string {
  return `git-me-${randomBytes(4).toString('hex')}`;
}

function defaultWorkerBundle(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), 'worker.js');
}

function initialConfig(workerName: string, workerBundle: string, accountId?: string): string {
  return [
    `name = ${tomlString(workerName)}`,
    `main = ${tomlString(workerBundle)}`,
    ...(accountId ? [`account_id = ${tomlString(accountId)}`] : []),
    `compatibility_date = ${tomlString(COMPATIBILITY_DATE)}`,
    'workers_dev = true',
    '',
    '[[durable_objects.bindings]]',
    'name = "GITME_AUTH"',
    'class_name = "AuthUser"',
    '',
    '[[migrations]]',
    'tag = "v1"',
    'new_sqlite_classes = ["AuthUser"]',
    '',
  ].join('\n');
}

function tomlString(value: string): string {
  return `"${value.replaceAll('\\', '/').replaceAll('"', '\\"')}"`;
}

function r2Binding(bucketName: string): string {
  return `\n[[r2_buckets]]\nbinding = "GITME_R2"\nbucket_name = ${tomlString(bucketName)}\n`;
}

function kvBinding(namespaceId: string): string {
  return `\n[[kv_namespaces]]\nbinding = "GITME_KV"\nid = ${tomlString(namespaceId)}\n`;
}

function kvNamespaceIdFromOutput(output: string): string | undefined {
  return output.match(/\bid\s*=\s*"([0-9a-f]{32})"/i)?.[1];
}

function endpointFromOutput(output: string): string | undefined {
  const field = output.match(/"(?:url|workers_dev_url)"\s*:\s*"(https:\/\/[^"\\]+)"/i)?.[1];
  const match = field ? [field] : output.match(/https:\/\/[a-z0-9][a-z0-9.-]*\.workers\.dev(?:\/[^\s]*)?/i);
  if (!match) return undefined;
  return match[1] ? match[1].replace(/[),.]+$/, '') : match[0].replace(/[),.]+$/, '');
}

function accountIdFromOutput(output: string): string | undefined {
  return output.match(/\b[0-9a-f]{32}\b/i)?.[0];
}


async function waitForHealth(endpoint: string, fetchImpl: typeof fetch): Promise<void> {
  let lastError = 'health check failed';
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      const response = await fetchImpl(new URL('/health', endpoint));
      if (response.ok) {
        const body = await response.json() as { ok?: boolean };
        if (body.ok === true) return;
      }
      lastError = `health check returned ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1000));
  }
  throw new Error(lastError);
}

async function runWrangler(args: string[], options?: { input?: string; interactive?: boolean }): Promise<CommandResult> {
  const executable = process.env.GITME_WRANGLER_BIN || require.resolve('wrangler');
  return await spawnCommand(process.execPath, [executable, ...args], options);
}

async function spawnCommand(command: string, args: string[], options: { input?: string; interactive?: boolean } = {}): Promise<CommandResult> {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: options.interactive ? 'inherit' : 'pipe' });
    let stdout = '';
    let stderr = '';
    if (!options.interactive) {
      child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
      child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
    }
    if (options.input !== undefined) {
      child.stdin?.write(options.input);
      child.stdin?.end();
    }
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolvePromise({ stdout, stderr });
      else reject(new Error(stderr.trim() || `Cloudflare command failed with exit code ${code ?? 'unknown'}`));
    });
  });
}
