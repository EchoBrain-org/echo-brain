# Shared context ingestion and capture V1

**Status: Proposed.** The user authorized bounded backend implementation and
synthetic fixture proof on 2026-10-01, then narrowed this milestone to ingestion
and capture. Production activation and acceptance of this proposal remain
separate decisions. This proposal does not amend accepted ADRs, including
[ADR-0010](../decisions/ADR-0010-disposable-related-atom-projection-v1.md).
The [worktree brief](2026-10-01-shared-context-intake-foundation-worktree.md)
describes the broader target; this milestone implements only its intake and
durable capture foundation.

## Logical Layer 1 and ownership

Layer 1 includes permitted immutable source captures alongside the separately
owned authoritative people directory and signed human-act record log. Captures
are source observations, never approved facts. Directory membership and verified
identity links remain authoritative; actor labels and mentions in captures do
not create people, memberships or identity links. Activity, tasks and approved
decisions remain distinct. External systems own their current mutable state.

The service's existing `authority_sources_v1`, `authority_source_revisions_v1`
and `authority_source_contents_v1` tables suffice for this bounded capability.
The versioned content contract is nested in `SourceEnvelopeV1` and passed through
the existing `SourceAdmissionStoreV1`; no SQL baseline changes or new database
roles are introduced. Source keys reuse `sourceItemIdV1`. Adapter version belongs
to the revision, rather than changing the stable source identity. A typed content
digest commits metadata, representation, provenance, anchors and observations.
Admission also commits the immutable revision manifest and Authority custody
and policy references. Replay capture time is observational, as in existing
admission; changing any immutable content or revision field conflicts. New
revisions remain separate, including their predecessor reference when present.

Only trusted composition may select retention, custody, access policy and
permitted storage representation. A provider supplies none of these grants.
An explicit retention authorization is required even when read access exists.
Policy references preserve the Authority-selected binding for future consumers;
they do not grant release or sharing permissions. This milestone evaluates no
reader ACLs and creates no permission engine. The signed record log, source
admission baseline and production composition stay unchanged.

## Typed capture contract

`ContextCaptureContentV1` has explicit schema version 1 and content kind
`echo-context-capture-v1`. Its source type, storage representation, truth status
and access policy remain separate dimensions. Source types are document, note,
message, ticket, meeting, activity, task and decision. Every capture has the fixed
truth status `source_observation`, including a decision-shaped source; approval
requires the separately owned signed human-act record contract.

V1 retains exactly the submitted, authorized representation:

| Representation | Preserved evidence |
| --- | --- |
| Pointer | Identifying metadata and exact external pointer; no body or passages |
| Excerpt | Bounded passages, external anchors and exact character offsets |
| Full snapshot | Bounded full text with passages that match its exact character ranges |

Character offsets use JavaScript string indexing; byte bounds use UTF-8.
Excerpts commit each passage and its source anchor without claiming the
unavailable whole body. Snapshot passages must match their committed text.
Pointer metadata cannot support anchored observations in V1. Source identity,
exact revision, provenance and policy references remain available even for a
pointer capture.

Optional adapter-declared `references` and `activity` observations are preserved
as source data. Each names an existing passage anchor and exact target source
and revision. They are neither projected relationships nor approved claims and
never imply permissions or identity links. This contract performs no inference
or traversal. Contributor identity claims, artifacts and derived representation
references are excluded from this bounded V1 intake contract.

Provenance `observed_at` is the source-read observation time, revision
`captured_at` is custody capture time, and observation `occurred_at` is the
source-declared event time. These are independent explicit time semantics.
Provenance and event timestamps use canonical UTC strings. Provider-generated
approval, custody and access fields are rejected rather than interpreted.

## One logical intake boundary

Each adapter keeps its own parsing and transport. The provider-neutral
`intakeContextBatchV1` coordinator validates both retained and request-only
dispositions through the same gate: configured adapter identity, canonical
stable source identity, exact revision and digest, provenance, source-owned
anchors, closed field sets, bounds and cancellation. Inputs and selected policy
are snapshotted and frozen before asynchronous work, then policy is rechecked
before persistence. No provider endpoint or adapter is activated by this module.

The Authority port selects explicit disposition, admission scope and permitted
representations outside provider data. The bounded capability accepts only the
existing on-request processing policy. A read grant does not substitute for
retention authorization. Representation permission cannot widen custody or
release permissions.

For retained capture, the persistence owner must repeat the retention fence
atomically with admission. Fixture composition binds Authority's current check
through the existing SQLite store's `beforeAdmit` callback inside its transaction.
An asynchronous store's pre-call check alone is insufficient. The fixtures prove
that revocation while admission is queued prevents durable writes.

For request-only intake, the coordinator returns a validated frozen value owned
by the request and never invokes a supplied admission store. It creates no
durable source item, revision, metadata, content, representation or observation.
The request owner must discard references when its work ends; V1 provides no
cache or durable request log. Live reader integration, release audits, retrieval,
Evidence Desk and Ask remain outside this milestone.

## Bounds, persistence and recovery

| Bound | V1 maximum |
| --- | --- |
| Serialized source envelope | 256 KiB |
| Full snapshot text | 128 KiB |
| Total excerpt text | 32 KiB |
| Individual passage | 4 KiB |
| Passage anchors per capture | 32 |
| Observations per capture | 32 |
| Intake batch or custody inventory read | 100 captures |

The entire batch is validated, including within-batch revision and custody
conflicts, before writes. Each retained capture commits atomically through
existing admission. Identical immutable revisions deduplicate even if replay
capture time changes. A conflict or content-write failure rolls back that
capture. A later failure can leave earlier captures committed; bounded replay
deduplicates those captures and retries the rest. No cursor or permanent queue
is advanced by this capability.

`SqliteContextCaptureReaderV1` is a server-internal custody read port for exact
retained captures. It reconstructs the envelope and Authority scope, verifies
stored canonical content and immutable revision commitments, and uses stable
source/revision ordering. It fails when its inventory bound would truncate the
result. It provides no search, graph projection, discovery or release authority.
Closing and reopening file-backed SQLite preserves captured revisions without
reinitializing state; replay uses the existing immutable witnesses.

The fixtures cover pointer, excerpt and full capture; identity and anchor
validation; explicit retention; duplicate and conflicting revisions; revised
sources; restart; transactional policy revocation; malformed and oversized input;
cancellation; atomic storage failure; partial-batch recovery; and request-only
non-retention under the same rules. No model or external endpoint is involved.

## Future consumers and deferred decisions

Future consumers can use the preserved source coordinates, exact revision
manifest, content digest, typed representation, anchors, observation times and
Authority policy references. Those bindings do not authorize processing or
release. Graph projection and discovery, retrieval changes, Evidence Desk
composition and cited Ask answers are deferred in full; ADR-0010's approved-atom
projection remains unchanged.

Deletion is unavailable under the current immutable tables. Production retention
expiry, erasure, legal holds and garbage collection require a later versioned
design and migration. Activation also requires accepted contract review,
Authority policy registration and retention-fence composition, provider-owned
mapping, capacity qualification and a separate activation decision. Capture
lifecycle scheduling and additional representations remain open decisions.

Automatic learning, personalization, full task management, model-generated
relationships and cross-tool identity inference are deferred. New capture
semantics require a new version rather than silent contract widening.

Reserved provider, Nango, onboarding, route, Person, deployment and current
composition files remain owned by Claude's PR 250 review. This implementation
changes only new provider-neutral modules and fixtures, so no shared-file
ownership transfer is needed. Before opening a foundation PR, reconcile the
finalized dependency as required by the brief; this local work does not merge it.
