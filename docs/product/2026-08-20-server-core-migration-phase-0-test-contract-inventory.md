# Server-core migration Phase 0 test-contract inventory

**Status:** Phase 0 specification, written 2026-08-20 against
`77a212134fce762fdffd30e028f3256ba6e75b42`. This document names required
future test contracts and maps them to the repository's current test evidence.
It does not claim that a future contract exists or passes.

**Parent plan:**
[server-core migration lean-down plan v4](2026-08-20-server-core-migration-lean-down-plan-v4.md).
The v4 preserve, replace-before-delete, safe-delete, and adapter/core ledgers
remain authoritative. This inventory makes their Phase 0 test gates explicit.

**Scope:** test specification and baseline classification only. It authorizes
no runtime change, schema change, deletion, policy-version change, cutover, or
Layer 4 work.

## Evidence labels

The two evidence classes in this document are deliberately different:

- **Existing passing evidence** names a test that exists in the current
  repository and was included in the current green baseline. It proves only
  the behavior named by that existing test. It is not proof of the future v4
  contract.
- **Future contract** names a proposed test suite and exact behavior that must
  be implemented and pass before the mapped deletion or phase exit. Every
  `T01` through `T15` entry below is future work and is **not passing evidence**.
- **Replacement-frozen evidence** names a currently passing test whose asserted
  behavior v4 intentionally replaces. Such a test must be retained as
  historical/old-artifact evidence or replaced in the same bounded tranche.
  It must never disappear without its named successor contract.

Repository-relative path aliases used in the mapping tables:

| Alias | Path |
| --- | --- |
| `OA` | `services/organization-authority/test` |
| `CP` | `services/organization-control-plane/test` |
| `REC` | `services/organization-record/test` |
| `RET` | `services/organization-retrieval/test` |
| `API` | `packages/organization-api/test` |
| `PRO` | `packages/organization-protocol/test` |
| `ARCH` | `tests/architecture` |
| `PC` | `tests/person-client` |

Every future negative case must assert both the externally safe response and
the absence of the protected side effect: no released bytes, provider call,
record/fact append, audit duplication, cursor advancement, delivery claim, or
state mutation, as applicable. A thrown error by itself is not proof.

## Phase-owned canonical evidence

The abandoned Phase-0 one-shot vector prototype is intentionally not part of
the test closure. It coupled unfinished D2, D3, D6, delivery, and route-
consolidation choices, drifted from main, and blocked typecheck without proving
runtime behavior. Each reversible phase now adds the smallest canonical
fixture alongside the implementation that owns those bytes. Object-order
invariance, array-order sensitivity, leaf mutation, kind/version separation,
forbidden cross-variant fields, and real signature verification remain required
before that boundary can pass Phase 4; they are not all prerequisites for the
first Phase-1 transport cut.

## Required future contracts

The paths below are proposed ownership locations. They do not exist yet.

### T01 — final topology and state-lineage contract

**Future suite:**
`tests/integration/server-core-v4/topology-lineage.test.ts`.

The suite must prove:

- one fresh Authority has exactly one organization, no tenant selector, one
  owner, at least three separately invited employees, and one separately
  invited later-joining employee;
- every Authority, control-plane, record, derived, and retrieval database has
  an exact manifest binding its role, schema version/digest, Authority,
  organization, state lineage, creation time, and creating artifact;
- all opened roles agree on the same Authority, organization, and lineage
  before a writable handle, listener, processing cycle, or provider call is
  exposed;
- a bounded foreign-Authority fixture cannot contribute a session, provider
  link, record, fact, generation, segment, or result to the target Authority;
  and
- missing, legacy, mixed-role, mixed-Authority, mixed-organization, mixed-
  lineage, and old-artifact/new-state combinations fail with zero mutation or
  provider traffic and no automatic upgrade.

### T02 — Person onboarding and identity lifecycle

**Future suite:**
`tests/integration/server-core-v4/person-onboarding.test.ts`.

The suite must prove:

- each invitation atomically creates a new principal, membership, audit row,
  and one-time Person login grant without creating an installation;
- the owner plus three employees can each complete the intended invitation,
  OIDC identity binding, session-family, access, refresh, and logout flow;
- exact email, issuer, subject, Authority, organization, membership, and grant
  relationships are checked at first login;
- returning login reuses only the exact immutable OIDC-to-principal binding;
- grant replay, refresh replay/race, membership revocation, foreign Authority,
  wrong email/issuer/subject, and stale Person/session state deny opaquely;
- a same-principal OIDC or membership retarget attempt denies without creating
  a binding, session, or membership; and
- invitation cardinality is not capped at the earlier two-person Pilot shape.

### T03 — adapter-to-ECHO identity spine

**Future suite:**
`tests/integration/server-core-v4/adapter-echo-identity-spine.test.ts`.

The suite must exercise this exact chain:

`Authority/organization/lineage -> provider connection -> adapter identity and
binding -> provider object and observed actor -> external identity link -> ECHO
principal and membership tenure -> action capability -> canonical human act`.

It must prove both retained approval policies through the same commitment
shape. Mutating, removing, revoking, replacing, crossing tenants, or inferring
any edge must deny at the stage that consumes that edge. Approval consumes
current provider/link/binding/capability evidence; record reproof consumes the
immutable audit ID/hash/proof; Person read consumes current Person/session/
membership plus canonical facts. After append, revoking every provider-side
edge in turn must not change stopped rebuild or current-Person read results.
Source custody and delivery identity must not satisfy a human approval edge.

### T04 — source activation, custody, and processing identity

**Future suite:**
`services/organization-authority/test/server-core-v4/source-pipeline-identity.test.ts`.

The suite must prove:

- stopped source activation makes zero meeting-provider calls and atomically
  freezes source kind/ID/instance/version, cursor/cutoff, normalizer contract,
  processor kind/ID/instance/version/config digest, credential proof, and
  exact current custodian principal/membership;
- candidate identity then adds the actual external object ID, canonical
  revision, `normalizer_version`, and nullable provider `source_revision`;
- retry/concurrency is convergent, restart preserves every member, and
  mutation of any pipeline or per-meeting member cannot resume the old row;
- known pre-call custodian revocation makes zero provider calls; revocation
  during a call discards the result with zero mutation; pending work pauses
  until atomic fresh-custodian activation against the unchanged tuple/bytes;
  and
- after durable human-action audit, custody revocation cannot strand exact
  record resolution or append-receipt recovery.

### T05 — approval identity and new policy contracts

**Future suite:**
`tests/integration/server-core-v4/approval-identity-contract.test.ts`.

**Initial contract slice (2026-08-20):**
`packages/organization-protocol/test/person-content-policy-v2.test.ts` freezes
the two exact Person policy bodies, consequence bytes, raw consequence
digests, computed contract digests, v1 separation, and selector-swap digest
separation. It does not claim approval binding, action-time authorization, or
runtime cutover proof.

**D2-1 contract-only slice (2026-08-20):**
`services/organization-control-plane/test/person-slack-approval-contracts-v2.test.ts`
freezes the exact private connection/current-state, link, approval binding,
capability, provider observation/message/action, authorization, integration
audit, semantic retry, and durable-result shapes. It mutates every identity
join and cross-checks the accepted ADR-0005 policy bytes with the protocol
source. It deliberately proves no persistence, administrator endpoint,
provider call, crash recovery, public export, or live runtime selection; those
remain D2-2 evidence. No application ID, baseline SQL, lineage genesis, or
SQLite opener is introduced before Phase 3.

**D2-2A offline activation slice (2026-08-20):**
`services/organization-control-plane/test/person-slack-approval-activation-v2.test.ts`
proves that an abstract Authority administrator credential, never an owner or
employee Person session, activates one installation-free Slack approval
binding and four ordered policy/action capabilities for an exact current
linked owner or employee. It covers current owner/target membership, active
link, connection-state and required-scope reproof, tenant/channel/adapter
joins, atomic rollback, command replay/conflict, concurrent resource reuse,
immutable versioning, and corrupt stored-body/digest/substitution denial. It
deliberately proves no concrete persistence, process restart, provider action,
audit-result recovery, public export, or live runtime selection. Those remain
D2-2B and Phase 3 evidence.

**D2-2B offline finalization slice (2026-08-20):**
`services/organization-control-plane/test/person-slack-approval-finalization-v2.test.ts`
proves the private `{approval_id}` state machine around an abstract stable
Authority/control-plane fence and an independently observing Slack provider
port. It performs pre-call connection, current-state, binding, policy, and
surface reproof; releases the fence for provider I/O; then atomically
intersects the observed Slack subject with the exact current tenant-scoped
Person link, membership tenure, and policy/action capability before building
the observation, message, provider action, authorization allow, chained audit,
semantic action, and durable D2 result. Recovery binds the requested approval,
the exact external-link digest through the provider-action hash, and verified
audit-chain membership before consulting mutable current edges or the provider.
The suite covers both policies and both actions, concurrent exact replay and
changed-expectation conflict, pre-call and in-flight revocation, atomic failure,
post-audit replay, corrupt history, cancellation, and adversarial object
shapes. It deliberately uses an injected Authority-owned frozen-approval
reproof witness plus in-memory coordinator/provider fakes. Concrete
persistence, process-restart proof, raw card/snapshot body ownership, the real
cross-role lock, a Slack adapter implementation, public export, live runtime
selection, and the later D3 resolution reference remain Phase 3/D3 evidence.

The suite must prove:

- Person Slack completion is link-only; the attempt ID is lookup/correlation,
  while a server-derived semantic digest binds attempt, code digest, stored
  message coordinate, current caller/session digest, and exact organization-
  tool digest;
- a separate Authority administrator-credential act creates the
  installation-free approval adapter binding and explicit policy-specific
  approve/reject capabilities; an owner Person session cannot satisfy this
  gate;
- the new provider-action digest binds every D2 field and a new integration-
  audit entry binds Authority, organization, lineage, actor class, stable link,
  connection, adapter binding, capability, event/detail, and predecessor;
- stable organization-tool, current connection-state, approval-binding, and
  action-capability bodies independently recompute their
  exact digests; missing bodies, partial comparison, credential rotation, and
  current-state substitution follow the RFC rules;
- the two closed Person policy-contract bodies recompute their exact digests;
  their exact consequence bytes and raw UTF-8 digests are frozen, and every
  field mutation, selector swap, item-order change, extra/missing field, and
  v1/new-version substitution denies;
- both retained policy families independently reconstruct the same semantic,
  provider-message, provider-action, and audit-entry commitments;
- new and legacy versions, policy families, tenants, adapter instances,
  connections, links, memberships, capabilities, cards, reactions, channels,
  and provider objects cannot substitute for one another; and
- every action-time denial asserts zero canonical act and, where rejection
  occurs before provider observation, zero provider call.

The suite contains no delivery binding, destination, intent, or publication-
consequence field. Changing approval channel, card, reaction, or
message/action commitment requires a new human act; delivery remains the
independently configured post-record state machine.

The digest and audit-entry tests must mutate every preimage field and include
predecessor, duplicate, retry, concurrency, revocation, conflicting reaction,
and provider-unknown cases.

### T06 — Authority record resolution and new Layer 1 writer

**Future suite:**
`tests/integration/server-core-v4/authority-record-resolution.test.ts`.

The suite must prove:

- approve and reject both carry one opaque monotonic
  `human_act_resolution_ref` with exact approval ID, action, policy ID/version,
  audit event ID/hash, and provider-action digest;
- the Authority resolves only that exact reference, recomputes immutable
  proof, builds the new domain-separated envelope, appends through the one
  governed in-process port, and returns the canonical signed receipt;
- exact retry, conflict, concurrency, predecessor/hash mutation, cross-policy,
  cross-version, cross-lineage, and restart behavior are deterministic;
- a crash after human-action audit but before gate save, append, or core receipt
  recovers the same act, audit entry, record, and receipt without a descriptive
  scan, second act, or second audit entry;
- approve and reject remain nonterminal until the append receipt is returned;
  rejection rejects every approved-payload, staged/final-content,
  policy-fact, rejection-text, candidate-content, or non-`none` delivery
  field, allows only the exact `none` publication-consequence digest as
  presentation proof, and appends no eligibility/readable fact or delivery
  intent;
- record and receipt fixtures independently mutate body hash, signature
  preimage, signing key, predecessor, event discriminator, policy-fact outcome,
  and wrapper/body field placement; and
- the log, receipt, audit, facts, and envelope contain no employee installation,
  enrollment, lease, installation key, synthetic Person, provider credential,
  live provider configuration, display identity, or resolved reader list.

### T07 — delivery identity, intent, and recovery

**Future suite:**
`tests/integration/server-core-v4/delivery-identity-recovery.test.ts`.

The suite must prove:

- an exact current owner/admin act separately activates a stable delivery
  binding/contract, distinct adapter kind/ID/instance, immutable destination,
  and current organization tool connection without creating an approval grant;
- the human act and record freeze exactly `none` or the matching binding,
  contract, destination, digest, and approved-snapshot digest;
- restricted-reviewer records freeze `none` absent a separately accepted exact-
  audience proof;
- wrong destination/audience, revoked or drifted binding/connection, approval-
  instance substitution, snapshot mutation, or absent intent makes zero
  provider calls and never changes the canonical act;
- the semantic delivery key binds Authority, organization, lineage, record
  identity/hash, snapshot, binding/contract, and destination, while credential,
  connection, and implementation revisions remain attempt provenance; and
- SQLite claim/unknown/outcome recovery covers crash before call, known-no-
  write retry, provider success before persistence, ambiguous outcome, restart,
  and core-receipt crash without blind repost.

### T08 — new-lineage Layers 1 and 2

**Future suite:**
`tests/integration/server-core-v4/layers-1-2-new-lineage.test.ts`.

The suite must prove:

- approved records atomically co-commit only the complete policy-specific,
  text-free eligibility facts; rejection commits none;
- canonical verification, predecessor/hash chain, receipt recovery, projection,
  and stopped rebuild are deterministic from the new genesis;
- organization-member segments bind organization plus policy contract, while
  reviewer segments additionally bind the exact principal/membership tenure;
- exact-head build produces immutable separated fact/content/lexical planes,
  and fact, content, provenance, segment, manifest, policy, head, or generation
  substitution fails before content is returned;
- a separately invited later employee can read organization-member content,
  while a revoked member, foreign organization, unknown future membership type,
  and different reviewer tuple deny; and
- old policy/envelope bytes remain historical and cannot enter the new lineage.

### T09 — Layer 3 Person release and D6 audit

**Future suite:**
`tests/integration/server-core-v4/person-read-release-audit.test.ts`.

The suite must cover every retained Person read and exclusion operation and
prove:

- reviewer-recent preserves the exact reviewer principal/membership-tenure
  selection, deterministic current response contract, and verified Layer-1/
  canonical-log availability, including immediately after append before a
  Layer-2 rebuild;
- readable search preserves the organization-member exact-head Layer-2 scope,
  deterministic response contract, and fixed unavailable response while its
  generation is stale; neither operation silently falls back to the other's
  substrate;
- exact caller binding over Authority, organization, state lineage, principal,
  membership, membership type, OIDC binding, session family, access credential
  digest, Person-state digest, and session-state digest;
- normative closed retrieval scope over caller, operation/request, ordered
  policies, retrieval contract/generation/manifest, record head, and every
  admitted path/segment and manifest, plus a non-substitutable closed
  Authority-state scope over source ownership and exclusion state for those
  operations, neither containing query/content text or returned items;
- post-search release binding over caller, scope, exact response digest, and a
  closed retrieval tuple or Authority-resource/state tuple; an uninformative
  mutation acknowledgement has no release binding but co-commits its audit;
- `prepare -> deterministic private serialization -> final fence and audit ->
  release unchanged bytes` ordering, with no early write or reserialization;
- start/end Person resolution, exact retrieval or Authority-state scope
  recheck, safe witnesses, opaque denial, and zero hidden count or item
  metadata;
- audit outage or mutation of any caller/scope/release member discards the
  private buffer and releases zero bytes; and
- 30-day retention and audited whole-row expiry; the export capability returns
  the closed `unsupported` result while selecting zero audit rows and opening
  or writing zero output files.

### T10 — installation-free operator surface

**Future suite:**
`tests/integration/server-core-v4/operator-surface.test.ts`.

The suite must initialize an organization and exercise owner plus three
employee invitations, revocation, OIDC status, organization Slack and source
onboarding, Person Slack links, approval activation, delivery activation,
provider/link/binding inspection, current processing state, and required
recovery through the canonical JSON API and thin CLI. It must prove there is
no dependency on the browser console or installation counts/pages and that
operator failures reveal no grant, credential, token, or content bytes.

### T11 — processing outcome and lifecycle ownership

**Future suite:**
`services/organization-authority/test/server-core-v4/processing-lifecycle.test.ts`.

The suite must prove the one serialized lifecycle emits deterministic accept,
edit, and reject outcome evidence from immutable request/resolution rows,
coalesces retries/concurrency without double counting, excludes synthetic work
from human capacity, and performs bounded 30-day cleanup of terminal work while
retaining pending, unresolved delivery, audit, marker, and receipt evidence.
Instrumentation or cleanup failure must not repeat the human act or lose
recoverable state.

### T12 — retained LLM provider configuration

**Future suite:**
`services/organization-authority/test/server-core-v4/retained-provider-config.test.ts`.

The suite must prove the retained production provider is explicit; missing,
unknown, or removed provider configuration fails before processing; no local
or retired-provider fallback exists; provider/model/schema-affecting changes
produce the intended processing identity; implementation-only timeout changes
do not; the retained golden processing digest/key remains pinned; and the
processor receives only source-port input, never Person credentials, retrieval
handles, global corpus access, or Layer 4 dependencies.

### T13 — deletion and runtime-closure contract

**Future suite:**
`tests/architecture/server-core-v4-runtime-closure.test.ts`.

The suite must scan production source, package exports, route tables, OpenAPI
and protocol assets, SQL manifests and schema objects, composition roots,
runtime artifact file lists, direct dependencies, configuration, commands,
fixtures, and current documentation for every retired identifier. Each target
must have zero current caller/import/export/route/object/artifact/dependency.
Historical ADR, design, v3, and qualification references must be allowed only
by exact path allowlist. The scan must also prove no compatibility behavior is
hidden behind a renamed alias.

For D6 export retirement the scan explicitly names both legacy CLI commands
`reviewer-query-audit-export` and `readable-search-query-audit-export`; the
`echo-authority-*-query-audit-export-command`, `-export`, and `-row-set`
document kinds; `reviewer-query-audit.ts` export surface;
`readable-search-query-audit-maintenance.ts` export surface; both SQLite
maintenance repositories and reviewer row helper; operator-state export/file
writer branches; and the `export-reviewer-query-audit` and
`export-readable-search-query-audit` runtime-fingerprint modes. No replacement
production row-selection or file-writing alias is permitted.

### T14 — semantic parity and reset rehearsal

**Future suite:**
`tests/integration/server-core-v4/parity-reset.test.ts`.

The suite must run the D5 corpus through isolated old and new artifact/state
pairs and compare human outcome, frozen bytes, mapped policy consequence,
reader sets, Layer 1 facts, Layer 2 contents, witnesses, denial/non-disclosure,
audits, retry/conflict/restart/unknown outcomes, and approval-versus-delivery
separation. It compares the full authorized candidate union before the new
recent transform, then proves the accepted global order/coalescing/cap of ten
for cross-policy interleaving, ties, and overflow. Audit behavior must remain
equivalent before day 30; the new row deliberately expires after day 30 while
the old 180-day row remains, and every old export command is deliberately
absent/unsupported in the new artifact. Only these accepted deltas and the
installation/lease-to-Person identity and policy-version delta may differ. It
must rehearse empty-state reset and rollback, reject mixed pairs, copy no rows,
dual-write nowhere, and make zero live provider calls.

### T15 — typed boundaries and Layer 4 exclusion

**Future suite:**
`tests/architecture/server-core-v4-boundaries.test.ts`.

The suite must prove direct registry-free injection of `MeetingSourceAdapter`,
`DecisionProcessorAdapter`, `ApprovalSurfaceAdapter`, `ApprovalGate`,
`DeliverySurfaceAdapter`, `CoreStateStore`, and the record-resolution port;
inward-only dependencies; no provider SDK, persistence implementation,
composition root, or credential loader in core; non-substitutable approval and
delivery identities; and no answer-composition route, retrieval-to-model edge,
prompt/answer audit, tool/agent path, or streaming answer in Layers 1–3.

## Preserve-row mapping

Every preserve row has some existing passing evidence. No preserve row yet has
complete final-lineage proof.

| ID | Preserve surface | Existing passing positive evidence | Existing passing denial evidence | Missing future proof |
| --- | --- | --- | --- | --- |
| P01 | One Authority per organization | `CP/control-plane-lifecycle.test.ts:47`; `OA/organization-record-lifecycle.test.ts:316` | `OA/operator-lifecycle.test.ts:1652,1756`; `OA/organization-record-lifecycle.test.ts:239` | T01 |
| P02 | Principals and 1:N memberships | `OA/authority-runtime.test.ts:444,1076` | Divergent command reuse in `OA/authority-runtime.test.ts:444`; revoked target at `OA/person-identity-sessions.test.ts:1429` | T01, T02 |
| P03 | Person login grants, OIDC, attempts, sessions, and credentials | `OA/person-identity-sessions.test.ts:504`; `OA/person-identity-session-persistence.test.ts:163` | Refresh replay, final-state race, and revoked target at `OA/person-identity-sessions.test.ts:1161,1216,1429` | T02 |
| P04 | Organization Slack tool onboarding | `OA/organization-integrations-application.test.ts:534`; `CP/integrations-repository.test.ts:1439` | Provider/owner failure, missing credential, and legacy fields at `OA/organization-integrations-application.test.ts:1056,1088,1205` | T01, T03 |
| P05 | Provider attempts and organization tool connections | `CP/integrations-repository.test.ts:534`; `OA/organization-integrations-application.test.ts:757` | Mismatched binding at `CP/integrations-repository.test.ts:438`; owner/credential drift at `OA/organization-integrations-application.test.ts:917,964` | T03 |
| P06 | Person Slack identity links | `OA/person-slack-identity-link.test.ts:215`; `CP/integrations-repository.test.ts:799` | Caller mismatch and post-observation revocation at `OA/person-slack-identity-link.test.ts:257,272` | T03, T05 |
| P07 | Adapter identities and persisted bindings | `CP/integrations-repository.test.ts:302,1045`; `OA/adapters/persistence/sqlite/processing-source-runtime-binding.test.ts:73` | Mismatched/partial binding at `CP/integrations-repository.test.ts:438,1267`; changed approval instance at `OA/organization-member-record-ingest.test.ts:150` | T03–T05, T07 |
| P08 | Approval capabilities and integration-audit proof | `OA/organization-integrations-application.test.ts:2022`; `CP/reviewer-restricted-evidence.test.ts:382`; `OA/organization-member-record-ingest.test.ts:65` | Binding/card drift, changed/tampered evidence, unavailable proof, and mismatch in the same suites | T03, T05, T06 |
| P09 | Source identity and custody binding | `OA/processing/adapters/granola-meeting-source.test.ts:246`; `OA/processing/storage/sqlite-authority-processing-store.test.ts:299,372` | Wrong/missing owner at Granola `:873,910`; cross-owner/revocation at store `:299,372` | T04; current store `:510` is replacement-frozen evidence |
| P10 | Member source and meeting exclusions | `OA/person-member-exclusions.test.ts`; `OA/sqlite-authority-member-exclusions.test.ts`; processing-store admission tests | Opaque owner mismatch/inactive or revoked session, same-transaction source ownership, and final read denials in the same suites | T04, T09 |
| P11 | Typed processing ports | `ARCH/workspace-boundaries.test.ts:830,876`; `OA/processing/core/tool-agnostic-core.test.ts:636` | Boundary probes `:830,857`; malformed source, rejection/no publish, and invalid receipt in core | T15; registry test at core `:464` is replacement-frozen evidence |
| P12 | Canonical record, derive, and retrieval boundaries | `REC/record-log.test.ts:91`; `REC/record-derive.test.ts:117,296`; `RET/generation-build.test.ts:181`; `RET/generation-serving.test.ts:24` | Record mutation, halted derive, substituted fact/content/provenance, and corrupt/swapped plane tests | T06, T08 |
| P13 | Both content-policy families | `OA/reviewer-restricted-full-lifecycle.test.ts:83`; `OA/readable-search.test.ts:377,396,427` | Reviewer tuple substitution, missing member fact, final read denial/race, and protocol-version denial | T01, T05, T08, T14 |
| P14 | Person Authority root | `PC/person-client.test.ts:91`; `OA/person-read-http.test.ts:119` | Invalid origin and `API/person-read-requests.test.ts:146` caller/subject rejection | T01, T02, T09 |
| P15 | Person response contracts | `API/recent-decisions-request.test.ts:130`; `API/readable-search.test.ts:115`; `OA/recent-decisions.test.ts:44`; `OA/readable-search.test.ts:377` | Oversize/repetition, source drift, no-scope, and audit-failure/no-byte tests | T05, T08, T09 |
| P16 | Audit and consistency fences | `OA/person-read-decision-audit-persistence.test.ts:76`; `OA/readable-search.test.ts:341,377`; `OA/authority-runtime.test.ts:2164` | Audit mutation, final revocation, audit failure, and recent-read revocation tests | T09 |
| P17 | Approval/delivery separation | `OA/processing/core/tool-agnostic-core.test.ts:636,682`; approval surface `:847`; delivery surface `:177,206` | Ambiguous delivery, wrong destination, unresolved delivery, and conflicting-reaction tests | T06, T07 |
| P18 | Central integration and record anchors | `OA/organization-record-lifecycle.test.ts:316`; `OA/operator-lifecycle.test.ts:1457`; `CP/control-plane-lifecycle.test.ts:47` | Missing/mismatched/foreign integration state and unanchored record-half tests | T01 |

## Replace-before-delete mapping

Existing evidence in this table describes the compatibility behavior or a
partial semantic replacement. It does not clear the deletion gate.

| ID | Legacy surface | Existing passing positive evidence | Existing passing denial evidence | Missing future replacement |
| --- | --- | --- | --- | --- |
| R01 | Server installation compatibility bridge | `OA/server-installation-compatibility-bridge.test.ts:342,389,430,475` | Same file `:526,567` | T05–T07 plus all three accepted D1 actor scopes |
| R02 | Installation enrollment and access-lease root | Current lease tests in `OA/authority-runtime.test.ts`; current Person session and membership tests | Forged/stale/expired access at Authority runtime `:867`; Person revocation/race tests | T02, T05, T06 and a zero-caller proof |
| R03 | Installation-signed permission checks | `OA/organization-integrations-application.test.ts:1283,2022,2327` | Card/link/provider/membership denials in the same suite `:1620–1790,2078–2243` | T03, T05 |
| R04 | Installation-owned approval bindings and grants | `CP/integrations-repository.test.ts:1045,1213`; Person link-only binding `:799` | Historical/mismatched/partial binding at `:1164,1267` | T03, T05, T07 |
| R05 | Installation-signed record envelope and HTTP ingest | `OA/protocol-record-envelope-builder.test.ts`; `OA/organization-record-ingest.test.ts:59,243,290`; `REC/record-log.test.ts` | Audit, tamper, signature, version, and evidence denials in the ingest suites | T06 |
| R06 | Installation-scoped idempotency and receipt fields | `REC/record-log.test.ts:253,297`; Authority ingest `:290` | Record log `:270`; Authority ingest `:449` | T06; record-log `:279` is replacement-frozen evidence |
| R07 | Installation actor fields in integration and query audits | `CP/integrations-repository.test.ts:1328,1391`; `OA/person-read-decision-audit-persistence.test.ts:76` | Evidence tamper/corruption and audit-row mutation tests | T03, T05, T09; integrations `:1391` is replacement-frozen evidence |
| R08 | Installation-signed recent/reviewer/search requests | Person HTTP and service tests for all three reads | Bearer, subject, revocation, pre-source authorization, and audit-outage tests | T09, T14 and zero installation dependency |
| R09 | V1 Slack identity-link transport | Person link application, HTTP, and API tests | Wrong caller/subject, revoked membership, forbidden field, and route tests | T03, T05, T13 |
| R10 | Machine enrollment invitation UI | `OA/admin-console-routes.test.ts:617,890`; CLI membership/invitation tests; Person login-grant tests | Console auth/origin and private CLI output tests | T02, T10 |
| R11 | Compatibility administration counts and pages | `OA/organization-admin-api-client.test.ts:191`; admin console and CLI list tests | API validation and inconsistent-summary tests | T10, T13 |
| R12 | Person body identity and route assertions | `API/person-read-requests.test.ts:60,74`; Person HTTP dispatch | Cross-route and unknown-field tests | T09; current DTO positives are replacement-frozen evidence |
| R13 | Fixed two-person Pilot path | `REC/permission-pilot.test.ts`; Authority Pilot activation tests | Missing/revoked audience, corrupt marker/pointer, and non-Pilot denial tests | T01, T05, T14 plus zero unresolved-Pilot state |
| R14 | Standalone reviewer-recent request/route/service/client surface | Current reviewer-recent API, HTTP, service, response, witness, Layer-1/log availability, and audit tests | Wrong caller/tenure, revocation, append-before-rebuild availability, final-fence, and no-byte audit-failure tests | T09 retained reviewer-recent path and T14 per-caller old/new item parity |

## Safe-delete mapping

Safe-delete still requires replacement negative proof where the current test
protects accepted semantics.

| ID | Safe-delete target | Existing passing evidence | Missing future deletion proof |
| --- | --- | --- | --- |
| S01 | Client enrollment, signing, keys, leases, machine database, service manager, JSONL outbox, and fleet updater remnants | `ARCH/workspace-boundaries.test.ts:818` already proves retired machine product roots absent; bridge tests expose the surviving server closure | T13 exhaustive runtime/artifact closure |
| S02 | V1 signed-read DTOs, builders, verifiers, constants, commands, and request fixtures | V1 API tests plus Person response and service tests provide the old/new semantic reference | T09, T13, T14 and no-retired-export proof |
| S03 | Installation onboarding schemas and fixtures | `PRO/onboarding-access-chain.test.ts`, schema conformance, and package-contract tests | T02, T13; current package-contract evidence is replacement-frozen |
| S04 | V1 Slack request-only DTOs and routes | `API/slack-link-request.test.ts`, integrations HTTP tests, and Person-link replacement tests | T03, T05, T13 route/export absence |
| S05 | Compatibility-only route, error, startup, configuration, and dependency wiring | Current route and bridge tests enumerate the legacy behavior | T13 after the last semantic replacement |
| S06 | Legacy installation SQL, migrations, repositories, counters, and schema builders | Authority, control-plane, and record migration tests pin the old schema/checksums | T01, T13 exact fresh schema and zero retired objects |
| S07 | Tests asserting only removed transport ceremony | Bridge, signed DTO, process-one, baseline, Pilot, file-lock, and old route tests identify candidates | Same-tranche mapping from every removed test to T01–T15; no blanket removal |
| S08 | Stale exports and dependencies | Package-contract and workspace-boundary tests | T13 negative export/import/dependency closure |
| S09 | Compatibility prose | `ARCH/docs-validator.test.ts` provides structural documentation checks | T13 exact-path historical allowlist and current-mode semantic scan |

## Adapter/core replacement and deletion ledger

These rows refine the classification above and receive their own test gates.

| ID | Current implementation | Existing passing evidence | Missing future gate |
| --- | --- | --- | --- |
| L01 | Combined recording-policy overlay | Recording activation, validation, and runtime-config tests | T04, T05 split plus restart/config-drift tests |
| L02 | Delivery reuses approval instance | Slack delivery and record-first-delivery tests | T07 |
| L03 | Incomplete processing key | Processing-store replay/restart tests | T04; source-version resume is replacement-frozen |
| L04 | Structured-text canary cannot resume the live LLM candidate | Process-one and baseline CLI/composition tests; live OpenRouter runtime test | T04 atomic no-pull activation and first-post-cutoff live processing |
| L05 | Multiplexed ordinary/Pilot/reviewer/member approval | Slack approval-surface and integration-application suites | T05 plus ordinary/Pilot unresolved-state preflight |
| L06 | Rejection becomes terminal before canonical record append | Core rejection and rejection-envelope builder tests | T06; the current core terminal test is replacement-frozen |
| L07 | File delivery journal plus SQLite receipt | Slack delivery crash/unknown tests and processing-store receipt tests | T07 SQLite pre-call state machine plus import/zero-state proof |
| L08 | Unwired outcome instrument and cleanup | Approval-outcome instrument tests and processing-store 30-day cleanup test | T11 live lifecycle ownership |
| L09 | Four LLM drivers and implicit provider default | Provider-client and LLM processor configuration/version tests | T12; implicit Ollama evidence is replacement-frozen |
| L10 | Synthetic replay in production closure | Synthetic replay unit and integration corpus tests | T14 before relocation or deletion |
| L11 | Repeated per-route Person fences and audits | Recent/search/exclusion service and audit tests | T09 joined current-access query and unified audit |
| L12 | Pre-serialized HTTP response boundary | Readable-search sealed handoff and audit-failure tests | T09 explicit immutable-buffer release protocol |

## Replacement-frozen current tests

The following tests intentionally describe current behavior that v4 replaces.
They are passing baseline evidence, not defects in the present artifact. Each
must become old-artifact evidence or be replaced atomically with its named
future contract.

| ID | Current passing assertion | V4 disposition |
| --- | --- | --- |
| F01 | `OA/processing/storage/sqlite-authority-processing-store.test.ts:510` resumes an old candidate after a source-adapter version change | T04 must require a distinct/conflicting candidate and exact frozen-version resume only |
| F02 | `REC/record-log.test.ts:279` scopes idempotency to installation | T06 replaces it with Authority/organization-writer-scoped semantic idempotency |
| F03 | `OA/processing/core/tool-agnostic-core.test.ts:682` marks rejection processed without canonical record append | T06 requires nonterminal rejection until canonical append receipt |
| F04 | `API/person-read-requests.test.ts:60,74` positively requires Authority, organization, subject, HTTP method, and path in Person bodies | T09 moves identity and routing to authenticated server context and keeps only semantic input |
| F05 | `API/person-slack-link.test.ts:45` positively requires caller-supplied challenge message coordinates | T05 uses stored challenge coordinates and a server-derived semantic completion digest |
| F06 | `OA/processing/adapters/llm-decision-processor.test.ts:382–464` treats omitted provider as explicit Ollama | T12 requires an explicit retained provider and no fallback |
| F07 | `CP/integrations-repository.test.ts:1391` recomputes the current audit entry after excluding `organization_id` | T05 introduces a new entry version binding Authority, organization, and lineage; old bytes remain historical |
| F08 | `OA/processing/core/tool-agnostic-core.test.ts:464` certifies the generic in-memory registry | T15 replaces it with direct typed-port composition proof |
| F09 | `PRO/package-contract.test.ts:28` requires legacy enrollment/access-state schemas in the runtime package | T13 removes them from the new runtime/export closure without rewriting historical files |
| F10 | Current policy and protocol fixtures certify literal installation/lease-bearing `*-v1` bytes | T05 and T08 add explicit Person/new-lineage versions; V1 remains historical and cross-denied |
| F11 | Current migration suites exercise in-place upgrades of legacy Authority/control-plane/record state | T01 and T14 require the new artifact to reject legacy/mixed state and initialize a fresh lineage |

The Phase-0 fixture now names `human_act_resolution_ref`,
`provider_action_sha256`, `delivery_binding_id`, `delivery_contract_sha256`,
`state_lineage_id`, and `release_binding_sha256`, but no production validator,
runtime path, or non-fixture integration test implements them. Existing
runtime `caller_binding_sha256` and `scope_binding_sha256` coverage uses
earlier partial shapes and does not satisfy T09's normative preimages.

## Phase 0 exit rule

Phase 0 test inventory is complete when:

1. every preserve, replace-before-delete, safe-delete, and adapter/core ledger
   row is mapped exactly once above;
2. every deletion tranche cites its required T01–T15 contracts before work
   starts;
3. every replacement-frozen test has an explicit old-artifact or same-tranche
   successor disposition;
4. no existing passing test is represented as final v4 proof; and
5. no T01–T15 future suite is represented as implemented or passing until its
   file exists, runs in the named command family, and supplies the required
   positive, negative, and zero-side-effect assertions.

This inventory closes only the test-contract naming portion of Phase 0. The
v4 D0 through D6 decisions and evidence gates remain independently blocking.
