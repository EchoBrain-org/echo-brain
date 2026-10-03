# Vendor-free capture core V1

**Status: Proposed build brief.** Branch `feat/capture-core`, based on main
`63c4764` (PR #266). This brief is the hand-off for the implementation
session. It adds the minimum runtime between providers and the existing
`SqliteCaptureFoundationV1` store. It activates no provider and changes no
production composition.

## Goal

One vendor-free path that takes V2 capture content from any provider and
stores it in Layer 1. Vendor code stays in `providers/<tool>/` plus one config
row. The core is built and tested against a fake provider before any real
provider is migrated.

Knowing an item came from Slack is data (`adapter_id`, the `slack:` ref prefix,
`origin_ref`). It is never a branch in core code.

## Non-goals

- No provider migration (Jira, Slack, Granola stay on V1 in this change).
- No scheduler service, job queue, review queue, policy engine or plugin framework.
- No model calls, derivation persistence, read path, graph, Evidence Desk or Ask change.
- No SQL baseline change and no state reset.
- No change to V1 capture paths or staging rehearsal profiles.

## What already exists (do not rebuild)

- `ContextCaptureContentV2`, `buildContextCaptureEnvelopeV2`, validators
  (`packages/organization-processing/src/core/contracts/context-capture-v2.ts`).
- Ref grammar and container scope (`capture-source-ref-v1.ts`,
  `capture-container-scope-v1.ts`).
- Classification, bindings, annotation and derive contracts
  (`context-derivation-v1.ts`).
- `SqliteCaptureFoundationV1(database, authority, containers)` with
  `admit()` and `snapshot()`, including fences, predecessor and fork checks
  (`services/organization-authority/src/adapters/persistence/sqlite/capture-foundation-v1.ts`).
- `CaptureFoundationAuthorityV1.requireCurrent` interface, no production implementation
  (`services/organization-authority/src/application/capture-foundation-v1.ts`).

## What to build

### 1. Provider-facing port (core contract)

Providers return content, not finished envelopes, because the predecessor is
chosen by Authority, not by the provider.

```ts
interface CaptureSourceV2 {
  readonly identity: SourceAdapterIdentityV1;            // kind 'source'
  pull(request: { cursor?: string; limit: number }, context?: AdapterOperationContext):
    Promise<{ items: readonly { external_id: string; captured_at: string; content: ContextCaptureContentV2 }[];
              next_cursor?: string }>;
}
```

Place it beside the V2 contracts in `organization-processing/core`. Validate the
returned batch shape, bounds (limit, cursor bytes) and freeze it before any
async step, following `createContextSourceIntakeV1`.

### 2. Source config (data, not code)

```ts
interface CaptureSourceConfigV1 {
  schema_version: 1;
  source_id: string;                                    // ECHO's id for this connected source
  adapter: SourceAdapterIdentityV1;                     // must equal provider.identity
  scope: SourceAdmissionScopeV1;                        // org, custody_ref, access_policy_ref, analysis_policy 'on_request'
  containers: CaptureContainerScopeV1;                  // exact container_ref -> project_id
  disposition: 'retained';                              // request_only stays on the live-reader path
  representations: readonly ('pointer' | 'excerpt' | 'full_snapshot')[];
  classifier: { id: string; version: string };         // config_sha256 is derived from this config
}
```

Closed-field validator, canonical digest. For this change the config is passed
in by composition or tests. Storing and editing it is later work.

### 3. Provider map

`Record<adapter_id, (config, deps) => { source: CaptureSourceV2; require_read_current(context?): void | Promise<void> }>`.
The read-grant check is provider-owned; the core only calls it before the pull
and again before admission. No provider is registered in this change except the
fake in tests.

### 4. Real permission check

A `CaptureFoundationAuthorityV1` built from the config row:

- adapter identity, `scope` and container mapping equal the config;
- representation is in `representations`;
- `people` must be empty unless an injected identity-link checker verifies each binding (default: reject non-empty);
- a document `original_artifact` is rejected unless an injected artifact-custody checker accepts it;
- synchronous only (the store already rejects a Promise).

### 5. Classification rule

Local rules only, vendor-free. Default: valid present capture → `retain/useful`;
tombstone → `retain/source_deleted`. Producer is `{ id, version, config_sha256 }`
from the config. Leave a seam for kind-based skip rules; add none yet.

### 6. Head lookup

The latest retained V2 revision for a `source_id` (the one with no successor).
The fork guard guarantees at most one. Return the full verified envelope so it
can be passed as `previous` to `buildContextCaptureEnvelopeV2`. Prefer a method
on `SqliteCaptureFoundationV1` that reuses its integrity checks.

### 7. Bookmark

Sidecar file `capture-cursors.sqlite` in the state directory, table
`(source_id PRIMARY KEY, cursor, updated_at)`. Written only after a batch is
fully admitted. Not atomic with `authority.sqlite`; this is safe because replay
is idempotent (unchanged content reuses its revision and returns `duplicate`).
Do not add tables to `authority.sqlite`; its baseline is fresh-init only.

### 8. `runCaptureSourceOnce(source_id)`

1. Load config, resolve provider from the map, check identity matches.
2. Read bookmark. `require_read_current`. Pull.
3. Validate and freeze the batch. `require_read_current` again.
4. For each item: head lookup → `buildContextCaptureEnvelopeV2({ previous })` →
   classify → bindings (`project_id`/`container_ref` from container scope, `people: []`) →
   `store.admit()`.
5. On `unresolved`: stop, do not advance the bookmark, return the retry ref.
6. After the whole batch: advance the bookmark.
7. Return counts `{ admitted, duplicate, skipped, stopped_at? }` with no content.

One pull at a time per source (reject concurrent runs). Propagate abort signals.
Expose it as a manual command or test entry only; no timer.

## Tests

- **Fake provider** in `tests/support`: emits ticket, message, meeting, note and
  document content in two containers, then a changed revision, an unchanged
  repoll and an explicit tombstone.
- End to end on real SQLite: first run admits, rerun is all duplicates, a changed
  item links to its predecessor, restart preserves bookmark and lineage, crash
  between admit and bookmark replays to duplicates.
- Refusals: unmapped container, disallowed representation, identity mismatch,
  non-empty people without a checker, revoked read grant mid-run, abort, concurrent run.
- **Vendor-name architecture test**: fails if any core capture file (the V2
  contracts and every file added here) matches `/slack|jira|granola/i`.

## Done when

- typecheck, lint and the tests above pass; existing tests unchanged.
- The architecture test passes, and no file under `providers/` changed.
- A later Jira V2 mapper would need only `providers/jira/` plus one config row.
  If anything here would need a vendor branch, stop and record it as a contract
  question instead.
