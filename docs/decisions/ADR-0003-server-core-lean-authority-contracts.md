---
schema_version: 1
id: ADR-0003
kind: decision
title: Server-core lean Authority contracts
component_ids:
  - CMP-ADAPTERS
  - CMP-CENTRAL-ORGANIZATION
  - CMP-CORE-PIPELINE
  - CMP-IDENTITY-ACCESS
  - CMP-PERMISSIONS
  - CMP-PROTOCOLS-CRYPTO
created_at: 2026-08-20
reviewed_at: 2026-08-20
reviewed_ref: 77a212134fce762fdffd30e028f3256ba6e75b42
status: superseded
supersedes: []
superseded_by:
  - ADR-0004
updates:
  - ADR-0001
  - ADR-0002
---

# ADR-0003: Server-core lean Authority contracts

## Disposition state

This ADR was proposed and was superseded before acceptance. It records the
decision that would have closed D1, D2, D3, D4, and D6 of the
[server-core lean-down plan](../product/2026-08-20-server-core-migration-lean-down-plan-v4.md),
but it never accepted that decision.

The normative candidate is
[RFC-0001](../rfcs/RFC-0001-server-core-lean-authority-contracts.md). The
front-matter `reviewed_ref` identifies the baseline against which the candidate
was drafted. It is not the candidate acceptance binding.

Before `status` may change to `accepted`, lifecycle metadata below must name an
existing commit containing the exact RFC bytes, the SHA-256 of that complete
file, the reviewer identities and dispositions, and the resolution of every
open choice. A broad instruction to continue the migration is not an
artifact-bound disposition.

| Disposition field                                                                              | Current value                                                                                                                                                                                                                                |
| ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RFC candidate commit                                                                           | pending                                                                                                                                                                                                                                      |
| RFC candidate SHA-256                                                                          | pending                                                                                                                                                                                                                                      |
| Constitution owner/founder disposition                                                         | partial: D6 retention interval, D6 export position, delivery behavior, and the standalone reviewer-recent route accepted 2026-08-20 for initial V1; D1 review and the remaining D2 identity/action contracts pending                         |
| Independent permissions review or explicit founder waiver                                      | independent Phase-0 review in progress; founder waiver pending                                                                                                                                                                               |
| D6 retention interval                                                                          | accepted by the founder 2026-08-20 for initial V1: 30 days from Authority-owned `evaluated_at`; a different interval is a new dated disposition before Phase 4 cutover                                                                       |
| D6 export position                                                                             | accepted by the founder 2026-08-20 for initial V1: deliberately unsupported; a different position is a new dated disposition before Phase 4 cutover                                                                                          |
| D2 v2 policy IDs, exact contract bodies/selectors and digests, and consequence-byte acceptance | accepted separately by ADR-0005; remaining D2 identity/action contracts pending                                                                                                                                                              |
| Delivery behavior                                                                              | accepted by the founder 2026-08-20 for initial V1: preserve main's configured delivery behavior and approval/delivery channel separation; any contraction remains deferred and enters only as a new dated disposition before Phase 4 cutover |
| Standalone reviewer-recent route                                                               | accepted by the founder 2026-08-20 for initial V1: retained with exact reviewer-tenure semantics and Layer-1/log-backed availability; route consolidation remains deferred and enters only as a new dated disposition before Phase 4 cutover |

Updating only this table, the ADR lifecycle status, `reviewed_at`, and
`reviewed_ref` after review is lifecycle metadata. Any change to context,
decision, contract meaning, or consequences requires a new proposed ADR or a
new RFC candidate and review.

## Context and options

[ADR-0001](ADR-0001-organization-operated-server-core.md) moves processing to
the organization-operated Authority and requires an exact named service actor.
[ADR-0002](ADR-0002-external-oidc-person-sessions.md) establishes current
Person sessions and forbids treating old installation history as Person
history. Both remain accepted and unsuperseded.

The server migration currently retains installation enrollment, keys, and
leases at approval, record-ingest, and read-audit boundaries. Provider human
identity, adapter identity, ECHO principal/membership identity, approval
capability, canonical record proof, delivery authority, and current Person read
identity also span several separately versioned shapes. Removing every
installation-named field without first fixing those meanings would either
break record admission or silently weaken authorization.

The considered choices are:

1. keep installation authority indefinitely as a compatibility root;
2. delete installation fields and infer authority from provider links,
   membership, or source ownership;
3. change the existing v1 policy/envelope meanings in place; or
4. create one explicit new-lineage contract from provider-observed human act
   through Authority record and current-Person read, then delete compatibility
   only after replacement proof.

Option 1 preserves the duplicated machine durability and authorization system
the migration is intended to remove. Option 2 collapses identity and
permission and makes links or membership accidental approval grants. Option 3
reinterprets accepted historical bytes and violates ADR-0002. RFC-0001 proposes
option 4.

## Proposed decision and consequences

If accepted against exact RFC bytes, ADR-0003 makes the following coordinated
decision.

### D1: one internal actor with three closed scopes

Accept `permission-constitution-server-core-amendment-v2`. The single internal
actor is `authority-processing-v1`. It has only:

- `pre-record-processing-v1`, for typed, Authority-composed source,
  processing, pending approval, resolution, retention, and exclusion work;
- `authority-record-resolution-write-v1`, for resolving an already audited
  exact human act and submitting only its frozen approve or reject record to
  the in-process Authority writer; and
- `authority-record-delivery-v1`, for an exact receipted approval and approved
  snapshot, deterministic submission to every configured typed delivery
  surface, and each surface's durable attempt/outcome/receipt recovery.

The actor has no ordinary Person-content, organization-record, retrieval,
search, export, administrator-report, generic append, generic delegation, or
human impersonation capability. An Authority signature never invents a human
act. Crossing a process boundary requires a later accepted authenticated
service transport; the logical actor name is not a credential.

Every consequential internal operation must first commit its one authoritative
operation-owned state transition or receipt. Source/pipeline and core-state
rows evidence pre-record work; the integration audit plus canonical receipt
evidence human-act resolution; the durable delivery-attempt row and provider
receipt evidence delivery; and a bounded deletion-control row evidences
terminal cleanup. Each binds Authority, organization, lineage, the fixed actor
and scope, operation-specific state, outcome, and Authority time. A log,
metric, uncommitted row, or second generic processing-audit table is not
evidence. This keeps auditability while avoiding another retention/export/
recovery system.

The v1 constitution-amendment review is closed without acceptance. Its
proposal bytes still describe their original submitted state and remain
unchanged so the recorded digest stays valid. RFC-0001 is the replacement
candidate, but it changes no constitutional rule unless this ADR receives an
exact accepted disposition.

### D2: preserve the full provider, adapter, and ECHO identity chain

Every provider-observed approve or reject act resolves through:

```text
Authority + organization + lineage
  -> verified provider connection
  -> approval adapter identity and active binding
  -> exact provider object, tool, and actor
  -> tenant-scoped external human link
  -> exact ECHO principal and current membership tenure
  -> explicit policy-and-action capability
  -> frozen card, policy consequence, destination, and reaction mapping
  -> provider-message and provider-action commitments
  -> immutable integration-audit ID and chain-entry hash
  -> exact Authority record-resolution proof
```

A provider connection, external link, membership, source custodian, content
reader, or adapter instance is not an approval grant. Person Slack completion
remains link-only. Its attempt ID is lookup/correlation state; a versioned
server-derived completion digest is its semantic replay/conflict contract.

Authority administrator-credential activation creates the approval binding and
explicit approve/reject capabilities; an owner Person session cannot satisfy
that administrator gate. Delivery remains a separately configured typed
surface with its own adapter identity, destination validation, idempotency,
attempts, outcomes, and receipts. It may share a provider connection, but never
approval authority.

The new immutable commitment kinds are:

- `echo-organization-tool-connection-v2` plus its separate current-state
  commitment;
- `echo-approval-binding-contract-v2`;
- `echo-approval-action-capability-v2`;
- `echo-provider-observation-v2`;
- `echo-provider-approval-message-v2`;
- `echo-provider-human-action-v2`;
- `provider-human-approval-authorization-v2`; and
- `echo-integration-audit-entry-v2`.

They bind the exact Authority, organization, lineage, provider tenant/tool and
actor, connection, adapter binding and version, external link, principal and
membership tenure, capability, provider object and action, policy,
presentation, event/detail evidence, predecessor, and immutable entry hash as
specified in RFC-0001. They contain no employee installation field. Old and
new validators reject one another.

Accept two new Person-lineage policy IDs only with explicit founder
confirmation of their exact closed policy-contract bodies/selectors, computed
digests, and consequence bytes:

- `restricted-reviewer-person-v2` preserves exact approving principal and
  membership-tenure visibility; and
- `organization-member-readable-person-v2` preserves visibility for every
  current active owner or employee in the organization, including a later
  joiner.

The only intended reader-set delta is authentication through a current
Authority Person session instead of installation enrollment and lease. The
installation-bearing v1 IDs, bytes, and digests are rejected rather than
renamed or edited.

Initial V1 preserves main's delivery behavior rather than deriving an external
audience from either reader policy. Approval under either retained policy
produces the canonical approved snapshot, and core submits it to every
configured delivery surface after append. Rejection creates no delivery work.
Approval and generic Slack delivery channels remain distinct; durable unknown
or delivered recovery uses frozen attempt state and never blindly reposts.

### D3: one Authority record-resolution envelope and receipt

Accept these new-lineage kinds:

- `echo-human-act-resolution-ref-v1`;
- `echo-organization-record-envelope-v4`;
- `echo-organization-record-receipt-v2`; and
- `echo-authority-human-act-idempotency-v2`.

The resolution reference binds the exact approval ID, action, policy,
integration-audit event ID/sequence/hash, provider-action digest, and
authorization proof. The resolver performs exact-key immutable reproof. It
does not scan descriptive fields or consult current mutable provider
configuration.

The envelope binds the exact human act; Authority/organization/lineage; source
kind/ID/instance/version, external ID, canonical revision,
`normalizer_version`, and nullable provider source revision; processor
kind/ID/instance/version and contract/configuration digest; one closed approved
event with the complete `echo-approved-decision-snapshot-v2` body/digest,
whose nested payload is the existing exact `OrganizationRecordApprovalPayloadV1`
under a literal contract ID, or one closed bounded-act rejected event that
retains the snapshot digest plus the exact existing
`OrganizationRecordRejectionPayloadV1` source/meeting/time/nullable-reason/
nullable-`reconsider_after` body while forbidding candidate/approved content;
and predecessor. The same snapshot digest is bound by the card, provider
action, canonical event, and each delivery submission. Body hash and Authority
signature use the separate exact domain-separated preimages in RFC-0001,
avoiding self-hash/signature cycles.

Only approval appends its complete deterministic eligibility/readable policy-
fact set, atomically with the canonical record. Rejection appends none. Layer 1 contains no provider
credential, credential handle, mutable connection configuration, display
identity, or resolved reader list. Detailed provider identity stays in the
immutable integration audit and is reached by exact reference.

Exact semantic retry and concurrency append once and return one signed receipt.
Reuse with changed semantic input conflicts. Both approve and reject work stay
nonterminal until the canonical receipt exists. A crash after audit commit but
before gate save or append recovers the same reference and receipt without a
second human act or second audit entry.

The receipt binds the resulting record head as well as record position/hash,
predecessor, policy-fact outcome, Authority key, and signature. External
witnessed checkpoints remain outside this receipt version.
`organization-protocol` owns its canonical schema and verification;
`organization-record` owns append and receipt persistence;
Authority composition owns exact human-act resolution and signing-key access.

After immutable action audit, revoking or rotating the originating source
custodian, provider connection, external link, binding, capability, or current
recording configuration blocks future actions but cannot strand append,
receipt recovery, rebuild, or permission-aware read.

### D4: rejection is a canonical act with zero readability

Accept rejection as an immutable canonical human act, not missing approval or
candidate content. Before receipt it is nonterminal. After exactly one
rejection envelope and receipt it becomes terminal and begins the governed
30-day terminal pre-record retention window from ADR-0001. Expiry removes the
pending candidate bytes, not the canonical rejection act or immutable proof.
The canonical act preserves main's bounded optional organization-visible
reason and `reconsider_after`; it never turns either into a readable atom or
policy fact.

An approve/reject race admits at most one outcome. Exact retry returns the same
receipt; conflicting action denies. Rejection creates zero approval
eligibility facts, readable atoms, retrieval facts, content segments, lexical
entries, delivery work, or provider delivery call. Person responses, audits,
denials, counts, titles, reasons, and exports reveal no rejected content or
existence under either policy.

### D6: shared current-Person fence and audit

Accept one `echo-person-read-decision-audit-v2` service for retained Person
reviewer-recent, readable-search, and self-owned source or meeting-exclusion
operations. Initial V1 preserves the standalone reviewer-recent route and its
verified Layer-1/log-backed availability. Readable search remains exact-head
Layer-2. Operation-specific candidate and policy logic remains typed;
authentication, current caller resolution, final fence, audit, and release
ordering become shared.

The service keeps three non-interchangeable commitments:

1. `echo-person-caller-binding-v2` over Authority, organization, state lineage,
   principal, membership ID/type, OIDC identity binding, session family,
   access credential digest, Person-state digest, and session-state digest;
2. `echo-person-scope-binding-v2` over that caller and operation/request, with
   a closed retrieval variant for ordered policy contracts, retrieval
   generation/manifest, exact record head, and admitted segments, or a closed
   Authority-state variant for exact source ownership and exclusion state; and
3. for allow responses, `echo-person-release-binding-v2` over caller, scope,
   the exact serialized response digest, and a closed retrieval-result or
   Authority-state-result binding. An uninformative mutation acknowledgement
   needs no release binding, but its state change and allow audit co-commit.

Scope is committed before lexical or content handles open. The HTTP adapter
serializes the typed authorized result once into a private immutable buffer.
Finalization re-resolves current caller and the exact scope variant, commits
the minimized audit and any Authority-state mutation in its one owning
transaction, and only then authorizes writing those exact bytes. Any
revocation, stale head/generation/Authority state, mutation, mismatch, or audit
failure discards the buffer and releases zero protected bytes.

The audit stores no query/content text, title, participant, source identifier,
display identity, live provider identity, or caller-supplied identity. Denial
rows contain no item metadata. Provider/action identity is immutable record
admission evidence and never a Layer-3 current read edge.

The disposition must select:

- a 30-day interval from Authority-owned `evaluated_at`, explicitly replacing
  the two historical 180-day query-audit contracts; and
- a deliberately unsupported export contract with no production export route,
  command, writer, or row-selection port.

Expiry removes whole rows and commits an expiry control
event. Selective field redaction is not allowed. D6 rows are append-once and
immutable for their declared lifetime, with one canonical row digest; D6 does
not add another cryptographic chain beside the integration-audit and record
chains.

## Consequences

### Benefits

- Employee installation identity can be deleted after replacement and parity
  proof without deleting human/provider/adapter identity.
- One exact human act survives provider revocation, restart, append retry, and
  deterministic rebuild.
- Approval capability, delivery authority, and current read permission remain
  visibly different concepts.
- Both approved policy families retain their reader sets for an organization
  with one owner and arbitrary employees.
- Layer 1 stays canonical and free of live credentials or reader lists; Layer
  2 stays policy-scoped; Layer 3 stays current-Person and audit-before-bytes.
- Route-specific audit transaction and maintenance machinery can later be
  removed behind one accepted D6 contract.

### Costs and constraints

- New schema, protocol, policy, audit, envelope, receipt, and lineage versions
  are required instead of a field-deletion patch.
- Approval and delivery require separate activation and recovery state.
- The two policies require symmetric record reproof and cannot share a loose
  current-configuration comparison.
- Canonical fixtures, mutate-every-field negatives, races, crash windows,
  restart, rebuild, and non-disclosure tests are mandatory before cutover.
- Historical v1 state requires its exact old artifact and cannot be opened by
  the new lineage.
- A future Layer-4 model consumer must obtain a separate purpose-specific
  release and audit contract; this decision grants it no generic read path.

## Migration, rollback, and evidence

### Acceptance evidence

Changing this ADR to accepted requires:

1. an exact committed RFC-0001 candidate and SHA-256;
2. constitution owner/founder disposition plus either an independent
   permissions review or explicit founder waiver of a second human reviewer
   until the first-external-organization re-entry gate;
3. explicit founder acceptance of the v2 policy IDs, exact closed policy-
   contract bodies/selectors and computed digests, exact consequence bytes,
   and v1/new-lineage version break;
4. explicit D6 retention and export choices;
5. explicit acceptance that initial V1 preserves main's post-append submission
   to every configured delivery surface, rejection submits to none, and Slack
   approval and generic delivery channels remain distinct;
6. explicit acceptance that initial V1 preserves standalone, Layer-1-backed
   reviewer-recent while readable search remains exact-head Layer-2;
7. canonical positive and cross-version/mutate-field negative vectors for
   every new commitment; and
8. an updated INV-IDENTITY-005 edge inventory and named implementation test
   owner for every later runtime case.

Phase-0 fixtures prove candidate consistency and domain separation only. They
do not prove runtime provider behavior, persistence, crash recovery,
non-disclosure, deployment, or qualification.

### Implementation and cutover evidence

Before any claim that this decision is implemented, the named suites must
prove both policies, link-only completion, administrator activation with owner
Person denial, exact identity
resolution, capability and provider revocation, symmetric audit reproof,
canonical append and receipt recovery, rejection races, delivery zero-call and
unknown-outcome recovery, restart/rebuild after provider revocation, and D6
allow/deny/race/audit-outage/expiry/chosen-export behavior.

D5 semantic parity must show zero unexplained reader-set, denial, disclosure,
record-fact, retrieval, response, audit-meaning, retry, conflict, or restart
delta after applying only the accepted Person/policy-version,
and D6 30-day/no-export mappings.

This ADR does not authorize D0 reset or any compatibility deletion. Cutover
requires the separate clean-state reset authorization, snapshot and rollback
pair, reset rehearsal, parity report, and exact-artifact qualification.

### Rollback

Before cutover, rollback is the smallest additive implementation revert. No old
state bytes change meaning. After a separately authorized cutover, rollback
stops the new artifact and uses only the checksummed old artifact with its
intact old-state snapshot. Old and new writers never run together, and rows are
never copied between lineages.

## Lifecycle update

Superseded on 2026-08-22 by ADR-0004 before this proposal was accepted.
ADR-0004 chooses one founder-only current pipeline and a directly authored
clean genesis instead of this candidate's multi-policy, multi-audit,
compatibility-preserving contract packet. The text above remains historical
context and is not a live implementation requirement.
