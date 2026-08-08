# Organization record contributor instructions

Read `README.md` and
`../../docs/product/2026-08-07-org-decision-record-append-derive-design.md`
before changing this workspace.

The log is truth and the derived graph is disposable. That split is the whole
design; most rules below are consequences of it.

## The log

- The log records facts; interpretation is derived. Litmus test: if deleting it
  loses truth it is a log event; if it can be recomputed from the log it is
  derived. Never add a derived field to a log row.
- No `UPDATE` and no `DELETE` statement may enter the append path. A field that
  needs to change after commit belongs in a create-once sibling table or is not
  a log field.
- The record frame is frozen by golden fixtures. Changing its shape, its field
  set, or its canonicalization changes every record hash ever issued, so it is
  a new `schema_version`, never an edit.
- Migrations stay contiguous from `0001`. The log and derived series are
  separate; never renumber or rewrite an applied migration.

## Derive

- Derivation reads nothing but the log. No authority state, no wall clock, no
  model calls, no entity resolution, no principal binding. If a change needs
  any of those, it belongs in the later interpretive pass, not here.
- Every derived row id must stay a pure function of log content, and the
  rebuild test must keep passing: a fresh derived store replaying the log
  reproduces `contentDigest()` exactly.
- All rows, edges, and the cursor advance for one record commit in one
  transaction. Never widen that to a batch and never advance the cursor
  separately.
- Every derived insert stays strict. `INSERT OR IGNORE` turns a real conflict
  into a silent partial commit, so duplicates that valid log content can
  produce are deduplicated deterministically in the pure projector and
  everything else is left to conflict, roll back, and halt.
- An unprocessable record halts the follower with an alert. Do not add a skip
  path: visible staleness is the designed behavior.

## Access

- Rows carry provenance facts and approver intent (`restricted`). They never
  carry resolved reader lists and never bind observations to principals.
  Effective access is computed at query time by a future gatekeeper against
  current membership.
- A future edge type must be filterable as rigorously as a node, and an edge is
  visible only when both endpoints are. Derive v1 is safe by construction —
  `supports` never crosses an approval group — and any new cross-approval edge
  must pass that rule before shipping.

## Scope

- No new runtime dependencies. `better-sqlite3` and
  `@echo-brain/federation-protocol` are the whole surface.
- No second canonical-JSON implementation, ever. Use
  `@echo-brain/federation-protocol`.
- Durable signed shapes belong in `packages/organization-protocol`, not here.
  Keep `src/application/contracts.ts` a minimum structural view and keep this
  workspace free of an import edge to the protocol package.
- This workspace hosts no HTTP listener and knows nothing about routes; the
  authority mounts ingest on its existing listener.
- The minimum-v1 schema is closed by default. A new table, column, enum branch,
  index, or trigger must implement a named externally observable milestone
  behavior, be assigned in `TABLES_BY_OBSERVABLE_BEHAVIOR` in
  `test/record-migrations.test.ts`, and ship with a failing-then-passing
  behavior test. "Future-proofing" is not a reason.
- Deferred on purpose, do not implement without an accepted milestone:
  `correction` events and payload tombstoning, witnessed checkpoints, Merkle
  inclusion proofs, automatic receipt reconciliation, Delta-Lake-style
  checkpointing of the replay, snapshot merging across records, and any
  retrieval or permission surface.
