# TypeScript-only Worker design

## Goal

Convert `git-me` to a TypeScript-first Cloudflare Worker Git LFS utility.
Go and TinyGo code are removed from the current tree only. Git history is not rewritten.

## Scope

In scope:

- Rename the Worker from `src/worker.js` to `src/worker.ts`.
- Rename tests from `test/worker.test.js` to `test/worker.test.ts`.
- Add TypeScript, Vitest, and Cloudflare Worker types.
- Remove `go.mod`, `cmd/`, `internal/`, and `Makefile`.
- Remove Go and TinyGo steps from CI and release workflows.
- Update docs to describe Node, TypeScript, Wrangler, R2, and KV only.

Out of scope:

- Git history purge.
- New auth schemes.
- New Git LFS transfer adapters.
- New storage backends.
- UI or dashboard features.

## Runtime architecture

`src/worker.ts` exports a Cloudflare Worker module with one `fetch` handler.

Bindings:

- `GITME_R2`: R2 bucket for object bytes.
- `GITME_KV`: KV namespace for object metadata.
- `GITME_AUTH_TOKEN`: bearer token required for all routes.

Routes remain unchanged:

- `POST /objects/batch`
- `PUT /objects/:oid`
- `GET /objects/:oid`

## Data model

R2 object keys:

- Final object: `objects/<oid>`
- Temporary upload: `objects/.tmp/<uuid>`

KV metadata key:

- `object:<oid>`

Metadata shape:

```ts
type ObjectMeta = {
  oid: string;
  size: number;
  created_at: string;
  uploaded: true;
};
```

## Request flow

All requests require `Authorization: Bearer <GITME_AUTH_TOKEN>`.

Batch upload returns a basic upload action for each valid object.

Batch download checks KV metadata and R2 existence. Missing data returns per-object LFS 404 errors, not a whole-request failure.

Upload writes request bytes to a temporary R2 key while computing SHA-256. If digest does not match the path OID, the temporary key is deleted and no metadata is written. If digest matches, the temp object is copied to `objects/<oid>`, temp is deleted, and KV metadata is written.

Download checks KV metadata and R2 object existence, then streams bytes with `application/octet-stream` and `Content-Length`.

## Error handling

LFS API errors return JSON with `Content-Type: application/vnd.git-lfs+json` and shape:

```json
{ "message": "..." }
```

Object-level batch download misses return:

```json
{
  "oid": "...",
  "size": 123,
  "error": { "code": 404, "message": "object not found" }
}
```

Current behavior is preserved unless TypeScript requires explicit narrowing.

## Tests

Use Vitest with typed in-memory R2 and KV mocks.

Keep these behavioral tests:

- Batch upload returns an upload action.
- Batch download returns an absolute download action href.
- Non-array `transfers` is rejected.
- Upload writes R2 object and KV metadata.
- Download returns bytes and headers.
- Auth is required.
- Hash mismatch does not write KV metadata.
- Hash mismatch preserves an existing object and metadata.
- Batch download returns an object error when R2 object is missing.

Verification gates:

- `npm test`
- `npm run typecheck`
- `npx wrangler deploy --dry-run`
- grep for stale Go/TinyGo references after migration

## CI and release

CI should use Node only:

- install dependencies
- run tests
- run typecheck
- run Wrangler dry deploy

Release workflow should not install Go or TinyGo and should not run `make build`.

## Documentation

README and CONTRIBUTING describe:

- TypeScript Cloudflare Worker runtime
- Node and Wrangler development
- R2 and KV bindings
- bearer token configuration
- Git LFS client setup

CHANGELOG notes the TypeScript-only rewrite and HEAD-only Go/TinyGo removal.
