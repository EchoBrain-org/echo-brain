---
schema_version: 1
id: ADR-0004
kind: decision
title: Founder Authority clean-state reset
component_ids:
  - CMP-ADAPTERS
  - CMP-CENTRAL-ORGANIZATION
  - CMP-IDENTITY-ACCESS
  - CMP-CORE-PIPELINE
  - CMP-PERMISSIONS
  - CMP-OPERATIONS-RELEASE
  - CMP-PROTOCOLS-CRYPTO
created_at: 2026-08-20
reviewed_at: 2026-08-20
reviewed_ref: 77a212134fce762fdffd30e028f3256ba6e75b42
status: proposed
supersedes: []
superseded_by: []
updates: []
---

# ADR-0004: Founder Authority clean-state reset

## Context and options

[ADR-0001](ADR-0001-organization-operated-server-core.md) moves processing
into the organization-operated Authority, and
[ADR-0002](ADR-0002-external-oidc-person-sessions.md) makes current Person
identity the replacement for employee-installation identity. The active
[server-core lean-down plan](../product/2026-08-20-server-core-migration-lean-down-plan-v4.md)
therefore needs a deliberately new state lineage rather than a compatibility
migration that relabels installation-era rows.

The target is the single founder-operated Authority. This proposal does not
infer from that description that its current state is disposable. Founder
attestation is required below, and the exact live artifact and state must be
captured only at the stopped Phase-4 gate. No live state was inspected while
preparing this proposal.

The options are:

1. Preserve and translate the current state in place. This retains rollback
   history inside the new runtime, but also retains the compatibility schema,
   makes new meanings depend on old installation rows, and expands the
   migration beyond the clean-state objective.
2. Delete the current state and initialize a new Authority without a stopped
   snapshot. This is smaller, but it has no exact rollback pair and cannot
   prove which artifact created the discarded bytes.
3. Authorize a future stopped cutover to a new empty lineage, preserve the old
   artifact and whole old state as one checksummed rollback pair, and
   re-onboard through the accepted current flows. This keeps old bytes under
   their original meaning and prevents a dual writer.

This proposal selects option 3 if and only if the disposition below is
accepted by the founder and every Phase-4 execution precondition is later
satisfied.

## Proposed decision and consequences

### 1. Phase-0 authorization scope

If accepted, this ADR authorizes planning, offline rehearsal against copies or
fixtures, and a later Phase-4 stopped clean-state cutover for exactly one
founder Authority and one organization. It authorizes discarding and
re-onboarding the following semantic state roles together:

1. **Authority and organization root:** Authority identity, organization
   binding, principals, memberships, invitations, OIDC bindings, Person
   session families and credentials, administrator state, signing identity,
   and state/installation anchors.
2. **Pre-record processing:** source activation and custody, cursor/cutoff,
   normalized meetings and revisions, processing identities, pending approval
   and rejection work, frozen presentations and policy consequences, terminal
   cleanup state, delivery attempts, and processing receipts.
3. **Integration control plane:** provider-connection attempts and active
   connections, external human identity links, adapter identities and
   bindings, action capabilities, organization-tool configuration, and the
   immutable integration audit.
4. **Layer 1 record truth:** canonical approve/reject records, record signing,
   idempotency, hash chain, checkpoints, append receipts, and append-atomic
   policy facts.
5. **Derived record state:** the deterministic projection rebuilt from the
   Layer 1 log.
6. **Layer 2 retrieval state:** policy-fact, content, and lexical planes,
   immutable generations, manifests, active pointers, and rebuild metadata.
7. **Operational identity and configuration:** Authority configuration,
   identity/initialization manifests, keys, credential files or opaque secret
   references, provider configuration, and deployment state that is valid only
   with the exact Authority state above.

The roles are one recovery unit even when several roles currently share a
database or one role spans a database and immutable files. Acceptance does
not bless a guessed file list, permit a partial reset, or permit new code to
open old state. Phase 4 must bind these roles to the exact stopped files and
lineages before any destructive action.

### 2. Required founder attestation

Acceptance requires a founder disposition bound to the exact text of this ADR
that states all of the following:

> I attest that the scoped Authority serves no customer and contains no
> customer-owned or otherwise irreplaceable identity, content, approval,
> audit, record, receipt, configuration, or recovery state. I authorize this
> founder-only state to be discarded after the stopped Phase-4 snapshot and
> rollback-pair gates pass, and I authorize re-onboarding from empty state.

If any customer, legal, contractual, evidentiary, or otherwise irreplaceable
state is discovered, this authorization does not apply. The migration stops
and requires a different decision. A general statement that the environment
is low risk is not a substitute for this scoped attestation.

### 3. Declarative re-onboarding inventory

Before acceptance, the Phase-0 record must name how each of these inputs will
be re-entered or deliberately omitted. It records no secret value. Phase 0
freezes the field names, ownership, and re-entry operation; the exact newly
minted IDs and external public tuple values are captured in the stopped
Phase-4 configuration manifest because this proposal does not inspect live
state:

- canonical Authority origin, organization name, public deployment settings,
  trusted-proxy settings, and the intended new Authority/organization and
  state-lineage creation procedure;
- OIDC issuer, client identifier, redirect URI, tenant rule, algorithm
  allowlist, and opaque reference to the client credential installation
  procedure;
- owner identity and the employee invitation roster, work addresses,
  membership types, and planned Person login/OIDC completion flow;
- organization Slack workspace/app/bot/bot-user/channel/scope tuple and opaque
  references to credential installation, followed by fresh Person Slack links;
- meeting-source kind, adapter identity/version, organization credential
  scope, custodian, cutoff/cursor rule, and opaque source-credential
  installation reference;
- processing adapter kind/ID/instance/version, provider/model selection,
  contract/configuration digest inputs, and opaque provider-credential
  installation reference;
- approval adapter binding, policy-specific approve/reject capabilities,
  action mapping, policy contracts, and frozen presentation contract;
- delivery intent policy and, when enabled, its distinct adapter binding,
  destination identity/digest, contract, and credential reference; and
- operational listener, tunnel, deployment, backup, retention, and recovery
  configuration required to start the one new Authority safely.

Unknown, inferred, or unavailable input is an open gate, not permission to
copy a legacy row or invent an identity edge. Provider-human links, active
memberships, action capabilities, and provider verification are recreated
through their accepted flows; they are never bulk relabelled.

The secret-free re-entry map is complete as follows:

| Role | Exact declarative input | Re-entry or deliberate omission |
| --- | --- | --- |
| Authority root | founder-supplied canonical HTTPS origin and organization display name; loopback listener default `127.0.0.1:39479`; trusted-proxy mode; new `authority_id`, `organization_id`, `state_lineage_id`, application IDs, schema digests, and Authority signing-key descriptor | The new initializer generates every ID, lineage, manifest, genesis, admin credential, proxy credential, and signing key in a new state directory. The operator supplies only the public origin/name/listener fields. Old IDs, pins, keys, marker hashes, and `installed_at` rows are omitted. |
| Person OIDC | `issuer`, `client_id`, exact `/v2/session/oidc/callback` redirect URI, tenant constraint, one ID-token algorithm, client-authentication method, client-secret reference when applicable, and PKCE-sealing-key reference | Write one new-lineage Person-session overlay whose Authority/organization IDs are the newly generated values. Install fresh private credential/key bytes behind the opaque references. Copy no OIDC binding, attempt, family, access credential, nonce, or PKCE state. |
| People | one owner work identity plus at least three separately invited employee work identities; display names; membership types; invitation lifetime policy | Create the owner through initialization. For each employee, the administrator first provisions the new principal and membership, then issues a one-time Person login grant to that exact existing membership. The employee completes OIDC binding and session creation. No grant creates or retargets a membership. Old principal, membership, grant, enrollment, installation, and session rows are omitted. |
| Organization Slack tool | issuer `https://slack.com`; founder-supplied workspace/enterprise, app, bot, bot-user, and channel IDs; required ordered scopes `channels:history`, `channels:read`, `chat:write`, `reactions:read`, `users:read`; opaque bot-credential reference | Run fresh organization-tool verification and activation, persist the new stable connection contract and current-state proof, then create new Person Slack links through link-only challenges. Copy no connection, attempt, external-link, audit, binding, capability, or credential row. |
| Meeting source | `granola` meeting-source adapter version `2.2.0`; founder-supplied instance; literal credential scope `organization`; normalizer contract/version; cutoff/cursor rule; custodian Person/membership; opaque source-credential reference | Install a fresh opaque organization-source credential, then run the stopped no-pull source activation against the current custodian. The first provider pull creates new candidate identity. Old cursor, candidate, owner binding, or pending bytes are omitted. |
| Decision processor | `llm` adapter version `1.3.0`; prompt `decision-extraction-v3`; schema `decision-extraction-schema-v4`; explicit provider `openrouter`; model `deepseek/deepseek-r1`; `max_output_tokens: 8192`; `request_timeout_ms: 600000`; founder-supplied instance; processor/configuration digests; opaque provider-credential reference | Activate this one explicit retained provider with no fallback. Install fresh credential bytes behind the reference. Old processor overlay, default-provider choice, candidate key, and model response are omitted. Changing any semantic input creates a new processor/configuration digest. |
| Approval | `slack-reactions` approval-surface adapter version `1.0.0`; founder-supplied instance and channel; reactions `white_check_mark` and `x`; provider connection; both v2 policy contracts and consequence bytes; presentation contract | An operator using the Authority administrator credential invokes the replacement approval-activation API and targets the exact current Person Slack link/membership. An owner Person session is not administrator authorization. The operation creates a new stable approval binding and separate approve/reject capabilities. Old installation ownership, grants, cards, pending work, and action audits are omitted. |
| Delivery | at least one configured delivery surface for enabled processing; initial live target uses `slack` version `1.0.0` with founder-supplied instance and destination plus opaque credential/connection reference | Configure the typed delivery-surface array in deterministic order. The Slack destination must differ from the approval channel. Every durable attempt/unknown/outcome/receipt store begins empty. Approval bindings and receipts are never reused as delivery authority. |
| Runtime and operations | exact artifact digest; config/overlay digests; state directory; listener; tunnel/service identity; proxy policy; backup/restore location; 30-day processing and D6 retention; D6 export `unsupported`; qualification mode | Render fresh config from these declarative fields, validate preflight while stopped, initialize, restart, rebuild the empty exact-head retrieval generation, and only then enable one listener/poller. Installation leases, browser-console state, query-audit exporters, legacy derived state, and old migration ledgers are deliberately omitted. |

The Phase-4 manifest must fill every public field in this table and replace
every opaque credential reference with a successfully installed reference,
never the credential bytes. A missing row or unresolved reference stops
initialization. This table is the Phase-0 declarative inventory; it is not
evidence that re-entry has already run.

### 4. Reset and no-dual-writer protocol

Acceptance approves this protocol but does not execute it:

1. Complete the replacement implementation, its accepted decision gates, the
   offline rehearsal, and the semantic parity gate before cutover.
2. At Phase 4, stop the old Authority and every poller, listener, tunnel, and
   process that can mutate its state or call a provider. Prove successful
   shutdown and singleton release before treating the state as stopped.
3. While stopped, validate the old recovery unit and create the fresh exact
   snapshot and artifact/state evidence required below. A failed shutdown,
   validation, or snapshot stops the cutover.
4. Move the complete old state out of every path the new artifact can open.
   Keep it immutable with its exact old artifact as the named rollback pair.
5. Initialize a different empty directory with new application, schema,
   envelope, audit, policy, and state-lineage versions. Copy no row, receipt,
   key, identity link, capability, audit entry, record, or retrieval
   generation into it.
6. Recreate the Authority/organization, owner, employees, Person identities,
   provider connections, source, processing, approval, delivery, and
   operational configuration through the accepted current commands and
   contracts.
7. Qualify the new lineage while the old artifact/state pair remains stopped.
   Enable the normal cycle only after the new artifact, manifests, record
   head, retrieval generation, and audit heads are recorded.

At no time may the old and new artifacts both own a listener, provider poller,
provider side-effect worker, record writer, or writable state handle. There is
no dual-write, shadow-write, row import, automatic upgrade, or mixed-lineage
mode.

### 5. Rollback protocol

Rollback is a whole-pair switch, never a data merge:

1. Stop the new artifact and every associated writer, listener, poller, and
   tunnel; preserve its state separately for diagnosis.
2. Prove the new singleton and all writable/provider-call paths are stopped.
3. Restore only the untouched stopped snapshot with the exact old artifact
   whose digest was recorded for it. New code never opens that snapshot.
4. Validate the restored old recovery unit while stopped, then start exactly
   one old Authority.
5. Record which external provider or delivery effects occurred after cutover.
   Never replay, merge, or pretend those effects are represented in the old
   state. If they make rollback semantically unsafe, remain stopped and obtain
   a new disposition.

The rollback pair is retained until the founder explicitly retires it after
the lean artifact is qualified. Retention of the pair does not make old state
part of the new runtime closure.

## Phase-4 execution evidence

This proposal deliberately separates Phase-0 authorization from destructive
execution evidence. Acceptance of this ADR does not assert that the following
evidence exists. Immediately before the Phase-4 cutover, with the Authority
stopped, the operator must produce and verify:

- successful shutdown evidence and proof that no writer, listener, poller,
  tunnel, provider-call worker, or writable handle remains;
- the exact old executable/container revision and immutable artifact digest;
- a complete state-role-to-path and state-lineage manifest for the stopped
  Authority, including supporting identity, key, credential, marker, and
  retrieval-generation files;
- stopped integrity, record-chain, derived-head, and active retrieval-
  generation verification appropriate to the old artifact;
- a fresh whole-state snapshot with per-file path, role, size, mode, and
  SHA-256, plus a deterministic manifest digest and archive digest;
- an exact declarative-configuration inventory, containing only public values,
  digests, and opaque secret references, checked against the Phase-0 inventory;
- a named immutable old artifact/state pair and the exact restore command or
  runbook that consumes only that pair;
- confirmation that the founder attestation still holds at cutover time and
  that no customer or irreplaceable state has since been introduced; and
- after initialization, the exact new artifact digest, new Authority,
  organization and lineage identifiers, database-role manifests, genesis,
  record head, retrieval generation, and audit heads.

Missing, stale, partially copied, internally inconsistent, or unbound evidence
stops Phase 4. An earlier backup, a running-filesystem copy, a digest without
the matching artifact, or a state archive without the role manifest cannot
satisfy this gate.

## Non-authorization and disposition

This proposed ADR does not authorize or perform a service stop, live-state
read, snapshot, deletion, credential rotation, provider call, deployment,
reset, re-onboarding, or cutover. The Phase-0 field/procedure inventory above
is complete; it does not claim the founder attestation has been made, the
deferred public values or opaque references have been filled in, or the
Phase-4 evidence has been produced.

Disposition remains pending. Acceptance requires the founder identity,
decision timestamp, exact ADR digest, the attestation above, and acceptance of
the complete secret-free field/procedure inventory with its Phase-4 value and
reference gates. Any edit after review requires a new digest and disposition.
