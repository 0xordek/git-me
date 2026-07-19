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
    const profile = file.profiles[name];
    return profile && profile.name === name ? profile : null;
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
    const parsed = JSON.parse(await readFile(filePath, 'utf8')) as Partial<ProfileFile>;
    if (parsed.version !== 1 || !parsed.profiles || typeof parsed.profiles !== 'object') throw new Error(`invalid profile file: ${filePath}`);
    return {
      version: 1,
      profiles: parsed.profiles as Record<string, WorkerProfile>,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, profiles: {} };
    if (error instanceof SyntaxError) throw new Error(`invalid profile file: ${filePath}`);
    throw error;
  }
}

function profileFilePath(env: Record<string, string | undefined>): string {
  if (env.GITME_CONFIG_DIR) return join(env.GITME_CONFIG_DIR, 'profiles.json');
  if (platform() === 'win32' && env.APPDATA) return join(env.APPDATA, 'git-me', 'profiles.json');
  if (platform() === 'darwin') return join(homedir(), 'Library', 'Application Support', 'git-me', 'profiles.json');
  return join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'git-me', 'profiles.json');
}
