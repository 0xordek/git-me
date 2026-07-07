# Contributing to git-me

Thanks for your interest in contributing! This project follows **project planning** with a standard contribution workflow. See `CONTRIBUTING.md` for the full agent workflow guide.

## Development Setup

1. Install Go 1.22+ and TinyGo 0.32+
2. Install Node.js 20+ and Wrangler: `npm install -g wrangler`
3. Clone the repository: `git clone git@github.com:0xordek/git-me.git`
4. Run verification: `go test -v -race -count=1 ./... && go vet ./... && npm test && make build`

## Workflow

1. **Brainstorm** — design new features in `design notes`
2. **Plan** — write detailed implementation plans in `implementation notes`
3. **Implement with TDD** — write failing tests first, then implementation code
4. **Verify** — `go test -v -race -count=1 ./...`, `go vet ./...`, `npm test`, and `make build` before committing
5. **Review** — request code review for non-trivial changes
6. **Create PR** against `main`

## Code Style

- Follow existing patterns in the codebase
- Keep interfaces small (1-3 methods). Compose them when needed.
- Files under 400 lines — split if a file grows beyond this
- Cloudflare-specific code behind `//go:build tinygo.wasm` build tags
- Store `GITME_AUTH_TOKEN` with `wrangler secret put GITME_AUTH_TOKEN`; never commit real secrets
- Godoc comments on all public types and functions
- Errors are values — return them, don't panic
- Standard library only for core logic — no external dependencies
