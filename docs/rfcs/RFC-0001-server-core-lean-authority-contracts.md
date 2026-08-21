---
schema_version: 1
id: RFC-0001
kind: rfc
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
status: draft
superseded_by: []
---

# RFC-0001: Server-core lean Authority contracts

## Proposal state and review binding

This RFC is the coordinated Phase-0 candidate for decisions D1, D2, D3, D4,
and D6 in the
[server-core lean-down plan](../product/2026-08-20-server-core-migration-lean-down-plan-v4.md).
It is a proposal, not an accepted decision, implementation claim, deletion
authorization, cutover authorization, or qualification report.

The `reviewed_ref` in front matter is the code and documentation baseline used
to prepare the candidate. It does not bind a reviewer to these RFC bytes. A
review disposition MUST name both the commit containing the exact RFC candidate
and the SHA-256 of the complete RFC file. Any normative edit after that commit
requires a new digest and a new disposition. Only an accepted ADR may put these
contracts in force.

The pending
[server-core actor amendment v1](../product/2026-08-18-organization-permission-constitution-server-core-amendment-proposal.md)
is not accepted by this RFC. RFC-0001 proposes a complete v2 replacement so
that service read authority and record-write authority are both explicit.
Constitution v1 and all installation-bearing policy, envelope, receipt, and
audit bytes retain their historical meanings.

## Problem, goals, and current boundary

The migrated server can ingest, process, present, authorize, append, derive,
search, and deliver organization records, but the current path still uses
installation enrollment, installation keys, and access leases at several
authority boundaries. The implementation also couples approval identity to
delivery, carries installation fields in provider-action and audit evidence,
and maintains separate Person-read audit shapes.

The lean foundation must remove those employee-machine authority roots without
removing the identity or permission edges that make approval and
permission-aware read sound.

This RFC has six goals:

1. define one internal Authority actor with separate closed pre-record,
   canonical record-resolution-write, and post-record-delivery scopes;
2. bind a provider-observed approve or reject action through the full
   provider, adapter, ECHO identity, membership, and capability chain;
3. define new-lineage Person-based policy contracts without reinterpreting
   installation-bearing v1 contracts;
4. define one Authority-owned canonical record and receipt path for approval
   and rejection;
5. keep approval, record admission, delivery, and Person read as separate
   authority stages; and
6. unify retained Person operations behind one minimized audit and one
   prepare/finalize/release fence.

The target topology remains one Authority bound to one organization, with one
owner and any number of employee memberships. Organization onboarding,
employee invitations, OIDC Person sessions, membership revocation, provider
onboarding, external human identity links, and both approved permission-policy
families remain load-bearing.

### Non-goals

This RFC does not:

- add answer generation, prompting, agents, tools, streaming, or any Layer-4
  model-on-read path;
- make the Authority multi-tenant or add an organization selector;
- add a general service-principal, policy-engine, or delegation framework;
- give the internal actor an ordinary record, retrieval, search, export, or
  Person-content read capability;
- make a provider link, membership, source custodian, content reader, or
  delivery binding sufficient to approve;
- infer a reader from Slack identity, meeting participation, source custody,
  email, display name, or model output;
- edit or relabel historical v1 bytes; or
- authorize the D0 state reset, compatibility deletion, deployment, or live
  cutover.

## Common canonical and versioning rules

Every structured digest contract introduced here uses the repository canonical-JSON
implementation and SHA-256 over the UTF-8 canonical bytes. Each preimage is a
closed object with an exact `schema_version` and exact `kind`. Unknown,
missing, duplicated, or differently typed fields deny. A nullable field is
present with `null`; absence is not another spelling of null.

The only exceptions to that structured canonical-object rule are:

- `policy_consequence_sha256`, SHA-256 over its separately frozen exact human-
  visible UTF-8 bytes, with no quoting or trailing newline;
- `serialized_response_sha256`, and the equal audit `response_sha256`, each
  SHA-256 over the exact private immutable response-buffer bytes; and
- the inherited P-256 `key_id` fingerprint, which is SHA-256 over the exact
  canonical SPKI DER bytes and is encoded as specified in D3.

These byte digests are not structured contracts and cannot verify as a
canonical-object digest or as one another. The audit `response_sha256` MUST
equal the `serialized_response_sha256` in the release binding for the same
release; it is not a second serialization or digest. Every other digest
introduced by this RFC follows the closed-object rule above.

Two Layer-1 identities are retained byte-for-byte from main rather than
introduced as new digest-contract namespaces: `signal_id_sha256` is SHA-256
over the exact raw UTF-8 signal-ID bytes, and `atom_id` is the canonical
SHA-256 of the historical closed object
`{kind: "echo-organization-record-atom", record_hash, signal_id}`. New
Person-v2 fact rows reuse those exact values so existing atom identity does not
fork during migration. Neither value may substitute for a versioned contract
digest.

The `kind` literal is the domain separator. A digest from one kind or version
MUST NOT verify as another kind or version. IDs are opaque stable identifiers;
display names, emails, provider labels, and mutable configuration are never
substitutes. Arrays are ordered unless this RFC explicitly calls them sets;
sets are canonicalized by the contract's stated stable key before hashing.

Old and new contract versions are mutually exclusive:

- old validators reject every new kind and version;
- new validators reject every installation-bearing v1 kind and version;
- no adapter or composition root falls back after a version mismatch; and
- persisted old bytes are read only by the matching old artifact/state pair.

The new lineage uses these normative identifiers:

| Meaning | Exact identifier |
| --- | --- |
| Constitution amendment | `permission-constitution-server-core-amendment-v2` |
| Internal actor | `authority-processing-v1` |
| Pre-record scope | `pre-record-processing-v1` |
| Record-resolution write scope | `authority-record-resolution-write-v1` |
| Post-record delivery scope | `authority-record-delivery-v1` |
| Organization tool connection | `echo-organization-tool-connection-v2` |
| Organization tool current state | `echo-organization-tool-connection-state-v2` |
| External human link contract | `echo-external-human-link-contract-v2` |
| Approval binding contract | `echo-approval-binding-contract-v2` |
| Approval action capability | `echo-approval-action-capability-v2` |
| Person content policy contract | `echo-person-content-policy-contract-v2` |
| Restricted-reviewer policy | `restricted-reviewer-person-v2` |
| Organization-member policy | `organization-member-readable-person-v2` |
| Approval authorization | `provider-human-approval-authorization-v2` |
| Provider observation | `echo-provider-observation-v2` |
| Provider message commitment | `echo-provider-approval-message-v2` |
| Provider action commitment | `echo-provider-human-action-v2` |
| Integration audit entry | `echo-integration-audit-entry-v2` |
| Human-act resolution reference | `echo-human-act-resolution-ref-v1` |
| Human-act event commitment | `echo-human-act-event-commitment-v1` |
| Meeting source provenance | `echo-meeting-source-provenance-v1` |
| Decision processor provenance | `echo-decision-processor-provenance-v1` |
| Record envelope | `echo-organization-record-envelope-v4` |
| Record signature | `echo-organization-record-signature-v4` |
| Record receipt | `echo-organization-record-receipt-v2` |
| Record receipt signature | `echo-organization-record-receipt-signature-v2` |
| Record idempotency | `echo-authority-human-act-idempotency-v2` |
| Approved decision snapshot | `echo-approved-decision-snapshot-v2` |
| Person retrieval contract | `permission-aware-person-retrieval-contract-v2` |
| Person semantic request | `echo-person-request-commitment-v2` |
| Person read audit | `echo-person-read-decision-audit-v2` |
| Audit expiry control | `echo-audit-expiry-control-v1` |
| Person caller binding | `echo-person-caller-binding-v2` |
| Person scope binding | `echo-person-scope-binding-v2` |
| Person release binding | `echo-person-release-binding-v2` |

These literals are candidate contract bytes. Changing one before acceptance
requires fresh fixtures and a fresh review digest. Changing one after
acceptance requires a new version and decision.

## D1: Constitution amendment and internal actor

### Exact amendment

RFC-0001 proposes that constitution v1 be updated by
`permission-constitution-server-core-amendment-v2` without editing constitution
v1. The amendment adds the following actor rule:

> A canonical organization record is Authority-signed and Authority-receipted,
> but an Authority signature never invents a human act. A human approval or
> rejection enters Layer 1 only with immutable evidence resolving the exact
> provider-observed actor to an exact current ECHO principal and membership
> tenure under an explicit action capability. The single internal actor
> `authority-processing-v1` may operate only through
> `pre-record-processing-v1`,
> `authority-record-resolution-write-v1`, and
> `authority-record-delivery-v1`. It has no ordinary Person-read, arbitrary
> record-read, search, export, generic append, generic delegation, or human
> impersonation authority.

The amendment also replaces installation-only response evidence for new
Person operations with the versioned D6 caller, scope, and release commitments.
Historical v1 evidence remains installation-bearing and is never treated as
Person or service evidence.

### `pre-record-processing-v1`

The pre-record scope authorizes only the Authority-composed processing module
to:

- read an active source pipeline contract and current custody activation;
- call the exact source and processor adapters named by that frozen contract;
- create, read, update, retry, resolve, expire, or terminalize typed pre-record
  candidate, approval, resolution, and cleanup state;
- evaluate the exact member-owned source or meeting exclusion before initial
  raw admission; and
- read only the frozen bytes and evidence required for those operations.

It does not authorize an arbitrary table query, a response containing
pre-record content to a Person or administrator, an organization-record read,
retrieval, search, report, or export. Source custody is a separate current
authorization edge. Before the immutable human-action audit is committed, a
known custodian revocation makes zero new provider calls and prevents pending
advancement. After that audit is committed, custodian or provider revocation
cannot strand canonical record resolution.

### `authority-record-resolution-write-v1`

The record-resolution scope authorizes only one in-process application port to
resolve an exact `echo-human-act-resolution-ref-v1`, reprove its immutable
audit ID, audit entry hash, provider-action commitment, and frozen record
input, and submit the resulting approve or reject event to the Authority
writer. It authorizes no arbitrary payload, loose identity lookup, descriptive
audit scan, second human act, audit rewrite, record read, or generic append.

The port returns only a typed canonical append receipt or a closed denial. Both
approve and reject pending work remain nonterminal until that receipt exists.
Exact retry returns the same receipt; changed semantic input conflicts.

### `authority-record-delivery-v1`

The post-record delivery scope becomes usable only with an exact canonical
approval receipt and approved-snapshot digest. It authorizes the Authority-
composed core to:

- submit that exact approved snapshot to every configured typed delivery
  surface in deterministic configuration order;
- let each surface claim, read, update, and reconcile only its durable attempt;
- validate its configured destination before an initial provider call; and
- persist its known or unknown outcome and receipt.

It grants no source, processor, approval, human-link, content-read, search,
generic record-read, generic delivery, or destination-selection authority. A
rejection or mismatched receipt/snapshot makes zero provider calls. A surface
whose configuration/destination is invalid makes no call. Unknown-outcome
recovery uses only the frozen attempt state and cannot blindly repost.

If the actor ever crosses a process boundary, the caller must use a separately
accepted authenticated, audience-bound, replay-bound service transport. The
in-process actor name is not itself a bearer credential.

### Internal actor evidence

The lean runtime does not create a second generic processing-audit sink. Each
consequential operation is evidenced by the one durable state transition or
receipt already owned by that operation:

| Scope | Operation | Authoritative evidence |
| --- | --- | --- |
| `pre-record-processing-v1` | pipeline activation, provider-call claim/completion, candidate or approval transition | exact source/pipeline or core-state transition row |
| `pre-record-processing-v1` | terminal cleanup | bounded lifecycle deletion-control row |
| `authority-record-resolution-write-v1` | human-act resolution and append | immutable integration-audit proof plus canonical record receipt |
| `authority-record-delivery-v1` | delivery claim, pre-call fence, and outcome recovery | one durable delivery-attempt row and provider receipt when known |

Every owning row binds Authority, organization, lineage, the fixed internal
actor and scope, operation-specific input/state commitments, outcome, and
Authority time. A transition is not successful until that row commits.
Provider-call claims commit before the call; an outcome that cannot persist
remains `unknown`. Logs, metrics, an uncommitted row, or a generic audit append
cannot substitute for the owning state or receipt. This preserves auditability
without adding another retention, export, recovery, or hash-chain subsystem.

## D2: Provider, adapter, ECHO, approval, and delivery identity

### Approval identity chain

A provider-observed human action can create a canonical ECHO act only through
this complete intersection:

```text
configured Authority origin + authority_id + organization_id + lineage
  -> verified organization provider connection
  -> active approval adapter binding and frozen adapter identity
  -> exact provider object, tool identity, and provider actor
  -> active tenant-scoped external human identity link
  -> exact ECHO principal and current membership tenure
  -> explicit policy-and-action capability
  -> frozen card, policy consequence, approval channel, and reaction mapping
  -> observed approve or reject intent
  -> provider-message and provider-action commitments
  -> immutable integration-audit entry ID and hash
  -> exact Authority record-resolution reproof
```

No edge implies another. In particular, a Person Slack identity link is
link-only. It grants no approval action, content read, source access, or
delivery authority.

### Organization tool and adapter-binding commitments

`echo-organization-tool-connection-v2` is the immutable identity contract for
one verified organization tool connection. Its closed preimage contains:

- Authority, organization, and state lineage;
- stable connection ID, provider issuer, tenant kind and ID, nullable
  enterprise ID, and tool kind;
- provider app ID, bot ID, and bot-user ID;
- ordered unique required provider scopes; and
- the public connection-configuration digest.

Its digest is `connection_contract_sha256`. It contains no secret or
credential handle. Credential rotation that authoritatively proves the same
closed provider identity does not change this stable contract.

`echo-organization-tool-connection-state-v2` is the action-time current-state
commitment. Its closed preimage contains the connection ID and contract
digest, active or revoked state, opaque credential-reference digest, ordered
unique observed granted scopes, verification event ID and evidence digest,
verification revision, and verification time. Its digest is
`connection_state_sha256`. Every provider-observed action records and rechecks
the exact current-state commitment used for that action. Later rotation or
revocation does not rewrite historical evidence.

`echo-approval-binding-contract-v2` contains Authority, organization, lineage,
stable approval-binding ID, connection ID and contract digest, approval
adapter kind/ID/instance/version, exact channel, approve and reject reactions,
and the ordered supported policy/action entries.
Each entry contains exact `policy_id`, computed `policy_contract_sha256`, and
ordered actions `["approve", "reject"]`.
Its digest is `approval_binding_contract_sha256`.

Each `echo-approval-action-capability-v2` contains Authority, organization,
lineage, stable capability ID, approval binding ID and contract digest,
external identity-link ID, exact principal and membership tenure/type, one
policy ID and contract digest, and exactly one action, `approve` or `reject`.
Its digest is `capability_contract_sha256`. Link, membership, binding, policy,
and action substitutions therefore cannot reuse a capability.

The organization-tool, approval-binding, and capability contract bodies plus
the current-state body are persisted create-once
or versioned by a new stable ID. Reproof reads their exact stored canonical
bytes and recomputes the digest. A caller-supplied digest, partial field
comparison, mutable display configuration, or a digest with no stored body is
not evidence.

`echo-external-human-link-contract-v2` is the immutable mapping consumed by
approval. Its closed preimage contains Authority, organization, lineage,
stable identity-link ID, provider issuer, tenant kind and ID, nullable
enterprise ID, provider human subject ID, exact principal ID, exact membership
ID and type, verification event ID/evidence digest, and verified timestamp.
The action-time lookup additionally requires that exact stored link and exact
membership tenure to be active. Later revocation is current state, never a
rewrite of the historical mapping contract.

### Link-only Person Slack completion

The existing Person Slack challenge remains a link operation. The
`challenge_attempt_id` is a lookup and correlation key, not the semantic
idempotency key. Completion uses a server-derived digest whose closed preimage
contains:

- kind `echo-person-slack-link-completion-v2` and schema version 2;
- Authority, organization, and lineage;
- challenge attempt ID and stored single-use code digest;
- stored channel, message, and challenge coordinate;
- exact current Person principal, membership, OIDC identity-binding, and
  session-family IDs;
- exact organization-tool connection, `connection_contract_sha256`, and
  current `connection_state_sha256`; and
- requested completion action.

The server loads the provider message coordinate from the attempt. Caller
duplication is rejected. Exact digest replay returns the same link; reuse with
any changed Person/session/member tuple conflicts. This link commitment is
independent of the later D6 read-caller contract. Completion creates or returns
only the external identity link.

### Approval activation API

The minimum API is `POST /v2/admin/integrations/slack-approval-activation`.
It requires the existing Authority administrator credential. A Person session,
including an owner session, cannot satisfy this administrator gate. The
Authority derives Authority, organization, lineage, and administrator actor;
those fields are forbidden in the body. The closed semantic body contains:

- `command_id`;
- `target_identity_link_id`;
- `provider_connection_id`;
- `adapter_instance_id` and exact `adapter_version`;
- `channel_id`, `approve_reaction`, and `reject_reaction`;
- ordered `policy_capabilities`, each containing one of the two v2 policy IDs
  and the exact permitted actions `approve` and `reject`.

Activation re-resolves the target link, target principal and current
membership, verified organization tool, provider tuple, adapter identity,
channel, actions, and policy contracts in one transaction. It creates one
stable approval binding plus policy-specific approve/reject capability IDs.
Exact command retry returns the same result; changed input conflicts. Neither
the administrator act nor target link creates delivery authority.

### New policy contracts and consequence bytes

`restricted-reviewer-person-v2` has this exact human-visible consequence:

```text
Approving records this package under restricted-reviewer-person-v2. Only you, the approving reviewer, may later read its decisions, actions, and rationales while this exact ECHO principal and membership tenure remain current and the request is authenticated by a current Authority Person session.
```

The reader is the exact approving `principal_id` and `membership_id`. A later
membership for the same principal, another member, another organization, a
revoked membership, or an unauthenticated session denies.

`organization-member-readable-person-v2` has this exact human-visible
consequence:

```text
Approving records this package under organization-member-readable-person-v2. Any person authenticated by a current Authority Person session with a current active owner or employee membership in this organization, including a person who joins later, may search and read its decisions, actions, and rationales while that membership remains active.
```

This reader set is current active owner and employee memberships in the same
organization. It is not the approving actor list and is never materialized in
Layer 1 or Layer 2 content.

Both policies use one closed semantic contract. The digest named
`policy_consequence_sha256` is SHA-256 over the exact UTF-8 consequence bytes
shown above. The code-fence delimiters and newline are excluded; there is no
quoting or trailing newline. The reviewer digest is
`sha256:f2d87d2ca6b4892ed9ce166f67120092de639b513fd919e864c0ddf58f253594`.
The organization-member digest is
`sha256:2a581951072720b0dfcbbf865cd90132e18421938c9d75dd1c11bb8a1fade2cf`.

The exact restricted-reviewer policy-contract body is:

```json
{
  "schema_version": 2,
  "kind": "echo-person-content-policy-contract-v2",
  "policy_id": "restricted-reviewer-person-v2",
  "policy_consequence_sha256": "sha256:f2d87d2ca6b4892ed9ce166f67120092de639b513fd919e864c0ddf58f253594",
  "reader_authentication": "current-authority-person-session-v2",
  "reader_selector": {
    "kind": "exact-frozen-approver-tenure-v1",
    "membership_state": "active",
    "membership_scope": "same-organization-as-record",
    "frozen_tuple": "approval-principal-id-and-membership-id"
  },
  "readable_item_kinds": ["decision", "action", "rationale"]
}
```

The exact organization-member policy-contract body is:

```json
{
  "schema_version": 2,
  "kind": "echo-person-content-policy-contract-v2",
  "policy_id": "organization-member-readable-person-v2",
  "policy_consequence_sha256": "sha256:2a581951072720b0dfcbbf865cd90132e18421938c9d75dd1c11bb8a1fade2cf",
  "reader_authentication": "current-authority-person-session-v2",
  "reader_selector": {
    "kind": "current-active-organization-members-v1",
    "membership_state": "active",
    "membership_scope": "same-organization-as-record",
    "eligible_membership_types": ["employee", "owner"],
    "later_members": "included"
  },
  "readable_item_kinds": ["decision", "action", "rationale"]
}
```

`policy_contract_sha256` is the RFC-8785 canonical SHA-256 of the complete
matching body. The restricted-reviewer contract digest is
`sha256:c0b1676ad1bd2f27d9d781605420beac2e6fd3cd18ffa69f0d18ea62fe48f043`.
The organization-member contract digest is
`sha256:7a874f8b8c0bea7fd58066f93e4f4a26f6f6c05bbbdfe45bf2141f0b2f3ff5e3`.
Policy ID and selector variant are a closed pair: swapping a
selector, consequence digest, item kind/order, authentication literal, or any
v1 contract member denies. Dynamic Authority, organization, principal,
membership, route, envelope, adapter, and provider values do not belong in
this global policy contract; the record fact, D6 caller/scope, D3 envelope,
and D2 identity contracts bind those values at their owning boundaries.

These IDs, exact bodies, consequence bytes, and computed digests are accepted
by ADR-0005. The installation-bearing
`restricted-reviewer-v1` and `organization-member-readable-v1` contracts are
rejected by the new lineage, not edited or aliased. Founder acceptance of the
ADR MUST explicitly confirm that the v2 ID and authentication-version delta
preserves the approved reader sets and denial behavior.

### Initial-V1 delivery behavior

Initial V1 does not add a policy-specific publication consequence or make a
destination part of the human approval contract. It preserves main's behavior:
an approved canonical snapshot is submitted to every configured delivery
surface after append, and rejection submits to none. Delivery configuration
does not derive from or change either ECHO reader set. A future
approval-bound destination or provider-audience contract requires a separate
decision and new canonical vectors.

### Approved decision snapshot commitment

One closed `echo-approved-decision-snapshot-v2` body is the content package
shown for approval, appended on approval, and delivered when delivery is
enabled. Its exact keys are:

```text
schema_version
kind
approval_id
staged_content_sha256
final_content_sha256
payload_contract_id
approved_payload
```

`schema_version` is `2`, `kind` is
`echo-approved-decision-snapshot-v2`, and `payload_contract_id` is
`organization-record-approval-payload-v1`. `approved_payload` is accepted by
the existing closed `OrganizationRecordApprovalPayloadV1` validator with exact
keys `brief`, `source`, `alternatives`, `links`, `reviewed_at`, and `surface`,
including its nested closed validators and required empty `alternatives` and
null `links`.

`approved_snapshot_sha256` is the RFC-8785 canonical SHA-256 of that complete
body. The frozen card, provider message/action, human-act reproof, approved or
rejected record event, and every delivery submission bind this same digest.
An approved record embeds the complete body and digest, revalidates the exact
payload, and recomputes the snapshot digest. Before live V4 admission, the
writer must also name and reprove the owners of `staged_content_sha256` and
`final_content_sha256`; the private D3-1 structural candidate treats them only
as opaque frozen commitments and does not claim their preimages. A rejected
record stores only the snapshot digest as proof of what was declined; it never
embeds the snapshot body or makes its content readable. There is no separate
unlinked staged or delivery snapshot digest.

### Frozen approval contract

Before presentation, pending work freezes:

- Authority, organization, lineage, approval ID, and candidate digest;
- policy ID, policy contract digest, and exact consequence bytes;
- approval adapter kind, ID, instance ID, and version;
- provider connection, approval binding, approval channel, and action mapping;
- presentation schema, card digest, `approved_snapshot_sha256`, and reactions;
- source and processor provenance commitments.

The frozen approval has no delivery binding, destination, delivery intent, or
publication-consequence member. Initial V1 preserves main's independently
configured post-record delivery fan-out; human approval neither selects nor
authorizes a delivery destination.

At action time the Authority rechecks every current edge consumed by approval:
the connection, link, target membership, approval binding, capability, frozen
adapter version, provider object, actor, channel, card, reaction mapping,
policy contract, and frozen-card digest. A missing, revoked, replaced,
cross-tenant, or mismatched edge denies with zero canonical append and zero
delivery call.

### Provider message commitment

The adapter first constructs `echo-provider-observation-v2` from only
provider-observed evidence: Authority, organization, lineage, provider issuer,
tenant/enterprise/tool tuple, connection ID plus contract/current-state
digests, approval adapter kind/ID/instance/version, provider object type and
stable coordinates, channel/message coordinate, actor subject, observed
reaction/action, provider response-evidence digest, and observed time. Its
digest is `provider_observation_sha256`. It contains no installation, ECHO
principal/membership, capability, or caller-supplied display value; those enter
only at the later Authority identity intersection. The installation-bearing v1
provider-event digest is rejected, not reused as this value.

The `echo-provider-approval-message-v2` preimage contains exactly:

- Authority, organization, lineage, and stable audit event ID;
- provider issuer, tenant kind and ID, nullable enterprise ID, tool kind,
  connection ID, `connection_contract_sha256`,
  `connection_state_sha256`, app ID, bot ID, and bot-user ID;
- approval binding, `approval_binding_contract_sha256`, and adapter
  kind/ID/instance/version;
- channel ID, message timestamp, provider actor subject, and observed reaction;
- approval ID, frozen policy ID and digest, card digest,
  `approved_snapshot_sha256`,
  policy-consequence digest, approve reaction, and reject reaction; and
- provider observation timestamp and `provider_observation_sha256`.

The provider adapter reconstructs this commitment from provider observation
and immutable frozen state. Caller-supplied display data is never an input.

### Provider human-action commitment

The `echo-provider-human-action-v2` preimage contains exactly:

- Authority, organization, and lineage;
- provider issuer, tenant kind and ID, nullable enterprise ID, and tool kind;
- connection ID, `connection_contract_sha256`, and
  `connection_state_sha256`;
- approval binding ID and approval-binding contract digest;
- approval adapter kind, ID, instance ID, and version;
- external identity link ID, `external_identity_link_contract_sha256`,
  principal ID, membership ID, and membership type;
- action-capability ID and capability contract digest;
- provider object type and stable coordinates, provider actor subject, and
  semantic action `approve` or `reject`;
- approval ID, policy ID, policy contract digest, policy-consequence digest,
  frozen card digest, `approved_snapshot_sha256`, and provider-message digest;
  and
- `provider_observation_sha256` and observed timestamp.

Every retained policy constructs the same preimage shape. Mutating any member
changes the digest. No v1 provider-event digest can cross-admit.
The external-link digest is recomputed from the exact stored
`echo-external-human-link-contract-v2` body at the action-time identity
intersection. Because it is a member of the provider-action preimage, the
authorization proof, integration audit, semantic replay key, and durable
locator bind that immutable link provenance transitively; a set-level copy of
the link body or digest is not evidence by itself.

`provider-human-approval-authorization-v2` is the closed Authority decision
body over Authority, organization, lineage, approval ID, semantic action,
policy ID/contract digest, exact principal and membership tenure/type,
capability ID/contract digest, `provider_observation_sha256`, provider-message
digest, provider-action digest, frozen-card digest, decision
`allow`, and evaluated time. Its digest is `authorization_proof_sha256`.
Denials use a separate minimized decision row with no human-act resolution
reference. Only an allow body may enter the immutable integration audit and
record-resolution reference.

### Integration audit chain entry

The immutable `echo-integration-audit-entry-v2` body contains exactly:

- Authority, organization, and lineage;
- monotonically increasing organization audit sequence;
- actor class `provider_human`;
- stable external-link, provider-connection, approval-binding,
  action-capability, principal, and membership IDs;
- canonical action, subject kind and ID,
  `event_digest = provider_observation_sha256`,
  `detail_digest = authorization_proof_sha256`, provider-message digest, and
  provider-action digest;
- correlation ID and occurred timestamp; and
- predecessor entry hash, or `null` only for the lineage genesis entry.

`entry_sha256` is SHA-256 of that closed canonical body. The stored audit entry
contains the body plus `entry_sha256`; the hash is not included recursively in
its own preimage. Record reproof checks the exact audit ID, sequence,
predecessor, body, and entry hash. There is no installation field and no null
placeholder for one.

Both v2 policies independently reconstruct the provider-message,
provider-action, event/detail, and chain-entry commitments from immutable
stored evidence. Selected-field comparison against current mutable
configuration is not reproof.

### Revocation and conflict

Before durable human-action audit commit, current membership, link,
connection, binding, capability, and provider-object checks apply. Two
different terminal reactions, a changed frozen card, an unknown actor, or
idempotency reuse with changed semantic input conflicts and yields no record.

After the exact human-action audit is durable, later provider/link/binding/
capability revocation blocks future actions but does not invalidate this act.
Record resolution and retry use only the immutable audit ID/hash/proof and
frozen record input. Layer-2 rebuild and Layer-3 read do not consult live Slack
state.

### Separate delivery capability and recovery

Initial V1 preserves the existing typed delivery-surface boundary and requires
at least one configured delivery surface for an enabled processing cycle.
After canonical approval append, core submits the exact approved snapshot to
every configured surface in deterministic configuration order. Rejection
creates no delivery work.

Approval identity, bindings, and receipts never authorize delivery. Delivery
configuration, destination validation, semantic idempotency, pre-call claim,
unknown/known outcome recovery, provider acknowledgement, and receipt remain
owned by each delivery adapter/runtime boundary. Slack approval and generic
Slack delivery channels MUST differ. The current live composition may configure
one Slack surface, but the core contract remains an array; this RFC does not
contract product cardinality or invent a reader-policy-derived audience.

Changing destination or configuration before an unclaimed attempt follows the
delivery adapter's current configuration contract. A claimed unknown/delivered
attempt recovers from its frozen durable attempt state and cannot blindly
repost. A future stable delivery-binding activation API or approval-bound
destination is a separate product contract, not a prerequisite for the
installation-identity migration.

## D3: Authority writer envelope and receipt

### Record-resolution port

Approval and rejection use one Authority-owned port:

```text
resolveHumanAct(reference, frozen_record_input)
  -> canonical append receipt | closed denial
```

The `echo-human-act-resolution-ref-v1` closed object has these exact keys:

```text
schema_version
kind
authority_id
organization_id
state_lineage_id
approval_id
action
policy_id
policy_contract_sha256
audit_event_id
audit_sequence
audit_entry_sha256
provider_action_kind
provider_action_schema_version
provider_action_sha256
authorization_proof_sha256
```

`schema_version` is `1`, `kind` is
`echo-human-act-resolution-ref-v1`, `action` is `approve` or `reject`, and the
provider-action kind/version pair is exactly
`echo-provider-human-action-v2`/`2`. The canonical digest of the complete body
is `human_act_resolution_ref_sha256`.

The resolver uses the exact reference key. It never searches by display name,
provider actor, timestamp range, `reviewed_by`, or a subset of fields. Unknown
or mutated references deny.

### Record envelope v4

`echo-organization-record-envelope-v4` is a closed signed wrapper with four
members: `body`, `record_sha256`, `signing_key_descriptor`, and `signature`.
The closed `body` has these exact keys:

```text
schema_version
kind
envelope_id
authority_id
organization_id
state_lineage_id
semantic_idempotency_key
issued_at
predecessor_position
predecessor_record_sha256
human_act_resolution_ref
source_provenance
source_provenance_sha256
processor_provenance
processor_provenance_sha256
event
```

`schema_version` is `4`; `kind` is
`echo-organization-record-envelope-v4`. Predecessor position and hash are both
present and both `null` only at the new-lineage genesis. The embedded exact
human-act reference already owns `authorization_proof_sha256`; neither that
digest nor `human_act_resolution_ref_sha256` is duplicated at body level.

`source_provenance` is the closed
`echo-meeting-source-provenance-v1` object with exact keys
`schema_version`, `kind`, `authority_id`, `organization_id`,
`state_lineage_id`,
`source_adapter_kind`, `source_adapter_id`, `source_adapter_instance_id`,
`source_adapter_version`, `external_id`, `canonical_revision`,
`normalizer_version`, and always-present nullable `source_revision`.
`schema_version` is `1`, `kind` is
`echo-meeting-source-provenance-v1`, and `source_adapter_kind` is
`meeting-source`. Provider-owned source values remain opaque and byte-
preserving JSON strings. `source_provenance_sha256` is recomputed from this
complete domain-separated body.

`processor_provenance` is the closed
`echo-decision-processor-provenance-v1` object with exact keys
`schema_version`, `kind`, `authority_id`, `organization_id`,
`state_lineage_id`,
`processor_adapter_kind`, `processor_adapter_id`,
`processor_adapter_instance_id`, `processor_adapter_version`, and
`processor_contract_sha256`. `schema_version` is `1`, `kind` is
`echo-decision-processor-provenance-v1`, and `processor_adapter_kind` is
`decision-processor`. Adapter version and processor-contract digest are
independent replay dimensions and neither substitutes for the other.
`processor_provenance_sha256` is recomputed from the complete provenance body.
The private D3-2 structural slice validates and binds the opaque processor
contract digest but does not claim its preimage. Live V4 admission remains
blocked until Phase 3 names a closed domain-separated processor-contract
preimage and reproves the frozen value.

For `event.kind: approved`, the exact keys are:

```text
kind
approved_snapshot
approved_snapshot_sha256
policy_id
policy_contract_sha256
policy_consequence_text
policy_consequence_sha256
```

The event embeds the complete closed snapshot body and its independently
recomputed digest. It accepts exactly one v2 policy ID, policy-contract digest,
and the matching exact reader-policy consequence text/raw UTF-8 digest.
Delivery destination/configuration is not part of this initial-V1 human-act
event.

For `event.kind: rejected`, the exact keys are:

```text
kind
candidate_sha256
approved_snapshot_sha256
frozen_card_sha256
policy_id
policy_contract_sha256
policy_consequence_sha256
action
rejection_payload
```

The event pins `kind: rejected`, semantic `action: reject`, the same frozen
card commitment owned by the D2 provider action, and the exact presented v2
policy tuple as provenance. `rejection_payload` is accepted by the
retained closed `OrganizationRecordRejectionPayloadV1` validator. That bounded
payload contains the exact source locator, meeting ID, rejected time, nullable
organization-visible reason of at most 2 KiB UTF-8, and nullable
`reconsider_after` timestamp. Approved snapshot/payload bytes, approval policy-
fact data, any delivery fields, and rejected candidate content remain
forbidden. Exact-key dispatch rejects a mixed event.

`record_sha256` is SHA-256 of the canonical UTF-8 `body` bytes. It is not a
member of `body`. The signature input is the canonical closed object with exact
keys:

```text
schema_version
kind
authority_id
organization_id
state_lineage_id
signing_key_id
record_sha256
```

`schema_version` is `4` and `kind` is
`echo-organization-record-signature-v4`. The signature is
computed over those bytes through an Authority signer that is also given the
expected pinned key ID. Verification recomputes body hash and signature;
the wrapper is rejected if a field is missing, extra, duplicated, or moved
between body and wrapper. There is no self-hash or self-signature cycle.

The record and receipt wrappers reuse the retained federation P-256 signing
profile rather than defining a new algorithm. `signing_key_descriptor` has
exact keys `key_id`, `algorithm`, and `public_key_spki_der_base64`.
`algorithm` is exactly `ecdsa-p256-sha256-der-low-s`; the public key is the
canonical uncompressed P-256 SPKI DER encoded as canonical base64; and
`key_id` is `sha256:<lowercase hex SHA-256 of those SPKI DER bytes>`. The
wrapper `signature` is canonical base64 of a strict DER-encoded low-S ECDSA
P-256/SHA-256 signature over the canonical signature-input bytes. Descriptor
fingerprint, curve, SPKI canonicality, DER form, low-S form, signature, body
hash, and exact Authority key pin are all reverified. Ed25519 and placeholder
signature strings are not accepted by this contract version.

Layer 1 does not contain provider credentials, opaque credential handles,
mutable connection configuration, display identity, or resolved reader lists.
Detailed provider identity remains in immutable integration audit. The record
contains the stable reference and proof required to reprove it.

The approved or rejected closed `event` is independently committed through
the exact canonical object below:

```text
schema_version
kind
event
```

`schema_version` is `1`, `kind` is
`echo-human-act-event-commitment-v1`, and `event` is exactly one of the two
closed variants above. The canonical SHA-256 of this domain-separated object
is `human_act_event_sha256`; hashing the nested event directly is forbidden.
The `echo-authority-human-act-idempotency-v2` preimage has these exact keys:

```text
schema_version
kind
authority_id
organization_id
state_lineage_id
approval_id
action
human_act_resolution_ref_sha256
human_act_event_sha256
```

`schema_version` is `2`; `kind` is
`echo-authority-human-act-idempotency-v2`. Its coordinate and action members
must equal the resolution reference, and its two digests are recomputed from
the exact reference and event bodies. Exact retry returns the same record and
receipt. Its canonical SHA-256 is the exact
`semantic_idempotency_key` stored in both the envelope body and receipt body;
an opaque caller-selected key is forbidden. Reuse with any different semantic
member conflicts. Concurrent exact submissions append once.

Only approval appends policy eligibility/readable facts, atomically with the
canonical record. Rejection appends no eligibility/readable fact. The two v2
policy namespaces remain distinct: member-readable segments bind organization
and exact policy; reviewer segments additionally bind exact principal and
membership tenure.

The private D3-3 structural projector emits one text-free row per approved
signal. Every row has these exact fields:

```text
authority_id
organization_id
state_lineage_id
approval_id
action
policy_id
policy_contract_sha256
record_position
record_sha256
atom_order
signal_id_sha256
atom_id
item_kind
audit_event_id
audit_sequence
audit_entry_sha256
provider_action_sha256
authorization_proof_sha256
```

`action` is `approve`; `item_kind` is `decision`, `action`, or `rationale`.
Projection preserves the approved snapshot's decisions, then actions, then
rationales, with dense zero-based `atom_order`. Organization-member rows have
exactly the common fields above and contain no actor selector. Restricted-
reviewer rows additionally and obligatorily contain
`reviewer_principal_id` and `reviewer_membership_id`, taken only from the
independently re-proved immutable D2 authorization allow and matching audit
actor. The rows contain no signal text, title, source locator, display
identity, current-membership snapshot, resolved reader list, provider
configuration, or delivery state.

A valid zero-item approval produces zero rows but still has
`policy_fact_outcome: {kind: appended, policy_id}`. Rejection produces zero
rows and `{kind: none}` without inspecting or hashing rejection content. No
sentinel row or free-standing fact-set digest is created. D3-3 is a pure
projection checkpoint only: Phase 3 must supply unforgeable verified-envelope,
append-allocation, and D2 audit-reproof capabilities and atomically compare and
persist the complete projection with the record and receipt.

### Receipt v2

`echo-organization-record-receipt-v2` is a closed signed wrapper with `body`,
`receipt_sha256`, `signing_key_descriptor`, and `signature`. Its closed body
has these exact keys:

```text
schema_version
kind
authority_id
organization_id
state_lineage_id
envelope_id
semantic_idempotency_key
event_kind
record_position
record_sha256
predecessor_record_sha256
record_head_position
record_head_sha256
issued_at
policy_fact_outcome
```

`schema_version` is `2`; `kind` is
`echo-organization-record-receipt-v2`. `record_position` is `1` exactly when
the verified envelope has the null genesis predecessor pair; otherwise it is
the envelope predecessor position plus one. The predecessor digest equals the
envelope predecessor digest, and the resulting head position/hash equal the
new record position/hash.
Rejection uses only `{kind: none}`. Approval uses only
`{kind: appended, policy_id}`. The canonical record hash, log position, and
policy ID already determine the complete append-atomic, text-free fact set;
the Record writer returns this outcome only after deriving and committing that
complete set in the same transaction. Startup and exact-duplicate admission
independently reproject and compare every fact from the canonical record. No
free-standing or caller-supplied fact digest can substitute for that proof.
External witnessed
checkpoints remain outside v2; no free-standing checkpoint ID or digest is
embedded in the receipt.

`receipt_sha256` is SHA-256 of canonical receipt-body bytes and is absent from
that body. The receipt-signature input has exact keys `schema_version`, `kind`,
`authority_id`, `organization_id`, `state_lineage_id`, `signing_key_id`, and
`receipt_sha256`; version is `2` and kind is
`echo-organization-record-receipt-signature-v2`. The signature is over those
canonical bytes. Receipt verification recomputes both digests
and rejects cross-version, extra-field, mixed-outcome, and signature/key
substitution. The receipt is the only signal that pending approve or reject
work may become terminal.

Restart and rebuild verify from the new genesis, exact envelope bytes, audit
proof, hash chain, receipts, and policy facts. They do not require live
provider state or current recording configuration.

The structural ownership boundary is fixed. `organization-protocol` owns the
closed envelope, receipt, canonicalization, signature, and cross-version
validators. `organization-record` owns idempotency, append, hash-chain,
receipt persistence, and append-atomic policy facts. Authority
composition owns current provider-action admission, exact human-act
resolution, the internal writer capability, signing-key access, and the
in-process port wiring. No package imports Authority composition to validate a
canonical record.

## D4: Rejection contract

A rejection is an immutable provider-observed human act. It is not absence of
approval, candidate deletion, or permission to expose rejected content.

Before receipt, rejection state is nonterminal and contains only the frozen
candidate, exact human-act reference, resolution attempt, and retry evidence.
After one canonical rejection record and receipt, processing marks the work
terminal exactly once and applies ADR-0001's 30-day terminal pre-record
retention. Expiry removes the rejected candidate bytes and pending-only
artifacts, not the canonical rejection act or its immutable authorization
proof. An exact retry returns the same receipt. A concurrent approve/reject
race admits at most one semantic outcome; the loser receives a conflict and
cannot append another act.

The canonical rejection record contains the action and bounded proof but
appends:

- zero approval eligibility facts;
- zero readable atoms, retrieval facts, content segments, or lexical entries;
- zero delivery attempt or provider call; and
- zero reader-list material.

Its event is the exact bounded-act `rejected` variant above. Supplying approved
snapshot/payload bytes, any delivery member, policy-fact data, or
candidate content is a schema error that appends nothing. The bounded retained
rejection payload preserves main's optional organization-visible reason and
`reconsider_after`; neither becomes a readable atom or policy fact. A digest
of rejected candidate or presentation bytes is proof of the human act, not
content made readable by the record.

No Person response, denial, count, title, reason, source identifier, or audit
export may reveal rejected candidate content or its existence through either
retained policy. Generic unavailable or not-found behavior must remain
metadata-free.

## D6: Initial-V1 shared Person-read audit, retention, and release

### Retained operations

Initial V1 retains Person `reviewer-recent-decisions`,
`readable-search`, and self-owned source/meeting-exclusion reads and
mutations. The fixed two-person Pilot `recent-decisions` route is retired
only after parity; it is not renamed into a new union.

Reviewer-recent preserves main's exact reviewer-principal and membership-tenure
reader set and reads verified append-atomic Layer-1 facts/canonical rows. It
remains available after a record append and before a Layer-2 rebuild. Readable
search preserves the organization-member exact-head Layer-2 scope and remains
fixed-unavailable while the active generation is stale. Neither operation may
fall back to, union with, or inherit the availability of the other.

The operations share only the parts that are truly common: current Person and
session resolution, server-derived request context, a caller-bound
operation-specific scope, the final current-state/head fence, deterministic
private response serialization, audit-before-release, and safe denial bytes.
Their candidate selection, policy witness, response contract, and availability
checks remain typed by operation. Exact v2 response/scope/audit schemas are
owned by the Phase 1/2 implementation and must preserve the corresponding main
contract before Phase 4 acceptance; Phase 0 does not invent a combined
retrieval contract.

### Semantic request commitment

After transport validation and before caller/scope admission, the application
constructs one closed body with exact keys `schema_version: 2`,
`kind: echo-person-request-commitment-v2`, `operation`, and `input`. The exact
operation/input pairs are:

```text
reviewer_recent_decisions -> {}
readable_search -> {query}
list_member_exclusions -> {source_adapter_id, source_instance_id}
change_member_exclusion -> {excluded, selector}
```

`query` is the exact NFC, trimmed, single-line, control-free value accepted by
the retrieval contract. The change selector is exactly either
`{scope: source, source_adapter_id, source_instance_id}` or
`{scope: meeting, source_adapter_id, source_instance_id, external_id}`;
provider-owned `external_id` bytes are opaque, nonempty, NUL-free, and bounded
to the retained 4,096-code-unit contract. Fields from the other selector
variant are forbidden. The canonical SHA-256 of the complete commitment body
is `request_sha256`; that same value appears in the scope and D6 audit. A
route/operation mismatch or digest from another input variant denies.

### Caller binding

The `echo-person-caller-binding-v2` preimage contains exactly:

- `authority_id`;
- `organization_id`;
- `state_lineage_id`;
- `principal_id`;
- `membership_id`;
- `membership_type`;
- OIDC `identity_binding_id`;
- `session_family_id`;
- `access_credential_sha256`;
- `person_state_sha256`; and
- `session_state_sha256`.

The resulting digest is `caller_binding_sha256`. The Authority resolves every
member from current state; no request field supplies one.

### Scope binding

Before any protected data handle opens, the application constructs one closed
`echo-person-scope-binding-v2` variant. Both variants contain
`caller_binding_sha256`, operation, and `request_sha256`.

The `scope_kind: retrieval` variant additionally contains ordered active
policy IDs/versions/contract digests, retrieval-contract digest, retrieval
generation ID and manifest digest, exact record-head position/hash, and every
ordered admitted policy-path or segment ID plus segment-manifest digest. It is
created before lexical or content handles open. Candidate selection,
statistics, scoring, and retrieval may operate only inside this scope.

The `scope_kind: authority_state` variant is used only for a self-owned source
or meeting-exclusion read or mutation. It additionally contains the Authority
source-activation binding digest, owned-resource digest, and current exclusion-
state digest. The caller binding plus exact source-activation commitment own
the custodian principal and membership; the scope does not duplicate those
identifiers. For a mutation, the common `request_sha256` is the complete
mutation-command commitment; no second command digest is added.
The final fence re-resolves the same current Person,
membership, source ownership, and state commitments and performs the mutation
plus audit in the same Authority write transaction. It opens no retrieval
generation, segment, lexical, content, or record-log handle.

Keys from the other variant are forbidden rather than nullable. Neither
variant contains query text, terms, title, participant, source locator,
content, score, count, or returned item. The resulting digest is
`scope_binding_sha256`; the discriminator prevents a retrieval scope from
replaying as an Authority-state mutation or conversely.

### Release binding

The application prepares a typed authorized result. The sole v2 HTTP release
adapter serializes it deterministically once into a private immutable buffer.
Serialization is not release. It provides the exact response digest and opaque
result bindings to finalization.

For an allow that returns protected bytes,
`echo-person-release-binding-v2` contains `caller_binding_sha256`,
`scope_binding_sha256`, `serialized_response_sha256` over the exact private
immutable response-buffer bytes, and one closed result variant. A
`result_kind: retrieval` variant contains every ordered returned tuple of
`atom_id`, `record_hash`, `policy_id`, `content_binding_sha256`, and
`provenance_binding_sha256`. A `result_kind: authority_state` variant has no
additional member: the caller, exact Authority-state scope, and immutable
response bytes already bind the result without copying resource identifiers
into release evidence. Keys from the other variant are forbidden. A mutation that returns
only an uninformative success code has no release binding; its allow audit and
state mutation still commit atomically before that code is written.

The final fence re-resolves the caller and rechecks the exact scope variant:
policy contracts, generation pointer/manifest, record head, and every admitted
path for retrieval; or current source ownership, Authority state, and exclusion
state for an Authority-state operation. It then commits the audit row, plus
the exclusion mutation when applicable, in the one owning transaction. Only
commit success authorizes the adapter to write the same buffer. The adapter
cannot reserialize after commit. Any mismatch, revocation, stale head,
stale generation or Authority state, mutation, or audit failure discards the
buffer and releases zero protected bytes.

### Audit row

An `echo-person-read-decision-audit-v2` stored row has exactly
`{body, row_sha256}`. `row_sha256` is the RFC-8785 canonical SHA-256 of `body`
and is not inside `body`. The append-once body has exactly:

```text
schema_version = 2
kind = echo-person-read-decision-audit-v2
audit_id
authority_id
organization_id
state_lineage_id
operation
request_sha256
context
decision
reason_code
outcome
evaluated_at
retain_until
```

`operation` is exactly `reviewer_recent_decisions`, `readable_search`,
`list_member_exclusions`, or `change_member_exclusion`.

`context` is one of three exact variants:

```text
{kind: no_current_caller}
{kind: caller_only, caller_binding_sha256}
{kind: scoped, caller_binding_sha256, scope_binding_sha256}
```

`no_current_caller` is only an `unauthenticated` or
`caller_context_invalid` denial before a caller binding exists and contains no
principal-like field. `caller_only` is only an `operation_forbidden` or
`scope_not_admitted` denial before a scope binding exists. `scoped` is required
for every allow and for a `current_state_changed` or
`protected_data_unavailable` denial after scope commitment. The audit stores
only the caller- and scope-binding digests, never the source, custodian,
resource, policy-path, segment, generation, manifest, or record-head members
committed inside the scope preimage.

`outcome` is exactly one of:

```text
{kind: deny}
{
  kind: retrieval_release,
  release_binding_sha256,
  response_sha256
}
{
  kind: authority_state_release,
  release_binding_sha256,
  response_sha256
}
{kind: authority_state_mutation}
```

`decision: deny` requires `outcome: {kind: deny}`. `decision: allow` requires
the outcome matching its scope and operation. The only allow reason is
`authorized`; deny reasons are `unauthenticated`, `caller_context_invalid`,
`operation_forbidden`, `scope_not_admitted`, `current_state_changed`, or
`protected_data_unavailable`. Each deny reason requires the context stage
defined above. Every deny maps to the same safe opaque external failure family
and contains no release/response digest, returned binding,
item/count/path/segment, resource/source identifier, or policy-specific reason.
`audit_unavailable` is not a row because persistence failed; it releases zero
bytes and performs no mutation.

A mutation acknowledgement has no release binding because it exposes no
protected bytes; its desired-state mutation and audit row commit in the same
Authority transaction. There is no second mutation-receipt object. A
byte-returning allow commits the row before the adapter writes
the exact buffer whose digest is both the outcome `response_sha256` and the
release binding's `serialized_response_sha256`. The caller, scope, and release
bindings are never overwritten, aliased, or substituted. No row contains
query/content text, titles, participants, display/provider identities, source,
custodian, resource, policy-path, segment, generation, manifest, or record-head
identifiers, or caller-supplied identity fields. `retain_until` is exactly 30
days after `evaluated_at`.

Whole-row expiry is recorded as an append-once
`echo-audit-expiry-control-v1` row with the same exact `{body, row_sha256}`
wrapper. Its body contains exactly:

```text
schema_version = 1
kind = echo-audit-expiry-control-v1
control_id
authority_id
organization_id
state_lineage_id
cutoff
retention_days = 30
expired_row_sha256s
occurred_at
```

`expired_row_sha256s` is an ascending, unique array of at most 500 row digests.
The control row commits with deletion of exactly those rows. Empty batches are
not written. Selective field redaction, row rewrite, early expiry, and export
are unsupported.

Provider and adapter identity is record-admission evidence, not a read-time
grant. D6 reads use current Person/session/membership and canonical policy
facts. Revoking an originating Slack connection or link after append cannot
change reader semantics or break rebuild.

### Retention and export choices requiring disposition

This draft recommends the lean disposition below, but it remains unresolved
until the exact founder review accepts it:

1. **Retention interval:** 30 days from Authority-owned `occurred_at`. This is
   an explicit replacement of the two historical 180-day query-audit
   contracts, not an inference that their data was unimportant.
2. **Export position:** deliberately unsupported. The lean runtime has no
   query-audit export route, command, file writer, or row-selection port. A
   capability query may return one closed `unsupported` result without
   selecting audit rows or opening an output path. The negative contract names
   and removes both legacy export commands, their command/document kinds,
   maintenance repositories and row-selection helpers, operator-state file
   writers, runtime-fingerprint modes, and CLI dispatch branches.

Expiry deletes whole rows in one transaction and commits the exact
`echo-audit-expiry-control-v1` `{body, row_sha256}` defined above, containing
only the stable control ID, Authority/organization/lineage, cutoff, fixed
30-day retention, ordered expired-row digests, and occurred time.
It contains no command digest, separately stored row count, actor, or aggregate
ordered-row digest. It never redacts selected fields or rewrites a retained
row. Exact retry returns the same control receipt.
Audit rows are append-once and immutable for their declared lifetime; the
minimal D6 table does not create a second cryptographic chain beside the
canonical integration-audit and record chains.

## State transitions

### Approval and record resolution

| From | Event | Required proof | To | External effect |
| --- | --- | --- | --- | --- |
| pending | provider action absent | frozen pending contract | pending | none |
| pending | valid approve/reject observed | all current D2 edges and exact frozen card | human-action-audited | integration audit only |
| pending | mismatch/revocation/conflict | closed denial | pending or conflicted | none |
| human-action-audited | exact record resolution | D3 immutable reference and frozen input | append-receipted | one canonical append |
| human-action-audited | crash/retry | same immutable reference and input | append-receipted | exact receipt recovery |
| append-receipted | terminal save | exact receipt | terminal | none |
| terminal approval | configured-surface fan-out | exact receipt/snapshot plus nonempty ordered surface list | delivery claimed per surface | no call yet |
| delivery claimed | surface pre-call validation passes | exact snapshot plus durable attempt and valid configuration/destination | unknown or delivered | at most one first call per surface |
| terminal rejection | any delivery request | rejection receipt | terminal rejection | zero calls |

### Person release

| State | Event | Required proof | Result |
| --- | --- | --- | --- |
| authenticated | scope admission | current caller plus exact policy/head/generation paths | private scoped query capability |
| scoped | selection and serialization | operation-specific policy and in-scope data only | private immutable buffer |
| prepared | final fence and audit commit | unchanged caller/scope/head/generation plus exact response digest | release capability |
| prepared | any mismatch or audit failure | closed failure | buffer discarded, zero bytes |
| released | adapter write | exact release capability and unchanged buffer | one audited response |

## Threat analysis and failure behavior

The contract addresses these threats:

- **tenant collision:** provider subjects are `(issuer, tenant, subject)`, not
  bare provider user IDs;
- **link-as-grant:** external identity links grant no approve, read, source, or
  delivery capability;
- **mutable reinterpretation:** pending work freezes adapter, policy,
  presentation, source, processor, and delivery meaning;
- **installation laundering:** new kinds contain no employee installation,
  enrollment, lease, or installation signing field;
- **service impersonation:** the internal actor can resolve only an already
  audited exact human act and cannot create one;
- **approval/delivery confusion:** separate bindings, activation, semantic
  keys, attempts, and receipts prevent an approval grant from authorizing a
  provider write;
- **current-provider dependency after append:** immutable audit reproof keeps
  admitted records rebuildable when live provider edges are revoked;
- **read widening:** Layer 3 derives the current Person independently and
  selects only through the exact policy namespace;
- **existence leakage:** denials and rejected records disclose no item metadata
  or hidden counts; and
- **audit mismatch:** exact caller, scope, release, and response digests plus
  commit-before-write prevent unaudited bytes.

At each stage, only the edges that stage consumes are current revocation
checks. Provider approval consumes current provider and capability edges;
record reproof consumes immutable audit proof; delivery consumes the canonical
receipt/snapshot plus each surface's configured destination before a call;
Person read consumes current Person state and
canonical record/retrieval facts.

## Compatibility, rollout, and rollback

Implementation is additive in the old artifact until the D0 new-lineage
cutover. The new validators, stores, and ports use new kinds, versions, policy
IDs, application IDs, manifests, and genesis. No row-level backfill or mixed
old/new database is allowed.

The rollout order is:

1. accept this RFC through an exact ADR disposition;
2. implement semantic Person DTOs and new-lineage manifests offline;
3. implement D1 service scopes, D2 identity/activation, D3/D4 record
   resolution, and D6 read audit behind new kinds;
4. pass canonical vectors, runtime tests, semantic parity, and reset rehearsal;
5. perform the separately authorized D0 reset and re-onboard through normal
   flows; and
6. delete compatibility in independently reviewable tranches only after the
   new lineage is sole live state.

Rollback before cutover is code-only. Rollback after cutover stops the new
artifact and restarts only the checksummed old artifact with its intact old
state snapshot. Old and new writers never run together and rows never move
between lineages.

## Evidence split: Phase 0 acceptance versus later runtime proof

Phase 0 may accept contract meaning without claiming unimplemented runtime
behavior. The two evidence classes are deliberately separate.

### Required for Phase-0 contract acceptance

- exact committed RFC bytes and SHA-256;
- explicit founder/constitution-owner disposition and either one independent
  permissions review or an explicit founder waiver of a second human reviewer
  for this no-customer Phase-0 contract;
- exact schema field lists, state-transition tables, identity-chain diagram,
  domain separators, policy IDs, consequence bytes, and unresolved-choice
  resolutions;
- canonical positive fixtures and mutate-every-field/cross-version negative
  vectors for both policy contracts, the approved decision snapshot, the
  Person retrieval contract, provider message/action, the integration-audit
  entry, human-act reference, envelope, receipt, idempotency, caller, scope,
  and release commitments;
- an evidence map from every required runtime case to a named test owner and
  target suite; and
- an updated INV-IDENTITY-005 edge inventory.

Fixture-vector tests in Phase 0 prove only that the candidate bytes are
self-consistent and domain separated. They do not prove provider behavior,
persistence, races, restart, or non-disclosure at runtime.

### Required before implementation/cutover/deletion claims

- owner activation, link-only completion, capability, revocation, provider
  mismatch, conflict, and fake-provider end-to-end tests for both policies;
- v1/v2 cross-denial and mutate-every-field tests in production validators;
- symmetric immutable audit reproof for both policies;
- exact retry, concurrency, audit-to-gate crash, append, receipt recovery,
  rejection race, restart, and stopped rebuild tests;
- delivery zero-call, unknown outcome, recovery, rotation, and no-blind-repost
  tests;
- Person allow/deny, revocation race, stale head/generation, audit outage,
  exact response digest, expiry, and chosen export/unsupported tests for every
  retained operation;
- semantic D5 parity with zero unexplained reader-set or disclosure delta; and
- exact-artifact qualification after the D0 reset rehearsal and cutover.

No Phase-0 document may label one of these later runtime cases passed merely
because the candidate specification describes it.

## Alternatives and tradeoffs

### Keep installation authority on the server

Rejected for the target. It preserves a second human/machine authorization
root, lease refresh, signing keys, compatibility transport, and schema history
that have no employee-machine purpose after processing becomes server-owned.

### Treat provider link as approval authority

Rejected. A link answers who a provider actor maps to, not what that Person may
do. Explicit policy/action capabilities are required.

### Use one Slack adapter identity for approval and delivery

Rejected. Approval records a human act; delivery is a recoverable provider
side effect. Sharing a verified tool connection is allowed, but binding,
contract, intent, idempotency, outcome, and receipt remain distinct.

### Keep literal v1 policy IDs and change their authentication meaning

Rejected. The existing IDs and consequence contracts bind installation and
lease semantics. Reusing them would reinterpret historical bytes. The v2 IDs
make the one accepted Person/session substitution explicit.

### Keep route-specific Person audits

Rejected as duplicate transaction and maintenance machinery. Operation policy
evaluation stays typed, while the current caller, scope, final release, and
retention fence become common.

### Put answer-model calls inside the read fence now

Rejected and out of scope. A future Layer-4 consumer needs a separate
purpose-specific release and audit contract. It cannot receive a generic
capability to observe Layer-3 results.

## Open questions requiring disposition

ADR-0003 MUST remain `proposed` until all rows are resolved against exact RFC
bytes:

| ID | Choice | Least semantic-delta proposal |
| --- | --- | --- |
| OQ-1 | D6 retention interval | Lean proposal: 30 days from Authority `occurred_at`, explicitly superseding the historical 180-day query-audit contracts |
| OQ-2 | D6 export position | Lean proposal: deliberately unsupported, with no production export route, command, writer, or row-selection port |
| OQ-3 | D1 review | Lean proposal: founder/constitution-owner acceptance plus the recorded independent contract review; founder explicitly waives a second human reviewer until first-external-organization re-entry |
| OQ-4 | D2 version break | Resolved by ADR-0005: the two v2 IDs, exact policy-contract bodies/selectors and computed digests, and exact consequence bytes are accepted while preserving reader sets |
| OQ-5 | Delivery behavior | Initial V1 preserves main's configured delivery behavior and approval/delivery channel separation; a single-destination or policy-specific contraction is deferred to a later decision |
| OQ-6 | Standalone reviewer-recent route | Retain it in initial V1 with exact reviewer-tenure semantics and Layer-1/log-backed availability; route consolidation is deferred |

Resolving an open question in an ADR without updating the corresponding
normative RFC bytes is invalid. If a choice changes this RFC, commit the new
candidate, recompute its SHA-256, and obtain a new review disposition.
