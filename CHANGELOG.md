# Changelog

All notable changes to this project will be documented in this file.

## 0.5.0 - 2026-07-12

- Fixed macOS Keychain writes so generated admin secrets are supplied through stdin with the required `-w` prompt option.
- Made proxy uploads settle storage and digest streams, clean temporary objects on every path, and route asynchronous failures through the Worker error boundary.
- Added constant-time bearer checks, UTF-8 Basic authentication, bounded password/object validation, and malformed-path handling.
- Switched `AuthUser` communication from JSON-over-fetch to typed Durable Object RPC while preserving existing records, tombstones, and migration state.
- Added generated binding types, Workers-runtime integration tests, observability defaults, stricter indexed-access checks, and compatible Cloudflare/Vitest upgrades.
- Secured migration temp files and secret-bearing URLs, detected conflicting pointer sizes, and added a fixed SigV4 signing vector.
- Simplified CLI-only Node imports and removed the unused profile `current` field without invalidating existing profile files.

## 0.4.1 - 2026-07-11

- Fixed npm-installed CLI commands silently exiting when launched through symlinked bin paths.
- Added direct and symlinked CLI entrypoint regression coverage.

## 0.4.0 - 2026-07-10

- Added zero-config `worker deploy` with packaged Worker bundle, resource provisioning, health checks, and local profiles.
- Added OS credential-store integration with stdin/environment fallback for admin credentials.
- Added `user list`, delete confirmation, JSON output, and a password-free admin user index.

## 0.3.0 - 2026-07-09

- Moved user credentials and login throttling into per-user Durable Objects.
- Replaced unsalted SHA-256 credential storage with salted PBKDF2-SHA-256 records; legacy users upgrade after successful login.
- Changed `direct` mode to signed R2 downloads only; uploads always use Worker SHA-256 verification.
- Removed KV object metadata from object-presence checks; R2 is authoritative for object existence and size.
- Removed secret-valued CLI arguments in favor of environment variables and standard input.
- Renamed npm package to `@0xordek/git-me` and added provenance-ready publishing metadata.
- Added Durable Object migration, package-artifact verification, and npm trusted-publishing release flow.

## 0.2.0 - 2026-07-09

- Added admin-managed Git LFS users backed by KV.
- Added Basic auth prompts for Git LFS clients.
- Added read/write access checks for pull and push flows.
- Documented first-login credential storage and repo-level `.lfsconfig` setup.

## 0.1.0 - 2026-07-08

- Rewrote the Worker runtime as TypeScript.
- Removed Go and TinyGo source/build files from the current tree without rewriting git history.
- Switched tests to Vitest with typed R2/KV mocks.
- Switched CI and release verification to Node, TypeScript, and Wrangler.
- Kept the Cloudflare Worker deployment path with R2/KV bindings.
- Kept bearer-token Git LFS client setup.
- Kept edge-case tests for Git LFS batch, upload, download, and auth behavior.
- Added opt-in direct R2 transfer mode using signed URLs.
- Added `GET /health` for configuration health checks.
- Added `npx git-me migrate` for copying existing Git LFS objects into `git-me`.
- Removed temporary design and plan docs from the tracked tree when present.
