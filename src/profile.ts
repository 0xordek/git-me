import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';

export type WorkerProfile = {
  name: string;
  endpoint: string;
  workerName: string;
  accountId?: string;
  bucketName?: string;
  kvNamespaceId?: string;
  createdAt: string;
};

export type ProfileStore = {
  get(name: string): Promise<WorkerProfile | null>;
  save(profile: WorkerProfile): Promise<void>;
};

type ProfileFile = {
  version: 1;
  profiles: Record<string, WorkerProfile>;
};

export function createProfileStore(env: Record<string, string | undefined> = process.env): ProfileStore {
  return new FileProfileStore(profileFilePath(env));
}

class FileProfileStore implements ProfileStore {
  constructor(private readonly filePath: string) {}

  async get(name: string): Promise<WorkerProfile | null> {
    const file = await readProfileFile(this.filePath);
    const profile = Object.hasOwn(file.profiles, name) ? file.profiles[name] : undefined;
    return profile ?? null;
  }

  async save(profile: WorkerProfile): Promise<void> {
    const file = await readProfileFile(this.filePath);
    file.profiles[profile.name] = profile;
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.filePath}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
    await rename(temporaryPath, this.filePath);
    await chmod(this.filePath, 0o600).catch(() => undefined);
  }
}

async function readProfileFile(filePath: string): Promise<ProfileFile> {
  try {
    const parsed: unknown = JSON.parse(await readFile(filePath, 'utf8'));
    if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.profiles)) throw new Error(`invalid profile file: ${filePath}`);
    const profiles = emptyProfiles();
    for (const [name, profile] of Object.entries(parsed.profiles)) {
      if (!isWorkerProfile(profile) || profile.name !== name) throw new Error(`invalid profile file: ${filePath}`);
      profiles[name] = profile;
    }
    return {
      version: 1,
      profiles,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, profiles: emptyProfiles() };
    if (error instanceof SyntaxError) throw new Error(`invalid profile file: ${filePath}`);
    throw error;
  }
}

function emptyProfiles(): Record<string, WorkerProfile> {
  return Object.create(null) as Record<string, WorkerProfile>;
}

function isWorkerProfile(value: unknown): value is WorkerProfile {
  return isRecord(value)
    && typeof value.name === 'string'
    && typeof value.endpoint === 'string'
    && typeof value.workerName === 'string'
    && typeof value.createdAt === 'string'
    && (!('accountId' in value) || typeof value.accountId === 'string')
    && (!('bucketName' in value) || typeof value.bucketName === 'string')
    && (!('kvNamespaceId' in value) || typeof value.kvNamespaceId === 'string');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function profileFilePath(env: Record<string, string | undefined>): string {
  if (env.GITME_CONFIG_DIR) return join(env.GITME_CONFIG_DIR, 'profiles.json');
  if (platform() === 'win32' && env.APPDATA) return join(env.APPDATA, 'git-me', 'profiles.json');
  if (platform() === 'darwin') return join(homedir(), 'Library', 'Application Support', 'git-me', 'profiles.json');
  return join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'git-me', 'profiles.json');
}
