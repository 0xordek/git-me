# Changelog

All notable changes to this project will be documented in this file.

## Unreleased

- Added CLI commands for admin-managed LFS users.

## 0.2.0 - 2026-07-09

- Added admin-managed Git LFS users backed by KV.
- Added Basic auth prompts for Git LFS clients.
- Added read/write access checks for pull and push flows.
- Documented first-login credential storage and repo-level `.lfsconfig` setup.

## 0.1.0 - 2026-07-09

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
