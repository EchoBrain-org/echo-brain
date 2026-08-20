---
schema_version: 1
id: INV-IDENTITY-005
kind: invariant
title: Adapter and provider identities confer ECHO authority only through explicit links
component_ids:
  - CMP-ADAPTERS
  - CMP-CENTRAL-ORGANIZATION
  - CMP-CORE-PIPELINE
  - CMP-IDENTITY-ACCESS
  - CMP-PERMISSIONS
created_at: 2026-08-20
reviewed_at: 2026-08-20
reviewed_ref: 77a212134fce762fdffd30e028f3256ba6e75b42
decision_ids:
  - ADR-0003
normative: MUST
enforcement_status: partial
enforcement_scope: Source custody, processing identity, Slack approval actor admission, record reproof, delivery identity, and Person permission-aware reads
invariant_ids:
  - INV-11B
  - INV-12
  - INV-PERMISSIONS-014
failure_pattern_ids:
  - FP-IDENTITY-001
  - FP-PERMISSIONS-001
---

# INV-IDENTITY-005: Adapter and provider identities confer ECHO authority only through explicit links

## Rule and rationale

A provider-observed human approve or reject action that can create a canonical
ECHO human act MUST resolve through one complete, explicit identity chain:

```text
Authority origin + authority_id + organization_id + state_lineage_id
  -> verified organization provider connection
  -> exact capability adapter binding and frozen adapter identity
  -> durable tenant-scoped provider object and provider actor
  -> active external identity link
  -> exact ECHO principal + membership tenure
  -> explicit action capability and frozen policy consequence
  -> observed human approve or reject intent
  -> domain-separated provider-action commitment + integration audit ID/hash
  -> exact Authority record-resolution reproof
  -> canonical approve/reject record + append receipt
  -> approval-only append-atomic policy facts
```

The chain is an intersection, not a set of interchangeable identifiers. A
provider connection is not an adapter binding. An adapter instance is not a
provider account or human. An external identity link identifies a human but
grants no action. A membership grants organization presence but no adapter
approval. Source custody, meeting participation, email, display name, a bare
provider user ID, or possession of a provider credential grants none of the
later edges.

Provider subjects are always scoped by provider issuer and tenant. The current
Slack human is `(https://slack.com, team_id, user_id)`, never `user_id` alone.
The current Slack tool proof also binds the verified workspace, enterprise
scope, app, bot, bot user, granted scopes, configured channel, opaque secret
handle, and verification evidence. Missing or disagreeing tuple members deny;
they are never inferred from display text or copied from a caller.

The stable organization-tool identity contract is distinct from its current
active/revoked credential-verification state. Both have closed canonical bodies
and independently recomputed digests. Credential rotation may update the
current-state proof without relabeling the stable provider identity; neither an
unspecified digest nor partial comparison is proof.

The approval capability adapter identity binds at least kind, adapter ID,
instance ID, version, provider connection/binding, approval channel and
provider-object coordinate, action mapping, and the frozen policy/presentation
contract. Delivery destination remains separate adapter configuration and
never becomes approval or read identity. Pending work resolves under its frozen
approval identity even when delivery configuration changes.

Source, processor, and delivery adapters do not synthesize a provider-human
identity link. A source follows its organization credential, source identity,
external object/revision, and active custodian chain. A processor follows its
source input and frozen transformation identity. Delivery follows an exact
canonical approval receipt and approved snapshot into each configured typed
delivery surface's distinct configuration, destination, durable attempt, and
receipt. These are provenance, custody, transformation, or side-effect chains;
none can create human approval or read authority.

Initial V1 preserves main's delivery behavior: after append, core submits the
same approved snapshot to every configured delivery surface in deterministic
order; rejection creates no delivery work. Approval identity cannot substitute
for a delivery surface, and a delivery receipt cannot authorize approval or a
read. Slack approval and generic delivery channels remain distinct. Each
surface validates its own configuration/destination before a provider call and
recovers unknown outcomes from durable frozen attempt state without blind
repost. A future stable delivery-binding activation or human-approved
destination contract requires a separate accepted invariant update.

Source activation pulls no meeting and separates two records: a frozen pipeline
contract (source kind/ID/instance/version, cursor/cutoff lineage, normalizer
contract, processor kind/ID/instance/version, and processor configuration
digest) and a current custody activation (organization credential proof plus
exact custodian principal/membership) that authorizes that pipeline contract.
Candidate creation later adds the actual external object ID, canonical
revision, `normalizer_version`, and nullable provider `source_revision` to the
pipeline-contract digest. This versioned candidate identity is complete. Replay
must preserve it. Mutating a pipeline or per-meeting member cannot resume or
inherit a prior candidate, frozen approval, or human act. An authorized
custodian replacement may reference the unchanged pipeline contract and frozen
candidate; custodian identity is not smuggled into meeting provenance or used
to rewrite the processing key.

Source custody remains a current pre-record authorization edge. Until the
immutable human-action audit is durably committed, provider polling and every
pending-work mutation require the exact active custodian membership frozen by
source activation. Revocation known before a provider call permits zero new
calls and stops pending advancement. Revocation during an in-flight call makes
the final custodian fence discard the result and commit no cursor, candidate,
or pending mutation. Resumption requires one atomic owner/admin activation by a
fresh current principal and membership that re-verifies the organization
credential and freezes a new custody activation over the exact existing
source/processor/cursor/cutoff tuple; it grants no approval or read authority
and neither mutates nor reprocesses existing candidate bytes. Changing a
processing-key member instead creates a different candidate identity. Once the
human-action audit is durable, record resolution and canonical append-receipt
recovery use its frozen proof and cannot be stranded by later
source-custodian revocation.

## Record and read boundary

At approval or rejection time, the Authority rechecks every mutable edge and
binds the accepted provider actor to the exact current ECHO principal and
membership tenure. The canonical record then freezes the human actor, policy,
provider/adapter authorization proof, presentation and semantic digests, and
record identity. Append-atomic policy facts carry only the identity and policy
material required for deterministic authorization; they do not contain a
resolved reader list. Only an approved record appends eligibility/readable
facts; a rejected record appends none.

The new lineage uses separate domain-separated provider-action and integration
audit chain-entry versions. The action commitment binds the Authority,
organization, provider tenant/tool/actor, connection, link, adapter
identity/binding, capability, provider object/action, and frozen
policy/presentation. The audit entry additionally binds the state lineage,
actor class, canonical event/detail digest, predecessor entry hash, and its own
entry hash. Installation-bearing versions cannot cross-admit. Record reproof
independently reconstructs both commitments from immutable stored evidence for
each policy; it never fills missing identity from current mutable
configuration or selected loose field comparisons.

Permission-aware read performs a separate current identity resolution:

```text
canonical configured Authority origin
  -> server-resolved Authority + organization + state lineage
  -> bearer credential + session family + OIDC binding
  -> ECHO principal + exact current membership tenure
  -> request-local policy scope
  -> canonical policy fact + exact-head retrieval generation
  -> final current-state fence + minimized audit
  -> released bytes
```

The provider or adapter chain proves who performed the recorded human act. It
MUST NOT become a new read grant. Layer 3 never infers a reader from a live
Slack link, adapter binding, source owner, meeting participant, or model output.
For the restricted-reviewer policy family, the current principal and exact
membership tenure must equal the frozen reviewer tuple. For the
organization-member-readable family, the caller must have a current active
owner or employee membership in the same organization; the frozen approving
actor is provenance, not the reader list. Contract versions may change the
authentication mechanism, but they cannot silently change either reader set.

Layer 3 commits three non-interchangeable identities: a current caller binding,
a caller-bound pre-search policy/generation/head/segment scope, and an allow
release binding over the ordered returned atom/record/policy/content/provenance
commitments plus exact response digest. Scope exists before lexical/content
handles open. The final fence re-resolves the caller and exact scope, commits
the minimized decision/release audit, and only then releases bytes. No digest
may be overwritten or reused for another stage.

Once Layer 1 admits the act, restart verification, deterministic rebuild, and
read authorization reprove its immutable canonical authorization proof. They
MUST NOT require the originating provider connection, external identity link,
adapter binding, or recording configuration to remain currently active.
Revocation or rotation of those mutable edges blocks future provider actions;
it does not erase, reinterpret, or make an admitted act unrebuildable.

## Failure, migration, and deletion behavior

- At each stage, a missing, revoked, expired, mismatched, cross-Authority,
  cross-organization, cross-tenant, or mixed-lineage edge that the stage is
  defined to consume fails closed. Provider approval consumes the current
  connection, human link, adapter binding, capability, and membership; record
  admission/recovery consumes the immutable audit ID, chain-entry hash, and
  proof; delivery claim/call consumes the canonical append receipt, exact
  approved snapshot, and the surface's validated configuration/destination,
  while unknown/delivered recovery consumes only durable attempt state; read consumes
  the current Person session/membership plus canonical policy facts and the
  exact retrieval generation. A historical approval-provider edge revoked
  after append is not a Layer-2 or Layer-3 read-time edge.
- Provider identity repair requires fresh authoritative proof and one atomic,
  audited update across every affected connection and binding. Null or legacy
  fields are never invented or blindly backfilled.
- A replacement membership is a new tenure. It does not inherit a restricted
  reviewer record or a provider identity link that named the old membership.
- Revoking a Person session, membership, external identity link, provider
  connection, adapter binding, or action capability affects the stage that
  consumes that edge. Revoking a provider link does not rewrite an already
  admitted canonical human act or manufacture a new reader.
- Audits may minimize public/provider detail, but their opaque identifiers and
  digests must prove which Authority, organization, Person/session, provider
  connection, external identity link, adapter binding/instance/version,
  capability, policy, record head, retrieval generation, and response were
  evaluated where those values are material to that stage.
- Compatibility tables, fields, ports, or proofs may be deleted only after the
  replacement chain is complete, every surviving row is on the new lineage or
  intentionally discarded, and no negative test loses its enforcement point.

## Verification

The current Slack and Person paths are partial enforcement. The lean migration
must add one end-to-end identity-chain suite covering:

- same Slack user ID in another workspace;
- correct workspace with the wrong app, bot, bot user, connection, channel,
  adapter instance/version, action mapping, or frozen presentation;
- identity link to the wrong principal or membership tenure;
- revoked/replaced membership, session family, identity link, binding, grant,
  or provider connection at each race point;
- restart, Layer-1 reproof, Layer-2 rebuild, and Layer-3 read after the
  originating provider link, connection, binding, or recording configuration
  is revoked or rotated;
- append under each retained policy, revoke the originating provider
  connection/link/binding/capability, rebuild, and prove reader behavior is
  determined only by the canonical policy facts and current Person membership;
- custodian revocation known before poll yields zero new provider calls;
  revocation during a call discards its result and commits no mutation;
  revocation with pending work prevents advancement until fresh atomic custody
  activation against the unchanged pipeline/candidate; activation cannot
  reinterpret existing bytes; and revocation after the durable human audit
  cannot strand canonical record/append-receipt recovery;
- processing-key mutation of source kind/ID/instance/version, external ID,
  canonical revision, `normalizer_version`, nullable provider
  `source_revision`, processor kind/ID/instance/version, or processor contract
  digest never replays an older candidate;
- rejection creates zero delivery work; approval submits the same canonical
  snapshot to every configured surface in deterministic order; invalid
  destination/configuration makes that surface call zero times; approval
  identity cannot substitute; claimed unknown/delivered recovery uses frozen
  durable attempt state and exact retry cannot repost an already delivered
  record;
- source custodian, meeting participant, matching email/display name, or model
  output attempting to stand in for the approving actor;
- cross-Authority, cross-organization, mixed-lineage, and replayed provider
  evidence;
- exact reviewer-tenure allow/deny and later-member organization-readable
  behavior; and
- final-fence and audit failure releasing zero content bytes.

Changing a tuple member, stage boundary, or inheritance rule requires an
explicit invariant/contract update and new qualification. Removing a database
join or DTO field is permitted only when the same semantic edge is derived from
the trusted server context and remains covered by these cases.

## Decision and migration status

- [RFC-0001](../rfcs/RFC-0001-server-core-lean-authority-contracts.md)
  proposes the exact replacement contracts that would enforce the full chain.
- [ADR-0003](../decisions/ADR-0003-server-core-lean-authority-contracts.md)
  remains proposed; this invariant therefore remains partially enforced.
- The [Phase 0 closure ledger](../product/2026-08-20-server-core-migration-phase-0-closure.md)
  owns the stage-by-stage identity-edge inventory and deletion gates.
- The [Phase 0 test-contract inventory](../product/2026-08-20-server-core-migration-phase-0-test-contract-inventory.md)
  names the missing end-to-end and mutation proof. No current qualification
  report is proof of the final lineage.
