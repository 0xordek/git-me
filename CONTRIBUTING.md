# Contributing

`git-me` is a small personal utility. Keep changes focused and easy to review.

## Setup

```bash
git clone git@github.com:0xordek/git-me.git
cd git-me
npm ci
npm run check
```

## Guidelines

- Prefer small PRs.
- Keep Cloudflare runtime code in `src/worker.ts`.
- Keep behavior covered by tests in `test/worker.test.ts`.
- Never commit secrets. Use `wrangler secret put GITME_AUTH_TOKEN`.
- Add or update tests for behavior changes.
- When touching Git LFS batch actions, cover both `proxy` and `direct` transfer behavior.
- When touching migration CLI code, run or update the CLI and migration tests in `test/cli.test.ts` and `test/migrate.test.ts`.

## Before opening a PR

Run the full pre-PR check set:

```bash
npm run check
```
