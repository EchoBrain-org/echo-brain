# Shared context intake foundation V1

**Status: Proposed.** Bounded backend implementation and synthetic fixture proof
were authorized on 2026-10-01. Production activation, API changes, provider
activation and acceptance of this proposal are separate decisions. This does
not amend accepted ADRs, including [ADR-0010](../decisions/ADR-0010-disposable-related-atom-projection-v1.md).
See the [worktree brief](2026-10-01-shared-context-intake-foundation-worktree.md).

## Logical Layer 1 and ownership

Layer 1 includes permitted immutable source captures alongside the separately
owned authoritative people directory and signed human-act record log. Captures
are source observations, never approved facts. Directory membership and verified
identity links remain authoritative; actor labels and mentions in captures do
not create people, memberships or identity links. Activity, tasks and approved
decisions remain distinct. External systems own their current mutable state.

The service's existing `authority_sources_v1`, `authority_source_revisions_v1`
and `authority_source_contents_v1` tables suffice for this bounded capability.
The new V1 content contract is nested in `SourceEnvelopeV1` and passed through
the existing `SourceAdmissionStoreV1`; no SQL baseline changes or new database
roles are introduced. Source keys reuse `sourceItemIdV1`. A typed content
digest commits metadata, representation, provenance, anchors and observations.
Admission also commits the immutable revision manifest and Authority custody
and policy references. Replay capture time is observational, as in existing
admission; changing any immutable content or revision field conflicts. New
revisions remain separate, including their predecessor reference when present.

Only trusted composition may select retention, custody, access policy and
permitted storage representation. A provider supplies none of these grants.
An explicit retention authorization is required even when read access exists.
Access references name existing accepted original-context policy resources for
the fixture; the existing original ACL and scope rules evaluate current access.
There is no new permission engine or frozen reader list. The signed record log,
source admission baseline and production composition stay unchanged.

V1 retains exactly the submitted, authorized pointer, excerpt or full text
snapshot. A pointer contains metadata and an exact external reference, no answer
text. An excerpt has bounded source-owned passages; a snapshot retains its
bounded full text and exact character-range anchors. Excerpts commit each
passage and its external anchor without claiming the unavailable whole body.
Source type, representation and the fixed `source_observation` truth status are
separate fields. Retained captures use on-request processing only in this proof.
Pointer metadata supplies inventory only and cannot support relationships in
V1. Provenance `observed_at` is the source-read observation time, revision
`captured_at` is custody capture time, and observation `occurred_at` is the
source-declared event time; these are independent, explicit time semantics.
Deletion is intentionally unavailable under the current immutable tables;
access revocation suppresses serving, not custody. Production retention expiry,
erasure, legal holds and garbage collection require a later versioned design
and migration; deployments needing these rules must not activate this fixture.

## Shared intake

One coordinator validates both dispositions before any downstream work:
configured adapter identity, canonical stable source identity, exact revision
and digest, canonical provenance timestamps, source-owned anchors, closed field
sets, bounds and cancellation. It snapshots inputs and Authority-selected
policy before awaiting and rechecks the policy before persistence. This is a
logical internal boundary; transports and adapter parsing remain independent.

Request-only intake invokes the same validator and explicit Authority policy
port, but accepts no store and cannot invoke admission or projection. The
validated value lives in the request and is cleared with its owner. Live readers
may wrap provider-normalized observations with this gate before returning to
the unchanged audited live-reader boundary. Read-binding, citation validation,
authorization, audit, cancellation and revalidation remain that boundary's
responsibility. The fixture uses a synthetic ticket-shaped live reader solely
to consume the existing versioned citation protocol; it activates no provider.
Audits keep only the allowlisted coordinates and commitments of existing
contracts, never titles, pointers, bodies, relations, queries or generated prose.

Initial hard limits are 256 KiB per serialized envelope, 128 KiB snapshot text,
32 KiB total excerpt text, 32 anchors, 32 observations, 4 KiB per released
passage, 100 captures per bounded processing read and 50 discovery candidates.
Malformed batches are validated before retention. Persistence commits each
capture atomically. A later failure can leave earlier admissions committed;
replay deduplicates and downstream work is retried separately. No cursor is
advanced by this capability and no permanent queue is introduced.

## Disposable graph V1

The graph is a deterministic, model-free, immutable, request-independent
projection of retained V1 captures only. Its complete sorted manifest identifies
organization, every source/revision, immutable revision digest, content digest,
policy/custody bindings and projection version. Its generation digest commits
this manifest and the projected nodes and relationships. The approved-record
head cannot stand in for the manifest. The ADR-0010 approved-atom projection
remains unchanged and is never mixed into this generation.

Nodes identify exact revisions and anchors. Only adapter-declared observed
relationships (`references` and `activity`) are projected, with supporting exact
source revision and anchor, occurrence time and target exact revision where
applicable. A new revision produces a distinct candidate; no mutable current
task state or inferred person relation is synthesized. Relationships are
retrieval hints, never claims, permission grants or direct model inputs.

Rebuild reads durable captures in deterministic order with a hard input bound.
It publishes a new generation only after full validation. A failed input leaves
the prior generation intact. An explicit bounded exclusion set may isolate the
exact failed revision; its digest and exclusion appear in the complete manifest,
so unrelated retained inputs can progress without claiming completeness. Retry
without the exclusion builds a different generation. Restart rebuilds from
durable inputs; there is no startup reset and no graph write for request-only
values. The first graph is memory-resident and disposable; a persisted generation
cache, scheduler and deployment role are deferred.

Discovery is server-internal and bounded. Visibility is evaluated before query
matching, counts, truncation or traversal. Every relationship requires current
visibility of its supporting revision and both endpoints. Hidden titles,
endpoints, relation metadata and degree information cannot enter results. A
query receives candidates only; the model sees no graph object or manifest.
The Desk pins a generation and revalidates exact retained revision integrity
and all prior releases before later model calls and final output. A generation
replacement fails that request rather than silently mixing snapshots; a failed
rebuild can continue serving unchanged verified revisions from the safe prior
generation. New captures await an explicit rebuild, never query-triggered work.

## Release and Ask

A new original-context adapter consumes graph candidates through the existing
`PersonOriginalContextEvidenceDeskPortV1`. The unchanged
`createPersonEvidenceDeskV1` supplies the only model-facing retained release
boundary. Current session, membership, scope and original resource ACL checks
precede metadata/content release, and repeat before the content-free audit
commits. Request-owned releases use object identity and exact citation
commitments. Revalidation checks all released metadata and passages, including
uncited evidence, the pinned generation, policy revision and same Person/session.

Server-owned `source_revision` citations bind immutable revision, representation
and source anchor digests. Pointer candidates remain metadata-only and cannot
become invented evidence. The unchanged request-local Ask loop receives only
Desk items and maps model aliases back to released citations. Audit failure,
authorization drift, cancellation or stale evidence releases no answer.
The fixture composes file-backed Authority persistence, actual admission,
current original-context policy, the graph, Desk, SQLite audits and a scripted
model. It uses no external endpoints or runtime credentials.

## Deferred decisions and qualification

Production activation requires accepted contract review, policy resource
registration for additional source types, deletion/expiry rules, provider-owned
mapping and citation protocols where existing protocols cannot express a source,
durable graph cache/coordination and capacity qualification. Reserved provider,
onboarding, route, Person, deployment and current composition files remain owned
by Claude's PR 250 review. No ownership transfer is needed for these additive
files. Before opening a foundation PR, reconcile the finalized dependency as
required by the brief; this local implementation does not merge it.

Automatic learning, personalization, full task management, model-generated
relationships and cross-tool identity inference are deferred. Capture schema,
processor and graph projection versions are explicit; new semantics require
a new contract rather than silent widening.
