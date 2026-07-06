# git-me

A self-hosted Git LFS server that runs entirely on Cloudflare's free tier.

Built with TinyGo, running on Cloudflare Workers, using R2 for object storage and KV for metadata.

## Quick Start

### Prerequisites
- Go 1.22+
- TinyGo 0.32+
- [Wrangler](https://developers.cloudflare.com/workers/wrangler/) CLI

### Setup

```bash
git clone https://github.com/yourusername/git-me.git
cd git-me
make test     # Run tests
make build    # Build WASM binary
```

### Deploy to Cloudflare

1. Create an R2 bucket named `git-me-objects` in your Cloudflare dashboard
2. Create a KV namespace for metadata
3. Update `wrangler.toml` with your KV namespace ID
4. Set your auth token: `GITME_AUTH_TOKEN=your-secret-token`
5. Deploy:

```bash
wrangler deploy
```

### Connect Your Git LFS Client

```bash
git lfs track "*.psd" "*.zip" "*.bin"
git add .gitattributes

git config lfs.url https://your-worker.workers.dev
git config lfs.http://your-worker.workers.dev.access basic
# Token goes in the username field (password is ignored):
git config lfs.http://your-worker.workers.dev.locksverify false
```

Then use `git push` as normal — LFS files will be stored in your Cloudflare account.

## Architecture

```
Git Client → Cloudflare Worker → TinyGo WASM App → KV (metadata) / R2 (objects)
```

See [project overview](project overview) and [architecture notes](architecture notes) for full details.

## API Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/objects/batch` | Batch API — discover upload/download actions |
| PUT | `/objects/{oid}` | Upload a binary object |
| GET | `/objects/{oid}` | Download a binary object |

Content-Type: `application/vnd.git-lfs+json` for Batch API, `application/octet-stream` for object data.

## Configuration

All configuration via environment variables:

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `GITME_AUTH_TOKEN` | Yes | — | Bearer token for authenticating LFS clients |
| `GITME_R2_BUCKET` | No | `git-me-objects` | R2 bucket name for object storage |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and workflow.

## License

MIT — see [LICENSE](LICENSE).
