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

Set the auth token as a secret:

```bash
wrangler secret put GITME_AUTH_TOKEN
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

Batch requests and error responses use `application/vnd.git-lfs+json`.

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

Do not commit auth tokens. Use `wrangler secret put GITME_AUTH_TOKEN`.

Report vulnerabilities through GitHub Security Advisories. See `SECURITY.md`.

## Contributing

Small fixes and focused issues are welcome. See `CONTRIBUTING.md`.

## License

MIT — see `LICENSE`.
