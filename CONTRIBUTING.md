# Contributing

`git-me` is a small personal utility. Keep changes focused and easy to review.

## Setup

```bash
git clone git@github.com:0xordek/git-me.git
cd git-me
npm ci
npm test
npm run typecheck
npm run deploy:dry
```

## Guidelines

- Prefer small PRs.
- Keep Cloudflare runtime code in `src/worker.ts`.
- Keep behavior covered by tests in `test/worker.test.ts`.
- Never commit secrets. Use `wrangler secret put GITME_AUTH_TOKEN`.
- Add or update tests for behavior changes.

## Before opening a PR

Run:

```bash
npm test
npm run typecheck
npm run deploy:dry
```
