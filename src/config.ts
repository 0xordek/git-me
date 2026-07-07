import type { Env } from './worker';

export type TransferMode = 'proxy' | 'direct';

export type R2SigningConfig = {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucketName: string;
};

export type AppConfig = {
  authToken: string;
  transferMode: TransferMode;
  signedUrlTtlSeconds: number;
  r2Signing?: R2SigningConfig;
};

export class ConfigError extends Error {
  constructor(message = 'configuration error') {
    super(message);
    this.name = 'ConfigError';
  }
}

export function loadConfig(env: Env): AppConfig {
  if (!env.GITME_AUTH_TOKEN) throw new ConfigError();

  const transferMode = env.GITME_TRANSFER_MODE ?? 'proxy';
  if (transferMode !== 'proxy' && transferMode !== 'direct') throw new ConfigError();

  const signedUrlTtlSeconds = parseSignedUrlTtl(env.GITME_SIGNED_URL_TTL_SECONDS);
  const config: AppConfig = { authToken: env.GITME_AUTH_TOKEN, transferMode, signedUrlTtlSeconds };

  if (transferMode === 'direct') {
    const { GITME_R2_ACCOUNT_ID, GITME_R2_ACCESS_KEY_ID, GITME_R2_SECRET_ACCESS_KEY, GITME_R2_BUCKET_NAME } = env;
    if (!GITME_R2_ACCOUNT_ID || !GITME_R2_ACCESS_KEY_ID || !GITME_R2_SECRET_ACCESS_KEY || !GITME_R2_BUCKET_NAME) {
      throw new ConfigError();
    }
    config.r2Signing = {
      accountId: GITME_R2_ACCOUNT_ID,
      accessKeyId: GITME_R2_ACCESS_KEY_ID,
      secretAccessKey: GITME_R2_SECRET_ACCESS_KEY,
      bucketName: GITME_R2_BUCKET_NAME,
    };
  }

  return config;
}

export function healthResponse(env: Env): Response {
  try {
    const config = loadConfig(env);
    return appJson(200, { ok: true, transfer_mode: config.transferMode });
  } catch {
    return appJson(500, { ok: false });
  }
}

function parseSignedUrlTtl(raw: string | undefined): number {
  if (raw === undefined) return 900;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 60 || value > 3600) throw new ConfigError();
  return value;
}

function appJson(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body) + '\n', { status, headers: { 'Content-Type': 'application/json' } });
}
