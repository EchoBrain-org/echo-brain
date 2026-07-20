# Federated Onboarding and Identity Layer — Accepted Direction and Founder Live Minimum

**Status:** Approved for implementation. ADR-FL-IDENTITY-001 through 014 are approved as written; ADR-FL-IDENTITY-015 is approved with the seed-grade amendment recorded below; ADR-FL-IDENTITY-016 is approved with the separate Slack publication/observation snapshots recorded below; ADR-FL-IDENTITY-017 is approved with the complete export verification closure recorded below.
**Date:** 2026-07-19
**Current-code baseline:** DEV.6 at `a8c8ddc`
**Scope:** Organization adoption, employee enrollment, machine and tool identity, record attribution, lifecycle failures, and the minimum identity facts required before trusted Founder Live records are created.

The founder has accepted the identity model, the three current-code findings, the federated-envelope approach, the separation between `OrgIngestReceipt` and `DeliveryReceipt`, and the Founder Live backfill boundary. This revision reduces that accepted direction to the smallest correct local implementation. Pre-cutover rehearsals are explicitly disposable and remain unblocked; the strict identity and protected-independent-copy gates begin only at the seed-grade cutover. It remains independent of the existing `FEDERATED-ONBOARDING-DESIGN.md` and does not silently reinterpret that document.

## Executive recommendation

Use a **federated-edge, centralized-identity** model:

```text
Employee's Echo Brain
  ├─ Granola credentials and raw meeting data remain local
  ├─ Core extracts decisions and actions
  ├─ Employee approves an exact record and audience
  └─ Signed approved records enter a durable sync outbox
                         │
                         ▼
Organization control plane
  ├─ Organization and membership registry
  ├─ Installation enrollment and revocation
  ├─ Tool-account identity bindings
  ├─ Record validation and deduplication
  └─ Organization-ingest receipts
                         │
                         ▼
Shared organization brain
  ├─ Accepted immutable records
  └─ Rebuildable search, embeddings, and LLM context
```

“Federated” should mean that processing and raw-source custody happen on employee machines. It should not mean that laptops establish organization identity, membership, or offboarding rules through peer consensus.

Every client organization needs one logical identity authority. It can eventually be Echo-hosted or customer-hosted, and its control plane and brain data plane can initially be one service.

## Current-code assessment

The current system has good local technical provenance:

- Adapter identity is `kind + adapter_id + instance_id + version`: [`adapter.ts`](../src/core/contracts/adapter.ts#L9).
- Meetings retain provider external IDs, canonical revisions, evidence blocks, participant claims, and governance fields: [`meeting.ts`](../src/core/contracts/meeting.ts#L66), [`meeting.ts`](../src/core/contracts/meeting.ts#L187), and [`meeting.ts`](../src/core/contracts/meeting.ts#L201).
- Local SQLite stores source cursors, canonical meetings, decision sets, approvals, processed markers, and delivery receipts: [`0002_core_state.sql`](../src/storage/migrations/0002_core_state.sql#L1).
- Installation records bind exact paths, config hash, executable, service, and product version: [`operator-lifecycle.ts`](../src/product/operator-lifecycle.ts#L70).
- Artifact installation separately establishes supply-chain identity for the exact product bytes.

It cannot yet durably answer:

- Which client organization owns a record?
- Which employee operated the installation?
- Which physical machine or Echo installation issued it?
- Which Granola account supplied the meeting?
- Which Slack workspace a user or channel belongs to?
- Which canonical organization member approved it?
- Whether records from two employee installations are duplicates, independent observations, or collisions?

### The immediate global-identity collision

The processing key currently contains:

```text
source adapter ID
source instance ID
provider external meeting ID
canonical revision
processor adapter ID
processor instance ID
processor version
```

It does not contain organization, member, installation, or provider-connection identity: [`run-core-cycle.ts`](../src/core/processing/run-core-cycle.ts#L111).

Because every employee may use the local label `granola/primary`, two installations can produce the same processing and approval identity for the same shared Granola note. The approval ID is then a hash of that local processing key: [`decision-node.ts`](../src/product/approval/decision-node.ts#L74).

Do not change the existing local key in place. Meeting IDs, signal IDs, approval IDs, delivery idempotency keys, and receipts cascade from the current identity. Changing it could make old work look new and repost deliveries. Add a globally scoped federated envelope around the existing local records.

### Adapter instances are configuration slots, not tool accounts

The shared adapter identity contains only:

```text
kind
adapter_id
instance_id
version
```

The `instance_id` is a locally chosen routing label. It is not a provider tenant, account, OAuth grant, employee, or organization integration.

This matters immediately for Granola. The current client proves that a token can call note endpoints, but it has no account or tenant discovery operation: [`granola-api-client.ts`](../src/adapters/meeting-sources/granola/granola-api-client.ts#L62). Replacing the token file while retaining the `primary` instance can silently reuse the prior account's cursor, processed markers, and cached decisions.

### Approval and delivery lack canonical actors

The core approval contract persists a mutable `reviewed_by` string: [`approval-gate.ts`](../src/core/approval/approval-gate.ts#L14). Slack approval additionally retains channel, message timestamp, and reviewer user ID in metadata, but not Slack workspace/team identity: [`slack-reactions-approval-surface.ts`](../src/adapters/approval-surfaces/slack-reactions/slack-reactions-approval-surface.ts#L463).

Slack's `auth.test` can return `team_id`, `user_id`, `bot_id`, and optionally `enterprise_id`, but the current client retains only `user_id`: [`slack-web-api-client.ts`](../src/adapters/shared/slack/slack-web-api-client.ts#L108).

The delivery envelope carries an approved brief and approval time, but not the reviewer or reason: [`delivery.ts`](../src/core/contracts/delivery.ts#L32). An organization importer that consumes only delivery output would lose approval attribution unless it also joins the local decision-node state.

### Meeting participants are observations

The meeting contract correctly says participant IDs are stable only within the meeting document: [`meeting.ts`](../src/core/contracts/meeting.ts#L82).

The Granola mapper creates participant aliases from provider IDs, normalized email, display-name hashes, or meeting-scoped diarization buckets. It may merge same-name participants inside one meeting: [`meeting-source-adapter.ts`](../src/adapters/meeting-sources/granola/meeting-source-adapter.ts#L365).

Those values are useful source evidence. They are not organization principals, memberships, or permission-bearing identities.

## Identity model

One identifier should answer one question.

| Identity              | What it represents                            | Important rule                                           |
| --------------------- | --------------------------------------------- | -------------------------------------------------------- |
| `organization_id`     | One client organization                       | Never derive it from a domain or Slack workspace         |
| `principal_id`        | One human or service within that organization | Organization-scoped; avoid cross-company person tracking |
| `membership_id`       | A particular employment or contract tenure    | New ID when somebody is rehired                          |
| `device_id`           | A registered machine/profile                  | Application-generated, not a hardware serial             |
| `installation_id`     | One Echo state root and enrollment            | Survives upgrades; replacement machine gets a new one    |
| `connection_id`       | One verified provider account or OAuth grant  | Credential rotation does not change identity             |
| `adapter_binding_id`  | One product capability using a connection     | Approval and delivery remain independently configurable  |
| `external_subject_id` | An observed external person/account           | Does not imply organization membership or access         |
| `event_id`            | One submission from an installation           | Globally unique transport and audit identity             |
| `record_id`           | One approved decision, action, or rationale   | Independent from a delivery destination                  |

### Organization

```text
Organization
  organization_id
  display_name
  status: provisioning | active | suspended | closed
  verified_domains[]
  identity_authorities[]
  policy_version
  data_region
  brain_ingest_endpoint
  created_at
```

Domains, names, IdPs, and Slack workspaces can change. The organization ID must not.

### Principal and membership

```text
OrgPrincipal
  principal_id
  organization_id
  kind: human | service
  status

OrgMembership
  membership_id
  organization_id
  principal_id
  type: owner | employee | contractor | advisor | service
  status: invited | active | suspended | ended
  valid_from
  valid_until?
  roles[]
  sponsor_membership_id?
```

Login identities are bindings, not primary keys:

```text
LoginBinding
  issuer
  subject
  principal_id
  verified_at
  revoked_at?
```

For OpenID Connect, `{issuer, subject}` is the stable identity. Email, phone, display name, and username can change or be reused and should not be primary identifiers. This follows [OpenID Connect Core's claim-stability model](https://openid.net/specs/openid-connect-core-1_0-18.html#ClaimStability).

A rehire can reuse a verified `principal_id`, but receives a new `membership_id`. Historical decisions remain attached to the old tenure.

### Machine and installation

```text
DeviceRegistration
  device_id
  organization_id
  assigned_membership_id
  class: managed | byod | service
  status: active | lost | retired | revoked
  posture_metadata?

InstallationEnrollment
  installation_id
  organization_id
  membership_id
  device_id?
  key_id
  public_key
  product_artifact_identity
  enrolled_at
  credential_expires_at
  status
```

Generate a different keypair for every installation. Protect the private key with the operating-system key store or Secure Enclave where available. Apple documents Secure Enclave keys as device-bound and usable without exposing the plaintext private key to the application: [Protecting keys with the Secure Enclave](https://developer.apple.com/documentation/Security/protecting-keys-with-the-secure-enclave).

Do not derive installation identity from hostname, macOS username, UID, hardware serial, config path, or `state_dir`. Those are operational attributes rather than durable identities.

An installation signature proves that the enrolled installation emitted certain bytes. It does not, by itself, prove human intent or that the record is true.

### Tool connections and adapter bindings

Bearer tokens are credentials, not identities. Separate the provider authorization from the product capability:

```text
ToolConnection
  connection_id
  organization_id
  owner: membership_id | organization service principal
  provider
  provider_tenant_id?
  provider_account_id?
  granted_scopes[]
  verification_method
  assurance: provider_verified | admin_attested | operator_attested | credential_observed
  credential_generation
  status: pending | active | reauth_required | revoked

AdapterBinding
  adapter_binding_id
  connection_id
  capability: meeting-source | approval-surface | delivery-surface
  adapter_id
  instance_id
  policy
```

This distinction preserves the current approval/delivery boundary:

- One Slack OAuth installation can establish the workspace connection.
- `slack-reactions` can be one approval binding.
- `slack` can be a separate delivery binding.
- They may share one underlying connection and token while remaining independently configured and authorized.

For Slack, retain at least:

```text
enterprise_id? + team_id + user_id
```

For the bot installation, also retain:

```text
team_id + app_id/bot_id
```

Slack documents these fields in [`auth.test`](https://docs.slack.dev/reference/methods/auth.test/).

For Granola, capture the strongest account or workspace identity its API can prove. If no reliable identity endpoint exists, record only `credential_observed` or an explicit `operator_attested`/`admin_attested` claim rather than treating token usability as identity proof.

If a token rotates and still identifies the same provider tenant and account, preserve `connection_id` and increment its credential generation. If it identifies a different account, stop, create a new connection, and begin a new cursor lineage.

### Observed participants and identity resolution

An attendee is not automatically an Echo user:

```text
ParticipantAlias
  alias_id
  source_observation_id
  meeting_participant_id
  observed_provider_claims[]
  display_data
  externality_claim
  resolution_status

IdentityResolution
  alias_id
  principal_id?
  status: proposed | verified | rejected | superseded
  method
  verifier
  recorded_at
```

Rules:

- Never create an organization member because an attendee has a company email.
- Never merge people across meetings solely by display name.
- Email may suggest a match but cannot establish it.
- Anonymous speakers remain meeting-scoped.
- Identity improvements append resolution events; they do not rewrite original meetings.
- Turning an external into an employee later must not retroactively grant access to historical restricted records.
- Free-text action owners and signal subjects remain unresolved aliases until explicitly linked.

## Federated organization record

The shared brain should not ingest a bare `DecisionBrief` or Slack delivery output. It needs a complete immutable envelope:

```text
FederatedRecordEnvelope
  schema_version
  event_id
  organization_id

  producer
    principal_id
    membership_id
    installation_id
    key_id
    sequence
    previous_event_hash?

  source
    adapter_binding_id
    provider_tenant_id?
    provider_account_id?
    external_meeting_id
    meeting_revision
    source_observation_id

  processor
    adapter identity
    model/config digest
    generated_at

  payload
    record_id
    kind: decision | action | rationale
    signal
    evidence blocks/quotes/hashes
    participant aliases

  approval
    approval_id
    approver_membership_id
    approval_adapter_binding_id
    raw provider actor identity
    reviewed_at
    reason
    approved_payload_digest

  publication
    audience
    sensitivity
    retention
    policy_version

  related_event_refs[]
  payload_digest
  signature
```

Use one organization record per approved decision, action, or rationale, all linked by a common approval identity and immutable approval snapshot. The minimum repeats that snapshot in each record; a future brain can materialize a parent approval event without rewriting signed records. Each record is then independently searchable, supersedable, permissionable, and attributable.

Keep these actors distinct:

- Installation that produced the record
- Member whose Granola connection supplied the meeting
- Meeting participants
- Processor/model that extracted the signal
- Human who approved it
- Person named as an action owner
- Destination that received it

They are frequently the same person during Founder Live but will not be in a multi-user organization.

### Delivery and organization acceptance are different receipts

Keep two receipt types:

```text
DeliveryReceipt
  Slack, terminal, Linear, or another delivery surface received the output

OrgIngestReceipt
  event_id
  status: accepted | duplicate | quarantined | rejected
  canonical_record_id?
  server_received_at
  policy_version
  reason?
  server_signature
```

A Slack delivery is not proof that the organization brain accepted a record. Because the approved-record envelope is immutable and normally exists before delivery finishes, later delivery receipts are separate related events rather than fields appended to the original envelope. They remain useful outcome evidence and can be joined to the accepted organization record.

The central brain stores accepted immutable records. Search tables, embeddings, summaries, and LLM context are derivative and rebuildable.

## Authority matrix

| Fact                                            | Authority                                               |
| ----------------------------------------------- | ------------------------------------------------------- |
| Organization, membership, roles, and revocation | Organization control plane, normally driven by IdP/SCIM |
| Installation origin                             | Enrollment credential plus installation signature       |
| Slack action                                    | Slack workspace, actor, and interaction identity        |
| Slack user mapped to employee                   | Verified external-account binding                       |
| Granola account/source                          | Verified or explicitly lower-assurance tool connection  |
| Exact meeting revision/evidence                 | Source adapter and stored provenance/hashes             |
| Exact approved snapshot                         | Local approval event                                    |
| Organization acceptance                         | Central ingest receipt                                  |
| Search result or LLM answer                     | Derived; never authoritative                            |

## Organization onboarding

When a client adopts Echo Brain:

1. An authorized administrator creates the organization and receives the immutable `organization_id`.
2. Echo verifies organizational authority through the company's IdP/domain or an explicit early-stage manual process.
3. Create the first principal and owner membership.
4. Establish recovery. For clients, require two administrators or a break-glass administrator.
5. Connect the identity authority:
   - OpenID Connect first
   - SCIM later for automated provisioning and offboarding
6. Define a baseline policy:
   - What stays local
   - What an approval sends to the organization brain
   - Default audience and sensitivity
   - Contractor expiration rules
   - External-participant treatment
   - Offline duration
   - Retention and deletion
   - Managed-device versus BYOD policy
7. Establish the organization brain endpoint and ingest keys.
8. Connect organization-owned services such as the Slack app.
9. Create separate approval and delivery adapter bindings.
10. Create a signed organization/policy manifest for employee enrollment.
11. Invite or provision memberships.

SCIM models administrative active/suspended status and employee/contractor-style user types, making it a suitable later provisioning input: [SCIM Core Schema](https://www.rfc-editor.org/info/rfc7643/).

## Employee onboarding

An employee setup should operate as follows:

1. Install and verify the signed Echo artifact.
2. Run `echo-brain join <organization>`.
3. Echo opens the system browser.
4. The employee signs in through the organization's IdP.
5. The control plane confirms an active membership.
6. Echo displays:
   - Organization name and immutable ID
   - Employee/principal and membership identity
   - What data remains local
   - What approved records will be shared
7. The installation creates its ID and local keypair.
8. The control plane registers the installation and issues short-lived credentials.
9. Persist non-secret identity metadata and credential references locally.
10. The employee connects Granola and other personal tools.
11. Echo calls provider identity endpoints and shows which account/workspace was actually connected.
12. Create verified or explicitly lower-assurance tool connections and adapter bindings.
13. Map the employee's Slack workspace/user identity to the membership.
14. Configure approval and delivery surfaces independently.
15. Select or accept an explicit default publication audience and classification.
16. Run `doctor` to validate enrollment, credential privacy, adapter bindings, and organization reachability.
17. Run a canary synchronization excluded from real organization memory.
18. Store the enrollment receipt locally and centrally.

For a desktop CLI, browser authorization-code flow with PKCE and a loopback redirect is the standard primary enrollment path: [RFC 8252](https://www.rfc-editor.org/info/rfc8252/). Device-code flow is a useful fallback for headless systems: [RFC 8628](https://www.rfc-editor.org/info/rfc8628/).

Use short-lived access tokens and either sender-constrained or rotating refresh tokens, following [OAuth 2.0 Security Best Current Practice](https://www.rfc-editor.org/info/rfc9700/).

For future multi-reviewer Slack approval, dynamically resolve the acting `(team_id, user_id)` to an active membership and check approval policy at the time of the action. A configured display name must never be the canonical actor. An unknown, suspended, or ambiguous actor leaves the approval pending.

## Synchronization and ingest

Each installation needs a durable organization-sync outbox separate from its Granola source cursor and Slack delivery receipts.

On sync, the organization ingest service validates:

- Organization ID
- Active membership
- Installation credential and signature
- Installation sequence and optional previous-event hash
- Active tool/adapter binding
- Schema and policy version
- Payload digest
- Record idempotency
- Publication audience and sensitivity

It then returns an `OrgIngestReceipt` and stores it locally. Repeated submissions return `duplicate` rather than creating another record.

For the same meeting captured by two employees, accept two source observations first:

```text
organization + adapter binding + provider external ID + revision
```

Then conservatively propose that they represent the same canonical meeting using provider/calendar identity, exact artifact hashes, and only then weaker time/title/participant fingerprints. Never discard either provenance chain or silently collapse two human approvals.

Raw transcripts and full source payloads should remain local by default. Sync approved signals plus bounded evidence. An organization can later opt into broader evidence retention through explicit policy.

## Lifecycle and failure behavior

### Employee departure

- End or suspend the membership; never delete the principal or historical membership.
- Revoke every installation credential, query session, and member-owned tool connection.
- Transfer or rotate organization-owned integrations where necessary.
- Reject future sync from ended memberships.
- Preserve historical records and attribution.
- Reassign open actions through new records rather than rewriting old records.
- Be explicit that Echo cannot remotely erase an offline BYOD machine without MDM or equivalent operational control.

### Rehire

Reuse the organization-local principal only after verification. Create a new membership tenure, issue new enrollment credentials, and reverify all tool bindings. Do not reactivate the old membership.

### Lost machine

- Mark the device/installation lost and revoke its credentials.
- Preserve records already accepted by the organization brain.
- Quarantine late submissions after the last trusted sequence unless independently corroborated.
- Enroll the replacement as a new installation with a new key.
- Never restore or copy the old private key.

### Planned machine replacement

If available, produce a signed handoff receipt, retire the old installation, and enroll the new one. The employee's membership remains unchanged. Tool credentials are reauthorized or securely transferred according to provider policy; installation identity is not transferred.

### Cloned state directory

A copied state root may contain the same installation identity. Diverging sequence or hash chains expose the fork. Quarantine the clone and require one copy to re-enroll with a new installation ID.

### Contractors

A contractor is an authorized, time-bounded membership—not merely an “external” email address.

Require:

- Explicit contractor membership type
- Sponsor
- Project/team scopes
- `valid_until`
- Shorter offline/enrollment leases
- Automatic expiration and revocation

Historical attribution remains after the contract ends.

### External meeting participants

Keep external participants as unresolved or externally resolved aliases. They receive no Echo membership and no organization-brain access. If an external later becomes an employee, append an audited identity-resolution link; do not rewrite historical provenance or grant access retroactively.

### Offline operation and offboarding

Permit local processing under a cached policy and short-lived enrollment lease. Offline records remain `pending_org_sync`, not shared organization facts.

On reconnect, validate membership, installation, tool binding, sequence, schema, and policy. Records from a revoked installation should be rejected or quarantined because a local laptop timestamp cannot reliably prove that work preceded revocation.

High-sensitivity organizations may require online approval or immediate sync. This is a deliberate trade-off between offline freedom and revocation strength.

### Credential rotates into another provider account

If provider tenant or account identity changes, stop the adapter and create a new connection and cursor lineage. Continuing under the old identity would corrupt provenance.

### Slack app reinstall or workspace change

If the workspace identity is unchanged, preserve the logical organization connection and record a new grant/credential generation plus new app/bot identifiers. If `team_id` or organization ownership changes, require a new connection.

### Multiple organizations

Use one organization enrollment per `state_dir` or profile. A single binary may operate multiple explicit profiles, but a pipeline must never route a record to an implicit or ambient organization.

If a record is accidentally addressed to the wrong organization, quarantine it. Never silently “move” it between organizations because that can become a cross-tenant disclosure.

## Founder Live boundary

The founder has decided that every record before the identity cutover is rehearsal data, not an organization-brain seed. Identity work therefore does not block continued pre-cutover Founder Live rehearsals. At the explicit cutover, the strict identity and independent-copy gates become mandatory, and every later seed-grade record must capture:

1. Stable organization anchor
2. Founder `principal_id` and `membership_id`
3. Stable `installation_id`
4. Stable Granola and Slack connection/binding IDs
5. Provider tenant/account identity, or an explicit lower assurance level
6. Slack workspace-scoped approval actor
7. Exact approved-snapshot digest, time, reason, and processor configuration
8. Explicit audience, sensitivity, retention, and policy version at approval
9. Source revision, evidence, and content hashes
10. Immutable schema and event identity

The genuinely non-backfillable facts are:

- Which provider account a rotated or deleted token represented
- Which organization member actually approved if only a mutable name survives
- What publication audience the human intended
- Exact evidence after a provider edits or deletes it
- Contemporaneous device or cryptographic attestation
- Membership and authorization state at the time of approval

A central server, PostgreSQL, SSO/SCIM automation, fleet dashboard, vector search, full RBAC, and MDM integration do not need to block Founder Live.

For existing DEV.6 records, use one of only two honest local classifications:

```text
disposable_test
legacy_imported_unverified
```

Use `legacy_imported_unverified` only where the record was already delivered and must be retained as historical local evidence. Neither class enters the future organization brain or the federated outbox. There is no retrospective promotion path.

Do not retroactively fill missing organization, installation, provider-account, approval-actor, or audience fields and present them as facts captured at the time.

If a central control plane does not exist yet, Founder Live can locally mint provisional opaque IDs for organization, principal, membership, installation, and connections. Preserve them during later registration through an explicit founder-bootstrap/import event. Label their assurance as self-attested until verified; do not silently replace or upgrade their historical assurance.

## Minimum solid foundation for continued Founder Live

This section is the near-term build boundary. It deliberately implements only the accepted “before continued Founder Live” gate for one organization, one founder installation, fewer than ten eventual people, and no server, IdP, SCIM, invitation service, or permission engine.

The minimum is not one database table per identity concept. It is:

```text
one atomic active-bundle pointer plus immutable local identity manifests
immutable versioned connection/binding registry snapshots
immutable versioned publication-policy files
one additive SQLite migration for source attribution + signed outbox
one export-bundle format
```

The existing runtime config, processing keys, meeting IDs, signal IDs, approval IDs, decision-node files, delivery envelopes, and delivery idempotency keys remain unchanged.

### Minimal instantiation of every accepted entity

| Accepted entity             | Founder Live instantiation                                                                                                | Why this is sufficient now                                                                                | Non-foreclosing upgrade path                                                                                                         |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Organization                | A distinct object and immutable `organization_id` inside the active immutable identity manifest; no table                 | There is exactly one organization per `state_dir`                                                         | Import the same ID and fields into a future organization registry; never remap historical envelopes                                  |
| Principal                   | A distinct object and immutable `principal_id` in the same manifest; no table                                             | The local profile represents one accountable human                                                        | Insert the same object into a future principal table and attach additional login claims                                              |
| Membership                  | A separate object and immutable `membership_id` in the same manifest; no table                                            | There is one active founder tenure, but tenure must remain distinct from the person                       | Insert the same membership as the first tenure; later suspension and rehire create lifecycle events/new memberships                  |
| Device                      | No standalone entity or lifecycle table; mint `device_id` and store device class as fields inside the installation object | The only current revocation unit is the installation                                                      | Extract those existing fields into `DeviceRegistration` when MDM, posture, or multiple installs per device exist                     |
| Installation                | A distinct object in the identity manifest plus a device-bound signing key referenced by `key_id`; no identity table      | Every promotable record needs an issuer that survives upgrades and differs on replacement machines        | Register the same installation/public key centrally; later key epochs can be separate rows without changing old envelopes            |
| Identity claim              | Nested claim records in the identity manifest, each with issuer, tenant, subject, method, assurance, and evidence digest  | Fewer than ten users do not need a claim database, but claim semantics must already be correct            | Move each claim unchanged into a future identity-claim table; an OIDC `{issuer, sub}` is another claim method, not a schema redesign |
| Tool connection             | Entries in the active immutable connection-registry revision; no table                                                    | There are only Granola and Slack connections, but credential/account continuity must be recorded now      | Import secret-free identity fields and immutable IDs/generations into a connection table; local credential guards never leave device |
| Adapter binding             | Top-level nested entries in the same connection registry, each retaining a distinct `adapter_binding_id`; no table        | Multiple Slack capabilities can share one connection, so binding and connection cannot be the same record | Extract bindings into their own table while preserving IDs and connection references                                                 |
| Participant alias           | No new local registry; embed the source participant ID and raw namespaced claims in each approved-record envelope         | Current `MeetingDocument` already preserves observation-level participants                                | The organization brain later materializes central alias rows from those preserved claims                                             |
| Identity resolution         | Does not exist yet; aliases are explicitly unresolved                                                                     | With one founder there is no safe local resolution authority and no permission use for it                 | Add append-only resolution events centrally; old source claims remain unchanged                                                      |
| Federated envelope          | One immutable signed row per approved signal in the new SQLite outbox                                                     | It is the portable unit that prevents later identity reconstruction                                       | Upload the exact bytes to a future ingest API; no rewrapping or ID migration                                                         |
| Delivery receipt            | The existing `DeliveryReceipt` and storage remain unchanged                                                               | Slack/terminal delivery already has its own idempotency and semantics                                     | Project later receipts as related federated events without mutating approved-record envelopes                                        |
| Organization-ingest receipt | Does not exist at all yet—only its future contract remains reserved                                                       | No server exists, so any local “accepted” receipt would be fictional                                      | Add a receipt table/client when an ingest authority exists; receipts reference existing `event_id` values                            |

Two apparently tempting collapses are forbidden even at this scale:

- `principal_id` and `membership_id` remain separate IDs even though they share one file. Otherwise a rehire or contractor tenure would force historical record rewrites.
- `connection_id` and `adapter_binding_id` remain separate IDs even though they share one registry. Otherwise one Slack OAuth installation could not safely support independently governed approval and delivery capabilities.

### Minimal state layout

All non-secret local identity state lives below the existing private `state_dir`:

```text
<state_dir>/
  identity/
    active-identity-bundle.v1.json
    manifests/
      identity-manifest.<manifest_id>.v1.json
    registries/
      connection-registry.<registry_id>.r<revision>.v1.json
    policies/
      publication-policy.<policy_id>.v<version>.json
  echo-brain.sqlite
```

The SQLite file receives only additive tables described below. No existing rows or primary keys are rewritten.

The installation private key does **not** live under `state_dir`, in runtime JSON, in SQLite, in a credential file, or in product backups. For this Founder Live slice it is generated by a provisioned app-like macOS helper as a Secure Enclave P-256 key in the data-protection keychain. There is no software fallback in the seed-grade path. The public key and actual `hardware_bound` assurance are stored in the identity manifest.

All identity files are direct regular files, mode `0600`, written atomically, validated with exact-key schemas, and covered by the existing whole-state backup. A restore on a replacement machine restores public identity and already signed envelopes but not the private key; `doctor` must then require a new installation enrollment before creating new native records.

### File 1: active bundle pointer plus write-once identity manifests

`active-identity-bundle.v1.json` is the one mutable pointer. It commits one coherent manifest, registry revision, and default policy. It is replaced atomically and signed by the installation it activates:

```json
{
  "schema_version": 1,
  "kind": "echo-active-identity-bundle",
  "manifest": {
    "manifest_id": "idm_4e617fc8-4df8-4e41-b4e6-3a57ec817f6a",
    "path": "manifests/identity-manifest.idm_4e617fc8-4df8-4e41-b4e6-3a57ec817f6a.v1.json",
    "sha256": "sha256:MANIFEST_DIGEST"
  },
  "connection_registry": {
    "registry_id": "reg_05c7c478-a47d-41d5-beb6-6a2ed8f0ab55",
    "revision": 3,
    "path": "registries/connection-registry.reg_05c7c478-a47d-41d5-beb6-6a2ed8f0ab55.r3.v1.json",
    "sha256": "sha256:REGISTRY_DIGEST"
  },
  "default_publication_policy": {
    "policy_id": "pol_805c94e8-51c9-4e3a-88ef-777a9d2626ef",
    "version": 1,
    "path": "policies/publication-policy.pol_805c94e8-51c9-4e3a-88ef-777a9d2626ef.v1.json",
    "sha256": "sha256:POLICY_DIGEST"
  },
  "active_installation_id": "ins_304f5ef4-bc72-48d2-9073-0eb694873130",
  "activated_at": "2026-07-19T20:10:00.000Z",
  "activation_reason": "founder-bootstrap",
  "integrity": {
    "canonicalization": "RFC8785",
    "payload_sha256": "sha256:ACTIVE_POINTER_DIGEST",
    "signature_algorithm": "ecdsa-p256-sha256-der-low-s",
    "key_id": "sha256:PUBLIC_KEY_FINGERPRINT",
    "signature_base64": "BASE64_SIGNATURE"
  }
}
```

Each `manifests/identity-manifest.<manifest_id>.v1.json` is one installation's immutable bootstrap/re-enrollment snapshot. It contains distinct objects, not a flattened “founder ID.” Illustrative shape:

```json
{
  "schema_version": 1,
  "kind": "echo-local-identity-manifest",
  "manifest_id": "idm_4e617fc8-4df8-4e41-b4e6-3a57ec817f6a",
  "predecessor_manifest_id": null,
  "created_at": "2026-07-19T20:00:00.000Z",
  "authority": {
    "kind": "local-founder-bootstrap",
    "assurance": "founder_attested"
  },
  "organization": {
    "organization_id": "org_a1f69299-dfd8-440a-b0bc-777a184ff265",
    "display_name": "EchoBrain",
    "created_at": "2026-07-19T20:00:00.000Z"
  },
  "principal": {
    "principal_id": "prn_8db1aa37-6b34-4204-9da1-d0221d5cc20d",
    "organization_id": "org_a1f69299-dfd8-440a-b0bc-777a184ff265",
    "kind": "human",
    "display_name": "zhenye"
  },
  "membership": {
    "membership_id": "mem_4b27987c-9ab7-46b9-933f-57cf338b9f91",
    "organization_id": "org_a1f69299-dfd8-440a-b0bc-777a184ff265",
    "principal_id": "prn_8db1aa37-6b34-4204-9da1-d0221d5cc20d",
    "type": "owner",
    "status": "active",
    "valid_from": "2026-07-19T20:00:00.000Z"
  },
  "installation": {
    "installation_id": "ins_304f5ef4-bc72-48d2-9073-0eb694873130",
    "organization_id": "org_a1f69299-dfd8-440a-b0bc-777a184ff265",
    "membership_id": "mem_4b27987c-9ab7-46b9-933f-57cf338b9f91",
    "device_id": "dev_80d84cdc-3652-4e91-bdb0-75f117d262c6",
    "device_class": "byod",
    "enrolled_at": "2026-07-19T20:00:00.000Z",
    "product": {
      "name": "echo-brain",
      "version": "0.0.0-dev.0",
      "source_sha": "a8c8ddc"
    },
    "signing_key": {
      "key_id": "sha256:PUBLIC_KEY_FINGERPRINT",
      "algorithm": "ecdsa-p256-sha256-der-low-s",
      "public_key_spki_der_base64": "BASE64_PUBLIC_KEY",
      "protection": "secure-enclave",
      "assurance": "hardware_bound"
    }
  },
  "identity_claims": [
    {
      "claim_id": "clm_fd142c91-5d5b-427c-9de7-6f9f7fd5b960",
      "principal_id": "prn_8db1aa37-6b34-4204-9da1-d0221d5cc20d",
      "issuer": {
        "kind": "provider",
        "provider": "slack",
        "tenant_id": "T123"
      },
      "subject": {
        "kind": "user",
        "id": "U123"
      },
      "verification": {
        "method": "slack_dm_challenge",
        "assurance": "provider_challenge_observed",
        "verified_at": "2026-07-19T20:05:00.000Z",
        "evidence_sha256": "sha256:CHALLENGE_EVIDENCE_DIGEST"
      }
    }
  ],
  "legacy_cutover": {
    "declared_at": "2026-07-19T20:10:00.000Z",
    "pre_cutover_default": "disposable_test",
    "native_records_require": [
      "source-attribution-v1",
      "processor-attribution-v1",
      "approval-context-v1",
      "signed-outbox-v1"
    ]
  },
  "integrity": {
    "canonicalization": "RFC8785",
    "payload_sha256": "sha256:MANIFEST_DIGEST",
    "signature_algorithm": "ecdsa-p256-sha256-der-low-s",
    "key_id": "sha256:PUBLIC_KEY_FINGERPRINT",
    "signature_base64": "BASE64_SIGNATURE"
  }
}
```

The signed payload is the RFC 8785 canonical JSON of every field except `integrity`. `payload_sha256` is SHA-256 of those bytes, and the installation key signs those same canonical bytes.

The Founder Live cryptographic profile is exact rather than implementation-defined:

- `key_id` is `sha256:` plus lowercase hexadecimal SHA-256 of the public key's SPKI DER bytes.
- macOS signs the canonical message bytes with `SecKeyAlgorithm.ecdsaSignatureMessageX962SHA256`; Echo does not prehash and then accidentally hash again.
- Signatures use strict X9.62 DER and canonical low-S form for the P-256 group. The helper normalizes generated high-S values and every verifier rejects non-minimal DER or high-S signatures, preventing a second valid signature encoding from creating a different `event_hash`.
- The exact RFC 8785 envelope bytes that were hashed and signed are the bytes stored in `envelope_json` and written to JSONL; read-time validation rejects structurally valid but noncanonical replacements.
- Only a Secure Enclave key is labeled `hardware_bound` and accepted for this seed-grade cutover. `platform_key_device_only` remains a reserved vocabulary value until a genuinely device-bound, non-exportable software implementation has independent platform proof; the product does not currently fall back to it.

Every manifest is write-once. A different machine or lost key creates a new manifest with a new installation/key and `predecessor_manifest_id`; it does not edit or delete the old installation identity. The active pointer then moves to the new manifest. Old manifests and per-installation SQLite chain heads stay available to verify historical envelopes. Future central enrollment registers these same provisional IDs or links them through an explicit import event.

This extra pointer is not an IAM registry. It is the minimum that avoids both a replacement-machine dead end and mixed bootstrap state: a singular fixed manifest filename would force either overwriting the old public key or abandoning the restored outbox, while three independently mutable “current” files could expose mismatched identity, connection, and policy after a crash. Before a central authority exists, re-enrollment is still founder-attested and must repeat the Slack challenge; the new signature cannot pretend to revoke or authorize the old installation centrally.

#### Why this does not foreclose OIDC

The claim model is already `issuer + tenant + subject + verification`. A future OIDC claim uses the same shape:

```json
{
  "claim_id": "clm_36c9f395-8173-48d7-a851-a8dc93967e50",
  "principal_id": "prn_8db1aa37-6b34-4204-9da1-d0221d5cc20d",
  "issuer": {
    "kind": "oidc",
    "issuer_uri": "https://idp.example.com"
  },
  "subject": {
    "kind": "oidc_sub",
    "id": "248289761001"
  },
  "verification": {
    "method": "oidc_id_token",
    "assurance": "provider_verified",
    "audience": "echo-control-plane-client-id",
    "authentication_time": "2027-01-01T00:00:00.000Z",
    "nonce_sha256": "sha256:OIDC_NONCE_DIGEST",
    "verified_at": "2027-01-01T00:00:00.000Z",
    "evidence_sha256": "sha256:VALIDATED_TOKEN_CLAIMS_DIGEST"
  }
}
```

No existing `principal_id`, `membership_id`, or historical envelope changes when OIDC is added. Because installation manifests are immutable, a later local claim is an append-only signed claim event—or, once available, a central claim row referencing the same principal—not an edit to the bootstrap manifest.

Assurance is typed by what is being asserted; it is not one misleading global score:

| Assertion                   | Minimum values                                                                     |
| --------------------------- | ---------------------------------------------------------------------------------- |
| Bootstrap authority         | `founder_attested`                                                                 |
| Human identity claim        | `provider_challenge_observed` or later `provider_verified`                         |
| Tool connection             | `provider_verified`, `credential_observed`, or `operator_attested`                 |
| Installation-key protection | `hardware_bound` or an explicitly lower platform-key assurance                     |
| Approval actor              | The assurance of the matched claim, or `installation_holder_self_attested` for CLI |

Adding a stronger claim later does not upgrade an older approval; each envelope retains the assurance available at its own approval time.

### File 2: immutable connection and binding registry revisions

Each `registries/connection-registry.<registry_id>.r<revision>.v1.json` is an immutable signed snapshot, not a credential vault. It keeps prior connection generations and retired bindings so a configuration change cannot silently acquire an old identity. Illustrative shape:

```json
{
  "schema_version": 1,
  "kind": "echo-local-connection-registry",
  "registry_id": "reg_05c7c478-a47d-41d5-beb6-6a2ed8f0ab55",
  "identity_manifest_id": "idm_4e617fc8-4df8-4e41-b4e6-3a57ec817f6a",
  "revision": 3,
  "previous_registry_sha256": "sha256:REVISION_2_REGISTRY_DIGEST",
  "updated_at": "2026-07-19T20:15:00.000Z",
  "connections": [
    {
      "connection_id": "con_12ae847b-86a7-4ad3-8618-0f08d7d4c153",
      "organization_id": "org_a1f69299-dfd8-440a-b0bc-777a184ff265",
      "owner": {
        "kind": "organization",
        "id": "org_a1f69299-dfd8-440a-b0bc-777a184ff265"
      },
      "provider": "slack",
      "generations": [
        {
          "generation": 1,
          "active_from": "2026-07-19T20:12:00.000Z",
          "ended_at": null,
          "provider_identity": {
            "tenant": {
              "kind": "slack-team",
              "id": "T123",
              "enterprise_id": null
            },
            "subject": {
              "kind": "bot-installation",
              "id": "U_BOT",
              "bot_id": "B123",
              "app_id": "A123"
            },
            "verification": {
              "method": "slack_auth_test",
              "assurance": "provider_verified",
              "verified_at": "2026-07-19T20:12:00.000Z",
              "evidence_sha256": "sha256:REDACTED_AUTH_TEST_RESPONSE_DIGEST"
            }
          },
          "local_credential_guard": {
            "reference": "file:/private/local/path/slack-bot-token",
            "algorithm": "sha256-salted",
            "salt_base64": "LOCAL_RANDOM_SALT",
            "digest": "sha256:LOCAL_ONLY_CREDENTIAL_DIGEST",
            "exportable": false
          }
        }
      ]
    }
  ],
  "bindings": [
    {
      "adapter_binding_id": "bnd_approval_0d5a",
      "capability": "approval-surface",
      "adapter_id": "slack-reactions",
      "instance_id": "founder-approval",
      "connection_id": "con_12ae847b-86a7-4ad3-8618-0f08d7d4c153",
      "connection_generation": 1,
      "configuration_snapshot": {
        "channel_id": "C123",
        "approve_reaction": "white_check_mark",
        "reject_reaction": "x"
      },
      "configuration_sha256": "sha256:REDACTED_CANONICAL_CONFIG_DIGEST",
      "created_at": "2026-07-19T20:13:00.000Z",
      "ended_at": null,
      "status": "active"
    },
    {
      "adapter_binding_id": "bnd_delivery_0f2c",
      "capability": "delivery-surface",
      "adapter_id": "slack",
      "instance_id": "team-decisions",
      "connection_id": "con_12ae847b-86a7-4ad3-8618-0f08d7d4c153",
      "connection_generation": 1,
      "configuration_snapshot": {
        "channel_id": "C123"
      },
      "configuration_sha256": "sha256:REDACTED_CANONICAL_CONFIG_DIGEST",
      "created_at": "2026-07-19T20:14:00.000Z",
      "ended_at": null,
      "status": "active"
    }
  ],
  "integrity": {
    "canonicalization": "RFC8785",
    "payload_sha256": "sha256:REGISTRY_DIGEST",
    "signature_algorithm": "ecdsa-p256-sha256-der-low-s",
    "key_id": "sha256:PUBLIC_KEY_FINGERPRINT",
    "signature_base64": "BASE64_SIGNATURE"
  }
}
```

A registry revision is never edited. An update writes the next revision, carrying closed lifecycle fields and the prior digest, then moves the active-bundle pointer last. Prior revision bytes remain available for verification. Old generations and bindings never acquire a different provider/config identity. Envelopes retain the exact active-generation snapshot used at observation/approval time.

`local_credential_guard` is private local drift-detection data and is omitted from all exports and envelopes. Its per-installation salt prevents the registry from becoming a stable cross-install credential correlator; the credential must still be high entropy. A later credential service can replace it with a keyed digest without changing `connection_id` semantics. No token or secret response is stored.

`configuration_sha256` covers an exact canonical, secret-free `configuration_snapshot` stored with the binding. That snapshot retains identity-relevant settings such as Slack channel, processor model, prompt/template version, and adapter configuration, while replacing credential material with its connection reference. A bare digest with no retained preimage would be insufficient future provenance.

Connection-change rules are conservative:

- A Slack credential change triggers `auth.test`. The same namespaced tenant/account creates a new generation of the same connection; a different tenant/account creates a new `connection_id` and new bindings.
- Granola currently exposes no trustworthy authenticated-account discovery. Its first successful capture proves only that one credential produced one source observation; it does **not** verify the human account owner. Record `provider_first_capture` with `credential_observed` assurance, keep provider subject unknown, and mint a new connection, source binding, source `instance_id`, and cursor lineage on credential-material change.
- A local processor such as Ollama has an adapter binding with `connection_id: null`. Its binding still freezes the model and redacted configuration digest. Changing those values creates a new binding; it does not change the existing core processing key.

The local adapter `instance_id` remains operational configuration, not provider identity. `primary` never means “the same Granola account.”

### File 3: immutable publication policy

The minimum needs one policy, but it must still be versioned and immutable. A policy change writes `publication-policy.<policy_id>.v<next-version>.json`; it never edits a policy version referenced by an approval.

```json
{
  "schema_version": 1,
  "kind": "echo-publication-policy",
  "policy_id": "pol_805c94e8-51c9-4e3a-88ef-777a9d2626ef",
  "organization_id": "org_a1f69299-dfd8-440a-b0bc-777a184ff265",
  "identity_manifest_id": "idm_4e617fc8-4df8-4e41-b4e6-3a57ec817f6a",
  "issued_by": {
    "installation_id": "ins_304f5ef4-bc72-48d2-9073-0eb694873130",
    "key_id": "sha256:PUBLIC_KEY_FINGERPRINT"
  },
  "version": 1,
  "effective_at": "2026-07-19T20:20:00.000Z",
  "publication": {
    "payload_scope": "approved-signal-with-meeting-context-brief-digest-and-bounded-evidence",
    "audience": {
      "scope": "organization",
      "subjects": [
        {
          "kind": "organization",
          "id": "org_a1f69299-dfd8-440a-b0bc-777a184ff265"
        }
      ]
    },
    "sensitivity": "internal",
    "retention": {
      "kind": "indefinite"
    },
    "raw_meeting_content": "local-only",
    "participant_observations": "included-namespaced"
  },
  "integrity": {
    "canonicalization": "RFC8785",
    "payload_sha256": "sha256:POLICY_DIGEST",
    "signature_algorithm": "ecdsa-p256-sha256-der-low-s",
    "key_id": "sha256:PUBLIC_KEY_FINGERPRINT",
    "signature_base64": "BASE64_SIGNATURE"
  }
}
```

This policy is publication intent, not legal or meeting consent. It must never be written into `MeetingGovernance.consent`, which concerns the meeting and its participants. If product-policy acceptance later needs legal evidentiary value, add a separate acceptance event.

The full `publication` object and its policy identity, signer, and digest are copied into the first immutable approval request. The Slack card must display every material publication field: payload scope, audience, sensitivity, retention, raw-meeting rule, and participant-observation rule. It also displays the canonical approved-object digest and provides the approval ID needed to inspect the complete stored brief. The captured card-block digest proves which presentation was rendered; Echo does not claim that a human read every JSON field. Approval authorizes the immutable object referenced by that presentation, and an administrator changing the default while a card is pending cannot change that card's meaning.

### Additive SQLite migration

The existing `<state_dir>/echo-brain.sqlite` remains the product database. A new migration adds only four tables; it does not alter any current table, row, primary key, cursor, or idempotency column.

```sql
CREATE TABLE federated_source_attributions (
  source_adapter_id TEXT NOT NULL,
  source_instance_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  meeting_revision TEXT NOT NULL,
  identity_manifest_id TEXT NOT NULL,
  adapter_binding_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  connection_generation INTEGER NOT NULL CHECK (connection_generation > 0),
  attribution_json TEXT NOT NULL CHECK (json_valid(attribution_json)),
  captured_at TEXT NOT NULL,
  PRIMARY KEY (
    source_adapter_id,
    source_instance_id,
    external_id,
    meeting_revision
  )
) STRICT;

CREATE TABLE federated_processor_attributions (
  source_adapter_id TEXT NOT NULL,
  source_instance_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  meeting_revision TEXT NOT NULL,
  processor_adapter_id TEXT NOT NULL,
  processor_instance_id TEXT NOT NULL,
  processor_version TEXT NOT NULL,
  identity_manifest_id TEXT NOT NULL,
  adapter_binding_id TEXT NOT NULL,
  attribution_json TEXT NOT NULL CHECK (json_valid(attribution_json)),
  captured_at TEXT NOT NULL,
  PRIMARY KEY (
    source_adapter_id,
    source_instance_id,
    external_id,
    meeting_revision,
    processor_adapter_id,
    processor_instance_id,
    processor_version
  )
) STRICT;

CREATE TABLE federated_chain_heads (
  installation_id TEXT PRIMARY KEY,
  last_sequence INTEGER NOT NULL CHECK (last_sequence >= 0),
  last_event_hash TEXT,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE federated_outbox_events (
  event_id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  event_type TEXT NOT NULL,
  local_subject_key TEXT NOT NULL,
  previous_event_hash TEXT,
  event_hash TEXT NOT NULL UNIQUE,
  envelope_json TEXT NOT NULL CHECK (json_valid(envelope_json)),
  created_at TEXT NOT NULL,
  UNIQUE (installation_id, sequence),
  UNIQUE (installation_id, event_type, local_subject_key)
) STRICT;

CREATE INDEX federated_outbox_events_type_sequence
  ON federated_outbox_events (event_type, installation_id, sequence);
```

`attribution_json` is the immutable public snapshot for that meeting revision:

```json
{
  "schema_version": 1,
  "kind": "echo-source-attribution",
  "source_observation_id": "obs_77f85f9e-662b-4bb7-89ec-94effaff57e4",
  "organization_id": "org_a1f69299-dfd8-440a-b0bc-777a184ff265",
  "identity_manifest_id": "idm_4e617fc8-4df8-4e41-b4e6-3a57ec817f6a",
  "source": {
    "adapter_binding_id": "bnd_granola_f0a2",
    "adapter": {
      "kind": "meeting-source",
      "adapter_id": "granola",
      "instance_id": "primary",
      "version": "2.2.0"
    },
    "configuration_snapshot": {
      "page_size": 100
    },
    "configuration_sha256": "sha256:SOURCE_CONFIG_DIGEST"
  },
  "connection": {
    "connection_id": "con_granola_76a1",
    "generation": 1,
    "owner": {
      "kind": "membership",
      "id": "mem_4b27987c-9ab7-46b9-933f-57cf338b9f91"
    },
    "provider": "granola",
    "provider_identity": {
      "tenant": null,
      "subject": null,
      "verification_method": "provider_first_capture",
      "assurance": "credential_observed"
    }
  },
  "meeting": {
    "external_id": "not_123",
    "canonical_revision": "rev_123",
    "document_sha256": "sha256:CANONICAL_MEETING_DOCUMENT_DIGEST"
  },
  "participant_observations": [
    {
      "meeting_participant_id": "not_123:participant:1",
      "display_name": "Timothy Finkelbinder",
      "observed_claims": [
        {
          "namespace": "provider:granola:con_granola_76a1",
          "kind": "source",
          "value": "granola-person-123"
        },
        {
          "namespace": "internet:rfc5322-email",
          "kind": "email",
          "value": "timothy@example.com"
        }
      ]
    }
  ],
  "captured_by": {
    "product_version": "CURRENT_PRODUCT_VERSION",
    "source_sha": "CURRENT_SOURCE_SHA",
    "artifact_sha256": "sha256:CURRENT_ARTIFACT_DIGEST"
  },
  "captured_at": "2026-07-19T20:25:00.000Z"
}
```

`processor_attribution_json` freezes extraction-time provenance rather than looking up whatever processor happens to be configured when approval is later requested:

```json
{
  "schema_version": 1,
  "kind": "echo-processor-attribution",
  "identity_manifest_id": "idm_4e617fc8-4df8-4e41-b4e6-3a57ec817f6a",
  "meeting": {
    "source_adapter_id": "granola",
    "source_instance_id": "primary",
    "external_id": "not_123",
    "meeting_revision": "rev_123"
  },
  "processor": {
    "adapter_binding_id": "bnd_processor_3df1",
    "adapter": {
      "kind": "decision-processor",
      "adapter_id": "llm",
      "instance_id": "ollama-qwen3-4b",
      "version": "1.0.0"
    },
    "configuration_snapshot": {
      "model": "qwen3:4b",
      "prompt_version": "decision-extraction-v1"
    },
    "configuration_sha256": "sha256:PROCESSOR_CONFIG_DIGEST",
    "decision_set_sha256": "sha256:CANONICAL_DECISION_SET_DIGEST"
  },
  "produced_by": {
    "product_version": "CURRENT_PRODUCT_VERSION",
    "source_sha": "CURRENT_SOURCE_SHA",
    "artifact_sha256": "sha256:CURRENT_ARTIFACT_DIGEST"
  },
  "captured_at": "2026-07-19T20:29:00.000Z"
}
```

SQLite's `json_valid()` is only a corruption/syntax guard. Every write, read, projection, and export also validates the applicable exact-key versioned schema and, for signed/event JSON, verifies that stored bytes are the RFC 8785 canonical form. Unknown keys require a future schema version rather than being silently ignored.

There are intentionally no organization, principal, membership, device, connection, alias, resolution, delivery-receipt, or ingest-receipt tables yet. Their minimal forms either live in the immutable identity-bundle files, remain existing product state, or do not yet exist.

Source attribution is captured when a meeting revision is first persisted—not reconstructed during export. The same decorator captures processor attribution when a `DecisionSet` is first saved. For each save, it canonicalizes the document/set, preflights or inserts the matching sidecar **before** delegating to the existing upsert. Replaying identical bytes/facts is idempotent; a different document digest or attribution for an existing natural key fails before the existing row can be overwritten. If the sidecar succeeds but the delegated save crashes, retry safely completes the underlying row. Either failure stops cursor advancement.

A cached or pre-cutover `DecisionSet` with no matching processor sidecar is structurally legacy and cannot acquire the currently configured processor identity. To re-extract it natively, the operator creates a new processor binding and, where required by the existing cache identity, a new adapter instance/version; the processing-key algorithm itself remains untouched.

Likewise, a new provider account must use a new connection, source binding, source `instance_id`, and cursor lineage. If an unrelated account is configured under an old instance and reuses the same `(external_id, revision)`, the sidecar collision quarantines it instead of overwriting attribution.

### Approval-time snapshots

The decision-node event files already provide immutable `metadata` objects. Use that open namespace without changing `approval_id`, `node_id`, or `processing_key`.

The first `requested.json` stores:

Its top-level `identity_manifest_id` is the approval-time identity manifest. The referenced source and processor sidecars retain their own capture-time manifest IDs. Those IDs may differ after a verified rotation, but every one must resolve through the same active predecessor lineage and organization.

```json
{
  "metadata": {
    "federation": {
      "schema_version": 1,
      "identity_manifest_id": "idm_4e617fc8-4df8-4e41-b4e6-3a57ec817f6a",
      "source_attribution_ref": {
        "source_adapter_id": "granola",
        "source_instance_id": "primary",
        "external_id": "not_123",
        "meeting_revision": "rev_123",
        "attribution_sha256": "sha256:SOURCE_ATTRIBUTION_DIGEST"
      },
      "processor": {
        "adapter_binding_id": "bnd_processor_3df1",
        "adapter": {
          "kind": "decision-processor",
          "adapter_id": "llm",
          "instance_id": "ollama-qwen3-4b",
          "version": "1.0.0"
        },
        "configuration_snapshot": {
          "model": "qwen3:4b",
          "prompt_version": "decision-extraction-v1"
        },
        "configuration_sha256": "sha256:PROCESSOR_CONFIG_DIGEST",
        "attribution_sha256": "sha256:PROCESSOR_ATTRIBUTION_DIGEST"
      },
      "approval_surface": {
        "binding": {
          "adapter_binding_id": "bnd_approval_0d5a",
          "adapter": {
            "kind": "approval-surface",
            "adapter_id": "slack-reactions",
            "instance_id": "founder-approval",
            "version": "1.0.0"
          },
          "configuration_snapshot": {
            "channel_id": "C123",
            "approve_reaction": "white_check_mark",
            "reject_reaction": "x"
          },
          "configuration_sha256": "sha256:APPROVAL_CONFIG_DIGEST"
        },
        "connection": {
          "connection_id": "con_12ae847b-86a7-4ad3-8618-0f08d7d4c153",
          "generation": 1,
          "owner": {
            "kind": "organization",
            "id": "org_a1f69299-dfd8-440a-b0bc-777a184ff265"
          },
          "provider_identity": {
            "provider": "slack",
            "team_id": "T123",
            "enterprise_id": null,
            "bot_user_id": "U_BOT",
            "bot_id": "B123",
            "app_id": "A123"
          }
        }
      },
      "publication": {
        "policy_id": "pol_805c94e8-51c9-4e3a-88ef-777a9d2626ef",
        "version": 1,
        "policy_sha256": "sha256:POLICY_DIGEST",
        "identity_manifest_id": "idm_4e617fc8-4df8-4e41-b4e6-3a57ec817f6a",
        "signer_installation_id": "ins_304f5ef4-bc72-48d2-9073-0eb694873130",
        "signer_key_id": "sha256:PUBLIC_KEY_FINGERPRINT",
        "payload_scope": "approved-signal-with-meeting-context-brief-digest-and-bounded-evidence",
        "audience": {
          "scope": "organization",
          "subjects": [
            {
              "kind": "organization",
              "id": "org_a1f69299-dfd8-440a-b0bc-777a184ff265"
            }
          ]
        },
        "sensitivity": "internal",
        "retention": {
          "kind": "indefinite"
        },
        "raw_meeting_content": "local-only",
        "participant_observations": "included-namespaced"
      },
      "candidate_context_sha256": "sha256:BRIEF_PROCESSOR_POLICY_SURFACE_DIGEST"
    }
  }
}
```

The immutable Slack `published-*.json` reference adds the actual presentation and publishing tool generation:

```json
{
  "reference": {
    "slack": {
      "channel_id": "C123",
      "message_ts": "1752956990.000100"
    },
    "federation": {
      "candidate_context_sha256": "sha256:BRIEF_PROCESSOR_POLICY_SURFACE_DIGEST",
      "rendered_blocks_sha256": "sha256:EXACT_SLACK_BLOCKS_DIGEST",
      "published_via": {
        "adapter_binding_id": "bnd_approval_0d5a",
        "connection_id": "con_12ae847b-86a7-4ad3-8618-0f08d7d4c153",
        "connection_generation": 1,
        "configuration_sha256": "sha256:APPROVAL_CONFIG_DIGEST",
        "provider_identity_sha256": "sha256:SLACK_BOT_IDENTITY_DIGEST"
      }
    }
  }
}
```

The immutable `resolved.json` stores the actor snapshot under the same namespace:

```json
{
  "metadata": {
    "federation": {
      "actor": {
        "principal_id": "prn_8db1aa37-6b34-4204-9da1-d0221d5cc20d",
        "membership_id": "mem_4b27987c-9ab7-46b9-933f-57cf338b9f91",
        "claim_id": "clm_fd142c91-5d5b-427c-9de7-6f9f7fd5b960",
        "raw_assertion": {
          "surface": "slack",
          "issuer": {
            "provider": "slack",
            "tenant_id": "T123"
          },
          "subject_id": "U123",
          "display_name": "zhenye",
          "channel_id": "C123",
          "message_ts": "1752956990.000100",
          "action": {
            "kind": "reaction",
            "name": "white_check_mark",
            "provider_occurred_at": null,
            "observed_at": "2026-07-19T20:30:00.000Z"
          },
          "reason_reply": {
            "message_ts": "1752956980.000090",
            "author_subject_id": "U123",
            "text_sha256": "sha256:REASON_TEXT_DIGEST"
          }
        },
        "assurance": "provider_challenge_observed"
      },
      "approval_context": {
        "candidate_context_sha256": "sha256:BRIEF_PROCESSOR_POLICY_SURFACE_DIGEST",
        "presentation": {
          "channel_id": "C123",
          "message_ts": "1752956990.000100",
          "rendered_blocks_sha256": "sha256:EXACT_SLACK_BLOCKS_DIGEST"
        },
        "approved_context_sha256": "sha256:CANDIDATE_PLUS_PRESENTATION_DIGEST"
      },
      "approval_surface_observation": {
        "adapter_binding_id": "bnd_approval_0d5a",
        "connection_id": "con_12ae847b-86a7-4ad3-8618-0f08d7d4c153",
        "connection_generation": 1,
        "configuration_sha256": "sha256:APPROVAL_CONFIG_DIGEST",
        "provider_identity_sha256": "sha256:SLACK_BOT_IDENTITY_DIGEST",
        "observed_by": {
          "product_version": "CURRENT_PRODUCT_VERSION",
          "source_sha": "CURRENT_SOURCE_SHA",
          "artifact_sha256": "sha256:CURRENT_ARTIFACT_DIGEST"
        }
      }
    }
  }
}
```

For Slack, the authoritative raw actor is the namespaced `(team_id, user_id)`, and it must match a verified identity claim before a native record can be projected. The existing `reviewed_by` remains an unchanged human-readable field.

Slack reactions do not provide an action timestamp. The existing `reviewed_at` is therefore the local durable observation time, while `provider_occurred_at` remains `null`; Echo must not present it as the exact instant the human clicked. When a reason exists, retain its reply timestamp, namespaced author, text digest, and copied reason text.

`candidate_context_sha256` hashes the exact `{brief, source attribution digest, processor attribution, publication snapshot, intended approval surface}`. `approved_context_sha256` hashes that candidate digest plus the immutable published message reference and rendered-block digest. If publishing and reaction observation used different credential generations, both safe snapshots are retained; they must resolve to the same verified Slack connection identity or the card stays pending.

CLI approval remains available for Founder Live recovery and testing. Its free-form `--reviewer` value is not an identity claim: the resolution snapshot binds the action to the local installation's founder membership and labels it `installation_holder_self_attested`. It must never be upgraded later to Slack- or OIDC-verified.

A record is eligible for `native_attributed` projection only when its source and processor sidecars, requested candidate metadata, published presentation/tool reference, and resolved actor/tool metadata all exist and reference the same organization/manifest lineage. Timestamp alone is never enough.

Rotation is allowed between those stages. The signed event therefore records both `identity_manifest_id` and `identity_manifest_sha256` inside its source and processor snapshots, while the event-level `identity_manifest_sha256` binds the approval/producer manifest. For example, source A, processor B, and approval/producer C are valid only when A → B → C is one verified predecessor lineage in one organization; the exact A, B, and C bytes all become part of the export verification closure.

### Versioned federated record envelope

The minimum emits one immutable event per approved decision, action, or rationale. It does not add a separate parent-approval event: every signal event carries its own exact signal, the approved-brief digest/signal manifest, and the approval snapshot, while `approval_id` groups them. A future brain can materialize a parent approval row without changing the signed bytes.

```json
{
  "schema_version": 1,
  "kind": "echo-federated-event",
  "event_type": "approved-org-record",
  "event_id": "evt_dbb39573-c938-46d2-b859-a3f207534bb5",
  "organization_id": "org_a1f69299-dfd8-440a-b0bc-777a184ff265",
  "sequence": 1,
  "previous_event_hash": null,
  "occurred_at": "2026-07-19T20:30:00.000Z",
  "producer": {
    "principal_id": "prn_8db1aa37-6b34-4204-9da1-d0221d5cc20d",
    "membership_id": "mem_4b27987c-9ab7-46b9-933f-57cf338b9f91",
    "installation_id": "ins_304f5ef4-bc72-48d2-9073-0eb694873130",
    "key_id": "sha256:PUBLIC_KEY_FINGERPRINT",
    "membership_assertion": {
      "status": "active",
      "authority": "local-founder-bootstrap",
      "assurance": "founder_attested"
    },
    "product_artifact": {
      "product_version": "CURRENT_PRODUCT_VERSION",
      "source_sha": "CURRENT_SOURCE_SHA",
      "artifact_sha256": "sha256:CURRENT_ARTIFACT_DIGEST"
    }
  },
  "source": {
    "identity_manifest_id": "idm_SOURCE_CAPTURE_MANIFEST",
    "identity_manifest_sha256": "sha256:SOURCE_CAPTURE_MANIFEST_DIGEST",
    "binding": {
      "adapter_binding_id": "bnd_granola_f0a2",
      "adapter": {
        "kind": "meeting-source",
        "adapter_id": "granola",
        "instance_id": "primary",
        "version": "2.2.0"
      },
      "configuration_snapshot": {
        "page_size": 100
      },
      "configuration_sha256": "sha256:SOURCE_CONFIG_DIGEST"
    },
    "connection": {
      "connection_id": "con_granola_76a1",
      "generation": 1,
      "owner": {
        "kind": "membership",
        "id": "mem_4b27987c-9ab7-46b9-933f-57cf338b9f91"
      },
      "provider_identity": {
        "provider": "granola",
        "tenant": null,
        "subject": null,
        "verification_method": "provider_first_capture",
        "assurance": "credential_observed"
      }
    },
    "meeting": {
      "external_id": "not_123",
      "revision": "rev_123",
      "source_observation_id": "obs_77f85f9e-662b-4bb7-89ec-94effaff57e4",
      "document_sha256": "sha256:CANONICAL_MEETING_DOCUMENT_DIGEST"
    },
    "participant_observations": [
      {
        "meeting_participant_id": "not_123:participant:1",
        "display_name": "Timothy Finkelbinder",
        "observed_claims": [
          {
            "namespace": "provider:granola:con_granola_76a1",
            "kind": "source",
            "value": "granola-person-123"
          },
          {
            "namespace": "internet:rfc5322-email",
            "kind": "email",
            "value": "timothy@example.com"
          }
        ]
      }
    ],
    "attribution_sha256": "sha256:SOURCE_ATTRIBUTION_DIGEST",
    "observed_by": {
      "product_version": "CURRENT_PRODUCT_VERSION",
      "source_sha": "CURRENT_SOURCE_SHA",
      "artifact_sha256": "sha256:CURRENT_ARTIFACT_DIGEST"
    }
  },
  "processor": {
    "identity_manifest_id": "idm_PROCESSOR_CAPTURE_MANIFEST",
    "identity_manifest_sha256": "sha256:PROCESSOR_CAPTURE_MANIFEST_DIGEST",
    "adapter_binding_id": "bnd_processor_3df1",
    "adapter": {
      "kind": "decision-processor",
      "adapter_id": "llm",
      "instance_id": "ollama-qwen3-4b",
      "version": "1.0.0"
    },
    "configuration_snapshot": {
      "model": "qwen3:4b",
      "prompt_version": "decision-extraction-v1"
    },
    "configuration_sha256": "sha256:PROCESSOR_CONFIG_DIGEST",
    "attribution_sha256": "sha256:PROCESSOR_ATTRIBUTION_DIGEST",
    "decision_set_sha256": "sha256:CANONICAL_DECISION_SET_DIGEST",
    "generated_at": "2026-07-19T20:29:00.000Z",
    "produced_by": {
      "product_version": "CURRENT_PRODUCT_VERSION",
      "source_sha": "CURRENT_SOURCE_SHA",
      "artifact_sha256": "sha256:CURRENT_ARTIFACT_DIGEST"
    }
  },
  "local_reference": {
    "processing_key": "CURRENT_UNCHANGED_PROCESSING_KEY",
    "approval_id": "CURRENT_UNCHANGED_APPROVAL_ID",
    "node_id": "CURRENT_UNCHANGED_NODE_ID",
    "meeting_id": "granola:primary:not_123",
    "signal_id": "action:sha256:CURRENT_UNCHANGED_SIGNAL_ID"
  },
  "record": {
    "record_id": "rec_6d4d8998-67ef-46ee-bb0a-46aa7e8cf51d",
    "kind": "action",
    "signal_id": "action:sha256:CURRENT_UNCHANGED_SIGNAL_ID",
    "signal": {
      "id": "action:sha256:CURRENT_UNCHANGED_SIGNAL_ID",
      "kind": "action",
      "text": "Prepare the migration plan",
      "subject": null,
      "owner": null,
      "due_at": null,
      "confidence": 0.92,
      "evidence": [
        {
          "meeting_id": "granola:primary:not_123",
          "block_id": "not_123:summary",
          "quote": "Prepare the migration plan"
        }
      ]
    },
    "meeting_context": {
      "id": "granola:primary:not_123",
      "title": "Migration planning",
      "participants": [
        {
          "id": "not_123:participant:1",
          "display_name": "Timothy Finkelbinder",
          "identities": [
            {
              "kind": "source",
              "value": "granola-person-123"
            }
          ]
        }
      ]
    },
    "approval_group": {
      "brief_schema_version": 1,
      "brief_id": "CURRENT_UNCHANGED_BRIEF_ID",
      "approved_brief_sha256": "sha256:APPROVED_BRIEF_DIGEST",
      "signal_manifest": [
        {
          "signal_id": "action:sha256:CURRENT_UNCHANGED_SIGNAL_ID",
          "kind": "action",
          "position_within_kind": 0,
          "sha256": "sha256:CANONICAL_SIGNAL_DIGEST"
        }
      ]
    }
  },
  "approval": {
    "surface": {
      "binding": {
        "adapter_binding_id": "bnd_approval_0d5a",
        "adapter": {
          "kind": "approval-surface",
          "adapter_id": "slack-reactions",
          "instance_id": "founder-approval",
          "version": "1.0.0"
        },
        "configuration_snapshot": {
          "channel_id": "C123",
          "approve_reaction": "white_check_mark",
          "reject_reaction": "x"
        },
        "configuration_sha256": "sha256:APPROVAL_CONFIG_DIGEST"
      },
      "connection": {
        "connection_id": "con_12ae847b-86a7-4ad3-8618-0f08d7d4c153",
        "generation": 1,
        "owner": {
          "kind": "organization",
          "id": "org_a1f69299-dfd8-440a-b0bc-777a184ff265"
        },
        "provider_identity": {
          "provider": "slack",
          "team_id": "T123",
          "enterprise_id": null,
          "bot_user_id": "U_BOT",
          "bot_id": "B123",
          "app_id": "A123"
        }
      },
      "presentation": {
        "channel_id": "C123",
        "message_ts": "1752956990.000100",
        "rendered_blocks_sha256": "sha256:EXACT_SLACK_BLOCKS_DIGEST"
      }
    },
    "observation": {
      "binding": {
        "adapter_binding_id": "bnd_approval_8f21",
        "adapter": {
          "kind": "approval-surface",
          "adapter_id": "slack-reactions",
          "instance_id": "founder-approval",
          "version": "1.0.0"
        },
        "configuration_snapshot": {
          "channel_id": "C123",
          "approve_reaction": "white_check_mark",
          "reject_reaction": "x"
        },
        "configuration_sha256": "sha256:APPROVAL_CONFIG_DIGEST"
      },
      "connection": {
        "connection_id": "con_12ae847b-86a7-4ad3-8618-0f08d7d4c153",
        "generation": 2,
        "owner": {
          "kind": "organization",
          "id": "org_a1f69299-dfd8-440a-b0bc-777a184ff265"
        },
        "provider_identity": {
          "provider": "slack",
          "team_id": "T123",
          "enterprise_id": null,
          "bot_user_id": "U_BOT",
          "bot_id": "B123",
          "app_id": "A123"
        }
      },
      "observed_by": {
        "product_version": "CURRENT_PRODUCT_VERSION",
        "source_sha": "CURRENT_SOURCE_SHA",
        "artifact_sha256": "sha256:CURRENT_ARTIFACT_DIGEST"
      }
    },
    "approver": {
      "principal_id": "prn_8db1aa37-6b34-4204-9da1-d0221d5cc20d",
      "membership_id": "mem_4b27987c-9ab7-46b9-933f-57cf338b9f91",
      "claim_id": "clm_fd142c91-5d5b-427c-9de7-6f9f7fd5b960"
    },
    "raw_actor_assertion": {
      "provider": "slack",
      "tenant_id": "T123",
      "subject_id": "U123",
      "display_name": "zhenye",
      "channel_id": "C123",
      "message_ts": "1752956990.000100",
      "action": {
        "kind": "reaction",
        "name": "white_check_mark",
        "provider_occurred_at": null,
        "observed_at": "2026-07-19T20:30:00.000Z"
      },
      "reason_reply": {
        "message_ts": "1752956980.000090",
        "author_subject_id": "U123",
        "text_sha256": "sha256:REASON_TEXT_DIGEST"
      }
    },
    "assurance": "provider_challenge_observed",
    "reviewed_at": "2026-07-19T20:30:00.000Z",
    "reason": "Matches the agreed next step",
    "approved_brief_sha256": "sha256:APPROVED_BRIEF_DIGEST",
    "approved_context_sha256": "sha256:CANDIDATE_PLUS_PRESENTATION_DIGEST"
  },
  "publication": {
    "policy_id": "pol_805c94e8-51c9-4e3a-88ef-777a9d2626ef",
    "version": 1,
    "policy_sha256": "sha256:POLICY_DIGEST",
    "identity_manifest_id": "idm_4e617fc8-4df8-4e41-b4e6-3a57ec817f6a",
    "signer_installation_id": "ins_304f5ef4-bc72-48d2-9073-0eb694873130",
    "signer_key_id": "sha256:PUBLIC_KEY_FINGERPRINT",
    "payload_scope": "approved-signal-with-meeting-context-brief-digest-and-bounded-evidence",
    "audience": {
      "scope": "organization",
      "subjects": [
        {
          "kind": "organization",
          "id": "org_a1f69299-dfd8-440a-b0bc-777a184ff265"
        }
      ]
    },
    "sensitivity": "internal",
    "retention": {
      "kind": "indefinite"
    },
    "raw_meeting_content": "local-only",
    "participant_observations": "included-namespaced"
  },
  "classification": "native_attributed",
  "identity_manifest_sha256": "sha256:MANIFEST_DIGEST",
  "integrity": {
    "canonicalization": "RFC8785",
    "payload_sha256": "sha256:EVENT_PAYLOAD_DIGEST",
    "signature_algorithm": "ecdsa-p256-sha256-der-low-s",
    "key_id": "sha256:PUBLIC_KEY_FINGERPRINT",
    "signature_base64": "BASE64_SIGNATURE"
  }
}
```

The `record` carries only its own signal, bounded evidence, shared meeting context, the exact approved-brief digest, and an ordered manifest of sibling signal digests. It does not repeat sibling decision/action/rationale content. A complete export can reconstruct and verify the original brief from all records in the approval group, while a later permissioned query can disclose one record without disclosing sibling text.

Founder Live applies one audience/sensitivity snapshot to every sibling in an approval group. A future brain may narrow access per record but may never widen it beyond the signed publication snapshot without a new authorization event.

The future organization brain treats `event_id` and `record_id` as global identity. It never treats the deliberately unchanged local `processing_key` or `approval_id` as globally unique across installations.

The producer's membership assertion preserves what authority existed locally at event time without overstating it: before a control plane, “active” is founder-attested rather than centrally authorized. A future ingest authority evaluates the signed assertion against its own membership and revocation history and records that result only in `OrgIngestReceipt`.

The envelope contains no provider token, credential reference/guard, raw transcript, complete source payload, or sibling signal body. It carries the approved signal, bounded evidence, unresolved namespaced participant observations, and complete safe source/processor/approval/publication attribution snapshots.

For an `approved-org-record`, `occurred_at` is the existing resolution's local durable `reviewed_at` observation time. The outbox table's `created_at` is separately the later projector/signing transaction time. Neither field is silently substituted for a missing Slack reaction timestamp.

The projection/signing transaction covers one complete approval group:

1. Start `BEGIN IMMEDIATE` and read the installation chain head.
2. Sort the approved signals by canonical kind/position and reserve one contiguous sequence per signal.
3. For each signal, set the preceding event hash, canonicalize every field except `integrity`, hash and sign those bytes, then define `event_hash` as SHA-256 of the full canonical low-S signed envelope.
4. Insert every signal event and update the chain head to the last event in the same transaction.
5. Commit only when the whole group validates; a crash exposes either none or all of that approval's records.

`local_subject_key` is `approved-org-record:<approval_id>:<signal_id>`. Its uniqueness makes projector retries return the original event instead of allocating a second sequence or signature.

The chain detects missing history and clones only when it is compared with a previously trusted head, an independent export, or a future organization receipt. With no server, it cannot prevent local deletion, prove a laptop timestamp preceded revocation, or identify which side of a fork is legitimate. No mutable ingest status appears inside the event; current acceptance state is derived only from a separately issued `OrgIngestReceipt`. Until one exists, the honest interpretation is “locally signed, not organization-accepted.”

Delivery remains separate. A successful Slack delivery does not mutate this envelope. A future `delivery-observation` event can reference both `event_id` and the existing `DeliveryReceipt`; a future `OrgIngestReceipt` is returned only by the organization authority.

### Durable outbox and manual export

SQLite is the only source of truth for the outbox. There is no “sent” or “accepted” column until a real ingest service exists. Export is repeatable and does not consume, acknowledge, or mutate events.

```text
echo-org-export-<installation_id>-<first_sequence>-<last_sequence>/
  export-manifest.v1.json
  identity-manifests/
    identity-manifest.<manifest_id>.v1.json
  publication-policies/
    publication-policy.<policy_id>.v<version>.json
  records.v1.jsonl
```

`records.v1.jsonl` contains the exact stored envelope bytes in sequence order. The export manifest contains:

```json
{
  "schema_version": 1,
  "kind": "echo-federated-export",
  "export_id": "exp_4989c769-9389-493a-9f32-0ee480e29e1f",
  "organization_id": "org_a1f69299-dfd8-440a-b0bc-777a184ff265",
  "installation_id": "ins_304f5ef4-bc72-48d2-9073-0eb694873130",
  "key_id": "sha256:PUBLIC_KEY_FINGERPRINT",
  "signing_identity_manifest_id": "idm_11111111-1111-4111-8111-111111111111",
  "artifacts": [
    {
      "path": "identity-manifests/identity-manifest.idm_11111111-1111-4111-8111-111111111111.v1.json",
      "kind": "echo-local-identity-manifest",
      "sha256": "sha256:MANIFEST_FILE_DIGEST"
    },
    {
      "path": "publication-policies/publication-policy.pol_805c94e8-51c9-4e3a-88ef-777a9d2626ef.v1.json",
      "kind": "echo-publication-policy",
      "sha256": "sha256:POLICY_FILE_DIGEST"
    }
  ],
  "sequence": {
    "first": 1,
    "last": 9,
    "predecessor_hash": null,
    "head_hash": "sha256:LAST_EVENT_HASH"
  },
  "records": {
    "path": "records.v1.jsonl",
    "count": 9,
    "sha256": "sha256:JSONL_DIGEST"
  },
  "generated_at": "2026-07-19T21:00:00.000Z",
  "integrity": {
    "canonicalization": "RFC8785",
    "payload_sha256": "sha256:EXPORT_MANIFEST_DIGEST",
    "signature_algorithm": "ecdsa-p256-sha256-der-low-s",
    "key_id": "sha256:PUBLIC_KEY_FINGERPRINT",
    "signature_base64": "BASE64_SIGNATURE"
  }
}
```

An export range is for one installation chain and includes the minimal deterministic identity-manifest verification closure: every identity manifest referenced by an event or included signed policy, the manifest named by `signing_identity_manifest_id` that binds the export-signing key, and every transitive predecessor needed to verify those manifests. The `artifacts` inventory commits exact ID-addressed paths and digests in bytewise path order. Missing, conflicting, duplicate, unrelated, or non-deterministically ordered manifest artifacts fail verification. Every referenced historical policy version is included; export never substitutes the currently active policy for a historical one.

The raw connection registry is deliberately not exported because it contains local credential guards. Every envelope carries the complete secret-free source and approval binding, connection-owner/generation, provider-identity, and configuration snapshots needed for provenance.

The existing whole-state backup naturally includes the identity files, decision events, SQLite outbox, and public keys. The private installation key remains excluded. After key loss, a recovery tool can still copy and verify individually signed envelopes, but it cannot produce the signed export-manifest format above; it emits this separately labeled unsigned report instead:

```json
{
  "schema_version": 1,
  "kind": "echo-federated-recovery-report",
  "unsigned": true,
  "reason": "installation-key-unavailable",
  "organization_id": "org_a1f69299-dfd8-440a-b0bc-777a184ff265",
  "installation_id": "ins_304f5ef4-bc72-48d2-9073-0eb694873130",
  "identity_manifest_sha256": "sha256:MANIFEST_DIGEST",
  "records": {
    "path": "records.v1.jsonl",
    "count": 9,
    "individually_verified": 9,
    "verification_failures": [],
    "sha256": "sha256:JSONL_DIGEST"
  },
  "generated_at": "2026-07-20T01:00:00.000Z"
}
```

Export creation stages a mode-`0700` directory, writes mode-`0600` canonical files, validates and fsyncs them, then atomically renames the completed bundle into place. A partial directory is never a valid export.

A local outbox is durable against process crashes, not against loss of the only machine. Until a server exists, continued Founder Live requires an operational check that an encrypted state backup or an access-controlled, encrypted export is copied to an independent location after native approvals. A plaintext export in a public or broadly shared folder is a policy violation because it contains internal evidence and participant observations. Claiming machine-loss durability without a protected second copy would be false.

### Honest treatment of pre-cutover data

Bootstrap records the cutover boundary and locally classifies every older record as:

```text
disposable_test
legacy_imported_unverified
```

`legacy_imported_unverified` is reserved for an already-delivered record that must remain as historical local evidence. Both classes are excluded from the signed federated outbox and future organization brain. Echo does not offer a later retrospective-promotion ceremony.

Structural eligibility—not a date comparison—enforces the boundary. A requested decision node without the new source, processor, and publication snapshot remains legacy even if the user approves it after bootstrap. It may be discarded and reissued from a newly attributed source observation, but its old immutable request is never edited.

No migration updates existing decision-node metadata, approval IDs, meeting rows, processing records, cursors, or delivery receipts.

### Challenge-based Founder Live enrollment

The local bootstrap ceremony is intentionally small:

1. Confirm that this `state_dir` has no identity manifest and show that one profile belongs to exactly one organization.
2. Mint opaque organization, principal, membership, device, installation, connection, binding, claim, and policy IDs locally.
3. Generate the installation key in the device-bound macOS key store and display its public fingerprint.
4. Show the organization name, founder identity, payload scope, audience, sensitivity, retention, and raw-meeting-local rule for explicit founder confirmation.
5. Call Slack `auth.test` to capture the bot installation's workspace-scoped connection identity.
6. Send a short-lived random nonce by Slack DM and require the proposed founder `(team_id, user_id)` to reply/react from Slack. Poll Slack for that provider-originating assertion; do **not** accept the locally known code back through the CLI. Store the namespaced actor, message/action references, method, time, and evidence digest, not the nonce itself.
7. Validate the Granola credential with one bounded diagnostic pull that does not advance the product cursor or persist meeting content. Record this only as connection `credential_observed`; do not turn meeting owner/participant data into a human identity claim.
8. Freeze adapter bindings and redacted configuration digests.
9. Stage and validate the signed manifest, registry revision, and policy; fsync/install those immutable files; atomically rename the signed active-bundle pointer **last**; then declare the legacy cutover.
10. Run the existing `doctor` plus the new strict identity check; only a green identity/provider/outbox/export result qualifies later records as native Founder Live records.

The shared verification shape supports `slack_dm_challenge`, `email_magic_link`, `provider_first_capture`, and `oidc_id_token` with explicit assurance, but in the correct context: first capture is connection evidence, never a human claim. This slice implements a Slack-originating challenge assertion for the approval actor and lower-assurance first capture for Granola connection continuity. Email links need a delivery/callback authority, and OIDC needs an authorization server; both remain design-only until a server exists.

The Slack-originating challenge is provider-observed evidence that the workspace user controlled that account at that time, assuming honest local software; it is not an independently verifiable provider credential and therefore uses `provider_challenge_observed`, not `provider_verified`. It does not prove legal name, employment tenure, or broad administrative authority; founder bootstrap supplies those as `founder_attested`. Granola first capture proves neither a person nor a stable account subject.

Bootstrap is resumable. A crash before the final pointer rename leaves only unreachable immutable staged/files and possibly an orphan Keychain key; retry verifies and reuses or explicitly deletes that named orphan before minting another. A crash after the rename exposes the entire coherent bundle. Connection rotation, policy changes, and re-enrollment use the same “write immutable dependencies, pointer last” commit rule.

### Non-destabilizing integration contract

Most implementation lives in new modules. A few additive hook edits in existing product code are unavoidable: without them, source and approval facts cannot be captured at the moment they exist. “New files only” can be literal for schemas and storage migrations, but cannot be literal for executable wiring. The hard constraint is that no existing identity/idempotency calculation, stored event, or adapter contract changes.

| Existing seam              | Additive hook only                                                                                                                  | Explicitly unchanged                                                        |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Product paths/composition  | Discover identity files under `state_dir`, construct `LocalIdentityContext`, and wrap the state store                               | Runtime-config v1 meaning, profile isolation, adapter factories             |
| Core state store           | Decorate `saveMeeting` and `saveDecisionSet` with source/processor-attribution sidecars                                             | `CoreStateStore` contract, meeting/cursor/processing keys, existing tables  |
| Decision-node store        | Require complete federation metadata when an active bundle exists and expose immutable requested/resolved metadata to the projector | `decisionApprovalId`, node IDs, first-request-wins behavior, slot filenames |
| Slack shared client        | Retain `team_id`, enterprise, app, bot, and user actor fields already returned by Slack                                             | OAuth token handling and delivery calls                                     |
| Slack approval surface     | Freeze card/binding/connection presentation, then validate the namespaced actor/tool snapshot before resolution                     | Reaction semantics, existing `reviewed_by`, approval ID                     |
| Store-backed approval gate | Ensure the signed outbox group exists before returning `approved` to the core                                                       | Core `ApprovalGate` and delivery contracts                                  |
| Product command layer      | Add bootstrap, identity-check, and export commands                                                                                  | `init`, `doctor`, `run-once`, `approve`, `reject`, service lifecycle        |
| Packaging/backup           | Package new schemas/migration/helper; verify identity/outbox files are backed up and private key is absent                          | Existing artifact/install and SQLite backup formats                         |

No core adapter port needs an organization ID. The local core remains tool-neutral. Product composition supplies the federated context around it.

The Founder Live path fails closed at each moment a non-backfillable fact exists:

1. Source and processor sidecars must be durably present before cursor advancement.
2. A complete source/processor/publication/approval-surface candidate snapshot must be in `requested.json` before a card is published; identity-enabled mode never writes `{metadata:{}}`.
3. The exact rendered-card digest and provider message reference must be in `published.json`.
4. Slack cannot write `resolved.json` unless the namespaced actor matches the enrolled claim and the actual approval connection/binding snapshot is complete. CLI writes its lower-assurance actor snapshot in the same immutable slot operation.
5. The store-backed gate invokes the projector and confirms the outbox events before it returns `approved` to the unchanged core, so no Slack/terminal delivery occurs first.

The projector remains retryable. A signing failure after a valid resolution slot cannot erase that approval or make it unattributable: all contemporaneous facts are already immutable, the command reports “resolution recorded; projection pending,” and the next run retries. It does, however, block delivery, cursor advancement, strict identity-check, and export success until the outbox group is committed. No cross-file rollback is attempted.

An installation with no active identity bundle keeps the current DEV behavior and emits no promotable envelope. It is explicitly `local_only_unattributed`; it does not silently mint identity on first use. Founder Live qualification calls the new strict identity check. Once a bundle exists, registry drift, missing stage/actor snapshots, or an unavailable signing key fails closed rather than downgrading a supposedly native record.

### Founder Live gate implementation plan and size

This is the complete build slice; central membership management, server sync, revocation service, search/LLM brain, multi-user invitation, OIDC, email delivery, SCIM, RBAC, and participant resolution remain out of scope.

| Workstream                            | Concrete output                                                                                                                                                                       |   Estimate |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------: |
| 1. Contracts and local identity       | Ten exact-key JSON Schemas; typed contracts; canonical JSON/digest utilities; provisioned Secure Enclave helper; immutable bundle stores/pointer; bootstrap and strict identity check | 5.5–8 days |
| 2. Connections and provider snapshots | Signed registry; Slack `auth.test` identity; Slack DM challenge; Granola lower-assurance first-capture and credential-drift rule; adapter-binding config snapshots                    |   2–3 days |
| 3. Approval intent and actor capture  | Fail-closed source/processor/policy metadata; complete card digest; namespaced Slack actor/tool snapshots; honest CLI assurance                                                       |   2–3 days |
| 4. Attribution, outbox, and export    | Additive source + processor attribution migration; state-store decorator; transactional signer/chain; retryable projector; deterministically ordered export and verification          | 4–5.5 days |
| 5. Legacy boundary and qualification  | Cutover classification; legacy events; backup/restore/package checks; failure injection; fresh-install and current-state live tests                                                   |   2–3 days |

Expected total: **16–23 engineering days for one engineer**, including tests and one founder live rehearsal, excluding Apple Developer account/profile issuance latency. The crypto, signed-helper distribution, crash consistency, fail-closed capture, and upgrade-boundary tests—not the JSON interfaces—drive the range.

Implementation discovery: Secure Enclave access on macOS requires the data-protection keychain and a stable provisioned app-like helper identity ([Apple TN3137](https://developer.apple.com/documentation/technotes/tn3137-on-mac-keychains)). Ordinary unsigned DEV artifacts therefore omit the signer and keep identity inactive. Seed-grade bootstrap must fail with `signer_unavailable` until the protected build supplies and verifies that helper; it may never fall back to a portable private-key file or mislabel a software key as device-bound. This does not change ADR-FL-IDENTITY-005, but adds roughly two to three engineering days to the original estimate.

Expected change size:

- Roughly 26–34 new source, schema, migration, native-helper, and focused test-support files
- Roughly 8–14 existing files touched only at the additive seams above
- Roughly 2,800–4,000 production lines, including 250–450 lines for the macOS signing helper
- Roughly 2,500–3,800 test lines covering exact schema/canonical rejection, key non-exportability, fail-closed capture, idempotent projection, crash/retry, clone/fork fixtures, legacy refusal, provider drift, backup/export confidentiality, packaging, and end-to-end live behavior

Representative new files:

```text
schemas/product/active-identity-bundle.v1.schema.json
schemas/product/local-identity-manifest.v1.schema.json
schemas/product/local-connection-registry.v1.schema.json
schemas/product/publication-policy.v1.schema.json
schemas/product/source-attribution.v1.schema.json
schemas/product/processor-attribution.v1.schema.json
schemas/product/approval-federation-metadata.v1.schema.json
schemas/product/federated-record-envelope.v1.schema.json
schemas/product/federated-export.v1.schema.json
schemas/product/federated-recovery-report.v1.schema.json

src/product/federation/contracts.ts
src/product/federation/canonical-json.ts
src/product/federation/active-identity-bundle-store.ts
src/product/federation/identity-manifest-store.ts
src/product/federation/connection-registry-store.ts
src/product/federation/publication-policy-store.ts
src/product/federation/installation-signer.ts
src/product/federation/macos-signing-helper.swift
src/product/federation/attributing-core-state-store.ts
src/product/federation/outbox-store.ts
src/product/federation/record-projector.ts
src/product/federation/export-bundle.ts
src/product/federation/legacy-classification.ts
src/storage/migrations/0003_federated_founder_identity.sql
```

The implementation should land as five small additive commits in the same order as the workstreams, with the feature inactive until bootstrap commits a valid active identity bundle. Acceptance requires:

1. All current tests and the exact DEV.6 Granola → core → approval → Slack delivery live path still pass with the same IDs/idempotency.
2. A fresh bootstrap atomically commits valid signed manifest/registry/policy files and an active pointer without exporting the private key.
3. Identity-enabled mode cannot publish a card without source + processor + candidate metadata, cannot resolve without complete actor/tool metadata, and cannot deliver before signed outbox projection succeeds.
4. One Slack-approved record produces exactly one outbox event per signal across repeated `run-once`, restarts, and repeated exports.
5. A provider-account change, unknown Slack actor, missing stage sidecar, modified policy/presentation snapshot, or broken chain fails closed and prevents `native_attributed` output.
6. Existing and pre-bootstrap-pending records cannot become native by timestamp or mutation.
7. Backup/restore verifies old envelopes; a replacement machine must enroll as a new installation before signing new ones.
8. A protected independent export/backup copy can be read and cryptographically checked before Founder Live continues.

### Where “minimal” would be too minimal

The following cuts save code now but destroy facts or force later rewrites, so they are outside the acceptable minimum:

- **One founder/user ID:** principal and membership must remain separate even in one manifest; otherwise rehire and tenure cannot be represented honestly.
- **One adapter/credential ID:** connection and binding must remain separate; otherwise one Slack installation cannot back independent approval and delivery capabilities, and account rotation corrupts provenance.
- **A private-key file in `state_dir`:** mode `0600` is not device binding, and backup/clone would copy the issuer. Founder Live needs a non-exported device key plus recorded protection assurance.
- **Slack IDs without tenant or Granola meeting owners as identities:** both are ambiguous or unverified. Namespaced raw assertions and honest assurance are mandatory.
- **Attribution inferred during export:** the credential/provider may have changed by then. The source snapshot must be captured at observation time.
- **Processor attribution inferred during approval:** a cached decision set may come from an older model/prompt. The processor snapshot must be captured at extraction time.
- **The current policy read during export:** it may differ from what the human approved. The full policy snapshot must be frozen in the approval request.
- **A locally re-entered Slack challenge code:** the local process already knows it and cannot use it to prove Slack-account control. Require a Slack-originating assertion and retain its lower, honest assurance.
- **Approval allowed to proceed with missing metadata:** once identity is active, missing source, processor, policy, presentation, tool, or actor facts must stop before card publication/resolution/delivery, not merely make a later report red.
- **Free-form CLI reviewer treated as verified:** it proves only that someone controlling the installation invoked the command. Preserve the lower assurance forever.
- **Native wrapping of old or already-pending approvals:** contemporaneous source, actor, and audience facts are absent. Keep only an honest local disposable/legacy classification; never place those records in the federated outbox or invent history.
- **Receipts appended to an approved envelope:** that would mutate a signed record. Delivery and ingest outcomes are separate related events/receipts.
- **A locally invented `OrgIngestReceipt`:** without an organization authority it proves nothing. Reserve the contract and wait for the server.
- **Local participant resolution guesses:** preserve source observations; add audited central resolutions later.
- **A hash chain described as revocation enforcement:** without a trusted external head and revocation authority it only makes later gaps/forks detectable. Preserve that honest status.
- **Only one on-device copy:** the outbox survives crashes, not laptop loss. Founder Live requires a protected, verified independent backup/export until central ingest exists.
- **Mutable independent “current” manifest/registry/policy files:** a crash can expose a mixed identity bundle. Keep immutable dependencies and atomically move one active pointer last.
- **Repeating sibling signals in each record envelope:** that leaks the whole approval group when one record is queried. Carry one signal plus meeting context, bounded evidence, and the approved-brief/sibling digests.
- **Zero edits to existing executable files:** this would make contemporaneous source and approval capture impossible. Allow only the small optional hooks listed above; forbid changes to all identity and idempotency calculations.
- **Silent processor-config reuse:** a changed model/config under the same binding undermines provenance. Create a new binding or fail the identity check while leaving the old core key untouched.

### ADR-worthy decisions for individual approval

Each line is intentionally a standalone decision:

1. **ADR-FL-IDENTITY-001:** One Echo `state_dir` represents exactly one organization enrollment and one active installation profile, while retaining immutable historical installation manifests and chain heads.
2. **ADR-FL-IDENTITY-002:** Founder Live mints opaque immutable provisional organization, principal, membership, device, installation, connection, binding, claim, policy, event, and record IDs that a future control plane registers but never rewrites.
3. **ADR-FL-IDENTITY-003:** Principal and membership remain distinct identities even when their first records share one local manifest.
4. **ADR-FL-IDENTITY-004:** Device is a nested installation field for Founder Live, while installation remains the signing and revocation unit and replacement machines always receive new IDs and keys.
5. **ADR-FL-IDENTITY-005:** Each installation signs canonical bytes with the locked P-256/low-S profile and a device-bound key excluded from state, configuration, exports, and backups; every record states actual key-protection assurance.
6. **ADR-FL-IDENTITY-006:** Human identity claims are namespaced issuer/tenant/subject assertions with verification method and assurance; a Slack-originating challenge is `provider_challenge_observed`, while email, display name, token possession, and unnamespaced Slack IDs are never canonical identity.
7. **ADR-FL-IDENTITY-007:** `ToolConnection` and `AdapterBinding` remain distinct; provider/credential changes create explicit generations or new connections/bindings and new source-instance/cursor lineage rather than inheriting `instance_id` state.
8. **ADR-FL-IDENTITY-008:** Source and processor attribution are frozen respectively at meeting observation and decision extraction and cannot be inferred or replaced during approval/export.
9. **ADR-FL-IDENTITY-009:** Identity-enabled approval fails closed while the request freezes candidate/tool/policy context, publication freezes presentation, and resolution freezes namespaced actor/tool assurance, without changing approval IDs or `reviewed_by` semantics.
10. **ADR-FL-IDENTITY-010:** Each approved signal receives one immutable signed envelope around unchanged local IDs containing only that signal, meeting context, bounded evidence, and approval-group digests; raw meeting and sibling signal content are not copied into it.
11. **ADR-FL-IDENTITY-011:** The SQLite outbox is an append-only source of pending organization records with per-installation sequence/hash chaining; manual exports are repeatable and never imply server acceptance.
12. **ADR-FL-IDENTITY-012:** `DeliveryReceipt` and `OrgIngestReceipt` are separate outcomes, and no organization-ingest receipt exists until a real organization authority issues it.
13. **ADR-FL-IDENTITY-013:** Meeting participants remain unresolved source observations during Founder Live; future resolutions are append-only central facts and never rewrite envelopes.
14. **ADR-FL-IDENTITY-014:** Pre-cutover and structurally incomplete records are disposable or explicitly `legacy_imported_unverified`/`founder_attested_retrospective`; Echo never upgrades them to native attribution.
15. **ADR-FL-IDENTITY-015 (approved amendment):** Seed-grade cutover and every record after it require both a green strict identity check and a protected, verified independent copy of the signed outbox until central ingest exists; disposable pre-cutover rehearsals do not.
16. **ADR-FL-IDENTITY-016:** Slack approval envelopes preserve publication and reaction-observation tool snapshots separately; different credential generations are permitted only when validation proves the same enrolled Slack workspace, connection, adapter identity and configuration, and provider identity.
17. **ADR-FL-IDENTITY-017:** A federated export includes the complete identity-manifest verification closure required by the export: every manifest referenced by an exported event or included signed policy, the manifest binding the key that signs the export manifest, and every transitive predecessor of those manifests. Files are stored under `identity-manifests/identity-manifest.<manifest_id>.v1.json`. Every manifest ID and digest reference must resolve to exactly one matching exported file; missing, conflicting, or unreferenced manifest artifacts fail verification. The closure is minimal and deterministic: duplicate IDs, one ID resolving to different digests, unrelated manifests, and non-deterministic artifact ordering are forbidden.

Operational narrowing for this cutover: although ADR-FL-IDENTITY-014 preserves the general design vocabulary as approved, this founder installation will not exercise `founder_attested_retrospective`; its pre-cutover records are only `disposable_test` or, where already delivered, `legacy_imported_unverified`, and neither enters the federated outbox.

## Recommended stage gates

### Before continued Founder Live with durable seed records

- Commit an active local identity bundle—immutable manifest, connection/binding registry revision, and publication policy—with provisional organization, principal, membership, installation, connection, and binding IDs.
- Capture Slack workspace/account and approval-actor snapshots.
- Capture honest Granola connection assurance, leave an unprovable provider account subject unknown, and prevent silent credential/account switching.
- Add a versioned federated record envelope around existing core output.
- Record audience, sensitivity, retention, and policy at approval.
- Preserve current local keys and idempotency behavior.
- Mark existing records as `disposable_test` or, only where already delivered, `legacy_imported_unverified`; exclude both from export and the organization brain.
- Create a durable sync/export outbox and verify a protected independent backup/export copy so the laptop is not the only promotable copy.

### Before the second employee

- Introduce a central organization and membership registry.
- Add browser enrollment, central installation/public-key registration, credential issuance, and key lifecycle.
- Add central revocation.
- Add an organization-sync uploader and signed ingest receipts for the existing local outbox.
- Resolve Slack actors dynamically to active memberships.
- Bind every source cursor to an immutable provider connection.

### Before Client Live

- Add SSO/SCIM lifecycle automation.
- Add recovery administrators and break-glass policy.
- Add retention, deletion, and audit controls.
- Add explicit BYOD/managed-device policy.
- Add client-visible membership, installation, and connection administration.
- Add operational monitoring for revoked/offline installs and stale tool grants.

## Primary trade-offs

### Central authority versus peer-to-peer federation

Central identity is less philosophically federated, but it makes offboarding, revocation, tenant isolation, and canonical membership tractable. Keep data capture federated and identity authority centralized.

### Organization-scoped principals versus global people

Organization-scoped principals avoid unnecessary cross-client correlation and simplify ownership. Do not attempt to build one global human identity graph across client companies.

### Per-installation keys versus portable user keys

Per-installation keys make loss and replacement safer. Human intent comes from the authenticated approval event, not from a private key copied across every device.

### Minimal approved sync versus full meeting sync

Minimal approved records protect employee and external-participant privacy. Full transcripts improve recall but dramatically increase permission, consent, retention, and breach consequences. Default to approved signals plus bounded evidence.

### Conservative deduplication versus aggressive merging

Preserve observations and link them. False merges destroy provenance and can combine unrelated people or decisions. Visible duplicates are easier to repair.

### Offline freedom versus revocation strength

Long offline leases improve availability but weaken offboarding guarantees. Make the lease explicit and shorter for sensitive organizations and contractors.

## Proposed architectural rule

Keep `MeetingDocument`, `DecisionSet`, the core loop, approval surfaces, and delivery surfaces tool-neutral and locally idempotent.

Put organization ownership, authenticated actors, installation provenance, provider-account bindings, publication intent, and sync integrity in a new federated record envelope surrounding the core. Do not overload local adapter labels such as `primary`, mutable emails, Slack display names, or machine paths with durable identity meaning.

One further rule follows from this design:

> Approval for Slack delivery is not automatically consent to permanent organization-wide memory. The approval event must state what payload is approved for which audience, and that publication intent must travel with the record.
