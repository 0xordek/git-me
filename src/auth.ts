import type { Env } from './worker';

export type UserAccess = 'read' | 'write';

type AuthResult = { ok: boolean; access?: UserAccess };

export async function createUser(env: Env, username: string, password: string, access: UserAccess): Promise<void> {
  await requestAuth(env, username, { action: 'create', username, password, access });
}

export async function deleteUser(env: Env, username: string): Promise<void> {
  await requestAuth(env, username, { action: 'delete', username });
}

export async function authenticateUser(env: Env, username: string, password: string, source: string): Promise<AuthResult> {
  return await requestAuth(env, username, { action: 'authenticate', username, password, source });
}

async function requestAuth(env: Env, username: string, body: unknown): Promise<AuthResult> {
  const request = new Request('https://git-me.internal/auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const response = await env.GITME_AUTH.getByName(username).fetch(request);
  if (!response.ok) throw new Error('authentication service error');
  return await response.json() as AuthResult;
}
