# git-me

A small self-hosted Git LFS utility for Cloudflare Workers, R2, Durable Objects, and KV-backed legacy-user migration.

Built as a TypeScript Cloudflare Worker.

## Requirements

- Node.js 22+
- Wrangler CLI or project-local `wrangler`
- Cloudflare account with Workers, R2, KV, and Durable Objects enabled

## Quick Start

```bash
git clone git@github.com:0xordek/git-me.git
cd git-me
npm ci
npm run check
```

## Cloudflare Setup

Create storage resources:

```bash
wrangler r2 bucket create git-me-objects
wrangler kv namespace create git-me-metadata
```

Wrangler prints the KV namespace id. Add it to `wrangler.toml` as `id = "..."` under `[[kv_namespaces]]` if your Wrangler version does not auto-provision or write the id for you.

Before a real deploy, replace the placeholder KV namespace id in `wrangler.toml` with the real KV namespace id from Cloudflare. `npm run deploy` creates the `AuthUser` Durable Object migration.

Set the admin token as a secret:

```bash
wrangler secret put GITME_AUTH_TOKEN
```

## Transfer Modes

- `proxy`: default mode. The Worker handles Git LFS upload and download bytes through the `PUT /objects/{oid}` and `GET /objects/{oid}` endpoints.
- `direct`: opt-in download acceleration. Uploads still use the Worker so every object gets SHA-256 verification; downloads receive short-lived signed R2 `GET` URLs.

Leave `GITME_TRANSFER_MODE` unset for `proxy`, or set it to `direct` to opt in to signed R2 downloads. Give direct mode a bucket-scoped, read-only R2 S3 API token.

## Configuration

| Name | Required | Purpose |
|------|----------|---------|
| `GITME_AUTH_TOKEN` | Yes | Admin bearer token for user management and emergency LFS access |
| `GITME_TRANSFER_MODE` | No | `proxy` by default; set `direct` for signed R2 downloads |
| `GITME_SIGNED_URL_TTL_SECONDS` | No | Signed URL TTL for `direct` mode; defaults to `900` |
| `GITME_R2_ACCOUNT_ID` | Direct mode | Cloudflare account id for R2 S3-compatible signing |
| `GITME_R2_ACCESS_KEY_ID` | Direct mode | Read-only R2 API access key id |
| `GITME_R2_SECRET_ACCESS_KEY` | Direct mode | Read-only R2 API secret access key |
| `GITME_R2_BUCKET_NAME` | Direct mode | R2 bucket used in signed download URLs |

Use Wrangler secrets for sensitive values:

```bash
wrangler secret put GITME_R2_SECRET_ACCESS_KEY
```

Deploy:

```bash
npm run deploy:dry
npm run deploy
```

## Git LFS Client Setup

Create a user as the deploy admin. Pass secrets through environment variables or standard input, never command arguments:

```bash
read -rsp 'Admin token: ' GITME_ADMIN_TOKEN; echo
export GITME_ADMIN_TOKEN
read -rsp 'LFS password: ' GITME_LFS_PASSWORD; echo
printf '%s' "$GITME_LFS_PASSWORD" | npx @0xordek/git-me user add \
  --target https://your-worker.workers.dev \
  --token-env GITME_ADMIN_TOKEN \
  --username alice \
  --password-stdin \
  --access write
unset GITME_ADMIN_TOKEN GITME_LFS_PASSWORD
```

Use `"read"` for pull-only users and `"write"` for pull/push users. Delete access with:

```bash
read -rsp 'Admin token: ' GITME_ADMIN_TOKEN; echo
export GITME_ADMIN_TOKEN
npx @0xordek/git-me user delete \
  --target https://your-worker.workers.dev \
  --token-env GITME_ADMIN_TOKEN \
  --username alice
unset GITME_ADMIN_TOKEN
```

Configure a repo:

```bash
git lfs track "*.psd" "*.zip" "*.bin"
git add .gitattributes

git config lfs.url https://your-worker.workers.dev
git config lfs.http.https://your-worker.workers.dev.locksverify false
```

For shared repositories, commit `.lfsconfig` so fresh clones use the Worker too:

```bash
git config -f .lfsconfig lfs.url https://your-worker.workers.dev
git add .lfsconfig
git commit -m "chore: configure git-me lfs"
```

Then use `git push` and `git pull` as normal. On first LFS access, Git asks for username and password. Git Credential Manager stores it on the machine, so deleting and cloning the repo again usually does not ask while the worker host stays the same.

The admin bearer token also works for LFS as an emergency write credential, but normal users should use Basic auth users created through `/admin/users/{username}`.

If you do not want the CLI, the same operations are available through `PUT` and `DELETE /admin/users/{username}`.

## Migrating Existing LFS Objects

Use the migration CLI from a local repository to copy objects from the current LFS server into `git-me`:

```bash
read -rsp 'Target token: ' GITME_TARGET_TOKEN; echo
export GITME_TARGET_TOKEN
npx @0xordek/git-me migrate --target https://your-worker.workers.dev --token-env GITME_TARGET_TOKEN --dry-run
unset GITME_TARGET_TOKEN
```

Run `--dry-run` first. It scans local Git LFS pointer files, deduplicates object IDs, and reports `scanned`, `unique`, `migrated`, `skipped`, and `failed` without transferring object bytes or writing Git config.

For a GitHub source, pass the source LFS URL explicitly when it is not already in `git config lfs.url`:

```bash
read -rsp 'Target token: ' GITME_TARGET_TOKEN; echo
export GITME_TARGET_TOKEN
npx @0xordek/git-me migrate \
  --source-url https://github.com/OWNER/REPO.git/info/lfs \
  --target https://your-worker.workers.dev \
  --token-env GITME_TARGET_TOKEN \
  --dry-run
unset GITME_TARGET_TOKEN
```

For another Git LFS server, use its Batch API base URL as `--source-url`:

```bash
read -rsp 'Target token: ' GITME_TARGET_TOKEN; echo
export GITME_TARGET_TOKEN
npx @0xordek/git-me migrate \
  --source-url https://source.example.com/repo.git/info/lfs \
  --target https://your-worker.workers.dev \
  --token-env GITME_TARGET_TOKEN \
  --dry-run
unset GITME_TARGET_TOKEN
```

Private source repositories usually require an extra source header. Repeat `--source-header-env` for every environment variable containing a `name: value` header:

```bash
read -rsp 'Target token: ' GITME_TARGET_TOKEN; echo
export GITME_TARGET_TOKEN
read -rsp 'Source header: ' GITME_SOURCE_AUTH; echo
export GITME_SOURCE_AUTH
npx @0xordek/git-me migrate \
  --source-url https://github.com/OWNER/PRIVATE-REPO.git/info/lfs \
  --source-header-env GITME_SOURCE_AUTH \
  --target https://your-worker.workers.dev \
  --token-env GITME_TARGET_TOKEN \
  --dry-run
unset GITME_TARGET_TOKEN GITME_SOURCE_AUTH
```

After a successful real migration, add `--write-config` to update the repository's `lfs.url` to the target:

```bash
read -rsp 'Target token: ' GITME_TARGET_TOKEN; echo
export GITME_TARGET_TOKEN
npx @0xordek/git-me migrate \
  --target https://your-worker.workers.dev \
  --token-env GITME_TARGET_TOKEN \
  --write-config
unset GITME_TARGET_TOKEN
```

Safety model: the CLI uses the generic Git LFS Batch API for source downloads and target uploads. Object bytes are streamed through temporary files named `git-me-migrate-*` in the OS temp directory, not buffered in memory, and each downloaded file must match the pointer SHA-256 OID before upload. Temporary files are removed after each object attempt, and `--write-config` only runs when the migration has no failures.

## API Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/objects/batch` | Git LFS Batch API |
| PUT | `/objects/{oid}` | Upload object bytes |
| GET | `/objects/{oid}` | Download object bytes |
| PUT | `/admin/users/{username}` | Create or update LFS user |
| DELETE | `/admin/users/{username}` | Delete LFS user |
| GET | `/health` | Configuration health check |

Batch requests and error responses use `application/vnd.git-lfs+json`.
`GET /health` returns `application/json`.

## Storage Layout

- R2 object key: `objects/<oid>`
- Temporary proxy-upload key prefix: `objects/.tmp/`
- Durable Object: one `AuthUser` instance per normalized username
- KV user key: `user:<username>` only during legacy SHA-256 credential upgrade

## Development

```bash
npm ci
npm run check
wrangler dev
```

## Security

Do not commit auth tokens or R2 API secrets. Use `wrangler secret put GITME_AUTH_TOKEN` and `wrangler secret put GITME_R2_SECRET_ACCESS_KEY`.

`proxy` uploads stream through the Worker and must match their Git LFS SHA-256 OID before becoming readable. `direct` mode only signs R2 downloads; it never signs uploads. Use a bucket-scoped, read-only R2 credential for direct mode.

Existing deployments upgraded from a release that signed direct uploads must first set `GITME_TRANSFER_MODE=proxy`, audit every `objects/<oid>` object against its SHA-256 filename, and quarantine mismatches. Rotate the old R2 S3 API token before enabling direct downloads again. Objects without the `v0.3` Worker verification marker always fall back to proxy downloads, even when `direct` mode is enabled.

New passwords use salted PBKDF2-SHA-256 records in Durable Objects. Existing KV SHA-256 records upgrade after one successful login. Deleted users leave a Durable Object tombstone, so stale KV reads cannot restore access. Authentication locks one client source for one username for one minute after five failed attempts in one minute.

`GET /health` checks configuration only. It does not prove R2, KV, or Durable Object availability. Failed requests emit a request ID in `X-Request-Id`; logs never include credentials or request bodies.

Report vulnerabilities through GitHub Security Advisories. See `SECURITY.md`.

## Contributing

Small fixes and focused issues are welcome. See `CONTRIBUTING.md`.

## License

MIT — see `LICENSE`.
