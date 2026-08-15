---
schema_version: 1
id: RFC-0001
kind: rfc
title: Resumable profile-aware onboarding and updates
component_ids:
  - CMP-ADAPTERS
  - CMP-LOCAL-RUNTIME
  - CMP-IDENTITY-ACCESS
  - CMP-CENTRAL-ORGANIZATION
  - CMP-PROTOCOLS-CRYPTO
  - CMP-OPERATIONS-RELEASE
created_at: 2026-08-15
reviewed_at: 2026-08-15
reviewed_ref: 4665c3a93187095d5d14acbe95e825cd69aaf31e
status: draft
superseded_by: []
invariant_ids:
  - INV-ADAPTERS-001
  - INV-ADAPTERS-002
  - INV-IDENTITY-002
  - INV-IDENTITY-003
  - INV-RELEASE-001
  - INV-RUNTIME-001
failure_pattern_ids:
  - FP-ADAPTERS-001
  - FP-ADAPTERS-002
  - FP-IDENTITY-002
  - FP-RELEASE-001
  - FP-RUNTIME-001
---

# RFC-0001: Resumable profile-aware onboarding and updates

## Status and review boundary

This is an implementation proposal for adversarial review. It does not claim
that the described protocol, launcher, coordinator, profiles, or update flow is
implemented. It was written against source commit
`4665c3a93187095d5d14acbe95e825cd69aaf31e` and tracks the outcomes in GitHub
issues 51, 52, and 53.

The proposal deliberately does not add WorkOS or another identity or
integration vendor. ECHO remains responsible for its enrollment, local
installation, adapter, update, and permission boundaries. A later external
identity or OAuth service may implement a port only if it preserves the trust
and failure semantics defined here.

## Decision summary

ECHO will present one resumable onboarding entrypoint and one automatic update
lifecycle.

Onboarding may pause only for information or consent that cannot be safely
derived:

- possession of the administrator-issued invitation;
- independent confirmation of the Authority trust pin;
- provider authorization required by the employee's provisioning profile;
- an operating-system permission that only the employee can grant; or
- explicit consent to a security-sensitive, non-backward-compatible change.

It must not pause for paths, identifiers, runtime versions, package-manager
commands, service commands, diagnostics, access refreshes, or recovery steps.

The implementation is not a shell wrapper around today's `bootstrap`. It has
two durable owners:

1. A stable, signed launcher owns sealed runtime and product installation on a
   clean Mac.
2. A product onboarding coordinator owns enrollment, profile configuration,
   adapter connection, service lifecycle, readiness, and resumption.

Every external or mutating effect is prepared durably with one stable
operation identity before execution. After interruption, the coordinator
reconciles observed state with that prepared intent and either accepts the
existing exact effect or replays the same effect. It never guesses that a
timeout means failure and never creates a second membership, enrollment,
installation, credential, service, or update transaction merely to make
progress.

Provisioning profiles choose which local capabilities to configure. They do
not grant permission. The Organization Authority remains the source of
membership, installation access, adapter bindings, action grants, content
policy, revocation, and final read authorization.

## Problem and current boundary

The current `bootstrap` implementation already has important safe behavior:

- it requires a materialized-commit package, Darwin arm64, exact Node
  `v22.22.1`, a local state filesystem, and explicit software-key consent;
- it validates the private invitation and separately supplied Authority pin;
- it refuses ambiguous config/state ownership and retired founder residue;
- it creates credentials and config with private modes and no overwrite;
- it verifies one Granola record-owner observation before retaining a new
  Granola credential;
- it initializes and enrolls idempotently enough to refresh an already
  accepted exact enrollment; and
- it finishes before installing or starting the LaunchAgent.

The complete employee journey is nevertheless split across concerns the
employee should not need to understand:

1. Obtain and independently verify Node, npm, the product package, release
   manifest, checksums, and provenance.
2. Select absolute config and state paths.
3. Place a private invitation file and enter an independently delivered pin.
4. Type an owner email, Slack channel ID, Slack user ID, display name, Granola
   token, and organization Slack bot token.
5. Run `bootstrap`.
6. Complete a separate Slack identity-link ceremony and wait for an
   administrator to activate grants.
7. Run a controlled product cycle.
8. Separately run `service install`, `doctor`, and `update apply`.

The updater has exact manifest and package verification, durable transaction
state, backup, retained previous package, doctor, and rollback. It still
depends on an already installed CLI, an absolute config path, a running
service, global package replacement, and manual invocation. The transaction
replays intent phases but cannot by itself give a clean Mac a sealed runtime or
make a stable launcher survive replacement of the package that contains the
updater.

The recurring root causes are ownership fragmentation and response ambiguity:

- the user is acting as the coordinator between otherwise safe commands;
- installation is owned by npm before the product can own its lifecycle;
- safe defaults and central facts are repeatedly entered as local flags;
- organization-owned Slack app credentials are collected per employee;
- one fixed contributor/reviewer configuration is treated as universal;
- progress is inferred from a command sequence rather than one durable plan;
- a step's local completion is sometimes treated as proof of its external
  effect; and
- rollback is described as universal even after a candidate may have caused
  externally visible or forward-only effects.

## Goals

1. A supported clean Mac reaches its profile-specific `ready` state from one
   entrypoint.
2. The employee performs no deterministic handoff between commands.
3. The same entrypoint resumes after cancellation, crash, reboot, network
   loss, response loss, or invitation consumption.
4. Existing installations are routed to update or recovery and are never
   overwritten by onboarding.
5. Reader, contributor, and reviewer capabilities request only the adapters
   and provider actions they need.
6. Organization-owned provider app credentials are configured once at the
   organization boundary, not copied to every Mac.
7. A normal update needs no re-enrollment, credential re-entry, config path,
   package-manager command, service command, or manual doctor.
8. A failed pre-commit update returns to the complete previous healthy tuple;
   a post-commit failure is clearly forward-only and never performs an unsafe
   state rewind.
9. Administrators can see non-secret progress and one actionable blocker per
   installation without remote shell access.
10. Tests inject interruption at every durable boundary and prove exact resume
    or fail-closed preservation.

## Non-goals

- Replacing the Organization Authority with an identity provider, RBAC
  service, or credential vendor.
- Creating a generic plugin platform or accepting arbitrary adapter code.
- General client release, Windows, Linux, or Intel Mac support.
- Eliminating the independent Authority pin channel.
- Automatically granting central permission from a requested local profile.
- Hiding security consent or provider authorization from the employee.
- Silently repairing unknown existing state or retired founder residue.
- Rolling back externally visible provider actions or accepted organization
  writes by restoring a local backup.
- Requiring every employee to run a background ingestion service.

## Scope assumptions

The minimum V1 assumes:

- the central organization and Authority are initialized and reachable;
- organization-owned tools such as the Slack app have already been onboarded
  and validated centrally;
- the administrator has created the employee membership, provisioning plan,
  any bounded future activation intents, and one bounded invitation;
- one exact Internal Live release is approved and its complete Darwin arm64
  runtime bundle is available through the supported distribution channel; and
- the Mac is owned by the employee and supports the current software-key
  assurance level.

If a central prerequisite is incomplete, the employee flow reports
`waiting_for_administrator`. It does not ask the employee to run an admin
command or copy internal identifiers.

## User-visible contract

The final entrypoint is conceptually:

```text
Echo Brain Onboard <invitation>
```

The signed launcher may expose this as a Finder application, a package, or a
stable executable. An already installed development build may temporarily
expose the same coordinator as:

```text
echo-brain onboard --invitation <private-file>
```

That transitional CLI is not the clean-Mac solution because a missing or
wrong runtime cannot be repaired by a command that depends on that runtime.

The interactive result is always one of:

| State | Meaning | Employee action |
| --- | --- | --- |
| `ready` | The required profile is usable and all required checks passed. | None. |
| `waiting_for_user` | A specific identity, provider, or OS consent is required. | Complete the one displayed action. |
| `waiting_for_administrator` | A central prerequisite is absent or inconsistent. | None; the administrator receives the blocker. |
| `retryable` | A bounded transport or provider operation is unavailable. | Leave the flow open or resume later. |
| `preserved` | Existing or partial state cannot be changed safely. | Contact support with the opaque incident ID. |

Machine-readable output additionally includes a stable reason code, flow ID,
current step, retry policy, and whether central or external effects may already
exist. It contains no credential, invitation grant, provider payload, private
path, query, organization content, or raw remote error body.

The flow never ends successfully with a list of commands for the employee to
run next.

## Information contract

### Administrator-provided information

One private invitation package contains the current enrollment invitation and
a signed, non-secret onboarding plan. The independent Authority pin is still
delivered through a different trusted channel.

The onboarding plan contains:

- plan ID and schema version;
- Authority, organization, principal, and membership identities;
- membership type and human-readable organization display name;
- provisioning profile and required capabilities;
- exact approved bootstrap release identity and compatibility tuple;
- safe adapter instance choices, approval-routing policy, organization-owned
  tool binding IDs, and any bounded activation-intent ID;
- default local config/state policy, expressed as a policy name rather than a
  private absolute path;
- issued and expiry timestamps; and
- the Authority signature and signing-key identity.

The plan contains no bearer grant, provider credential, private key, raw
provider identity roster, or permission allow. Its profile is a provisioning
request, not an authorization decision.

The launcher verifies the plan signature using the independently pinned
Authority descriptor. After enrollment, it fetches the current plan again
through the installation-signed channel and requires the same plan ID and
profile before activating any capability.

### Employee-provided information

The employee may be asked for only:

- the invitation package, when it was not opened directly;
- the independently communicated Authority pin;
- confirmation that the displayed organization and employee identity are the
  expected ones;
- a Granola authorization or credential for a contributor profile;
- completion of the Slack human identity challenge for a reviewer profile;
- required macOS consent; and
- explicit acknowledgement of the current exportable software-key assurance,
  until a hardware-backed implementation replaces it.

If Granola identity verification requires an employee-owned visible note and
none exists, creating or sharing one note is a legitimate
`waiting_for_user` action. The coordinator performs the verification and
continues automatically after the provider state changes.

### Derived information

The implementation derives and never asks the employee to enter:

- config path, state path, installation path, service label, and log paths;
- Node, npm, product version, release channel, artifact name, and source SHA;
- Authority, organization, principal, membership, enrollment, installation,
  adapter-binding, and grant IDs;
- Slack workspace, app, bot, channel, and user IDs already verified centrally;
- owner email already bound to the central principal;
- adapter IDs, versions, instance IDs, reactions, and health commands; and
- update, backup, rollback, and diagnostic commands.

## Provisioning profiles are not permissions

V1 defines capability profiles rather than security roles:

| Profile | Local capability | Human pause | Service requirement |
| --- | --- | --- | --- |
| `reader` | Signed permission-aware organization reads. | Identity/trust only. | No background ingestion service. |
| `contributor` | Reader plus an owner-bound Granola meeting source and local processing. | Granola authorization and any required macOS consent. | Required. |
| `reviewer` | Reader plus a centrally verified Slack human identity link. | Slack challenge. | Not required solely for review. |
| `contributor_reviewer` | Union of contributor and reviewer capabilities. | Granola authorization and Slack challenge. | Required. |

An owner or organization administrator uses a separate privileged ceremony and
is not an employee profile.

Changing a profile does not create a permission grant. The local coordinator
may configure only capabilities named in the signed plan, and every central
operation still evaluates current membership, enrollment, installation,
identity link, adapter binding, action grant, and policy. A locally broadened
or tampered profile therefore fails closed.

Readiness is profile-specific. A reader is not unhealthy merely because no
LaunchAgent or Granola credential exists. A contributor is not ready until the
managed service and required source adapter are healthy. A reviewer does not
receive or store the organization Slack bot token.

## Organization-owned and employee-owned adapters

The onboarding coordinator consumes an explicit adapter ownership descriptor:

- `organization`: the provider app credential and tenant connection live at
  the central organization boundary. The employee may link a human identity
  but never receives the app secret.
- `employee`: the credential represents the employee's provider account and is
  stored through the governed local credential store.
- `none`: the capability needs no provider credential on the Mac.

Slack approval is organization-owned. The existing per-employee Slack bot
token prompt must be removed from the final flow. The Authority's active Slack
tool remains responsible for provider app identity and transport; the
employee's separate Slack challenge binds the human identity used by approval
policy. A contributor's plan selects a central approval-routing policy rather
than copying one reviewer identity into the contributor's config.

When reviewer permission should become active during onboarding, the
administrator creates a bounded activation intent before issuing the
invitation. The intent identifies the membership, provider subject
expectation, tool, adapter, actions, and expiry, but is not itself a grant.
After the employee proves the exact Slack human and the Authority creates the
link and adapter binding, the Authority atomically consumes the matching
intent and creates the exact grants. A missing, expired, already-consumed, or
mismatched intent becomes `waiting_for_administrator`; the employee never
transfers binding IDs between terminals.

Granola is employee-owned in V1. Its credential is collected through a hidden
or browser-mediated provider step and committed to the governed credential
store only after exact owner verification. The onboarding transaction stores
only an opaque credential reference and verification receipt, never the
credential or a reusable digest of it.

Adapter transport, identity, scopes, and health remain independently verified
at their owning boundary. A generic `connected` boolean is not enough to mark
an adapter ready.

## Stable launcher and versioned installation layout

The clean-Mac launcher is a small signed and notarized artifact whose update
surface is intentionally narrower than the product. It owns:

- platform and filesystem preflight;
- verification and installation of one complete offline-capable runtime
  bundle;
- versioned product directories;
- the active-version pointer;
- the machine-wide onboarding/update coordination lock;
- invocation of the product coordinator from the exact installed version; and
- recovery into either the previous healthy version or a preserved state.

The product must not replace the executable currently coordinating its own
replacement. The LaunchAgent points at the stable launcher, which resolves the
committed active-version pointer. A release is installed into a new immutable
version directory and verified in place. No global npm prefix is mutated
in-place during normal onboarding or update.

Conceptual layout:

```text
~/Library/Application Support/Echo Brain/
  launcher/
  installs/<release-identity>/
  active-installation.v1.json
  onboarding/<flow-id>/
  updates/<installation-id>/<transaction-id>/
  profiles/<profile-id>/config/runtime.json
  profiles/<profile-id>/state/
```

Exact paths remain an implementation decision of the launcher and are never
user input. Directories and files use the current ownership, mode, ACL,
canonical-path, local-filesystem, and no-symlink rules. The pointer and every
transaction file are canonical, exact-key, atomically replaced, and durably
synced with their parent directory.

## Onboarding transaction

### Identity and storage

One flow ID and local profile ID are deterministically bound to the signed
onboarding plan and the invitation's public command, Authority, organization,
and membership IDs. Neither derives from the bearer grant bytes. The
coordinator refuses a second active flow for the same plan or target profile.

The transaction is secret-free. Secret-bearing invitation and credential
material remain in separate private stores with independent lifecycle rules.
The transaction records:

- schema, kind, flow ID, plan digest, and pinned Authority identity;
- exact target release and launcher identity;
- canonical target profile and derived local profile identity;
- each step's state, attempt count, stable operation ID, prepared request
  digest when applicable, and accepted receipt digest;
- the last safe public status and reason code;
- whether local mutation, central enrollment, provider connection, service
  activation, or product work may have occurred; and
- started, updated, and terminal timestamps.

The transaction is a resumable snapshot, not evidence that an external effect
happened. Each effect-bearing step separately owns a prepared intent and an
immutable accepted receipt.

### Step algebra

Each step is one of:

- `not_started`;
- `waiting_for_user`;
- `waiting_for_administrator`;
- `prepared`;
- `reconciling`;
- `succeeded`;
- `retryable`; or
- `terminal_preserved`.

`running` is not a durable truth. A process can die immediately after a side
effect and before recording completion. On restart, any `prepared` or
`reconciling` step observes local or authoritative remote state before deciding
whether to accept or replay the same operation.

### Ordered flow

1. **Classify the machine.** Inspect platform, disk, paths, prior launcher,
   existing installations, service ownership, retired residue, and partial
   flows without mutation.
2. **Verify trust and plan.** Parse the private invitation, compare the
   independently entered pin, verify the Authority descriptor and signed plan,
   and verify expiry and compatibility.
3. **Verify release.** Validate the sealed runtime/product bundle completely
   before changing an existing installation.
4. **Confirm the human boundary.** Display organization, employee, requested
   profile, credential ownership, and software-key assurance in plain
   language. Collect only missing confirmations.
5. **Install the version.** Populate and verify a new immutable version
   directory. Do not activate it yet.
6. **Reserve local profile.** Derive paths, create the private flow/profile
   roots, and atomically reserve the config/state identity without initializing
   product state.
7. **Collect required employee adapters.** Complete only the provider actions
   required by the signed profile. Store secrets outside the transaction.
8. **Stage and validate config.** Generate exact profile config, validate it
   offline, and commit it atomically without overwriting any existing config.
9. **Initialize local state.** Create the installation key and product state
   under the exact prepared local identity.
10. **Enroll or reconcile enrollment.** Persist one exact signed request before
    sending it. Accept only the matching enrollment/access receipt; after
    response loss, query or exactly replay rather than generate a new key or
    installation.
11. **Refresh the signed plan.** Fetch the installation-bound current plan and
    require it to match the locally verified plan and current central state.
12. **Complete central bindings.** For a reviewer, drive the Slack challenge in
    the same flow and poll for the exact link, binding, activation-intent
    consumption, and grant result. The employee is never told to pass IDs to
    an administrator.
13. **Install and start service when required.** Reader-only profiles skip this
    step by contract. Contributor profiles install the stable-launcher
    LaunchAgent, start in readiness quarantine, and prevent product work until
    readiness commits.
14. **Run profile doctor.** Use a profile-derived check set; do not require
    irrelevant services or adapters.
15. **Run a no-content permission readiness probe.** Exercise installation
    signature, current Person resolution, active access, applicable policy,
    generation readiness when required, final fence availability, and audit
    writability without returning organization content or opening unrelated
    adapter planes.
16. **Activate.** Commit the active profile/version pointer, release any
    quarantined service into normal work, write the immutable onboarding
    receipt, and report `ready`.

The no-content probe is a new bounded operation, not a magic search query that
might accidentally match private content. It must share the same live identity
and permission dependencies as the corresponding read path while returning
only readiness booleans and opaque digests permitted by its contract.

## Resume and abandonment rules

### Before central enrollment

The flow can abandon cleanly by deleting only its uncommitted staging area and
unreferenced version directory. Invitation and credentials are removed only
according to their own ownership rules. Existing profiles are untouched.

### After enrollment and before activation

Enrollment is an append-only central fact and cannot be erased by deleting
local files. Abandonment must use an installation-signed or administrator
authorized central operation to revoke or mark the incomplete installation
abandoned. The local private key and receipt are preserved until that outcome
is durably known. A second onboarding attempt does not reuse or conceal the
abandoned installation.

### After provider connection or identity link

Disconnecting locally does not prove provider-side revocation. The coordinator
records whether the provider or central link may remain active and routes the
cleanup to its owning boundary. It never reports a clean rollback merely
because the local credential reference was removed.

### After service activation or product work

The onboarding flow is complete. Later repair uses update or recovery, not
bootstrap replay. Any externally visible Slack card, provider request, or
organization append is preserved and reconciled rather than erased by local
restore.

## Update lifecycle

Onboarding and updating share the stable launcher, versioned install store,
coordination lock, release verifier, profile classifier, doctor vocabulary,
and public status algebra. They have separate transaction schemas because
update operates on an existing installation and has a rollback boundary.

### Background preparation

While the current service remains healthy, the launcher or its supervised
agent may:

1. request the applicable signed release directive;
2. download the exact sealed bundle;
3. verify approval, manifest, artifact, provenance, compatibility, downgrade
   policy, disk space, paths, config/state identity, credential references,
   backup eligibility, and retained previous bytes;
4. install and inspect the candidate in an inactive version directory; and
5. report `verified` without stopping product work.

No release is claimed merely because it is currently pointed to by the
Authority. The installation durably claims one directive sequence, manifest
digest, artifact digest, source SHA, and version. A resumed transaction cannot
drift to a newer release.

### Update transaction phases

```text
offered
  -> downloading
  -> verified
  -> claimed
  -> quiescing
  -> backing_up
  -> migrating_candidate
  -> candidate_ready
  -> activating
  -> healthy
```

Failure before activation enters `rolling_back` and then either
`rolled_back` or `preserved`. A non-critical unclaimed release may be
`deferred`; a newer release may supersede only an unclaimed candidate.

Each mutation phase persists intent before effect and reconciles the exact
effect after interruption. Reconciliation checks the actual version pointer,
installed bytes, config digest, state generation, backup receipt, service
owner, and doctor receipt. It does not infer success from phase order.

### Quarantine and commit boundary

The candidate service starts in update quarantine. It may open only the local
state and non-mutating diagnostic dependencies required for migration and
doctor. It cannot poll providers, publish Slack cards, resolve approvals,
deliver output, append organization records, or perform ordinary product work.

Activation is one durable boundary:

1. candidate bytes, config, migration, local doctor, and permission readiness
   are proven;
2. the active-version pointer and service generation are committed;
3. the candidate is released from quarantine; and
4. the signed healthy receipt is submitted idempotently.

Before this boundary, the complete previous package/config/state/service tuple
may be restored. After this boundary, an observed external or append-only
effect makes state rewind unsafe. Recovery is then fixed-forward unless a
separately proven backward-compatible rollback can preserve every committed
effect. The UI and fleet state call this boundary out explicitly.

### User interaction

Normal approved updates are prepared and applied automatically within the
configured maintenance policy. The user may:

- defer a non-critical unclaimed release;
- choose an allowed maintenance window; or
- approve one clearly explained security-sensitive migration.

Retries of the same exact approved migration do not request consent again.
The employee is never asked for a config path, Node/npm command, service
command, credential, access refresh, backup action, or doctor action.

The final result is exactly one of `updated`, `already_current`, `deferred`,
`rolled_back`, `retryable`, or `preserved` with one stable reason code.

## Central status and privacy

The Authority accepts signed, idempotent, non-secret lifecycle events keyed by
installation and flow or update transaction. Minimum onboarding states are:

- invited;
- started;
- waiting for employee;
- waiting for administrator;
- enrolled;
- configuring adapters;
- validating;
- ready;
- expired;
- abandoned; and
- preserved.

Minimum update states are:

- not offered;
- offered;
- downloading;
- verified;
- claimed;
- installing;
- healthy;
- deferred;
- rolled back;
- failed;
- preserved; and
- superseded.

Events contain exact source/artifact/config identities, step/result codes, and
timestamps where required. They never contain provider credentials, raw
invitation bytes, local paths, queries, content, provider payloads, or terminal
logs. A successful event commit is an observed lifecycle attempt, not proof
that the employee saw the UI response.

Event delivery is at least once. The Authority applies exact idempotency and
rejects the same event identity with different canonical bytes. Polling or a
replayable ordered event feed is preferred over using unordered webhook
arrival as the source of truth.

## Error and retry algebra

Internal errors retain their owning layer and stable machine code. Presentation
maps them into the five public onboarding states without destroying the code
needed for support and exact retry.

| Class | Examples | Behavior |
| --- | --- | --- |
| Human input | Missing pin, Granola consent, Slack challenge, macOS permission. | Pause without consuming a new operation ID. |
| Administrator prerequisite | Missing plan, inactive organization tool, absent central grant. | Notify admin; employee flow polls or resumes. |
| Retryable availability | Network loss, provider unavailable, Authority 503, download interruption. | Keep exact prepared intent and retry with bounds. |
| Closed denial | Wrong pin, wrong person, revoked membership, plan/profile mismatch. | No broader fallback; preserve evidence and stop. |
| Local conflict | Existing unrelated config/state/service, symlink, wrong owner or filesystem. | Inspect only; never overwrite or guess ownership. |
| Unknown external outcome | Timeout after enrollment, link, event, or receipt submission. | Reconcile or exactly replay; never create a replacement effect. |
| Post-commit failure | Product work or append may have occurred after activation. | Stop unsafe work and fix forward; no automatic state rewind. |

Provider and Authority transports must preserve status and stable error code to
the coordinator. They may redact bodies at the presentation boundary, but a
generic message must not erase the difference between denial, unavailability,
conflict, or response loss.

## Concurrency and ownership

- One machine-wide launcher lock serializes installation pointer changes.
- One profile lock serializes onboarding, update, restore, and service
  lifecycle for an installation.
- Canonical path and installation identity, not the spelling of a CLI path,
  determine lock ownership.
- The coordinator owns all child tasks and cancellation. No adapter health,
  provider poll, enrollment refresh, or lifecycle event outlives the flow that
  started it.
- A second process may inspect public status but cannot mutate the active
  transaction.
- Signals leave a durable resumable intent and stop or quarantine owned child
  processes before exit.

## Threat analysis and required controls

### Invitation theft or same-channel pin substitution

The bearer grant and independent pin remain separate. The launcher verifies
the descriptor and signed plan against the independently entered pin before
release or enrollment mutation. A stolen invitation without the pin cannot
silently choose another Authority.

### Provisioning profile escalation

The plan is signed and re-fetched after enrollment. The profile is never used
as a permission allow. Central policy still requires current membership,
installation, identity, binding, and grant. Unknown profile or capability
values fail closed.

### Secret leakage through resumption

Transactions, events, logs, crash reports, arguments, environment summaries,
and diagnostics contain opaque credential references only. Tests scan stdout,
stderr, journals, service logs, backups, and lifecycle events for invitation
and credential material.

### Partial local creation

All new paths are canonical, direct, private, local-filesystem paths. Config,
pointer, plan, and transaction publication uses create-exclusive staging,
exact validation, atomic rename, file sync, and parent sync. Existing unknown
content is never adopted by name alone.

### External response loss

Stable operation IDs and request bytes are persisted before the call.
Authoritative lookup or exact replay resolves the outcome. A new operation ID
is forbidden until the previous operation is terminal.

### Moving release pointer

The update claims an exact directive sequence and artifact identity before
quiescing. Resume uses those bytes even if a newer release becomes current.
Only an unclaimed candidate can be superseded.

### In-place package corruption

The stable launcher and active product live in separate versioned locations.
Candidate installation cannot damage the running or retained previous version.
The active pointer changes only after candidate verification.

### Rollback after disclosure or append

Candidate quarantine prevents product work before commit. After activation,
the transaction records the forward-only boundary; local backups are not used
to pretend external writes never happened.

### Configuration reinterpretation

Pending approvals and external effects retain their frozen adapter and policy
contracts. Onboarding or update may change configuration only through existing
compatibility and frozen-publication preflight. It does not reinterpret
pending work using the new config.

### Overbroad fallback

Missing profile, adapter, permission, or provider state never activates a
broader default profile, anonymous mode, legacy adapter, local-only access, or
old credential.

## Compatibility and migration

### Existing installed contributor/reviewer profiles

The first implementation slice may coordinate today's exact
contributor/reviewer bootstrap on an already installed, verified package. It
must store its own transaction and remove the follow-up command chain, but it
does not satisfy the clean-Mac launcher goal.

Existing configs remain valid. Their inferred profile is
`contributor_reviewer` only after exact config and central binding inspection.
Inference never creates missing bindings or rewrites credentials. A normal
existing installation is routed to update; an ambiguous one is preserved.

### Existing per-Mac Slack bot credentials

They remain readable only for the old config version during migration. The
new profile migrates to the centrally owned Slack tool under stopped
reconfiguration and frozen-pending-work preflight. The old secret is deleted
only after the new central binding and exact profile are active and its
provider-side revocation/retirement policy is known.

### Existing global npm installation

The stable launcher imports one exact verified installation into a versioned
directory without modifying it in place. It proves package identity before
switching the service entrypoint. The old global tree is retained until the
new launcher-managed version is healthy and its recovery window closes.

### Invitation compatibility

Current V1 invitation validation remains supported. The signed onboarding plan
may initially travel as a second file in the private package. A future
invitation schema may embed it only after protocol review; the bearer grant is
never put into a non-secret plan or status event.

## Implementation ownership

The expected source boundaries are:

- `packages/organization-api/`: signed onboarding-plan and lifecycle-event
  contracts, validators, canonicalization, and HTTP shapes;
- `services/organization-authority/`: plan ownership, current prerequisite
  checks, exact lifecycle-event idempotency, profile status, and the no-content
  permission readiness operation;
- `src/product/onboarding/`: coordinator, transaction parser/store, step
  algebra, reconciliation, profile composition, and presentation model;
- `src/product/organization/`: enrollment and plan clients, Slack identity-link
  coordination, and current access refresh;
- `src/product/update/`: exact release claim, versioned candidate lifecycle,
  quarantine, reconciliation, activation, and rollback;
- `src/product/`: profile-aware config, operator status, doctor, service, and
  command dispatch;
- `src/adapters/`: employee-owned credential verification and provider-specific
  health without authorization widening;
- `tools/` and release workflows: sealed runtime production, launcher signing,
  publication, and exact-artifact evidence; and
- `tests/product/`, `tests/machine/`, service tests, and protocol tests: failure
  injection and end-to-end qualification.

The coordinator depends on ports for clock, randomness, filesystem,
credential store, launcher, release source, enrollment, plan, adapter setup,
service, doctor, permission readiness, and lifecycle events. Domain step logic
must not call process-global filesystem, terminal, network, launchd, or provider
APIs directly.

## Existing issue ownership

This RFC coordinates existing work rather than hiding it in a new umbrella
implementation:

| Issue | Responsibility in this design |
| --- | --- |
| 18 and 19 | An enrolled installation can recover stale Authority trust without being stranded or silently accepting a new Authority. |
| 25 | Canonical source and release protection remains the publisher-side trust boundary. |
| 26 | The stable launcher consumes one complete offline-installable Darwin arm64 runtime bundle. |
| 27 | Exact release claim, supersession, lease, and fleet coordination. |
| 30 | Idempotent publication of the exact tested release bytes. |
| 51 | Employee-facing onboarding coordinator and acceptance outcome. |
| 52 | Employee-facing automatic update and recovery outcome. |
| 53 | Cross-issue readiness ordering and closure discipline. |

Implementation PRs close leaf issues only with their own tests and evidence.
Completing one RFC slice is not permission to close a dependency whose exact
acceptance conditions remain open.

## Delivery slices

Each slice ends with an independently reviewable behavior and does not claim
the final clean-Mac outcome early.

### Slice 1: Durable coordinator over the installed package

- Add `echo-brain onboard` as one coordinator around existing bootstrap,
  enrollment refresh, service install/start, profile doctor, and readiness.
- Derive standard config/state paths and retain the existing exact
  contributor/reviewer inputs where they cannot yet be derived.
- Persist a secret-free transaction and prepared effect identities.
- Resume after interruption without repeating enrollment or service creation.
- Replace the `next_steps` command list with the public status algebra.

Exit: on an already verified compatible installation, one command reaches the
same safe state as the current multi-command ceremony. This is source-tested
and founder-rehearsal only, not clean-Mac qualified.

### Slice 2: Signed plan and profile-aware readiness

- Add the signed onboarding plan and post-enrollment confirmation.
- Add reader, contributor, reviewer, and combined profile composition.
- Make status and doctor require only profile-relevant services/adapters.
- Add the no-content permission readiness operation.
- Remove user-entered IDs and paths now supplied by the plan or central state.

Exit: reader onboarding requires no adapter credential or LaunchAgent;
contributor and reviewer flows ask only for their required human actions.

### Slice 3: Organization-owned Slack onboarding

- Drive Slack link begin/complete inside the coordinator.
- Poll or reconcile exact central link, binding, and grant state.
- Remove the per-employee Slack bot-token prompt from new profiles.
- Migrate an existing local Slack credential only through stopped exact
  reconfiguration and explicit retirement evidence.

Exit: a reviewer pauses only for the Slack human challenge; no Slack token,
channel ID, user ID, binding ID, or admin command crosses the employee UI.

### Slice 4: Stable sealed launcher

- Build and sign the stable launcher and complete Darwin arm64 runtime bundle.
- Install into immutable version directories and use an atomic active pointer.
- Route LaunchAgent execution through the launcher.
- Import or preserve existing global installations without in-place mutation.

Exit: a clean supported Mac begins from one artifact/entrypoint and needs no
preinstalled Node, npm, global package, PATH edit, or terminal recipe.

### Slice 5: Automatic resumable update

- Reuse launcher verification and versioned installation.
- Add background download/preflight, exact directive claim, reconciliation,
  quarantine, atomic activation, and honest rollback boundary.
- Preserve enrollment, key, credential references, config, state, and pending
  frozen work.
- Add maintenance policy, defer, and one-time sensitive-migration consent.

Exit: every healthy profile reaches the exact approved version or returns to
the previous healthy tuple without shell remediation or credential re-entry.

### Slice 6: Fleet status and qualification

- Add non-secret central onboarding/update status and actionable admin views.
- Run the ten-profile failure matrix and macOS machine tests.
- Produce exact artifact, config, state, and evidence receipts.
- Update architecture, invariants, failure patterns, runbooks, qualification,
  and release claims only after their corresponding evidence exists.

Exit: issues 51 and 52 may close only when their named acceptance outcomes are
proven on one exact artifact. Issue 53 remains the broader readiness tracker.

## Test and qualification plan

### Deterministic coordinator tests

- Table-test every state transition and reject unknown or noncanonical journal
  fields.
- Crash before and after every prepared intent, external call, local mutation,
  atomic rename, receipt write, pointer switch, and service transition.
- Re-run from every crash point and assert the same operation identity and
  exactly one accepted effect.
- Inject response loss after the Authority or provider commits successfully.
- Inject a stale or conflicting response for the same operation identity.
- Prove cancellation drains owned work and leaves no provider poll or service
  callback alive.

### Onboarding integration matrix

- Clean reader, contributor, reviewer, and combined profiles.
- Wrong pin, wrong Authority, tampered plan, profile escalation, wrong provider
  person, missing provider scope, unavailable provider, and expired invitation.
- Invitation expiry before consumption and response loss after consumption.
- Existing healthy install, older updater-capable install, partial local
  staging, retired founder residue, nonlocal filesystem, symlink ancestor,
  wrong owner/mode/ACL, and path alias.
- Reboot or process death at every durable boundary.
- Two concurrent launches for one plan and ten independent plans with no
  identity, key, path, credential, or service crossover.
- Secret scans across process arguments, environment summaries, stdout,
  stderr, journal, receipts, lifecycle events, service logs, and backups.
- Human-pause accounting: every pause maps to an allowed human action and
  deterministic pauses equal zero.

### Update integration matrix

- Already current, one version old, deferred, superseded before claim,
  interrupted download, corrupt bundle, insufficient disk, expired access,
  stale Authority trust, config incompatibility, migration failure, candidate
  doctor failure, restart failure, receipt response loss, and power loss.
- Failure injection across quiesce, backup, migration, version-pointer commit,
  service generation change, quarantine release, and healthy receipt.
- Prove no provider, approval, delivery, organization append, or ordinary
  product work occurs while the candidate is quarantined.
- Prove pre-activation failure restores the complete old package/config/state/
  service tuple and post-activation failure never silently rewinds state.
- Prove two aliases cannot update one installation concurrently and a claimed
  release cannot drift to a newer directive.

### Founder and client evidence boundaries

Source tests and CI do not make the flow founder-live or client-live
qualified. The first exact-artifact founder run must record:

- number and type of human pauses;
- time to profile-specific ready;
- exact release, launcher, config, state, plan, and Authority identities;
- resume behavior after at least one real interruption;
- adapter and permission readiness without content in diagnostic evidence;
- update to a second exact release and either healthy activation or proven
  rollback; and
- absence of secrets and private content from tracked evidence.

Client Live remains a separate promotion stage.

## Alternatives considered

### Keep the README ceremony and improve wording

Rejected. The user remains the distributed transaction coordinator, and
documentation cannot make response loss, package replacement, or partial state
safe.

### Add a friendly wrapper around `bootstrap`

Rejected as the final design. It can provide Slice 1 value but cannot install
or repair the runtime it needs to execute, survive replacement of its own
package, or establish versioned launcher ownership.

### Require every employee to configure every adapter

Rejected. It expands the secret and provider failure surface, confuses
provisioning with permission, and makes readers and reviewers depend on
irrelevant ingestion infrastructure.

### Copy a founder or teammate config/state directory

Rejected. It reuses installation identity, private keys, credentials,
high-watermarks, and mutable state across people and machines.

### Keep Slack bot credentials on every Mac

Rejected for new profiles. The Slack app is organization-owned, and repeating
its secret creates unnecessary rotation, support, and compromise surface.

### Continue global in-place npm replacement

Rejected as the final update substrate. A partial install can damage the only
CLI/updater path and cannot provide atomic version activation.

### Build a web-only onboarding portal

Rejected as the sole coordinator. A portal cannot prove or mutate local
filesystem, runtime, key, service, and package state transactionally. A browser
may host human consent while the signed local coordinator retains ownership.

### Adopt WorkOS now

Deferred. WorkOS could later reduce identity, OAuth, or enterprise provisioning
plumbing, but it would not remove the need for the launcher, local transaction,
profile-aware config, update quarantine, ECHO permission checks, or exact
resume semantics. Adding it before these boundaries are stable would create a
second source of onboarding state.

## Adversarial review questions

The review should attempt to disprove at least these claims:

1. Can a stolen invitation, altered plan, or local profile edit broaden
   permission or bind the wrong person?
2. Is any effect still represented only by a mutable phase rather than a
   prepared operation plus authoritative reconciliation?
3. Can a crash after remote success create a second enrollment, installation,
   Slack link, grant, lifecycle event, or update receipt?
4. Can a secret enter arguments, environment, transaction state, logs,
   diagnostics, backups, or central status?
5. Can a reader be forced to configure a service or adapter it does not need?
6. Can contributor or reviewer onboarding fall back to a broader profile when
   a required adapter is missing?
7. Can the launcher or updater replace the executable currently coordinating
   recovery?
8. Can candidate service work escape quarantine before the rollback-safe
   boundary?
9. Can local rollback erase or contradict an external provider action or
   append-only organization effect?
10. Can a moving release, alias path, second process, reboot, or stale response
    change the identity of an active transaction?
11. Does the no-content readiness operation actually exercise the required
    permission dependencies without opening or returning content?
12. Are any administrator prerequisites still converted into employee shell
    instructions?
13. Is any profile field secretly functioning as an authorization allow?
14. Can existing pending approvals be reinterpreted by onboarding or update
    config changes?
15. Which proposed port, schema, or status is unnecessary and can be removed
    without weakening the guarantees?

## Acceptance decision

Before implementation, adversarial review must resolve:

- the signed plan transport and post-enrollment confirmation;
- the exact launcher trust, signing, and distribution boundary;
- the profile-aware config migration from today's fixed profile;
- the organization-owned Slack transport boundary;
- the no-content permission readiness contract;
- the update quarantine and activation transaction; and
- the minimum status events needed for support without creating a second
  mutable source of truth.

Accepted choices should be extracted into ADRs and invariants. Reusable defects
found during implementation should become failure-pattern records. Exact
readiness claims require a qualification matrix and immutable report rather
than updates to this RFC.
