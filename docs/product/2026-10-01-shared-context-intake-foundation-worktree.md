# Shared context ingestion and capture foundation worktree

This worktree implements a bounded, provider-neutral ingestion and immutable
capture foundation. Each tool keeps its own adapter, while retained and
request-only source context enter through one logical validation contract.
It does not activate a provider or production path.

The versioned design is [Shared context ingestion and capture V1](2026-10-01-context-intake-foundation-v1-design.md).
It remains proposed and does not amend an accepted ADR.

## Worktree scope

| Item | Value |
| --- | --- |
| Worktree | `.worktrees/context-foundation` |
| Branch | `feat/context-foundation-v1` |
| Base | `main` at `8578b58` |
| Authorized deliverable | Bounded capture foundation and provider-conformance fixtures |

The foundation uses existing main interfaces and is independent of PR 250.

The existing `SourceEnvelopeV1`, `SourceAdmissionScopeV1`,
`SourceAdmissionStoreV1`, and SQLite source-custody tables
(`authority_sources_v1`, `authority_source_revisions_v1`, and
`authority_source_contents_v1`) are sufficient for this milestone. The work
adds a typed context capture contract and an Authority-fenced admission owner;
it does not require a schema baseline, production composition, route, provider,
or deployment change.

Raw source captures are observations. They are not signed human acts, approved
facts, decisions in the organization record log, memberships, identity links,
or permission grants. A decision-shaped provider item is still a source
observation until a separate human approval path creates its signed record.
Provider metadata, names, mentions, external account IDs, and read grants
cannot create or merge ECHO people or authorize retention.

## Capture contract

The contract has a closed source type and a matching closed payload kind. The
permitted pairs are document, note, message, ticket, meeting, activity, task,
and decision. A document payload cannot be submitted as a ticket, and unknown
payload fields or kinds fail validation. Type-specific payloads preserve only
source metadata, source state, and external references appropriate to that
type. They do not carry ECHO membership, identity, approval, custody, or access
claims.

Source type, truth status, storage representation, and Authority policy remain
separate. The fixed truth status is `source_observation`. Bodies belong only to
the selected representation:

| Representation | Retained value |
| --- | --- |
| Pointer | Bounded external reference and metadata, with no body or passages |
| Excerpt | Bounded source text passages with exact source anchors and offsets |
| Full snapshot | Bounded source text and passages whose offsets match that text |

All representations use the same stable source identity, revision, type-specific
metadata, external references, and provenance contract. Pointer captures cannot
be widened into text later under the same revision.

Structured metadata/state is retained content, including for pointers; Authority
must authorize it explicitly. Request-only intake uses the same validation and
policy checks but never calls durable admission, even when a store is supplied.
Its values remain request-owned and create no durable item, revision, metadata,
content or observation.

## Revision and time semantics

`captured_at` is the poll observation and custody time. It is not part of the
immutable revision hash. The first accepted capture is stored; a later poll of
the same immutable revision deduplicates and does not create a `last_seen` log.

`source_updated_at`, when supplied by the external source as a stable timestamp,
is immutable provenance and is hashed. There is no fetched or observed-at poll
timestamp in capture content. Adapters use a provider-native revision token when
one exists. Otherwise they create a deterministic semantic revision digest from
the closed type-specific metadata, source state, external references, and
selected representation, excluding poll and capture metadata.

An immutable revision cannot gain content on replay. A representation change,
normalization change, or other semantic content change receives a new revision.
The admission store rejects conflicting bytes for an existing immutable
revision.

## Authority retention fence

The intake coordinator validates configured adapter identity, canonical source
identity, matching type and payload kind, revision, semantic digest,
provenance, representation bounds, anchors, and cancellation before asking
Authority to retain a value. Adapters supply source data only. Authority selects
retention, the permitted representation, exact custody reference, access-policy
reference, and processing scope.

The persistence owner repeats this fence inside its admission transaction for
both new and duplicate revisions. It must reselect policy, validate retained
disposition and representation, require the exact custody, policy, and
processing scope, call `requireCurrent`, and check cancellation. There is no
await between this final Authority check and SQLite writes. A duplicate is not a
shortcut around current Authority policy.

`SqliteContextCaptureStoreV1` requires the server-configured adapter identity and
snapshots/freezes source and scope before admission. Policy selection and
`requireCurrent` must finish synchronously; an asynchronous fence is rejected.
Other stores behind the existing generic admission port must prove equivalent
transactional guarantees before provider integration.

This is retention authorization only. It neither grants a reader access nor
releases content to a model or another user.

## Fixture proof and deferred work

Provider-conformance fixtures exercise the existing `SourceAdapterV1` and
admission contracts with synthetic document, note, message, ticket, meeting,
activity, task, and decision captures. The proof covers closed type/payload
validation, pointer/excerpt/full representations, native and semantic
revisions, replay deduplication, immutable conflicts, changed revisions,
restart reads, cancellation, and the in-transaction Authority fence.

Graph projection and discovery, Evidence Desk release, Ask composition and
citations, request-only live-reader composition, automatic learning,
personalization, task lifecycle behavior, cross-tool identity inference,
provider activation, and production activation are deferred. Existing provider
directories, connector behavior, onboarding, Person surfaces, production
composition, and deployment scripts remain unchanged.
