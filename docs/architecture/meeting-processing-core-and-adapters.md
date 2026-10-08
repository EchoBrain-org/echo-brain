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
- `providers/shared/` is the registered `@echo-brain/provider-runtime` adapter
  library. Concrete providers may depend on it; it cannot depend on concrete
  providers or Authority composition, and provider-neutral core packages cannot
  import it. Shared Atlassian helpers remain at this adapter boundary.
- `packages/organization-processing/src/admitted-meeting-processing/sqlite-authority-meeting-processing-state-v1.ts`
  owns production processing state in SQLite.
- `packages/organization-processing/src/admitted-meeting-processing/` owns the serialized bounded server cycle.
- Authority composition selects concrete adapters, credentials, organization
  policy, and stores. An active external-capability provider is selected only
  in the modules that
  [INV-ADAPTERS-005](../invariants/INV-ADAPTERS-005-provider-semantics-at-boundary.md)
  allows.

`npm run check:architecture-boundaries` enforces these rules for every owned
source file, not only today's entry-point closure. Processing tests live in `packages/organization-processing/test/`; provider tests
live in their provider workspaces; cross-workspace source and artifact checks live under
`tests/architecture/`.

## Shared source admission

Context sources share the versioned `SourceAdapterV1` and
`SourceAdmissionStoreV1` ports. Person uploads and meeting sources admit through
`pullAndAdmitSourceBatchV1()` before their domain-specific processing. Tool Ask
uses the separate request-only live-read path described below.

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

Reusable context capture adapter (no active Granola acquisition)
  -> SourceAdapterV1<ContextCaptureContentV1>.pull()
  -> createContextSourceIntakeV1() -> intakeContextBatchV1()
  -> SqliteContextCaptureStoreV1 (a SourceAdmissionStoreV1)
```

The organization Granola staging capture route is retired. Personal connector
checks verify live reads without retaining their payloads.
Legacy capture contracts remain compiled but do not supply tool Ask; captured
context feeds no processing, retrieval or Ask stage. See
[connector contracts](connector-contracts.md) for that separate contract.

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

Authority stores these records in `authority_sources_v1`,
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

The server owns source cursors, processing state, pending approvals, and
organization-record submission. The Person client owns none of
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
- An **approval surface** reads the approval core (`createApprovalCoreV1`),
  which freezes one proposal per meeting and records one decision from any surface.
- No **delivery surface** port exists today. A capability that publishes
  approved content elsewhere would need its own typed port.

The shared approval path keeps no presentation reference on a proposal. A
surface keeps its own record of where it showed one (for Slack,
`authority_approval_presentations_v1`). The approved-record path receives a
policy projector that translates a canonical approval decision
(`echo-approval-decision-ref-v1`) into the record facts appropriate for the
selected product policy; it does not inspect an approval-surface payload.

Approval and any future delivery remain separate capabilities. They may share
a provider connection, but a generic Slack delivery surface must differ from
the active private Slack approval surface, preserving main's human-action/
side-effect boundary.

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
- Repeating the same source, processing, or approval operation is idempotent.
- A cursor returns only to the exact source instance and version that issued
  it.
- Pending approval pins its source revision and staged brief.
- The approved record uses the stored approved snapshot, never regenerated
  content.
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

The Slack approval adapter owns its narrow Web API transport, click
verification and identity-link check. It never writes records: a verified click
calls the approval core's `decide`, which owns idempotency and the one decision
per proposal. Slack actors are tenant-namespaced `(team_id, user_id)` subjects,
never bare user IDs.

Decided approvals have two ordered responsibilities. The durable worker
publishes each decision before Authority startup can serve: the one publisher
appends the V4 record, then writes the receipt and runs the after-record hooks
in one Authority transaction, so a crash between the append and the receipt
finishes once on recovery. Card redraw is provider presentation only: publication
requests it immediately after the durable work, independently of search. Each
presenter turn tries one card that no longer shows the proposal's state and
records the new state only after Slack confirms the replacement update.
Confirmed progress schedules another turn so a burst drains without waiting for
source polling. An uncertain result or failure waits for a new approval wake or
periodic pass; the cursor rotates so one unavailable card cannot starve the
rest. This keeps a Nango outage out of the startup gate and retains bounded,
cancellable attempts.

## Current composition

The Organization Authority composition root selects OpenRouter with the pinned
Claude Sonnet processing version as the decision processor, Slack for the
optional approval DM copy, interactions and identity, and Authority SQLite
state. Meetings enter only through a person's own sources, so ordinary startup
requires no meeting source. A staging-only synthetic personal source exercises
the retained meeting pipeline without Granola. It separately
composes the bounded Person `ask` path above Layer 3 with a pinned OpenRouter
DeepSeek planner/answer model. The other LLM transports are compiled
alternatives, not active runtime dependencies. This is an allowed selecting
composition profile, not evidence that every active provider has completed
qualification.

The Jira live runtime (`jira-person-live-runtime-v1.ts`) is a selected,
request-bound Person read capability. Global Ask reads tickets visible through
the asker's own Jira connection; project Ask additionally requires the saved
ECHO-to-Jira project mapping, and Mine excludes Jira. Jira data is read live for
the request and does not enter source admission or canonical meeting
processing. Personal connector verification remains request-only.

Confluence follows the same personal live-read boundary through its own
provider and selecting runtime. Global Ask discovers pages visible to the
connected person on the selected Confluence site, without an ECHO space or
page allowlist. Project Ask narrows discovery to the saved ECHO-project to
Confluence-space mapping and still checks the asker's permissions. A mapping
does not grant access, and an unmapped project does not fall back to global
Confluence discovery. Mine excludes external pages.

Live pages have their own provider-neutral citation contract. They are not
retained uploads, meeting records, or tickets. Discovery releases page metadata;
opening releases bounded sections with stable page and section coordinates,
the provider version, and a digest of the text actually read. Continuations
remain bound to the request, and current provider permissions are rechecked
before evidence reaches a model or an answer. Page bodies remain in request
memory and never enter source admission, capture, indexing, or change history.
The new answer response version keeps historical citation codecs strict.
Confluence query syntax, pagination, body formats, and site validation remain
inside the provider; the planner uses shared source capabilities.

The source-processing model remains separate from the permission-aware
read/model path. It receives one admitted source revision through the processor
port and has no Person session, retrieval-generation handle, broad corpus
access, or authorization-widening fallback. Answer composition receives only
the atoms released by the Layer 3 protocol boundary for one authenticated
Person request and cannot read lower
layers directly.

Current live composition reviews each meeting once, in the approval core. The
desktop card and, for a reviewer who linked Slack, the Slack DM copy offer the
same choices, and the first decision wins. **Who can read it** defaults to
**Only me**, which binds `restricted-reviewer-person-v2` if approved unchanged.
The reviewer may instead pick one to twenty of their active projects, binding
`project-members-readable-person-v1`; there is no Team choice. A separate
**Share the transcript** checkbox, off by default, also releases the exact
retained transcript to that audience. Owners are recorded only when the approver
confirms them. The selected policy is frozen with the approved record;
rejection creates no record.

## Shared connector capabilities

Sharing follows capabilities, so a provider reuses only the layers it needs:

| Shared layer | Current consumers | Provider-owned behavior |
| --- | --- | --- |
| Bounded JSON/UTF-8 reads, byte limits, abort/deadline handling and response cleanup | Jira, Confluence, Slack setup clients, Nango broker | URLs, HTTP/media-type policy, error meanings, retries and provider payloads |
| Personal Nango connection lifecycle, binding store, connection HTTP/client contracts | Jira and Confluence | OAuth scopes, resource/account verification and API permissions |
| Project mapping store and current project-grant fence | Jira and Confluence | Mapping shape, project/space discovery and visibility checks |
| Native Atlassian Document Format text normalization | Jira and Confluence | Requested representation, unsupported-content policy and evidence section identity |
| Registered live-source dispatch and Ask catalog | Jira, Confluence and explicitly bound Slack reads | Reader implementation and declared scope/capabilities |

The shared server mechanisms live in
[`providers/shared`](../../providers/shared/src/); common Person connection
contracts and client helpers remain in `packages/organization-api`. The bounded HTTP helper
handles stalled fetches/streams even if they ignore cancellation; wrappers keep
their existing status, size and empty-body policies. The common ADF normalizer
reads provider-native JSON, bounds depth/nodes/text and never fetches embedded
links or media. Confluence reports omitted unsupported content as incomplete.

Nango manages the OAuth flow and credential refresh; the person completes
provider consent. The shared personal connection
code creates Connect sessions and obtains credentials from Nango, then binds the
verified external account to the exact ECHO person, membership and local grant.
This path uses Nango for authentication only: it defines no content sync,
action or cache. ECHO persists connection references, grant/configuration state
and audit coordinates/digests; live ticket, page and message bodies remain in
request memory. Project mappings narrow discovery and never confer access.

Authority composition registers `PersonLiveConnectorDefinitionV1` entries with a
stable source ID, selector, content kind, description, list capabilities,
permitted scopes, minimum response version and runtime factory. The request
route binds each available source to the asker and exact project before
`createRegisteredPersonLiveEvidenceDeskV2` dispatches reads. Two providers may
both supply `page` content: their independent IDs/selectors determine which
source receives list/search, and issued handles determine which source receives
open. The planner's catalog and closed selector schema come from these entries;
adding a provider with an existing content kind needs no planner branch.
Revalidation checks every released source, then all local grants synchronously.
Older construction inputs translate into this same dispatch path, while older
answer versions retain their strict citation contracts.

Granola retains transport-free meeting normalization and context capture
transforms. Its organization acquisition and owner-admission code is retired;
shared meeting custody and processing contracts remain distinct from personal
live reads. Slack's organization app and approval DM copies likewise retain
their own lifecycle. A Slack Person read requires a separately authorized
binding; an organization approval installation alone grants no such access. This refactor
does not migrate Slack approval onboarding onto the Jira/Confluence personal
Nango lifecycle.

## Extension rule

A new integration begins as a typed capability, not a generic plugin. It keeps
vendor types behind its adapter boundary, declares identity and failure
semantics, supplies deterministic fakes, and passes capability-level tests.
The processing core must still compile and test when that adapter is absent.

For a new live connector:

1. Choose an existing evidence kind/citation contract, or introduce an explicit
   response version for a genuinely new kind. Implement the provider's bounded
   discovery, open and visibility revalidation behind `PersonLiveEvidenceReaderV1`.
2. Reuse bounded HTTP and, for compatible OAuth2 bearer connections, the shared
   Nango lifecycle. Supply provider validation and account/resource verification.
   Declare a fixed `storage_namespace` in the compiled provider descriptor.
   The shared stores validate that SQL identifier and keep a stable selection;
   request fields and Nango integration IDs never choose tables. Adding a
   connector does not extend a provider union or SQL registry in the shared engine.
3. Register its live definition and expose its Person tools/settings through the
   existing client and desktop composition. Add provider-specific mapping/picker
   semantics only when project scope needs them. Declare package/source-boundary
   and deployment dependencies; keep server adapter code out of the Person client.
4. Test permission loss, scope isolation, stale grants, pagination and same-kind
   coexistence with deterministic fakes. Qualify actual consent/read behavior
   through the operator lane before claiming the live integration is ready.

Provider semantics terminate at the edge. Adding a provider may add an adapter,
selecting composition, provider-owned persistence, onboarding, and tests, but
must not add provider branches to shared processing or canonical state. The
normative rule and the known failure mode are
[INV-ADAPTERS-005](../invariants/INV-ADAPTERS-005-provider-semantics-at-boundary.md)
and
[failure pattern](../failure-patterns/FP-ADAPTERS-005-first-provider-becomes-architecture.md).

## Known provider-neutrality caveats

- Initial-owner onboarding and the compatibility CLI select the concrete
  OpenRouter and Slack profile; there is no universal source-onboarding flow.
- The boundary covers external capabilities, not interchangeable SQLite,
  file-key, Node-runtime, or authentication-protocol implementations. The
  source port is pull-oriented; Person push submissions use the durable edge
  inbox. New push providers need an equivalent explicit buffering boundary.
- The Authority approval outbox stores no presentation state: a proposal's
  frozen snapshot and suggestions, and one decision row in
  `authority_approval_decisions_v1`, are all any surface draws from.
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
do not invoke the meeting decision processor, create approval proposals or publish
approved records. This implementation adds no requested-analysis API;
[global/project Ask](../features/global-project-ask-v1.md) answers from
extracted document evidence. Existing meeting sources retain their explicitly
composed `automatic` decision workflow; common admission does not imply every
source executes every downstream stage.

The legacy `/v2/person/updates` note contract retains its existing original
inbox, read indexes and optional search-enrichment worker. The client-less
`/v1/person/updates` route and its V1 search-hint worker are retired. Retained
V1 notes stay in custody and remain citable by Ask. Server pull also admits
accepted text notes, including retained V1 notes, through the same Person
source capability as documents, without requiring a model. Its typed content
distinguishes `person-text` from `person-document`; neither invents
`MeetingDocument` facts. Existing enrichment hints cannot alter the original or
audience and are not decision/action proposals; model failure preserves source
readability. See
[ADR-0014](../decisions/ADR-0014-unified-source-ingestion-and-document-custody.md),
[project documents](../features/project-documents-v1.md), and the historical
[upload scope](../product/2026-09-21-person-update-inbox-v1.md).
