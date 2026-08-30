# Organization record contributor instructions

Read `README.md` before changing this workspace. The historical
`../../docs/product/2026-08-07-org-decision-record-append-derive-design.md`
explains why the record log is canonical, but current source and tests define
the shipped component boundary.

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
- Fresh stores are created from the byte-pinned SQL baselines. Do not add a
  migration runner or edit a pinned baseline in place; a schema change needs a
  new versioned baseline and explicit compatibility plan.

## Reads and retrieval

- `src/retrieve/person-record-reader-v1.ts` is the permission-aware Person read
  boundary. It resolves current membership and policy facts at query time and
  fails closed when the authorization proof does not match.
- `src/retrieve/record-retrieval-source-snapshot-v1.ts` exposes the bounded
  source snapshot used to build retrieval generations. It must preserve the
  same visibility boundary as direct record reads.
- Record code does not call a model, select an answer, or widen the set of
  released readers.

## Access

- Rows carry provenance and approved visibility-policy facts, not a cached
  answer-time reader list. Effective access is computed by the current Person
  record reader against current membership.
- Restricted-reviewer and organization-member policies must remain distinct.
  A new record or retrieval surface must prove that it cannot release a
  restricted record to another member.

## Scope

- No new runtime dependencies. `better-sqlite3` and
  `@echo-brain/federation-protocol` are the whole surface.
- No second canonical-JSON implementation, ever. Use
  `@echo-brain/federation-protocol`.
- Durable signed shapes belong in `packages/organization-protocol`, not here.
  Keep this workspace free of an import edge to the protocol package.
- This workspace hosts no HTTP listener and knows nothing about routes; the
  authority mounts ingest on its existing listener.
- The schema is closed by default. A new table, column, enum branch, index, or
  trigger must implement named externally observable behavior and ship with a
  focused failing-then-passing behavior test. "Future-proofing" is not a
  reason.
- Deferred on purpose, do not implement without an accepted milestone:
  `correction` events and payload tombstoning, witnessed checkpoints, Merkle
  inclusion proofs, automatic receipt reconciliation, Delta-Lake-style
  checkpointing of replay, and snapshot merging across records.
