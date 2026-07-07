# Final Fix 3 Report

## Finding

Direct batch upload treated `existingMeta.uploaded === true` with missing R2 head or mismatched R2 size as eligible for a new signed `PUT`. That overwrote KV with `{ uploaded: false }` and exposed an overwrite path for the final object key.

## Fix

- Updated `src/worker.ts` direct upload handling so `existingMeta.uploaded === true` always exits before pending metadata creation.
- If existing uploaded metadata has matching R2 head size, response remains `{ oid, size }` with no upload action.
- If R2 head is missing or size differs from the requested object size, response is `objectNotFound(obj)` with no upload action.
- KV metadata is not modified in either existing uploaded metadata path.

## Tests Added

- `direct batch upload with uploaded metadata but missing R2 object returns object error and preserves metadata`
- `direct batch upload with uploaded metadata but R2 size mismatch returns object error and preserves metadata`

## TDD Evidence

- Red: `npm test` failed with the two new tests because `body.objects[0].error` was undefined, confirming old behavior returned an upload action instead of an object error.
- Green: after the worker change, `npm test` passed with 23 tests.

## Verification

- `npm test`: passed, 23 tests.
- `npm run typecheck`: passed.
- `npm run deploy:dry`: passed; Wrangler dry-run completed and exited with `--dry-run: exiting now.`

## Commit

- `fix: preserve uploaded direct metadata`

## Concerns

- Existing untracked `.superpowers/sdd/*` files were present before this fix and were left untouched, except this required report file.
