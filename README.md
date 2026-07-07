# git-me

A small self-hosted Git LFS utility for Cloudflare Workers, R2, and KV.

Built as a TypeScript Cloudflare Worker.

## Requirements

- Node.js 20+
- Wrangler CLI or project-local `wrangler`
- Cloudflare account with Workers, R2, and KV enabled

## Quick Start

```bash
git clone git@github.com:0xordek/git-me.git
cd git-me
npm ci
npm test
npm run typecheck
npm run deploy:dry
```

## Cloudflare Setup

Create storage resources:

```bash
wrangler r2 bucket create git-me-objects
wrangler kv namespace create git-me-metadata
```

Wrangler prints the KV namespace id. Add it to `wrangler.toml` as `id = "..."` under `[[kv_namespaces]]` if your Wrangler version does not auto-provision or write the id for you.

Before a real deploy, replace the placeholder KV namespace id in `wrangler.toml` with the real KV namespace id from Cloudflare.

Set the auth token as a secret:

```bash
wrangler secret put GITME_AUTH_TOKEN
```

## Transfer Modes

- `proxy`: default mode. The Worker handles Git LFS upload and download bytes through the `PUT /objects/{oid}` and `GET /objects/{oid}` endpoints.
- `direct`: opt-in mode. The Worker returns R2 signed URLs from the batch API so clients upload and download object bytes directly with R2. This requires R2 S3-compatible API credentials in secrets or vars.

Leave `GITME_TRANSFER_MODE` unset for `proxy`, or set it to `direct` to opt in to signed R2 URLs.

## Configuration

| Name | Required | Purpose |
|------|----------|---------|
| `GITME_AUTH_TOKEN` | Yes | Bearer token expected from Git LFS clients |
| `GITME_TRANSFER_MODE` | No | `proxy` by default; set `direct` for signed R2 URLs |
| `GITME_SIGNED_URL_TTL_SECONDS` | No | Signed URL TTL for `direct` mode; defaults to `900` |
| `GITME_R2_ACCOUNT_ID` | Direct mode | Cloudflare account id for R2 S3-compatible signing |
| `GITME_R2_ACCESS_KEY_ID` | Direct mode | R2 API access key id |
| `GITME_R2_SECRET_ACCESS_KEY` | Direct mode | R2 API secret access key |
| `GITME_R2_BUCKET_NAME` | Direct mode | R2 bucket name used in signed URLs |

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

```bash
git lfs track "*.psd" "*.zip" "*.bin"
git add .gitattributes

git config lfs.url https://your-worker.workers.dev
git config http.https://your-worker.workers.dev.extraheader "Authorization: Bearer <token>"
git config lfs.http.https://your-worker.workers.dev.locksverify false
```

Then use `git push` and `git pull` as normal.

## API Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/objects/batch` | Git LFS Batch API |
| PUT | `/objects/{oid}` | Upload object bytes |
| GET | `/objects/{oid}` | Download object bytes |
| GET | `/health` | Configuration health check |

Batch requests and error responses use `application/vnd.git-lfs+json`.
`GET /health` returns `application/json`.

## Storage Layout

- R2 object key: `objects/<oid>`
- Temporary upload key prefix: `objects/.tmp/`
- KV metadata key: `object:<oid>`

## Development

```bash
npm ci
npm test
npm run typecheck
wrangler dev
```

## Security

Do not commit auth tokens or R2 API secrets. Use `wrangler secret put GITME_AUTH_TOKEN` and `wrangler secret put GITME_R2_SECRET_ACCESS_KEY`.

Report vulnerabilities through GitHub Security Advisories. See `SECURITY.md`.

## Contributing

Small fixes and focused issues are welcome. See `CONTRIBUTING.md`.

## License

MIT — see `LICENSE`.
