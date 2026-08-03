import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { createProfileStore, type WorkerProfile } from '../src/profile';

const tempDirs: string[] = [];
const profile: WorkerProfile = {
  name: '__proto__',
  endpoint: 'https://worker.example',
  workerName: 'worker',
  createdAt: '2026-07-31T00:00:00.000Z',
};

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('profile store', () => {
  test('persists reserved object keys as ordinary profile names', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'git-me-profile-test-'));
    tempDirs.push(directory);
    const store = createProfileStore({ GITME_CONFIG_DIR: directory });

    await store.save(profile);

    await expect(store.get(profile.name)).resolves.toEqual(profile);
    const file = JSON.parse(await readFile(join(directory, 'profiles.json'), 'utf8')) as { profiles: Record<string, WorkerProfile> };
    expect(file.profiles[profile.name]).toEqual(profile);
  });

  test('rejects malformed profile entries', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'git-me-profile-test-'));
    tempDirs.push(directory);
    const store = createProfileStore({ GITME_CONFIG_DIR: directory });
    await store.save(profile);
    const path = join(directory, 'profiles.json');
    const contents = JSON.parse(await readFile(path, 'utf8')) as { profiles: Record<string, unknown> };
    contents.profiles.alice = { name: 'alice' };
    await writeFile(path, JSON.stringify(contents));

    await expect(store.get(profile.name)).rejects.toThrow('invalid profile file');
  });
});
