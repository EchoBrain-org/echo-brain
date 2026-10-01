# Shared context ingestion and capture V1

**Status: Proposed.** The user authorized bounded backend implementation and
synthetic fixture proof on 2026-10-01, then narrowed this milestone to ingestion
and capture. Production activation and acceptance of this proposal remain
separate decisions. This proposal does not amend accepted ADRs, including
[ADR-0010](../decisions/ADR-0010-disposable-related-atom-projection-v1.md).
The [worktree brief](2026-10-01-shared-context-intake-foundation-worktree.md)
defines the same ingestion-only scope. `feat/context-foundation-v1` is based on main
`8578b58ab708caa4bda7b59e707c7870c00a73c4`; it uses existing main interfaces
and has no dependency on PR 250.

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

The required `payload` is a closed, versioned structured value whose `kind`
matches `source_type`. It preserves selected source fields rather than flattening
every input into a title and text body:

| Source type | Structured payload fields (besides version and kind) |
| --- | --- |
| Document | Media type; optional language |
| Note | Plain-text or Markdown format |
| Message | Channel reference and sent time; optional thread and author references |
| Ticket | Key, status and labels; optional priority, assignee reference and due time |
| Meeting | Start time and participant references; optional end time |
| Activity | Action, occurrence time and subject reference; optional actor reference |
| Task | Status; optional due time, completion time and assignee reference |
| Decision | Source status and decider references; optional decision time |

External references remain opaque source coordinates. They cannot create or merge
directory identities or memberships. A provider's decision status is still a
source observation, not an ECHO approval. Unknown fields and unversioned provider
blobs are rejected; provider mappings select only fields covered by this contract
and the Authority retention decision. Bodies belong in the representation, not a
duplicate field hidden in the payload. These structured metadata/state fields
are retained content even for a pointer and require explicit retention permission.
They are not given a free metadata exemption.

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

The time and revision semantics follow existing main admission:

| Time | Meaning and immutable commitment |
| --- | --- |
| `revision.captured_at` | Read/poll observation and capture time; excluded from the immutable revision witness |
| `provenance.source_updated_at` | Optional provider-declared time stable for this exact source revision; included in content digest |
| Payload/event times, including `observation.occurred_at` | Source event times, included in content digest |

An adapter never substitutes its current fetch time for a missing source time.
It omits `source_updated_at` when unavailable. Fetch-time `observed_at` is rejected
in content. Re-polling unchanged source evidence changes only `captured_at`, so
the same revision deduplicates. SQLite retains the first successful capture time;
there is no durable last-seen or poll-history log in this capability. Request-only
results retain that request's observation time and disappear with the request.

Adapters use an immutable provider revision token where available. Otherwise
they derive a deterministic revision ID from canonical semantic content, excluding
capture/poll fields. Content includes the selected representation, structured
payload, provenance and source anchors. A changed field, corrected source time,
different retained representation or incompatible normalization requires a new
capture revision; provider coordinates/tokens can be incorporated into that key.
It cannot overwrite or silently enrich an existing revision. Adapter version
alone cannot distinguish revisions. New revisions preserve their source identity
and may name their exact predecessor. Provider timestamps use canonical UTC
strings; provider approval, custody and access claims are rejected.

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
atomically with admission, including duplicate/replay paths. The additive
`SqliteContextCaptureStoreV1` implements that requirement using the existing main
store's `beforeAdmit` callback; it is opt-in and not installed in production.
Its constructor requires the server-configured adapter identity. The store uses
the same envelope validator and snapshots/freezes source and scope at entry, so
calling the store directly cannot bypass identity checks or mutate captured bytes.
Inside the same transaction and before any writes, it must:

1. Check cancellation and revalidate the exact typed envelope.
2. Reselect current Authority policy for the source; reject revoked retention,
   `request_only`, a disallowed representation or unsupported processing policy.
3. Compare organization, custody, access-policy reference and processing binding
   with the selected admission scope. Fail on drift rather than widening custody.
4. Run `requireCurrent` synchronously, then check cancellation again.

Authority policy selection and the fence must complete synchronously. A returned
Promise is not a completed check and fails closed. No awaited provider read or
queue work can sit between the final fence and the writes. Other implementations
of `SourceAdmissionStoreV1` must provide an equivalent transactional fence; the
generic main port and a pre-call check alone do not guarantee it. A read grant
cannot satisfy this requirement. Authority must authorize the complete selected
capture, including labels, pointers and structured fields, under the current
configured adapter and retention policy.

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
| Canonical structured payload | 16 KiB; at most 32 entries per reference/label list |
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

Provider conformance fixtures emit existing main `SourceAdapterV1` /
`SourceEnvelopeV1` values. Provider code keeps those inward dependencies;
Authority composition owns mapping validation and intake, and a provider never
imports Authority service internals. Synthetic mappings for each payload kind
prove exact structured-field roundtrip, stable revision replay with later poll
time, semantic-time conflicts/new revisions, closed-field/bound rejection in both
dispositions, and queued disposition/representation/scope drift at the atomic
fence. The conformance helper accepts a provider-owned map and adapter identity;
it is fixture composition, not another production intake pipeline.

Authority integration tests can reuse
[`ContextProviderConformanceAdapterV1(rawValues, mapRaw, identity)`](../../services/organization-authority/test/fixtures/context-provider-conformance-v1.ts)
with a provider-owned raw mapper. Pull its existing `SourceBatchV1`, run the
shared intake coordinator, and supply
`SqliteContextCaptureStoreV1(database, authority, identity)` for retained cases.
The [conformance suite](../../services/organization-authority/test/context-intake-conformance-v1.test.ts)
is the executable acceptance matrix. Provider production packages continue to
depend only on inward source contracts; composing tests belong to Authority.

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

Provider, Nango, onboarding, route, Person, deployment and current composition
files remain outside this scope. The foundation consumes existing main interfaces
without changing them; no PR 250 integration or ownership transfer is required.
Only the foundation modules, fixtures and proposed documents are part of this
foundation change. Nothing here merges, deploys or activates a provider.
