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

- `services/organization-authority/src/processing/core/` imports no adapters,
  vendor SDKs, Authority composition, or persistence implementation.
- `processing/adapters/` implement typed core ports and own provider transport.
- `processing/storage/` owns Authority processing durability.
- `processing/admitted-meeting-processing/` owns the serialized bounded server cycle.
- Authority composition selects concrete adapters, credentials, organization
  policy, and stores through explicit bundles for meeting source, decision
  processor, answer composition, approval/interaction, and Person external
  identity. Those bundles are the only place an active external-capability
  provider is selected.

`npm run check:architecture-boundaries` enforces these rules for every owned source file, not
only today's entry-point closure. Processing tests live beside the Authority;
cross-workspace checks remain under `tests/integration/`.

## Canonical flow

```text
meeting source
  -> canonical meeting revision
  -> decision processor
  -> canonical signals and evidence
  -> exact approval snapshot
  -> exact human approve or reject resolution
  -> canonical organization record and policy facts
  -> delivery surface for an approved workflow
  -> acknowledged delivery receipt
```

The server owns source cursors, processing state, pending approvals, delivery
receipts, and organization-record submission. The Person client owns none of
that state and cannot load provider adapters.

## Typed capabilities

- A **meeting source** pulls changed meetings and returns canonical documents
  plus an opaque cursor.
- A **decision processor** turns one canonical revision into decisions,
  actions, rationales, and source-linked evidence.
- An **approval surface** presents the exact staged brief and records an
  explicit human outcome.
- A **delivery surface** publishes an approved destination-neutral envelope
  and returns a provider receipt.

The shared approval path retains an opaque, generic presentation reference,
not a provider message timestamp or channel grammar. The approved-record path
receives a policy projector that translates a canonical terminal approval into
the record facts appropriate for the selected product policy; it does not
inspect an approval-surface payload.

Approval and delivery remain separate capabilities. They may share a provider
connection, but a generic Slack delivery channel must differ from the active
Slack approval channel, preserving main's human-action/side-effect boundary.
The current compatibility composition still reuses approval configuration for
its one Slack delivery surface; Phase 2D/D5 must remove that coupling before
claiming this target invariant and before compatibility deletion.

## Cross-capability invariants

- Source identity includes adapter, instance, external ID, and revision.
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
meeting source, OpenRouter with the pinned DeepSeek processing version as the
decision processor, Slack for approval, interactions, identity, and the
existing delivery capability, and Authority SQLite state. It separately
composes the bounded Person `ask` path above Layer 3 with a pinned OpenRouter
planner/answer model. The other LLM transports are compiled alternatives, not
active runtime dependencies. This is an allowed selecting composition profile,
not evidence that every active provider has completed qualification.

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
  meeting-source port is pull-oriented; push sources need an edge buffer or a
  versioned provider-independent capability.
- V3 physically stores `provider_message_ts`; shared code treats it as opaque
  `presentation_external_id` until an explicit schema migration.
- Bundles are trusted static composition, and name/dependency checks cannot
  detect every hidden semantic coupling. Each selected profile still needs
  capability tests and a bounded staging rehearsal.
- Compatibility-bound `clean-founder-*` commands, manifest kinds, and durable
  instance IDs describe the V1 initial-owner bootstrap contract. Runtime
  components must not reuse that cohort name; replacing the persisted/operator
  vocabulary requires an explicit versioned bootstrap migration.
