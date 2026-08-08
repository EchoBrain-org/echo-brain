# Organization record

The organization's single append-only record of human-approved decisions, plus
the deterministic graph derived from it. Implements the append and derive
halves of
[`docs/product/2026-08-07-org-decision-record-append-derive-design.md`](../../docs/product/2026-08-07-org-decision-record-append-derive-design.md).
Retrieval and the permission gatekeeper are deliberately out of scope.

Like `organization-control-plane`, this is a **library, not a service**, despite
its `services/` path: no `bin`, no process entry point, no listener. It is
linked into the customer-hosted authority process and hosted behind that
process's authenticated singleton guard. Charters are enforced at the database
level, so the authority's "does not store decisions" stays true of
`authority.sqlite`.

## Two databases

| File | Role |
| --- | --- |
| `record-log.sqlite` | The immutable log. Truth. |
| `record-derived.sqlite` | The derived graph. Disposable, rebuildable. |

Both follow the existing service convention: `journal_mode = DELETE` (a stopped
database is inspectable read-only without WAL/SHM sidecars, and `state-backup`
refuses WAL sidecars), `trusted_schema = OFF`, `temp_store = MEMORY`, and
contiguous `NNNN_name.sql` migrations applied under `BEGIN IMMEDIATE` with
`PRAGMA user_version` as the counter and a checksum ledger over both. Distinct
`application_id`s (`ECRL`, `ECRD`) mean the wrong file is refused before any
statement runs.

## Three machines, two of them here

Append, derive, and retrieve never call each other; they communicate only
through data at rest. The boundary manifest enforces it — `src/derive/**`
cannot import `src/log/**`. Derive reads the log through
`OrganizationRecordLogReader`, a read-only interface over the runtime's log
database handle.

### Append

`OrganizationRecordIngest.append(envelope)` is verify, then dedupe and append:

1. **Verify** — the injected `OrganizationRecordAuthorityPort`. Payload
   validation happens before append, always: an immutable log must never accept
   a record derive cannot process.
2. **Dedupe and append** — one serialized `BEGIN IMMEDIATE` transaction
   enforcing `UNIQUE(installation_id, idempotency_key)`. A matching duplicate
   returns the stored original receipt unchanged; a known key with a different
   envelope digest is a permanent `idempotency_conflict`. A new key gets the
   next monotonic position and record hash, and the deterministic receipt
   payload is stored with the row.

Ahead of both, one narrow exception: a resend whose **exact** canonical bytes
and digest already sit under the same installation-scoped idempotency key skips
verification and returns that committed row's receipt. Re-authorizing a resend
as a new act would let a lease that expired — or a membership revoked — after
the append permanently strand a durable record with no receipt. The resend is
not a new act, the caller already holds the member's signed envelope, and all
it recovers is that member's own receipt for it. Anything else takes the full
verification path: an absent row faces undiminished authority verification, and
divergent content under a known key still raises `idempotency_conflict`.

The versioned record frame is RFC 8785 canonical JSON and
`record_hash = sha256(canonical_record_frame_bytes)`:

```json
{
  "schema_version": 1,
  "kind": "echo-organization-record-frame",
  "organization_id": "...",
  "position": 1,
  "previous_record_hash": null,
  "recorded_at": "...",
  "envelope_sha256": "sha256:..."
}
```

There is no update and no delete statement in the append path. Triggers reject
update, delete, non-contiguous insertion, and a broken predecessor link through
ordinary code paths; the hash chain catches out-of-band mutation.

`verifyOrganizationRecordChain` walks the chain — the host runs it at process
start and before every backup, because a chain nobody walks is decoration. It
detects mutation, reordering, and interior deletion, and it says so in the
returned value that it **cannot** detect a valid-prefix tail truncation or a
rollback: `tail_truncation_detectable: false`.
Comparing receipts or witnessed checkpoints against the local chain is deferred
beyond v1.

### Derive

One follower in the same process, with one cursor. Waking is correctness, not
optimization: an in-process nudge after each append commit plus a full
catch-up pass at process start. Concurrent nudges coalesce into the running
pass and there is no standing poll timer. A crash between append and derive is
healed by the startup catch-up.

Every derived row id is a pure function of log content (see
`src/derive/identity.ts`), and all rows, edges, and the cursor advance for one
record commit in one transaction under strict inserts — a conflict rolls the
whole record back and halts, and duplicates that valid log content can produce
(a rationale naming the same sibling twice) are resolved deterministically in
the pure projector instead. A full rebuild — a fresh
`record-derived.sqlite`, cursor at zero, replay — reproduces
`contentDigest()` exactly. That digest is over derived content only;
derivation wall-clock is outside it because it is not log content.

Nodes: `atom` (decision / action / rationale), `meeting_snapshot` (one per
approval — v1 deliberately does not merge snapshots across records),
`participant_observation`, `rejection`. Edges: `derived-from`, `from-meeting`,
`listed-participant`, `attended-by` (only on an explicit approved
`attendance: 'attended'`), `supports`.

**No principal binding happens in derive.** Observations stay observations;
resolving one against membership is query-time gatekeeper work and would read
state that is not log content.

An unprocessable record halts the follower after an operator alert rather than
being skipped — staleness is visible, truth untouched. `drain()` reports
`halted` in its progress so a startup catch-up cannot return looking healthy.
The composition root decides whether to make that halt process-fatal.

## Ports the host wires

| Port | What the host supplies |
| --- | --- |
| `OrganizationRecordAuthorityPort` | The authority application's verification: current access lease, installation signature over the canonical bytes, envelope and payload schema validation, and the exact allowed authorization-evidence lookup in the integration audit. Throwing means permanent rejection. |
| `OrganizationRecordReceiptSignerPort` | Signing with the existing authority signing key that member machines already pin. Never a new service identity. |
| `OrganizationRecordClock` | Record time, injected because it is inside the hashed frame. |
| `OrganizationRecordAlertPort` | Operator alerts. This library never calls `process.exit` on its caller's behalf. |

The module never opens `authority.sqlite` and never re-implements a
verification rule.

## Expected protocol adapter

`packages/organization-protocol` owns the durable signed shapes — the two
envelope types, the receipt, and the payload schema — following its existing
`SignedIntegrity`/schemas/fixtures conventions. This workspace deliberately
does not import it and does not copy it. `src/application/contracts.ts` holds
only the **minimum structural views** this module reads, so a protocol type
carrying more fields is assignable without an import edge.

The adapter the host writes is thin:

```ts
const authority: OrganizationRecordAuthorityPort = {
  async verifyEnvelope(value) {
    const envelope = validateOrganizationRecordEnvelope(value); // protocol package
    await authorityApplication.assertIngestAllowed(envelope);   // lease + evidence
    return {
      envelope: envelope as JsonObject,
      envelope_id: envelope.envelope_id,
      event_type: envelope.event_type,
      idempotency_key: envelope.idempotency_key,
      installation_id: envelope.submitter.installation_id,
    };
  },
};
```

`organizationRecordEnvelopeIndex` reads those same four fields back out of the
canonical bytes, and the ingest path refuses an adapter whose reported index
disagrees with what it signed. That is a binding check, not schema validation.

The payload field paths the derive projection reads are the exact
`DecisionBrief` paths core validates (`payload.brief.meeting.participants[]`,
`payload.brief.{decisions,actions,rationales}[]`,
`payload.brief.provenance.meeting_revision`, `payload.source.{adapter_id,
instance_id,external_id}`, `payload.reviewed_at`, `reviewer.principal_id`,
`reviewer.reviewed_by`, `intent.restricted`; and for rejections
`payload.{meeting_id,rejected_at,reason,reconsider_after}`). The design accepts
that the protocol payload schema restates core's shape and pins the two with
shared golden fixtures rather than shared code; the same fixtures should pin
this projection.

## One canonicalization

Every digest here is RFC 8785 from `@echo-brain/federation-protocol`. This
workspace adds no canonical-JSON implementation, and core's divergent delivery
digest (`src/core/delivery/envelope.ts`) is never used for organization-record
artifacts. Runtime dependencies: `better-sqlite3` and
`@echo-brain/federation-protocol`. Nothing else.

## Deliberate deviation from the design text

The design lists "optional materialized signed-receipt bytes" among the log
table's columns. Filling a nullable column after the append commits requires an
`UPDATE`, which contradicts the same section's "no update or delete statement
exists in the codepath" and the immutability triggers. The signed receipt
therefore lives in `organization_record_signed_receipt`, a create-once sibling
table in the same database, keyed by log position. The receipt payload is still
committed with the log row, so the recoverable materialization seam behaves
exactly as specified — a retry after a crash in that window materializes the
receipt from the stored payload and appends nothing — while the log itself
stays strictly insert-only.

## Where the host wires it

`services/organization-authority/src/composition/organization-record.ts` opens
both databases, verifies the append chain, wires the ingest and the derive
follower, and exposes one HTTP use case. The authority mounts it on its
existing listener at `POST /v1/record-envelopes` — the one route with a
256 KiB canonical-envelope allowance plus the exact 20-byte request wrapper,
which leaves the shared 16 KiB organization API limit untouched everywhere
else.

The two databases live beside `authority.sqlite` in the authority state
directory as `record-log.sqlite` and `record-derived.sqlite`. Initialization
publishes them, the runtime fingerprint binds their exact file identity, and
serve preflight verifies them read-only; serve never creates them. A halted
startup derivation is fatal, so the supervisor restart re-runs the same
catch-up rather than leaving a stale process looking healthy.

## Not here

Route definitions and HTTP hosting (the authority owns both), the member
submitter (`src/product/organization/`), retrieval, the permission gatekeeper,
observation-to-principal resolution, interpretive derivation, `correction`
events, witnessed checkpoints, and Merkle inclusion proofs.

## Tests

```sh
npm run test:record        # from the repository root
```
