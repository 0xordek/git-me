# Contributing

`git-me` is a small personal utility. Keep changes focused and easy to review.

## Setup

```bash
git clone git@github.com:0xordek/git-me.git
cd git-me
go test -v -race -count=1 ./...
go vet ./...
npm test
make build
```

## Guidelines

- Prefer small PRs.
- Keep core Go code dependency-free.
- Keep Cloudflare runtime code in `src/worker.js`.
- Never commit secrets. Use `wrangler secret put GITME_AUTH_TOKEN`.
- Add or update tests for behavior changes.

## Before opening a PR

Run:

```bash
go test -v -race -count=1 ./...
go vet ./...
npm test
make build
```
