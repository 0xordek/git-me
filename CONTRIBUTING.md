# Contributing

`git-me` is a small self-hosted Git LFS utility. Keep changes focused, documented, and easy to review.

## Setup

```bash
git clone git@github.com:0xordek/git-me.git
cd git-me
npm ci
npm run check
```

## Guidelines

- Prefer small PRs.
- Keep routing in `src/worker.ts`, auth state in `src/auth-do.ts`, and CLI behavior in `src/cli.ts`.
- Keep behavior covered by focused tests beside each component.
- Never commit secrets. Use `wrangler secret put GITME_AUTH_TOKEN`.
- Add or update tests for behavior changes.
- When touching Git LFS batch actions, cover proxy upload plus proxy and direct-download behavior.
- Worker and Durable Object behavior must also pass `npm run test:workers` in the local Workers runtime.
- Do not add secret-valued CLI arguments. Use environment variables or standard input.
- When touching migration CLI code, run or update the CLI and migration tests in `test/cli.test.ts` and `test/migrate.test.ts`.
- Update `README.md`, `SECURITY.md`, and `CHANGELOG.md` when public behavior or security changes.

## Before opening a PR

Run the full pre-PR check set:

```bash
npm run check
```

`npm run check` rebuilds `dist/cli.js` and fails when committed output is stale.
It also checks generated Wrangler binding types and runs both Node and Workers-runtime test projects.
