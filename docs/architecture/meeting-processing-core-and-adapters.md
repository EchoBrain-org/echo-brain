# Meeting processing core and adapter architecture

**Status:** Current

ECHO has a provider-neutral processing core surrounded by replaceable server
adapters. Vendors may shape transport and mapping, but never canonical records
or processing rules.

## Dependency direction

```text
provider API -> server adapter -> processing contracts <- processing cycle
                                           ^                 |
                                           |                 v
                                  Authority composition -> durable server state
```

- `packages/organization-processing/src/core/` imports no adapters,
  vendor SDKs, Authority composition, or persistence implementation.
- `providers/<provider>/src/` implements typed core ports and owns provider transport.
- `packages/organization-processing/src/admitted-meeting-processing/sqlite-authority-meeting-processing-state-v1.ts`
  owns production processing state in SQLite.
- `packages/organization-processing/src/admitted-meeting-processing/` owns the serialized bounded server cycle.
- Authority composition selects concrete adapters, credentials, organization
  policy, and stores through explicit bundles for meeting source, decision
  processor, answer composition, approval/interaction, and Person external
  identity. Those bundles are the only place an active external-capability
  provider is selected.

`npm run check:architecture-boundaries` enforces these rules for every owned
source file, not only today's entry-point closure. Processing tests live in `packages/organization-processing/test/`; provider tests
live in their provider workspaces; cross-workspace source and artifact checks live under
`tests/architecture/`.

## Shared source admission

Context sources share a versioned port before their domain-specific processing:

```text
Person HTTP upload -> durable Authority inbox -> PersonSourceAdapterV1 --+
                                                                       |
meeting provider -> MeetingSourceAdapter -> MeetingSourceBridgeV1 ------+
                                                                       |
                         SourceAdapterV1<TContent>.pull() <--------------+
                                      |
                         pullAndAdmitSourceBatchV1()
                                      |
                         SourceAdmissionStoreV1
                           /                    \
            document extraction/index       meeting decision workflow
```

Person submission pushes into an edge inbox; core ingestion pulls from the
server-owned inbox. The source adapter does not need a contributor's computer
after acceptance. PDF, Word and text decoding are format handlers behind one
Person source capability, not separate identities or permission tunnels.

`SourceItemV1` identifies an item by adapter/instance/external identity and a
stable source ID. `SourceRevisionV1` pins captured content and artifact digests;
`SourceEnvelopeV1<TContent>` carries typed content or an artifact descriptor.
`SourceAdmissionScopeV1` binds organization, custody, access-policy reference
and analysis policy from trusted Authority state, outside the adapter payload.
The core validates the whole bounded batch and canonical hashes before durable
admission. Changed bytes cannot overwrite a retained revision. A duplicate
admission remains eligible for downstream job recovery.

Authority V8 stores these records in `authority_sources_v1`,
`authority_source_revisions_v1`, `authority_source_contents_v1` and
`authority_source_representations_v1`. Stable identity excludes adapter version;
captured provenance retains it. New representations name their input revision
and processor version. These internal records provide no direct read grant.
Domain read ports still enforce current membership/audience and final release
fences; a source association cannot widen access.

The meeting bridge removes volatile `provenance.observed_at` from captured
typed content and records it as `revision.captured_at`, restoring it before
existing processors run. Repeated observation therefore keeps the content
digest stable. The production cycle uses shared admission before extraction.
`assertCurrentSourceAdmission()` checks its current owner membership and source
identity inside the custody transaction, closing revocation during provider
pull. Existing candidate, approval and cursor fences remain in place.

## Meeting decision flow

```text
meeting source
  -> canonical meeting revision
  -> decision processor
  -> canonical signals and evidence
  -> exact approval snapshot
  -> exact human approve or reject resolution
  -> canonical organization record and policy facts
```

The server owns source cursors, processing state, pending approvals, delivery
receipts, and organization-record submission. The Person client owns none of
that state. Its provider client fragments use only authenticated Authority ports;
server adapters remain outside its dependency closure.

## Typed capabilities

- A **source** pulls versioned context through `SourceAdapterV1<TContent>`;
  trusted composition separately binds custody and analysis policy. The
  **meeting source** capability remains behind its compatibility bridge and
  supplies canonical meetings plus an opaque cursor. Person sources use durable
  inbox leases instead of inventing provider cursors.
- A **decision processor** turns one canonical revision into decisions,
  actions, rationales, and source-linked evidence.
- An **approval surface** presents the exact staged brief and records an
  explicit human outcome.
- No **delivery surface** port exists today. A capability that publishes
  approved content elsewhere would need its own typed port.

The shared approval path retains an opaque, generic presentation reference,
not a provider message timestamp or channel grammar. The approved-record path
receives a policy projector that translates a canonical terminal approval into
the record facts appropriate for the selected product policy; it does not
inspect an approval-surface payload.

Approval and any future delivery remain separate capabilities. They may share
a provider connection, but a generic Slack delivery channel must differ from
the active Slack approval channel, preserving main's human-action/side-effect
boundary.

## Cross-capability invariants

- Stable source identity includes adapter, instance and external ID within an
  organization; source revisions are separately immutable.
  Processing identity also includes processor adapter, instance, and version.
- Adapter identity names a capability implementation, not a provider account,
  ECHO human, membership, or permission. Consequential provider actions must
  resolve the separate connection, persisted adapter binding, tenant-scoped
  provider actor, external identity link, exact principal/membership tenure,
  and explicit action capability required by
  [INV-IDENTITY-005](../invariants/INV-IDENTITY-005-adapter-to-echo-identity-chain.md).
- Repeating the same source, processing, approval, or delivery operation is
  idempotent.
- A cursor returns only to the exact source instance and version that issued
  it.
- Pending approval pins its source revision and staged brief.
- Delivery uses the stored approved snapshot, never regenerated content.
- Provider acknowledgement is required before success is recorded.
- Unknown remote outcomes remain unknown and retry conservatively.
- Authentication, invalid input, rejection, rate limiting, temporary failure,
  and unknown outcome remain distinguishable.
- Calls are bounded and cancellable.
- Only explicit permanent rejection becomes a dead letter.

## Adapter responsibilities

Each adapter must:

- state the strongest provider account or tenant identity it can prove;
- keep credentials out of URLs, records, logs, and Person responses;
- refuse redirects where they could cross an authentication boundary;
- validate success bodies rather than trusting HTTP status alone;
- map available facts without inventing missing portable data;
- preserve source revisions and exact evidence locations; and
- define retry, crash, concurrency, and reconciliation behavior.

The bundled `llm` decision processor owns one canonical prompt/output/evidence
contract. Its Ollama, OpenAI, Anthropic, and OpenRouter drivers own only
provider authentication, wire translation, capability checks, response
extraction, and error normalization.

Slack approval and delivery adapters share a narrow transport but retain
separate authorization, idempotency, and receipt semantics. Slack actors are
tenant-namespaced `(team_id, user_id)` subjects, never bare user IDs.

## Current composition

The Organization Authority composition root concretely selects Granola as the
meeting source, OpenRouter with the pinned Claude Sonnet processing version as the
decision processor, Slack for approval, interactions, identity, and the
existing delivery capability, and Authority SQLite state. It separately
composes the bounded Person `ask` path above Layer 3 with a pinned OpenRouter
DeepSeek planner/answer model. The other LLM transports are compiled
alternatives, not active runtime dependencies. This is an allowed selecting
composition profile, not evidence that every active provider has completed
qualification.

The source-processing model remains separate from the permission-aware
read/model path. It receives one admitted source revision through the processor
port and has no Person session, retrieval-generation handle, broad corpus
access, or authorization-widening fallback. Answer composition receives only
the atoms released by the Layer 3 protocol boundary for one authenticated
Person request and cannot read lower
layers directly.

Current live composition delivers private meeting-owner approval DMs. Their
visibility selector defaults to **Only me**, which binds
`restricted-reviewer-person-v2` if approved unchanged. The owner may select
**Team** before approving to bind `organization-member-readable-person-v2`.
The selected policy is frozen with the approved record; rejection creates no
record.

## Extension rule

A new integration begins as a typed capability, not a generic plugin. It keeps
vendor types behind its adapter boundary, declares identity and failure
semantics, supplies deterministic fakes, and passes capability-level tests.
The processing core must still compile and test when that adapter is absent.

Provider semantics terminate at the edge. Adding a provider may add an adapter,
selecting composition, provider-owned persistence, onboarding, and tests, but
must not add provider branches to shared processing or canonical state. The
normative rule and the known failure mode are
[INV-ADAPTERS-005](../invariants/INV-ADAPTERS-005-provider-semantics-at-boundary.md)
and
[failure pattern](../failure-patterns/FP-ADAPTERS-005-first-provider-becomes-architecture.md).

## Known provider-neutrality caveats

- Initial-owner onboarding and the compatibility CLI select the concrete Granola,
  OpenRouter, and Slack profile; there is no universal source-onboarding flow.
- The boundary covers external capabilities, not interchangeable SQLite,
  file-key, Node-runtime, or authentication-protocol implementations. The
  source port is pull-oriented; Person push submissions use the durable edge
  inbox. New push providers need an equivalent explicit buffering boundary.
- V3 physically stores `provider_message_ts`; shared code treats it as opaque
  `presentation_external_id` until an explicit schema migration.
- Bundles are trusted static composition, and ownership/dependency checks cannot
  detect every hidden semantic coupling. Each selected profile still needs
  capability tests and a bounded staging rehearsal.
- Compatibility-bound `clean-founder-*` commands, manifest kinds, and durable
  instance IDs describe the V1 initial-owner bootstrap contract. Runtime
  components must not reuse that cohort name; replacing the persisted/operator
  vocabulary requires an explicit versioned bootstrap migration.

## Explicit Person uploads

The `/v1/person/documents` family preserves exact originals up to 25 MiB and
uses the common Person source adapter for text/Markdown, PDF and `.docx`.
The generic source content is an immutable document descriptor; original bytes
stay in the document BLOB table. A serialized, cancellable worker performs
bounded deterministic extraction and indexes the result without a model.
Originals, derived representations, job state and live read policy remain
separate facts.

Accepted `team` and `project` documents continue processing after the
contributor departs. Current project grants admit new members to shared history
and deny removed members. `only_me` stays private and retains its private
processing-tenure requirement, regardless of project association. An
account-scoped minimal receipt can acknowledge an earlier save without
disclosing content after project access is lost.

Person documents carry `on_request` analysis policy. Admission and extraction
do not invoke the meeting decision processor, create approval cards or publish
approved records. This implementation adds neither a requested-analysis API nor
document retrieval for Ask. Existing meeting sources retain their explicitly
composed `automatic` decision workflow; common admission does not imply every
source executes every downstream stage.

Legacy `/v1/person/updates` and `/v2/person/updates` note contracts retain their
existing original inbox, read indexes and optional search-enrichment worker.
Server pull also admits accepted text notes through the same Person source
capability as documents, without requiring a model. Its typed content
distinguishes `person-text` from `person-document`; neither invents
`MeetingDocument` facts. Existing enrichment hints cannot alter the original or
audience and are not decision/action proposals; model failure preserves source
readability. See
[ADR-0014](../decisions/ADR-0014-unified-source-ingestion-and-document-custody.md),
[project documents](../features/project-documents-v1.md), and the historical
[upload scope](../product/2026-09-21-person-update-inbox-v1.md).
