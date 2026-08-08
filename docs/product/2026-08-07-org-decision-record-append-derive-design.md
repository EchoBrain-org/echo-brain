# Organization decision record: append and derive design (v1)

**Status:** Design approved in founder session 2026-08-07; implementation not started
**Builds on:** [org-brain-direction.md](org-brain-direction.md) (direction),
`src/product/approval/` (local decision chain), `services/organization-authority`
(membership, keys, leases)

## Goal

Give one organization a single trusted, append-only record of its human-approved
decisions, fed by enrolled member machines, with a deterministic derived graph
on top. This is the append and derive half of the organization brain. Retrieval
is deliberately out of scope.

## Design principles (settled)

1. **Append, derive, and retrieve are three separate logical machines.** They
   never call each other; they communicate only through data at rest (the log,
   then the derived store). Append runs on human acts, derive follows the log
   with a cursor, retrieve answers questions. V1 builds append and derive only.
2. **The log records facts; interpretation is derived.** Litmus test: if
   deleting it loses truth, it is a log event (human acts: approval, rejection).
   If it can be recomputed from the log, it is derived (atoms, edges, indexes).
3. **Stone/gatekeeper split for access.** Log records and derived nodes carry
   provenance facts (source meeting, participant observations, approver) and
   approver intent (`restricted` flag). They never carry resolved reader lists.
   Effective access is computed at query time by a future permission layer
   against current org membership. A derive bug therefore cannot widen access.
4. **The log unit is what the human approved.** One approval event stores the
   resolved decision package byte-exact (the `DecisionBrief` with its evidence
   spans). Per-signal atoms are a derived, rebuildable projection, never log
   content.
5. **Rejections are logged as acts, not content.** A rejection event records
   that a package was rejected (by whom, when, optional reason, optional
   `reconsider_after`). The rejected content stays in the member machine's
   local store. A later revisit that gets approved ships as a normal approval
   linking back to the rejection.
6. **Raw-source custody stays local.** Transcripts and vendor payloads never
   travel. Only the bounded evidence spans already inside the approved brief
   cross the wire, plus pointers (meeting id, block id, timestamps) back to the
   local source.
7. **Derive v1 is deterministic only.** Atomization and provenance edges; no
   entity resolution, no model-proposed links, no model calls. Interpretive
   linking is a later, separately designed pass.

## Shape and placement

New service `services/organization-record`, sibling of `organization-authority`
and `organization-control-plane`, following the same one-process, SQLite,
singleton-guard idiom. Both existing services explicitly exclude product
content, which forces (and justifies) the new service.

- `record-log.sqlite` — the immutable log. Truth.
- `record-derived.sqlite` — the derived graph. Disposable, rebuildable.

The authority remains sole truth for principals, memberships, installations,
and keys. `organization-record` validates leases and installation signatures
via the authority's existing surface and stores none of that truth. The wire
contract lives in `packages/organization-protocol`; product and service never
import each other.

Member side adds one product module: the **submitter** (`src/product/organization/`).

## Envelope contract (v1)

Two event types now; `correction` reserved but unbuilt.

**Approval event**

- `schema_version: 1`, `event_type: 'approval'`
- `idempotency_key` — the existing sha256 approval id derived from the decision
  node's processing key
- `payload` — the resolved decision node byte-exact as approved: `DecisionBrief`
  (meeting, participants, decisions/actions/rationales with verbatim
  `EvidenceSpan`s), alternatives, links, `reviewed_by`, `reviewed_at`, surface
- `intent` — `{ restricted: boolean }`, approver-set, default `false`
- `submitter` — installation id, `submitted_at`
- `signature` — installation signing key over the canonical serialization

**Rejection event**

- `schema_version: 1`, `event_type: 'rejection'`
- `idempotency_key` — same derivation as approvals
- `payload` — meeting id, `rejected_by`, `rejected_at`, optional free-text
  `reason`, optional `reconsider_after` timestamp. No brief content.
- `submitter`, `signature` — as above

Approved and rejected acts both enter the org timeline; only approved content
does.

## Ingest protocol and log storage

**Submitter (member side).** Watches the local decision-node store for newly
resolved nodes, builds and signs the envelope, POSTs to the ingest endpoint
under a current access lease, retries with backoff using the same idempotency
key, and files the returned receipt locally. Retries cannot duplicate; there is
no timer pressure. The append path for a decision is complete when its receipt
is stored.

**Ingest (service side).** Three steps, in order:

1. **Verify** — access lease (via authority), envelope signature against the
   enrolled installation key, schema validation.
2. **Dedupe** — a known idempotency key returns the original receipt unchanged.
3. **Append** — one record at the next monotonic position, then return a signed
   receipt.

**Log table.** Append-only: `position` (monotonic integer primary key),
canonical envelope bytes, `record_hash = sha256(prev_record_hash || envelope_bytes)`,
`recorded_at`. The hash chain gives tamper evidence; a verify command walks the
chain. No update or delete statement exists in the codepath.

**Receipt.** Signed by the service: envelope id, idempotency key, log position,
record hash, recorded-at.

**Rejected ingest is loud.** Expired lease → submitter refreshes and retries.
Bad signature or schema → permanent rejection with reason, surfaced to the
member machine's operator. Nothing is silently dropped.

## Derive v1 (deterministic)

A follower loop inside the `organization-record` process. State: a single
cursor (last processed log position) stored in `record-derived.sqlite`. Loop:
read records past the cursor, derive, advance cursor. Wake by poll; an
in-process nudge after append is a latency optimization, never the correctness
mechanism.

**Nodes**

- `atom` — kind `decision | action | rationale`, text, subject, status/owner/
  due (kind-specific), confidence, evidence spans, `restricted` flag, approval
  provenance (`reviewed_by`, `reviewed_at`, approval group, log position)
- `meeting` — meeting id, title, time
- `participant_observation` — meeting id, observed name/email,
  `resolved_principal` (nullable)
- `rejection` — derived from rejection events: meeting id, rejected-by, time,
  reason, `reconsider_after`

**Edges**

- `derived-from` — atom → log record
- `from-meeting` — atom → meeting
- `attended-by` — meeting → participant observation
- `supports` — rationale atom → sibling atoms, from `supports_signal_ids`

Atoms from one approval share its approval group (approval-group provenance).

**Identity binding (conservative).** A participant observation binds to an
enrolled principal only on exact email match against the authority. Otherwise
it remains an unresolved observation. No fuzzy matching in v1.

**Determinism.** Every derived row id is a pure function of log content:
atoms hash (log record hash, signal id); rejections hash the log record hash;
meetings key on meeting id; observations hash (meeting id, observed identity).
Derivation is a pure function of the log: a full rebuild (delete
`record-derived.sqlite`, cursor to zero, replay) must produce a byte-identical
database, and this property is tested. If derive encounters an unprocessable
record, it halts with an operator alert rather than skipping; staleness is
visible, truth untouched.

## Access policy (recorded, not enforced in v1)

The future gatekeeper reads graph facts plus authority membership at query
time. Initial policy, changeable without touching the log: unflagged atoms
resolve org-wide; `restricted` atoms resolve to source-meeting participants;
rejection events (minimal payload) are org-visible as acts. The authority's
existing `POST /v1/permission-checks` is the anticipated enforcement hook.

## Testing

- Protocol package: canonical serialization and signature round-trip; golden
  envelope fixtures for both event types.
- Service: ingest integration (dedupe and replay, chain verification, lease and
  signature rejection paths).
- Derive: determinism property (incremental run ≡ full rebuild, byte-identical);
  crash-resume at cursor.
- End-to-end: approve on a member machine → receipt filed → atoms queryable in
  the derived store; repeat from the second pilot machine; zero duplicates.

## Success criteria (pilot)

1. Every approval and rejection from both pilot machines lands exactly once in
   one org log with a verifiable hash chain.
2. The derived graph answers: which decisions came from which meeting, who
   attended, who approved, what supports what.
3. `restricted` intent travels end to end.
4. A full rebuild reproduces `record-derived.sqlite` byte-identically.

## Out of scope (deliberate)

- Retrieval, the permission gatekeeper, and any query surface.
- Interpretive derivation: entity resolution beyond exact email match,
  model-proposed supersedes/relates edges, atom ranking.
- `correction` events (shape reserved in `event_type` only).
- Resurfacing of `reconsider_after` rejections (the fact is logged; the
  reminder behavior is a future derived-side feature).
- Any UI beyond existing operator surfaces.
