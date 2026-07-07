# git-me

A self-hosted Git LFS server for Cloudflare Workers, R2, and KV.

Built with TinyGo for the Go protocol core and a Cloudflare Worker module for deployment.

## Requirements

- Go 1.22+
- TinyGo 0.32+
- Node.js 20+
- Wrangler CLI
- Cloudflare account with Workers, R2, and KV enabled

## Quick Start

```bash
git clone git@github.com:0xordek/git-me.git
cd git-me
go test -v -race -count=1 ./...
go vet ./...
npm test
make build
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
wrangler deploy --dry-run
wrangler deploy
```

## Git LFS Client Setup

```bash
git lfs track "*.psd" "*.zip" "*.bin"
git add .gitattributes

git config lfs.url https://your-worker.workers.dev
git config lfs.http.https://your-worker.workers.dev.extraheader "Authorization: Bearer <token>"
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
- KV metadata key: `object:<oid>`

## Development

```bash
go test -v -race -count=1 ./...
go vet ./...
npm test
make build
wrangler dev
```

## Security

Do not commit auth tokens. Use `wrangler secret put GITME_AUTH_TOKEN`.

Report vulnerabilities through GitHub Security Advisories. See `SECURITY.md`.

## Contributing

See `CONTRIBUTING.md`.

## License

MIT — see `LICENSE`.
