# Server-core migration Phase 0 closure ledger

**Status:** initial V1 implementation-ready / formal acceptance open

**Inventory baseline:** `77a212134fce762fdffd30e028f3256ba6e75b42`
on `migration/server-core-relocate-retire`, compared with
`4665c3a93187095d5d14acbe95e825cd69aaf31e` on `main`.

**Purpose:** freeze the file, symbol, schema, identity-edge, decision, and
verification inventory used to execute the migration phase by phase. This is a
Phase-0 implementation baseline, not a deletion patch and not authorization to
cross the Phase-4 reset/cutover gate.

The active execution plan is the
[server-core migration lean-down plan v4](2026-08-20-server-core-migration-lean-down-plan-v4.md).
This ledger gives its deletion classes stable target IDs and verification
owners. It reuses the detailed caller and sizing evidence in the
[machine-boundary audit](2026-08-16-machine-boundary-audit.md),
[Phase 4B Authority retirement sizing ledger](2026-08-18-phase-4b-authority-retirement-sizing-ledger.md),
and historical
[server-core migration plan v3](2026-08-17-server-core-migration-plan-v3.md)
instead of copying thousands of caller lines into another document.

## Non-action declaration

Creating and reviewing this ledger:

- changes documentation only;
- deletes or rewrites no application, test, migration, fixture, or historical
  decision file;
- opens, migrates, resets, or copies no Authority, control-plane, record,
  derived, retrieval, or processing database;
- changes no runtime configuration, credential, provider connection, Slack
  binding, deployment, service, cloud resource, or live process;
- performs no founder-state cutover or rollback; and
- does not make D0 through D6 accepted.

No runtime or product state change is part of Phase 0 inventory work. A later
phase may act only through the entry, exit, kill, and rollback gates in v4.

## Baseline verification

The full pre-deletion baseline is green. This is the comparison point for every
later replacement and deletion tranche; it is not evidence that a future
tranche is safe.

| Check                                    | Baseline result        |
| ---------------------------------------- | ---------------------- |
| Documentation validation                 | Green                  |
| Workspace and source-boundary validation | Green                  |
| Type checking                            | Green                  |
| Lint                                     | Green                  |
| Test files                               | 141 passed             |
| Tests                                    | 1,390 passed           |
| Full command                             | `npm run check` passed |

Every later tranche starts from this result, adds its focused contract proof,
and ends with another full `npm run check` from the exact candidate commit.

## Verification owners

The owner is the subsystem that must supply evidence, not permission to weaken
another subsystem's contract.

| Code         | Verification owner                                                           |
| ------------ | ---------------------------------------------------------------------------- |
| `CORE`       | Typed processing core and architecture boundaries                            |
| `PERSON`     | Person API, client, OIDC identity, sessions, and membership state            |
| `IDENTITY`   | Authority and control-plane provider/adapter/ECHO identity chain             |
| `PROCESSING` | Source custody, candidates, approval, delivery, and lifecycle                |
| `RECORD`     | Protocol, Authority writer, canonical log, receipts, and Layer 1 facts       |
| `READ`       | Derived state, retrieval, Layer 3 authorization, audit, and byte release     |
| `LINEAGE`    | Fresh schemas, manifests, artifact/state pairing, reset, and refusal         |
| `OPS`        | JSON administration API, thin CLI, inspection, recovery, and state preflight |

## Named test contracts

The canonical contract namespace, proposed ownership paths, existing evidence,
and missing future proof live in the
[Phase 0 test-contract inventory](2026-08-20-server-core-migration-phase-0-test-contract-inventory.md).
This ledger links those contracts directly and creates no aliases:

- [T01] — final topology and state-lineage contract
- [T02] — Person onboarding and identity lifecycle
- [T03] — adapter-to-ECHO identity spine
- [T04] — source activation, custody, and processing identity
- [T05] — approval identity and new policy contracts
- [T06] — Authority record resolution and new Layer 1 writer
- [T07] — delivery identity, intent, and recovery
- [T08] — new-lineage Layers 1 and 2
- [T09] — Layer 3 Person release and D6 audit
- [T10] — installation-free operator surface
- [T11] — processing outcome and lifecycle ownership
- [T12] — retained LLM provider configuration
- [T13] — deletion and runtime-closure contract
- [T14] — semantic parity and reset rehearsal
- [T15] — typed boundaries and Layer 4 exclusion

[T01]: 2026-08-20-server-core-migration-phase-0-test-contract-inventory.md#t01--final-topology-and-state-lineage-contract
[T02]: 2026-08-20-server-core-migration-phase-0-test-contract-inventory.md#t02--person-onboarding-and-identity-lifecycle
[T03]: 2026-08-20-server-core-migration-phase-0-test-contract-inventory.md#t03--adapter-to-echo-identity-spine
[T04]: 2026-08-20-server-core-migration-phase-0-test-contract-inventory.md#t04--source-activation-custody-and-processing-identity
[T05]: 2026-08-20-server-core-migration-phase-0-test-contract-inventory.md#t05--approval-identity-and-new-policy-contracts
[T06]: 2026-08-20-server-core-migration-phase-0-test-contract-inventory.md#t06--authority-record-resolution-and-new-layer-1-writer
[T07]: 2026-08-20-server-core-migration-phase-0-test-contract-inventory.md#t07--delivery-identity-intent-and-recovery
[T08]: 2026-08-20-server-core-migration-phase-0-test-contract-inventory.md#t08--new-lineage-layers-1-and-2
[T09]: 2026-08-20-server-core-migration-phase-0-test-contract-inventory.md#t09--layer-3-person-release-and-d6-audit
[T10]: 2026-08-20-server-core-migration-phase-0-test-contract-inventory.md#t10--installation-free-operator-surface
[T11]: 2026-08-20-server-core-migration-phase-0-test-contract-inventory.md#t11--processing-outcome-and-lifecycle-ownership
[T12]: 2026-08-20-server-core-migration-phase-0-test-contract-inventory.md#t12--retained-llm-provider-configuration
[T13]: 2026-08-20-server-core-migration-phase-0-test-contract-inventory.md#t13--deletion-and-runtime-closure-contract
[T14]: 2026-08-20-server-core-migration-phase-0-test-contract-inventory.md#t14--semantic-parity-and-reset-rehearsal
[T15]: 2026-08-20-server-core-migration-phase-0-test-contract-inventory.md#t15--typed-boundaries-and-layer-4-exclusion

## Classification rule

- **Preserve** means the behavior or evidence is load-bearing. Its internal
  shape may receive a separately accepted version, but cleanup cannot remove
  its meaning.
- **Replace before delete** means the current representation is not the end
  state. The named replacement and tests must be live before any old caller,
  schema object, or route is removed.
- **Safe delete** means no new product meaning is required. It still needs the
  exact zero-caller/export/state proof named below and a focused green tranche.

A target never becomes safe merely because its name contains `installation`,
`v1`, `legacy`, `pilot`, or `unused`.

## Preserve ledger

| Target ID  | Concrete surface                                                                                                                                                                                  | Required preserved meaning                                                                                                                                                                  | Owner                    | Test contracts             |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | -------------------------- |
| `P0-P-001` | `authority_metadata`, `authority_principals`, `authority_memberships`                                                                                                                             | Immutable Authority/organization binding, one owner plus arbitrary employees, provisioning, exact-tenure revocation, and no tenant selector.                                                | `PERSON`, `IDENTITY`     | [T01], [T02]               |
| `P0-P-002` | `person-identity-sessions.ts`; OIDC/login/session repository ports; Authority migrations `0009`, `0013`, `0014`                                                                                   | Person grants, issuer/subject bindings, nonce, state, PKCE, expected email, session families, credentials, replay closure, and current-state checks.                                        | `PERSON`                 | [T02]                      |
| `P0-P-003` | Control-plane connection, external-link, tool-connection, adapter-binding, capability/grant, and integration-audit semantics                                                                      | Provider identity is linked to one exact ECHO principal/membership and adapter action without treating a link, reader, or source owner as an approver.                                      | `IDENTITY`               | [T03], [T05]               |
| `P0-P-004` | `AdapterIdentity`, `AdapterConfig`, `MeetingSourceAdapter`, `DecisionProcessorAdapter`, `ApprovalSurfaceAdapter`, `ApprovalGate`, `DeliverySurfaceAdapter`, `CoreStateStore`, `LlmProviderClient` | Narrow typed capabilities, exact adapter instance/version evidence, and inward dependency direction. Approval and delivery remain distinct.                                                 | `CORE`                   | [T15]                      |
| `P0-P-005` | `MeetingProvenance`; source owner/configuration/cursor/candidate state; `processing-source-identity.ts`; `processing-source-runtime-binding.ts`                                                   | Source custody, credential proof, full external object/revision provenance, normalizer version, nullable provider revision, processor identity/config digest, cutoff, and restart identity. | `PROCESSING`, `IDENTITY` | [T04]                      |
| `P0-P-006` | Processing candidates, slots, approval contracts, resolution proof, processed markers, frozen act input, and configured delivery attempt/receipt meaning                                             | Durable pre-record work, exact human outcome, crash recovery, terminal cleanup basis, and separate post-record delivery acknowledgement.                                                    | `PROCESSING`             | [T05], [T06], [T07], [T11] |
| `P0-P-007` | Canonical record log, predecessor/hash chain, Authority receipt, reviewer and organization-member facts, deterministic derive                                                                     | Layer 1 truth, approval-only facts, rejection non-disclosure, exact audit reproof, and the two independent policy families.                                                                 | `RECORD`                 | [T06], [T08]               |
| `P0-P-008` | Facts/content/lexical retrieval databases, immutable generations, active-generation pointer, policy path namespaces                                                                               | Layer 2 remains rebuildable, exact-head, physically separated, pre-scoped, and policy-specific.                                                                                             | `READ`                   | [T08], [T09]               |
| `P0-P-009` | Person caller/session resolution, membership/exclusion checks, scope and release fences, response validators/witnesses, audit-before-bytes                                                        | Layer 3 releases only the exact audited bytes to a current Person and leaks no hidden count or metadata on denial.                                                                          | `READ`, `PERSON`         | [T09]                      |
| `P0-P-010` | Authority signing identity, organization provider credential references, control-plane anchor, record anchor, isolated database roles                                                             | Central organization custody and deletion detection survive employee-machine retirement.                                                                                                    | `LINEAGE`, `IDENTITY`    | [T01], [T03]               |

## Replace-before-delete ledger

| Target ID  | Current file, symbol, or schema target                                                                                                                                                                                                        | Replacement and deletion proof                                                                                                                                                                                                                           | Gate                                           | Owner                    | Test contracts                    |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | ------------------------ | --------------------------------- |
| `P0-R-001` | Installation methods and types in `application/organization-authority.ts`: enrollment completion, installation contexts, lease issue, signed reads/checks, revocation, and recovery                                                           | Current membership plus the accepted narrow processing/writer actors; zero surviving call resolves an employee enrollment, key, or lease.                                                                                                                | D1-D5                                          | `IDENTITY`               | [T02], [T03], [T06], [T13]        |
| `P0-R-002` | Enrollment/access types and methods in `application/ports/authority-repository.ts` and `sqlite-authority-repository.ts`; `authority_enrollment_grants`, `authority_enrollments`, `authority_access_states`, `authority_access_lease_requests` | Fresh baseline contains only Person and server authority state; exact-schema tests prove all employee-installation objects absent.                                                                                                                       | D0, D1, D5                                     | `IDENTITY`, `LINEAGE`    | [T01], [T02], [T13]               |
| `P0-R-003` | `organization-protocol` enrollment request/receipt and installation-access-state files; `organization-api/access-lease-request.ts`                                                                                                            | No retained route, client, repository, protocol export, fixture, or state names the retired ceremony.                                                                                                                                                    | D1, D5                                         | `IDENTITY`               | [T02], [T13]                      |
| `P0-R-004` | `server-installation-compatibility-bridge.ts`, `existing-exportable-installation-key.ts`, and composition wiring                                                                                                                              | Authority-owned pre-record processing, record-resolution-write, and post-record-delivery scopes and typed ports are the sole live service paths.                                                                                                         | D1-D5                                          | `PROCESSING`, `IDENTITY` | [T03], [T05], [T06], [T07], [T13] |
| `P0-R-005` | Installation-signed permission request/verifier files and V1 Slack identity-link transport                                                                                                                                                    | D2-1 freezes the private exact link/connection/binding/capability/provider-action contracts while preserving link-only identity. D2-2A/B prove private activation and finalization orchestration; Phase 3 must persist and select the server-owned path before deletion. | D2-1/D2-2A/B candidates green; Phase 3/D5 pending | `IDENTITY`               | [T03], [T05], [T13]               |
| `P0-R-006` | `SlackIdentityLinkInstallation`, installation begin/complete branches, and installation ownership fields in adapter bindings/capabilities                                                                                                     | D2-1 separates Person link, approval binding, and per-policy/action capability in exact contract bytes. D2-2A proves private administrator-only activation, exact current-edge reproof, atomic replay/conflict, and one resource/one capability set without persistence or live selection; Phase 3 persistence and D5 still gate deletion. | D2-1/D2-2A candidates green; Phase 3/D5 pending | `IDENTITY`               | [T03], [T05], [T13]               |
| `P0-R-007` | `organization_integration_audit.actor_installation_id`, installation actor kind, and the old entry preimage/digest                                                                                                                            | D2-1 freezes the installation-free provider observation/message/action, authorization, and lineage-bound audit-entry bodies for both policies. D2-2B proves private rehash, atomic chain append, exact conflict, and chain-bound recovery; Phase 3 persistence remains before old evidence is removed. | D2-1/D2-2B candidates green; Phase 3 pending   | `IDENTITY`, `RECORD`     | [T03], [T05], [T06]               |
| `P0-R-008` | Installation-signed `record-envelope.ts`, `record-envelope-v2.ts`, `record-envelope-v3.ts`, `record-receipt.ts`; `/v1/record-envelopes`; `organization_record_log.installation_id` and installation-scoped dedupe                             | D3-1 freezes the exact human-act leaf graph and semantic idempotency; D3-2 freezes the Authority/lineage-pinned v4 envelope and provenance; D3-3 freezes the signed receipt and pure text-free Person-v2 fact projection. Opaque upstream reproof, append allocation, persistence, atomicity, restart, and live selection remain Phase 3. | D3-1/D3-2/D3-3 candidates green; Phase 3/D5 pending | `RECORD`                 | [T06], [T08], [T13]               |
| `P0-R-009` | Installation evidence in `organization-record-ingest.ts`, the current protocol envelope builder, and former approval-coupled record-first delivery wrapper                                                                                     | Phase 2C moved compatibility append behind one resolved-act writer before terminal marking or delivery, deleted the delivery wrapper, and added provider-free startup recovery for exact terminal acts after source-custody revocation. Installation-free proof remains D3/D4 work. | C-A/C-B complete; D3, D4 pending               | `RECORD`, `PROCESSING`   | [T06]                             |
| `P0-R-010` | Literal installation-bearing restricted-reviewer and organization-member-readable `v1` authorization/envelope contracts                                                                                                                       | Explicit new-lineage policy versions retain reader sets, consequences except the named Person substitution, revocation, denial, and separation; old bytes remain historical and rejected.                                                                | D2, D3, D5                                     | `RECORD`, `READ`         | [T05], [T08], [T14]               |
| `P0-R-011` | Person request body assertions in `person-read-requests.ts`, `person-member-exclusion-change.ts`, `person-member-exclusion-read.ts`, and `person-slack-link.ts`; caller-supplied Slack message coordinate                                     | New semantic DTOs derive Authority, organization, subject, method, path, operation, and stored message coordinate from authenticated server state; old fields are rejected as unknown.                                                                   | D6-1 private request/caller candidate green; live DTO removal deferred to D6/D5 | `PERSON`                 | [T02], [T05], [T09]               |
| `P0-R-012` | Combined `organization_recording_policy_v1` routing/approval overlay and incomplete processing key                                                                                                                                            | Separate no-pull pipeline and approval contracts; candidate key binds source kind/ID/instance/version, external ID, canonical revision, normalizer version, nullable source revision, and processor identity/config digest.                              | Phase 2, D2, D5                                | `PROCESSING`             | [T04], [T05]                      |
| `P0-R-013` | Former `process-one-meeting.ts`, `baseline-live-source.ts`, `run-one-meeting.ts`, structured-text live composition, canary-only store APIs, and retained production synthetic replay                                                                 | Phase 2B replaced the live canary with atomic stopped `activate-meeting-source` and a complete processing key. Only the isolated offline replay corpus remains; move or delete it after real-corpus D5 parity.                                             | Live canary complete; replay blocked on D5     | `PROCESSING`             | [T04], [T13], [T14]               |
| `P0-R-014` | Former file implementation behind `slack-delivery-receipt-store.ts` and deleted `process-file-lock.ts`                                                                                                                                        | Implemented in Phase 2: Authority SQLite owns the atomic pre-call claim, unknown/delivered outcome, safe clear, and restart recovery. The contract file is now only a small port. Live cutover must still prove old file attempts absent or import them. | Phase 2 implemented; D5 live preflight remains | `PROCESSING`             | [T07], [T13]                      |
| `P0-R-015` | Delivery reuse of `approval_surface_adapter_instance_id` and absence of persisted delivery activation                                                                                                                                         | Separate owner/admin delivery binding, destination/contract digest, frozen intent, semantic key, revocation, and attempt provenance.                                                                                                                     | D2                                             | `PROCESSING`, `IDENTITY` | [T07]                             |
| `P0-R-016` | Former rejection terminality before record-first resolution and approval-only frozen envelope sidecar                                                                                                                                        | Phase 2C-A writes the existing V1 canonical rejection before terminal marking, with no delivery, and widened frozen-envelope storage without rewriting old rows. D3-3 freezes new-lineage rejection receipt `none`/zero-fact semantics; Phase 3/D4 must persist, select, and recover them before compatibility deletion. | Compatibility ordering and D3-3 structure green; Phase 3/D4 pending | `PROCESSING`, `RECORD`   | [T06], [T08]                      |
| `P0-R-017` | Reviewer query audit, readable-search query audit, member-exclusion read audit, their route-specific repositories, exporters, expiry code, and CLI choreography                                                                               | One D6 Person-read audit with distinct caller/scope/release digests, 30-day whole-row expiry, and an unsupported export result that selects no rows and opens/writes no file.                                                                            | D6                                             | `READ`                   | [T09], [T13], [T14]               |
| `P0-R-018` | Ordinary/Pilot presentation branches, Pilot activation/eligibility tables and readers, and compatibility resolvers                                                                                                                            | D5 records Pilot retirement while both reviewer and organization-member policy families remain live; state preflight proves no unresolved ordinary/Pilot work.                                                                                           | D5                                             | `PROCESSING`, `RECORD`   | [T08], [T13], [T14]               |
| `P0-R-019` | Browser console `presentation/admin-console/assets.ts`, `routes.ts`, `sessions.ts`, `views.ts`                                                                                                                                                | Canonical JSON API plus thin CLI have parity for initialization, invitations, revocation, provider/source onboarding, link/binding inspection, approval/delivery activation, and recovery.                                                               | Phase 5 parity gate                            | `OPS`                    | [T10], [T13]                      |
| `P0-R-020` | Anthropic, OpenAI, or Ollama clients; provider union/factory branches; implicit Ollama default                                                                                                                                                | Explicit retained provider, no fallback, no active/pending state naming removed drivers, and unchanged retained processing-version/key golden tests.                                                                                                     | Separate driver disposition, D5                | `PROCESSING`             | [T12], [T15]                      |
| `P0-R-021` | `approval-outcome-instrument.ts` and currently unwired terminal cleanup                                                                                                                                                                       | Wire deterministic outcome reporting and bounded lifecycle-owned 30-day cleanup, or accept an explicit superseding decision before deletion.                                                                                                             | Accepted ADR disposition                       | `PROCESSING`             | [T11]                             |
| `P0-R-022` | Current 29 Authority, control-plane, record-log, and derived migration files in the runtime migration closure                                                                                                                                 | D0-authorized fresh exact baselines with new application IDs, manifests, envelope/receipt/log versions, and genesis; mixed and legacy state refuse to open. Old migrations are never edited in place.                                                    | D0, D5, Phase 4                                | `LINEAGE`                | [T01], [T13], [T14]               |
| `P0-R-023` | Duplicate reviewer-recent audit/maintenance infrastructure, not the reviewer-recent product route                                                                                                                                             | Preserve the standalone Person reviewer-recent DTO, route, client, service, exact-tenure witness, and Layer-1/log-backed availability. Consolidate only its duplicated audit/expiry machinery after D6 is implemented.                                   | D5, D6                                         | `READ`, `PERSON`         | [T09], [T13], [T14]               |

## Safe-delete ledger

No target in this table may be deleted during Phase 0. `Ready after proof`
means it needs no new product decision, not that the proof has already landed.

| Target ID  | Exact target                                                                                                                                                                             | Required zero-caller or replacement proof                                                                                                                                                                                             | Status                                                             | Owner                  | Test contracts |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ---------------------- | -------------- |
| `P0-S-001` | `processing/core/runtime/adapter-registry.ts`; `AdapterRegistry`; `adapterInstanceKey`; `AdapterInstanceConfig`; `AnyAdapter`; core barrel export; registry-only test and boundary entry | Completed in Phase 1A. Zero references remain; direct composition, typed ports, `AdapterIdentity`, and `AdapterConfig` remain.                                                                                                        | Complete; core/architecture/boundary/full checks green             | `CORE`                 | [T13], [T15]   |
| `P0-S-002` | `processing/live/run-live-meeting-cycle.ts`; `AuthorityLiveAdapterConfig`; `AuthorityLiveMeetingCycleResult`; `runAuthorityLiveMeetingCycle`                                             | Completed in Phase 1A. The sole composition caller now invokes `runCoreCycle(..., { limit: 1 })` directly and the alias file/boundary rule are gone.                                                                                  | Complete; focused core/runtime, boundary, and full checks green    | `CORE`, `PROCESSING`   | [T13], [T15]   |
| `P0-S-003` | Schema objects `authority_internal_live_releases` and `authority_internal_live_update_receipts`                                                                                          | No runtime writer or reader remains; references are limited to the historical migration chain, source manifest, read-only inspection, and migration/lifecycle assertions. Omit them from the fresh baseline and assert exact absence. | Blocked on new lineage; do not delete migration `0004` alone       | `LINEAGE`              | [T01], [T13]   |
| `P0-S-004` | `SqliteAuthorityProcessingStore.addOwnExclusion`, `removeOwnExclusion`, `listOwnExclusions`, and the duplicate processing-store exclusion DTO                                            | Completed in Phase 1A. Production and tests use the transaction-owned Authority exclusion path or explicit admission fixtures; zero callers remain for the duplicate processing-store CRUD.                                           | Complete; transaction/revocation/admission checks green            | `PROCESSING`, `PERSON` | [T04], [T13]   |

Everything else remains `preserve` or `replace before delete` until an exact
caller, export, route, schema, dependency, test, configuration, and target-state
scan proves otherwise.

## Adapter-to-ECHO identity-edge inventory

This table applies
[INV-IDENTITY-005](../invariants/INV-IDENTITY-005-adapter-to-echo-identity-chain.md)
to deletion review. `Minimizable` means detailed fields may live behind one
immutable digest/reference at a later boundary. It never means the edge can be
discarded.

| Identity edge                                                          | Current stage that consumes it                                                 | Frozen evidence after that stage                                                                 | Revocable                                                          | Tenant-scoped    | Minimizable at later boundary                      | Disposition                                               |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ | ---------------- | -------------------------------------------------- | --------------------------------------------------------- |
| Authority, organization, and state lineage                             | Every control, processing, record, and read boundary                           | IDs plus lineage/manifest commitments                                                            | Authority binding: no; deployment lineage: replace only by reset   | Yes              | No                                                 | Preserve                                                  |
| Provider issuer, tenant/workspace, app, bot, and bot-user identity     | Organization tool onboarding and live approval/delivery recheck                | Verified connection ID and audit proof; detailed tuple remains in immutable integration evidence | Yes, for future provider calls                                     | Yes              | Yes in Layer 1                                     | Preserve                                                  |
| Provider connection and opaque credential reference                    | Source, approval, and delivery activation/call fence                           | Stable connection ID, verification/config digest, and attempt provenance                         | Yes                                                                | Yes              | Yes in canonical record                            | Preserve                                                  |
| Adapter kind, ID, instance, version, and binding                       | Pipeline, approval, or delivery activation and action                          | Stable binding plus frozen adapter/contract digest                                               | Yes or replace-by-new-binding                                      | Yes              | Details remain in audit/provenance, not omitted    | Preserve                                                  |
| Provider object and observed human action                              | Approval action-time verification                                              | Provider-action digest, approval/action ID, message/object reference, and audit ID/hash          | Historical act: no; provider visibility may later disappear        | Yes              | Yes in record through exact audit reference        | Preserve                                                  |
| External provider-human identity link                                  | Approval action maps Slack actor to ECHO person                                | Link ID and immutable issuer/tenant/subject-to-principal/membership evidence                     | Yes, blocks future actions                                         | Yes              | Yes in record; no live read dependency             | Preserve                                                  |
| ECHO principal and membership tenure                                   | Approval, source custody, and Person read each perform their own current check | Exact principal/membership tuple and state/proof digest appropriate to the act                   | Membership: yes                                                    | Yes              | No for policy meaning                              | Preserve                                                  |
| Approve/reject action capability                                       | Approval only                                                                  | Capability ID, policy/action binding, and immutable audit proof                                  | Yes, blocks future actions                                         | Yes              | Yes in record through proof digest                 | Preserve                                                  |
| Source custodian binding                                               | Before provider pull and before pre-audit pending advancement                  | Pipeline/candidate digest and exact custodian tenure evidence                                    | Yes; requires fresh activation                                     | Yes              | Yes after durable human-action audit               | Preserve; never approval/read authority                   |
| Human-act resolution reference                                         | Record resolution after durable provider audit                                 | Approval ID, action, policy version, audit event ID/hash, provider-action digest                 | No mutation; unknown/mutated reference denies                      | Yes              | Already minimized                                  | Preserve                                                  |
| Canonical record and policy fact                                       | Layer 1 append and every rebuild/read                                          | Record hash, exact policy fact, content/provenance bindings                                      | Append-only                                                        | Yes              | No                                                 | Preserve                                                  |
| Configured delivery surface, destination, and approved snapshot        | After canonical approval receipt, each delivery surface validates its own configuration and destination before call | Exact record/snapshot/surface semantic key plus durable attempt/receipt                           | Configuration may change for future processing; a committed attempt does not change | Yes              | Attempt details remain outside Layer 1              | Preserve separately from approval and reader policy       |
| Person OIDC binding, session family, access credential, and membership | Layer 3 start/end/final release fence                                          | Caller binding plus person/session state digests in minimized read audit                         | Yes                                                                | Authority-scoped | Raw values minimized to exact digest where allowed | Preserve; provider approval edges are not read-time edges |

Stage rules:

1. Before a durable approve/reject audit, approval consumes current provider
   connection, external link, adapter binding, capability, and membership.
2. Record append/rebuild consumes the immutable audit ID/hash/proof and frozen
   input, not current Slack state.
3. Read consumes the current Person/session/membership plus canonical policy
   facts, not a historical provider edge.
4. Before durable human-action audit, source custody revocation stops new calls
   and pending advancement. After that audit it cannot strand record append or
   receipt recovery.
5. Delivery independently consumes its current binding/destination before a
   provider call and its frozen intent/attempt state during recovery.

## Central workspace anchors versus employee-installation state

The word `installation` is overloaded in the current repository. Cleanup must
classify ownership and authority, not grep the noun.

### Preserve as central organization state

| Surface                                                                         | Why it remains                                                                 |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `authority_metadata.integrations_control_plane_id`                              | Binds this Authority to its one organization control plane.                    |
| `authority_metadata.integrations_marker_sha256` and `integrations_installed_at` | Detects loss or silent recreation of the central integrations workspace.       |
| `authority_metadata.record_marker_sha256` and `record_installed_at`             | Detects loss or silent recreation of canonical record history.                 |
| Authority signing key/descriptor and organization/Authority IDs                 | Sign and scope canonical records, receipts, sessions, and all database roles.  |
| Organization tool/source provider connections and opaque credential handles     | Organization-owned provider custody required by source, approval, or delivery. |
| Authority, control-plane, record, derived, and retrieval databases              | One organization's central state and Layers 1-3 trust boundaries.              |

The new lineage may rename `installed_at` vocabulary, but it must retain the
central deletion-detection meaning.

### Retire as employee-machine state

| Surface                                                                              | Retirement target                                                                                              |
| ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| Enrollment grants and enrollment receipts                                            | Human onboarding is Person invitation plus login grant.                                                        |
| Employee `installation_id`, installation public/signing keys, and local signer state | No employee machine authorizes approval, records, or reads.                                                    |
| Access-state chains, lease requests, TTL refresh, and recovery                       | Current Person membership/session or narrow server actor replaces them.                                        |
| Installation-signed permission, recent, search, Slack-link, and record requests      | Server context and Authority-owned application ports replace transport ceremony.                               |
| Installation-owned adapter-binding and permission-grant columns                      | Stable provider, adapter, ECHO identity, and action capability semantics remain under server-owned activation. |
| Installation-scoped record idempotency and receipt identity                          | Authority/organization writer-scoped semantic idempotency replaces it.                                         |
| Machine database, JSONL outbox, service manager, updater, and fleet state            | No employee runtime remains in the target topology.                                                            |

## D0-D6 decision and evidence gates

D0 through D4 and D6 remain open in this draft. That is intentional for the
initial V1: reversible offline Phase 1 and additive Phase 2 work may proceed
against the recorded target and main-parity expectations. D5 is not due until
the replacement exists. Exact artifact-bound acceptance remains mandatory
before Phase 4 reset/cutover and Phase 5 compatibility deletion.

| Gate | Required closure artifact                                                                                                                                                                                                                                                               | Blocks while open                                                                                         | Phase 0 status                              |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| D0   | Founder-authorized reset scope, declarative re-entry configuration, no-customer/irreplaceable-state attestation, and exact reset/rollback protocol. The stopped snapshot and checksummed old/new artifact-state pairs are Phase 4 entry evidence, not Phase 0 acceptance prerequisites. | Live reset and Phase 4 cutover                                                                            | Open                                        |
| D1   | Accepted one internal actor with exact pre-record, record-resolution-write, and post-record-delivery scopes/audit, plus prohibition on ordinary reads, arbitrary record access, or human impersonation                                                                                  | Final service authorization, record-writer/delivery-worker activation, all installation-identity deletion | Open                                        |
| D2   | Accepted provider/adapter/ECHO approval and separate delivery identity contracts, new policy/version commitments, state transitions, cross-version denial, and symmetric reproof                                                                                                        | V1 permission/link/binding ownership removal, bridge deletion, delivery decoupling                        | Open                                        |
| D3   | Accepted Authority-writer canonical envelope, receipt, log, provenance, proof-reference, semantic-idempotency, and restart/rebuild contracts                                                                                                                                            | Record route/log/receipt/key-verifier replacement                                                         | Open                                        |
| D4   | Accepted canonical rejection act, race/retry/retention behavior, and explicit zero readable/delivery consequence                                                                                                                                                                        | New writer activation and old rejection-path deletion                                                     | Open                                        |
| D5   | Accepted old/new semantic parity report for one owner plus at least three employees, both policy families, later join, revocation, rejection, retry, and foreign-Authority denial                                                                                                       | Cutover and every compatibility deletion                                                                  | Not due in Phase 0; Phase 3/4 gate          |
| D6   | Accepted shared Person-read audit shape, operation-specific scope commitments, retention, export position, and audit-before-byte protocol                                                                                                                                               | Route-specific audit tables, repositories, exporters, expiry code, and CLIs                               | Open; D6-1 private request/caller bodies green; scope, release, audit, retention, export, and live removal pending |

## Phase 0 closure checklist

Phase 0 is implementation-ready when the initial V1 items are recorded. Final
decision closure remains a separate pre-Phase-4 gate:

- [x] Exact branch and comparison baseline recorded.
- [x] Full green baseline recorded: docs, boundaries, types, lint, 141 test
      files, and 1,390 tests.
- [x] Preserve, replace-before-delete, and safe-delete targets have stable IDs.
- [x] Verification owner codes and named test-contract IDs are assigned.
- [x] Adapter/provider/ECHO identity edges are inventoried by stage,
      revocability, tenancy, freezing, and minimization.
- [x] Central workspace anchors are separated from employee-installation state.
- [x] No runtime or state mutation is authorized by this artifact.
- [x] D0 has a proposed reset scope, re-entry configuration,
      no-customer/irreplaceable-state attestation shape, and reset/rollback
      protocol; acceptance and live evidence are explicitly deferred to Phase 4.
- [x] D1 through D4 and D6 have draft targets and named implementation owners.
      Their accepted decision/evidence artifacts remain mandatory before Phase 4.
      D5 remains a later executable parity gate and is not claimed in Phase 0.
- [x] Every Phase 1 and Phase 2 replacement target has an implementation owner
      and target T01–T15 file/suite named in the execution worklist.
- [x] The single-Authority preflight specification names pending processor,
      policy, delivery-attempt, provider-binding, and lineage outputs without
      exposing secrets or content. Its executable implementation is a later phase
      gate, not Phase 0 evidence.
- [ ] The initial V1 Phase 0 packet is committed as the implementation
      baseline. This does not constitute D0-D6 acceptance.

Phase 1 and additive/offline Phase 2 work may now take the small safe cuts and
reversible replacements under their focused gates. No compatibility, policy,
identity, record, audit, schema-history, or live-state deletion is authorized
until the Phase 4 acceptance gate closes.
