import type { Env } from './worker';

export type UserAccess = 'read' | 'write';
export type IndexedUser = { username: string; access: UserAccess };

type AuthResult = { ok: boolean; access?: UserAccess };
const USER_REGISTRY = 'admin:users';

export async function createUser(env: Env, username: string, password: string, access: UserAccess): Promise<void> {
  return env.GITME_AUTH.getByName(username).create(username, password, access);
}

export async function deleteUser(env: Env, username: string): Promise<void> {
  return env.GITME_AUTH.getByName(username).delete(username);
}

export async function authenticateUser(env: Env, username: string, password: string, source: string): Promise<AuthResult> {
  return env.GITME_AUTH.getByName(username).authenticate(username, password, source);
}

export async function updateUserIndex(env: Env, username: string, access?: UserAccess): Promise<void> {
  const registry = env.GITME_AUTH.getByName(USER_REGISTRY);
  if (access) await registry.upsertIndexedUser(username, access);
  else await registry.removeIndexedUser(username);
}

export async function listUsers(env: Env): Promise<IndexedUser[]> {
  return env.GITME_AUTH.getByName(USER_REGISTRY).listIndexedUsers();
}
