# Changelog

All notable changes to this project will be documented in this file.

## Unreleased

- Rewrote the Worker runtime as TypeScript.
- Removed Go and TinyGo source/build files from the current tree without rewriting git history.
- Switched tests to Vitest with typed R2/KV mocks.
- Switched CI and release verification to Node, TypeScript, and Wrangler.
- Kept the Cloudflare Worker deployment path with R2/KV bindings.
- Kept bearer-token Git LFS client setup.
- Kept edge-case tests for Git LFS batch, upload, download, and auth behavior.
