import type { Env } from './worker';

export type UserAccess = 'read' | 'write';
export type IndexedUser = { username: string; access: UserAccess };

type AuthResult = { ok: boolean; access?: UserAccess };
const USER_REGISTRY = 'admin:users';

export async function createUser(env: Env, username: string, password: string, access: UserAccess): Promise<void> {
  await requestAuth(env, username, { action: 'create', username, password, access });
}

export async function deleteUser(env: Env, username: string): Promise<void> {
  await requestAuth(env, username, { action: 'delete', username });
}

export async function authenticateUser(env: Env, username: string, password: string, source: string): Promise<AuthResult> {
  return await requestAuth<AuthResult>(env, username, { action: 'authenticate', username, password, source });
}

export async function updateUserIndex(env: Env, username: string, access?: UserAccess): Promise<void> {
  await requestAuth(env, USER_REGISTRY, access ? { action: 'upsert', username, access } : { action: 'remove', username });
}

export async function listUsers(env: Env): Promise<IndexedUser[]> {
  return (await requestAuth<{ users: IndexedUser[] }>(env, USER_REGISTRY, { action: 'list' })).users;
}

async function requestAuth<T = unknown>(env: Env, username: string, body: unknown): Promise<T> {
  const request = new Request('https://git-me.internal/auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const response = await env.GITME_AUTH.getByName(username).fetch(request);
  if (!response.ok) throw new Error('authentication service error');
  return await response.json() as T;
}
