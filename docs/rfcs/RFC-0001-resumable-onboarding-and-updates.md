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

The first adversarial review of RFC commit
`bf3c8a52578db563e62d73a3951392a4a299d46d` found one approval-transport gap
and thirteen related trust, identity, liveness, and proof-algebra gaps. This
revision resolves them at four shared roots:

1. an organization-owned credential is useful only when the owning boundary
   also owns the provider operation, idempotency, reconciliation, and receipt;
2. stable member profile, per-invitation flow, private identity/credential
   store, mutable state, and backup are separate ownership domains;
3. the launcher owns an execution gate and recovery term, not merely a PID lock
   or a path to the current product; and
4. central status is derived from Authority facts and signed terminal receipts,
   not a second client-pushed lifecycle-event history.

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
timeout means failure. A replacement effect is allowed only after the owning
boundary has made the earlier attempt terminal and recorded explicit
supersession; it is never an accidental retry with a new identity.

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
- provider credentials, installation keys, mutable state, and backup share one
  filesystem ownership boundary;
- the updater lock and normal product-work lock are different protocols;
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
   installation without accepting unauthenticated pre-enrollment events.
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
- Automatic Authority trust-pin or signing-key rotation. Minimum V1 supports
  the initial independent pin and same-pin endpoint/CA rebind only; any other
  trust change fails closed for administrator handling under issues 18 and 19.
- Authority-managed fleet artifact leases. Minimum V1 freezes a completely
  verified artifact locally before mutation; broader fleet coordination in
  issue 27 remains a separate design.

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
| `denied` | Trust, identity, access, or plan binding failed closed. | Supply new valid trusted input or wait for an administrator action. |
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

- plan ID, monotonic plan revision, optional superseded plan ID, and schema
  version;
- Authority, organization, principal, and membership identities;
- an invitation binding containing the canonical Authority origin and ID,
  organization and membership IDs, principal ID from the issued grant,
  invitation command ID, and enrollment-grant digest;
- membership type and human-readable organization display name;
- provisioning profile and required capabilities;
- exact approved bootstrap release identity and compatibility tuple;
- safe adapter instance choices, approval-routing policy, organization-owned
  tool binding IDs, and any bounded activation-intent ID;
- issued and expiry timestamps; and
- the Authority signature and signing-key identity.

The plan contains no bearer grant, provider credential, private key, raw
provider identity roster, or permission allow. Its profile is a provisioning
request, not an authorization decision.

The launcher verifies the plan signature using the independently pinned
Authority descriptor. Before it reserves a profile or asks for a provider
credential, it requires every invitation-binding field to equal the validated
invitation and its issued grant. Independently valid but differently bound
artifacts are a closed denial. After enrollment, it fetches the current plan
again through the installation-signed channel and requires the same plan ID,
revision, invitation binding, and profile before activating any capability.

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

Slack approval is organization-owned only when the central integration
boundary owns the operation as well as the credential. The existing local
approval adapter is currently the only code that publishes approval cards and
polls their reactions. Removing its token without replacing that operation
would break approval. Minimum V1 therefore adds an Authority-owned Slack
approval relay with these contracts:

- the Authority alone resolves the active organization Slack credential and
  makes provider publish/read calls;
- an installation sends a signed, capability-scoped publish or observe
  command bound to the approval ID, frozen presentation and policy digests,
  organization tool, channel policy, and one stable operation ID;
- the publish command carries one bounded canonical card payload; only the
  private relay outbox may persist those bytes, while status, audit summaries,
  and receipts retain digests and provider references only;
- the relay persists a canonical outbox intent before a provider call and an
  immutable provider-reference receipt after it;
- a deterministic non-secret publication marker lets the relay reconcile an
  unknown provider outcome before reposting; zero, one, or ambiguous exact
  matches respectively mean post, accept, or fail closed; and
- the product consumes only the Authority decision receipt, which re-proves
  the current link, binding, action grant, policy, provider identity, and exact
  frozen card. It never polls Slack or receives the organization token.

The local Slack approval adapter is retained only inside stopped legacy
migration. No local Slack approval adapter runs in a new organization-owned
profile; deterministic rendering moves behind the Authority relay contract.
A contributor's plan selects a central approval-routing policy rather than
copying one reviewer identity into the contributor's config.

Slack identity linking has its own attempt protocol. The private store holds
the raw challenge code, stable begin/complete request IDs, attempt ID, and
provider reference only for the bounded challenge lifetime. The public
onboarding transaction holds opaque references and digests. The Authority
returns the existing attempt or result for an exact replay. If the private
code is irrecoverably lost or expires, the coordinator first makes that
attempt terminal, records `expired` or `superseded`, and only then creates one
replacement attempt. That explicit bounded supersession is not represented as
an idempotent replay.

```text
prepared_private -> begin_prepared -> challenge_posted -> proof_observed
  -> linked -> activation_pending -> granted
any non-terminal attempt -> expired | superseded
```

An activation intent has one of two closed subject modes:

- `exact_subject` contains the immutable Slack user ID already known and
  verified by the administrator; the observed link must equal it before link,
  binding, and grants commit atomically; or
- `confirm_after_link` creates no grant. After link verification, the
  Authority presents the exact provider subject to a currently authorized
  administrator, whose separate confirmation atomically activates the exact
  binding and grants.

Wildcard workspace membership, display-name matching, and email-only matching
are forbidden grant inputs. Intent creation and confirmation derive the
administrator from current Authority state; request fields cannot self-assert
administrator membership. A missing, expired, consumed, or mismatched intent,
or an unconfirmed linked subject, becomes `waiting_for_administrator`. The
employee never transfers provider or binding IDs between terminals.

Granola is employee-owned in V1. Its credential is collected through one
hidden local prompt and committed to the governed private store only after
exact owner verification. A browser authorization flow is deferred until it
has its own exact callback and resume contract. The onboarding transaction
stores only an opaque credential reference and verification receipt, never
the credential or a reusable digest of it.

Adapter transport, identity, scopes, and health remain independently verified
at their owning boundary. A generic `connected` boolean is not enough to mark
an adapter ready.

## Stable launcher and versioned installation layout

The clean-Mac launcher has a stable signed bootstrap anchor and a versioned
launcher engine. The anchor's surface is intentionally narrower than the
product. It resolves the active launcher engine, can start the retained prior
engine for recovery, and is replaceable only by a separately signed and
notarized installer. The anchor embeds the allowed publisher trust root,
signing policy, and Team ID. Launcher pointers and promotion records are
selection data only: before every engine execution, including `pending` and
`last_healthy`, the anchor revalidates the canonical signed engine manifest,
every bundle-file digest, code signature/notarization, contained immutable
path, and allowed signer. A pointer or promotion record can never make
unverified bytes executable. If no retained engine verifies, the anchor fails
closed to the separately signed repair installer. The versioned engine owns:

- platform and filesystem preflight;
- verification and installation of one complete offline-capable runtime
  bundle;
- versioned product directories;
- the active-version pointer;
- the machine-wide resume agent and installation execution gate;
- invocation of the product coordinator from the exact installed version; and
- recovery into either the previous healthy version or a preserved state.

The launcher engine is updated through its own transaction. The active engine
stages and verifies a new immutable engine and records it as `pending` for the
next process invocation. The stable anchor verifies the candidate's signed
manifest, launches it in a no-product-work promotion probe, independently
checks that it can resolve and verify the active product tuple, and only then
writes the durable `last_healthy` promotion record and clears `pending`. A
pending engine is never fallback authority. A crash, failed probe, or missing
promotion record makes the anchor choose the retained `last_healthy` engine.
Plans and release directives carry minimum anchor and launcher-engine versions
plus a launcher/product protocol range. If the anchor or all retained engines
are below the required floor, product mutation stops at
`waiting_for_administrator`; an older launcher never interprets a newer plan.

The product must not replace the executable currently coordinating its own
replacement. Every LaunchAgent points at the stable anchor, which resolves the
committed launcher and product pointers. A product release is installed into a
new immutable version directory and verified in place. No global npm prefix is
mutated in-place during normal onboarding or update.

Conceptual layout:

```text
~/Library/Application Support/Echo Brain/
  launcher/anchor/
  launcher/versions/<launcher-identity>/
  launcher/active-launcher.v1.json
  installs/<release-identity>/
  active-installation.v1.json
  onboarding/<flow-id>/
  updates/<installation-id>/<transaction-id>/
  profiles/<profile-id>/config/runtime.json
  profiles/<profile-id>/state/
  private-store/<profile-id>/credentials/<adapter-binding-id>/
  private-store/<profile-id>/installation/keys/
  backups/<profile-id>/<backup-id>/
```

Minimum V1 supports one active organization membership profile per macOS user
and therefore one active product pointer and execution gate. The plural
directories retain staged, abandoned, or migration evidence; they do not imply
simultaneous active profiles. A second active membership on the same account is
`preserved` for a later multi-profile design rather than sharing the global
pointer unsafely. Multi-employee tests use separately rooted launcher fixtures
or separate OS accounts/Macs.

Exact paths remain an implementation decision of the launcher and are never
user input. Directories and files use the current ownership, mode, ACL,
canonical-path, local-filesystem, and no-symlink rules. The pointer and every
transaction file are canonical, exact-key, atomically replaced, and durably
synced with their parent directory.

The private store is not a child of profile state and is never included in a
state backup. Config stores opaque governed references into that store.
Backups may contain private product content, but their manifest must declare
`contains_credentials: false`, bind the stable profile identity, config/state
schema, and credential-reference-set digest, and contain neither provider
credentials nor installation keys. Restore verifies those bindings and never
opens, creates, overwrites, deletes, or rolls back the private store.

One machine-wide resume agent belongs to the launcher, not to a contributor
service. It starts at login and on a bounded maintenance schedule, reconciles
every non-terminal onboarding, launcher-update, and product-update transaction
before starting new work, and uses no provider or organization-content
adapter. A reader skips the ingestion worker, not this coordinator. An
interactive launcher invocation performs the same reconciliation first.

## Onboarding transaction

### Identity and storage

The stable local profile ID is derived only from the Authority, organization,
and membership IDs. It names one member's private store, config, mutable state,
and service ownership across invitation re-issue. It never contains a plan,
invitation command, or bearer-grant value.

A flow ID is separately derived from the signed plan ID and revision,
invitation command, Authority, organization, membership, and enrollment-grant
digest. It identifies one attempt, not the member profile. A newer
Authority-signed plan for the same stable profile may supersede an expired or
abandoned flow and adopt its exact reservation only after checking the prior
flow's effect boundary. The profile reservation carries the accepted plan
revision. A stale or parallel flow cannot mutate or activate the profile after
a newer revision owns it. A changed capability set enters explicit migration
or `preserved`; it never overwrites the reservation by inference.

The transaction is secret-free. Secret-bearing invitation, short-lived Slack
challenge, provider credential, and installation-key material remain in the
separate private store with independent lifecycle rules.
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
- `terminal_denied`;
- `terminal_abandoned`; or
- `terminal_preserved`.

`running` is not a durable truth. A process can die immediately after a side
effect and before recording completion. On restart, any `prepared` or
`reconciling` step observes local or authoritative remote state before deciding
whether to accept or replay the same operation.

`retryable` is a presentation result with a retry policy over a prepared or
reconciling operation, not a durable phase. Transport recovery never changes
the operation identity.

### Ordered flow

1. **Classify the machine.** Inspect platform, disk, paths, prior launcher,
   existing installations, service ownership, retired residue, and partial
   flows without mutation.
2. **Verify trust and plan.** Parse the private invitation, compare the
   independently entered pin, verify the Authority descriptor and signed plan,
   verify expiry and compatibility, and require the exact invitation-binding
   tuple to match. No profile path is reserved and no provider input is
   requested before this check succeeds.
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
   required by the signed profile. Store secrets outside the transaction and
   mutable state. Granola uses the one hidden local prompt in V1.
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
    the same flow using the private attempt record and stable begin/complete
    operation IDs. Poll for the exact link and either exact-subject activation
    or post-link administrator confirmation. Then require the exact binding,
    intent consumption, and grant receipt. The employee is never told to pass
    IDs to an administrator.
13. **Install and start service when required.** Reader-only profiles skip this
    step by contract. Contributor profiles install the stable-launcher
    LaunchAgent, start in readiness quarantine, and prevent product work until
    readiness commits.
14. **Run profile doctor.** Use a profile-derived check set; do not require
    irrelevant services or adapters.
15. **Run a no-content permission readiness probe.** Use an explicit
    readiness-only target in the existing permission-check operation family.
    Exercise installation signature, current Person resolution, active access,
    applicable policy, generation readiness when required, final fence
    availability, and audit writability without returning organization content
    or opening unrelated adapter planes.
16. **Activate.** Prepare the exact signed `ready` receipt, commit the active
    profile/version pointer while the execution gate and service remain
    quarantined, submit and reconcile that receipt under the Authority-owned
    terminal projection key, persist the accepted receipt, and only then open
    the gate and release normal work. An unknown receipt outcome remains
    quarantined and replays the same bytes; it never reports `ready` or rolls
    back until Authority outcome is known.

The no-content probe is not a new authorization family and is not a magic
search query that might accidentally match private content. It must share the
same live identity and permission dependencies as the corresponding read path
while returning only readiness booleans and opaque digests permitted by its
contract. Revoked or inactive access must deny before any adapter, index, or
content plane opens.

The current schema-v3 permission check is hard-coded to one Slack approval
reaction and cannot represent this probe. Minimum V1 adds a closed
`profile_readiness_v1` target as a new version of the existing signed
`POST /v1/permission-checks` operation family. Its exact request binds:

- Authority, organization, enrollment, installation, installation key, and
  current membership identities;
- current signed plan ID and revision plus its invitation-binding digest;
- one canonical profile and exact sorted capability set;
- request ID, requested timestamp, HTTP method/path, and installation
  signature; and
- no provider subject/event, approval/card, query, content, or local-path
  field.

The Authority verifies the current installation key, membership, enrollment,
access lease, current plan revision, and capability-specific control-plane and
serve-readiness facts. Read capability checks the same admitted Layer 1/2
generation and final-fence availability used by readable search, but through a
readiness port that is structurally unable to construct provider clients or
open fact, index, or content handles. Reviewer readiness checks current exact
link/binding/grant and central relay availability from Authority-owned state;
it does not call Slack. The response contains only schema/kind, request digest,
`allowed`, a closed reason code, evaluation time, and authorization-audit
record ID and entry digest. Exact audit failure returns unavailable and no
success.

## Resume and abandonment rules

### Before central enrollment

The flow can abandon cleanly by deleting only its uncommitted staging area and
unreferenced version directory. Invitation and credentials are removed only
according to their own ownership rules. An expired invitation may be reissued:
the newer signed flow adopts the same membership-derived profile reservation
under its higher plan revision, while the old flow becomes terminal. Existing
active profiles are untouched.

### After enrollment and before activation

Enrollment is an append-only central fact and cannot be erased by deleting
local files. Abandonment must use an installation-signed or administrator
authorized central operation to revoke or mark the incomplete installation
abandoned. The local private key and receipt are preserved until that outcome
is durably known. A second onboarding attempt does not reuse or conceal the
abandoned installation.

State backup and restore never include the private identity/credential store.
A restore is valid only for the same stable profile and exact
credential-reference-set digest, and it leaves every credential and
installation-key byte unchanged.

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

The machine-wide launcher resume agent may prepare an update while the current
profile remains healthy. It is also the named owner after reboot and for reader
profiles that have no ingestion service. It may:

1. request the applicable signed release directive;
2. download the exact sealed bundle;
3. verify approval, manifest, artifact, provenance, compatibility, downgrade
   policy, disk space, paths, config/state identity, credential references,
   backup eligibility, and retained previous bytes;
4. install and inspect the candidate in an inactive version directory; and
5. record the candidate as staged without stopping product work.

No release is claimed merely because it is currently pointed to by the
Authority. Minimum V1 uses a local claim, not an invented fleet lease. Only
after the complete bundle is verified and retained in an immutable candidate
directory does the installation durably bind its transaction ID, directive
sequence, manifest digest, artifact digest, source SHA, version, and local
candidate identity. Resume uses those exact retained bytes without consulting
the moving current directive. A newer directive may supersede only staged,
unclaimed work. Authority-managed artifact retention and cross-installation
leases remain issue 27 scope.

### Update transaction phases

Minimum V1 has seven durable local states:

```text
staging -> claimed -> switching -> healthy
   |          |          |------> rolled_back
   |          |-----------------> rejected
   |----------------------------> rejected
              any unsafe ambiguity -> preserved
```

`staging` includes offer discovery, download, and verification while the active
tuple is untouched. `claimed` freezes exact local candidate bytes while the old
profile still works. `switching` owns durable substeps for quiesce, backup,
migration, candidate doctor, pointer activation, and quarantine release.
`rejected` is terminal only when the active tuple was never mutated, so it does
not pretend a rollback occurred. A switching failure before activation proves
and records `rolled_back`; an indeterminate effect or unsafe post-activation
failure is `preserved` and fixed-forward. `retryable` is an outcome over the
current state, never a phase.

Each mutation phase persists intent before effect and reconciles the exact
effect after interruption. Reconciliation checks the actual version pointer,
installed bytes, config digest, state generation, backup receipt, service
owner, and doctor receipt. It does not infer success from phase order.

### Execution gate, quarantine, and commit boundary

Before the first active-tuple mutation, update takes the installation's
exclusive execution gate, durably changes it from `open` to `draining`, rejects
new product work as retryable, stops the managed worker, and drains every
outstanding work lease. It records `fenced` only after no provider, Authority,
delivery, approval, or append effect remains live. Backup, migration, and
pointer mutation are forbidden before that receipt. A crash or reboot leaves
the gate fenced until exact transaction reconciliation chooses the old or new
tuple.

The candidate service starts in update quarantine. It may open only the local
state and non-mutating diagnostic dependencies required for migration and
doctor. It cannot poll providers, publish Slack cards, resolve approvals,
deliver output, append organization records, or perform ordinary product work.

Activation is one durable boundary:

1. candidate bytes, config, migration, local doctor, and permission readiness
   are proven;
2. the exact signed healthy receipt intent is prepared;
3. the active-version pointer and service generation are committed while the
   execution gate remains fenced and the candidate remains quarantined;
4. the Authority validates, stores, and returns the exact terminal projection
   receipt, whose accepted bytes are persisted locally; and
5. only then is the candidate released from quarantine and the gate opened.

An unknown step-4 outcome keeps the candidate fenced and replays the same
receipt. It cannot roll back or release work until reconciliation proves
whether the Authority accepted `healthy`. Once accepted, recovery is
fixed-forward even if the final local release step fails.

Before terminal receipt acceptance is known, and only after reconciliation
proves it was not accepted, the complete previous package/config/state/service
tuple may be restored. Receipt acceptance is the forward-only control-plane
boundary; quarantine release can then create provider or append-only effects
that independently make rewind unsafe. Recovery after either boundary is
fixed-forward unless a separately proven backward-compatible rollback can
preserve the accepted projection and every committed effect. The UI and fleet
state call this boundary out explicitly.

### User interaction

Normal approved updates are prepared and applied automatically by the launcher
resume agent or on the next launcher invocation. Maintenance-window and defer
UI are outside minimum V1. The user is asked only to approve one clearly
explained security-sensitive, non-backward-compatible migration.

Retries of the same exact approved migration do not request consent again.
The employee is never asked for a config path, Node/npm command, service
command, credential, access refresh, backup action, or doctor action.

The final result is exactly one of `updated`, `already_current`, `rejected`,
`rolled_back`, `retryable`, or `preserved` with one stable reason code.

## Central status and privacy

Central status is a projection, not a client-authored event history.
Pre-enrollment `started` and `waiting_*` states are local and explicitly
unauthenticated; the Authority does not accept them or reserve their flow IDs.
The only pre-enrollment remote mutation is the existing signed enrollment
request plus enrollment-grant digest. Grant consumption, enrollment creation,
and the Authority's `enrolled` fact commit atomically, and exact request replay
returns the stored result.

Minimum central onboarding status is derived as follows:

- `invited` or `expired` from the bounded enrollment grant;
- `enrolled` from the accepted enrollment and current installation access;
- `ready` from one installation-signed immutable onboarding receipt;
- `abandoned` from an installation-signed or administrator-authorized terminal
  operation; and
- `preserved` from an installation-signed terminal receipt after enrollment.

An installation signature is necessary but not sufficient to change this
projection. At receipt acceptance the Authority re-resolves the exact current
enrollment, active installation key, membership, access, plan revision, and
invitation binding. The onboarding receipt binds the enrollment and
installation IDs, stable membership profile, plan ID/revision, flow ID,
invitation command/grant digest, exact product/launcher/config identities, and
one legal terminal result. The Authority owns one terminal projection key per
installation and plan revision. Exact replay returns its stored receipt; a
second receipt ID, different bytes, stale/revoked installation, or illegal
terminal transition is rejected and cannot affect status.

Administrator prerequisites are derived from current plan, organization-tool,
activation-intent, membership, and installation facts. Employee-only waiting
states remain private local presentation. No unauthenticated client can squat a
deterministic flow ID or publish a false central blocker.

Minimum central update status reuses the current directive plus one signed
terminal update receipt. Its six projected values are `no_release`, `pending`,
`healthy`, `rolled_back`, `rejected`, and `preserved`.
Download and switching detail remains in the local secret-free transaction;
it is not a second mutable central state machine.

The update receipt binds one Authority-owned projection key consisting of the
installation ID and update transaction ID to the exact issued directive
sequence, source/manifest/artifact identities, and legal terminal result. The
Authority re-proves the active installation and exact issued-directive history
before acceptance, then permits only exact replay for that projection key. An
older validated outcome remains immutable history; when a newer directive is
current, installation status is simply `pending`. A stale or revoked signer
and a receipt for an unknown directive never create a fleet state.
Directive-history validation is distinct from an artifact lease; minimum V1
still makes no central byte-retention claim.

Validated terminal projection receipts contain exact source/artifact/config
identities, stable
result codes, and required timestamps. They never contain provider
credentials, raw invitation bytes, local paths, queries, content, provider
payloads, or terminal logs. Receipt submission is at least once, but alternate
receipt identities cannot bypass the Authority-owned projection key. A
successful commit records an attempted outcome, not proof that the employee
saw the UI response.

## Error and retry algebra

Internal errors retain their owning layer and stable machine code. Presentation
maps them into the six public onboarding states without destroying the code
needed for support and exact retry.

| Class | Examples | Behavior |
| --- | --- | --- |
| Human input | Missing pin, Granola consent, Slack challenge, macOS permission. | Pause without consuming a new operation ID. |
| Administrator prerequisite | Missing plan, inactive organization tool, absent central grant. | Notify admin; employee flow polls or resumes. |
| Retryable availability | Network loss, provider unavailable, Authority 503, download interruption. | Keep exact prepared intent and retry with bounds. |
| Closed denial | Wrong pin, wrong person, revoked membership, plan/profile mismatch. | No broader fallback; preserve evidence and stop. |
| Local conflict | Existing unrelated config/state/service, symlink, wrong owner or filesystem. | Inspect only; never overwrite or guess ownership. |
| Unknown external outcome | Timeout after enrollment, link, relay publication, or receipt submission. | Reconcile or exactly replay; supersede only after the owning boundary makes the prior attempt terminal. |
| Post-commit failure | Product work or append may have occurred after activation. | Stop unsafe work and fix forward; no automatic state rewind. |

Provider and Authority transports must preserve status and stable error code to
the coordinator. They may redact bodies at the presentation boundary, but a
generic message must not erase the difference between denial, unavailability,
conflict, or response loss.

## Concurrency and ownership

- One machine-wide launcher mutation lease serializes launcher and product
  pointer changes.
- One per-installation execution gate has a durable term and the states `open`,
  `draining`, `fenced`, and `recovering`. Every product-work ingress, including
  the managed worker and manual `run-once`, must acquire a non-transferable
  work lease for the current term before constructing adapters or contacting a
  provider or Authority. Direct product-binary invocation that bypasses the
  launcher gate is unsupported and refused.
- Onboarding, update, restore, and service lifecycle take the same gate. Update
  obtains its exclusive mutation lease only after durable drain intent and all
  work leases have ended.
- Canonical path and installation identity, not the spelling of a CLI path,
  determine lock ownership.
- Process exclusion uses a kernel-backed advisory lock held for the process
  lifetime. Persisted diagnostics include boot-session ID, PID, process-start
  token, installation, operation, random owner token, and gate term, but are
  never liveness authority. A contender overwrites stale diagnostics only
  after acquiring the kernel lock; it never reclaims by mtime or `kill(pid, 0)`
  alone. Kernel release on exit or reboot prevents PID reuse from wedging V1.
- The coordinator owns all child tasks and cancellation. No adapter health,
  provider poll, enrollment refresh, or receipt submission outlives the flow that
  started it.
- A second process may inspect public status but cannot mutate the active
  transaction.
- Signals leave a durable resumable intent and stop or quarantine owned child
  processes before exit.
- Every launcher start and resume-agent tick reconciles non-terminal
  transactions before admitting ordinary product work.

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

Transactions, receipts, logs, crash reports, arguments, environment summaries,
and diagnostics contain opaque credential references only. Tests scan stdout,
stderr, journals, service logs, backups, and terminal receipts for invitation,
challenge, installation-key, and credential material. State backups assert
`contains_credentials: false`; legacy state-root credentials must be relocated
or the installation is preserved before the new backup/update path runs.

### Independently valid but differently bound artifacts

Plan signature, invitation validation, and Authority pin verification are not
separate success flags. Their exact Authority origin/ID, organization,
membership, principal, command, and grant-digest tuple must agree before local
reservation or credential collection. A reissued invitation creates a new flow
for the same membership profile and must carry a newer current plan revision.

### Organization credential without organization operation ownership

Removing a local Slack token is safe only after the central relay owns publish,
reconciliation, decision observation, and immutable receipt. Slice 3 cannot
claim success from identity linking alone; it must prove an approval card round
trip with no local Slack credential.

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

The update locally claims an exact directive sequence and completely verified
immutable candidate before quiescing. Resume uses those retained bytes even if
a newer directive becomes current. Only staged, unclaimed work can be
superseded; V1 makes no central lease or artifact-retention claim.

### In-place package corruption

The stable launcher and active product live in separate versioned locations.
Candidate installation cannot damage the running or retained previous version.
The active pointer changes only after candidate verification.

### Launcher below the product protocol floor

The plan and directive state their minimum launcher and protocol range. A
compatible launcher engine is updated and made healthy before product
mutation. If the stable anchor cannot start any compatible engine, the flow
waits for the signed administrator installer rather than guessing how to
interpret the newer plan.

### Reboot, PID reuse, or work during quiesce

Kernel-backed exclusion supplies liveness; persisted process identity is
diagnostic only. The durable execution-gate term survives process loss, so a
reboot does not reopen product work during an unresolved switch. All effectful
product entrypoints use that gate, not only the managed service.

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

### Existing state-root credentials and installation keys

The current layout places provider credentials and the installation key below
`state_dir`, and current backup deliberately copies them. Before an imported
installation can use the V1 backup or automatic-update path, a stopped
relocation transaction must:

1. classify every current credential and installation-key file without
   printing its value;
2. create the canonical private-store target with no-overwrite semantics;
3. move and rebind exact governed references atomically;
4. prove the old state-root secret paths are absent and the service can resolve
   only the new references; and
5. create a credential-free state backup whose restore leaves the private store
   byte-identical.

Unknown, duplicated, aliased, or partially moved secret material yields
`preserved`; update may not silently retain a secret-bearing backup format.

### Existing per-Mac Slack bot credentials

They remain readable only for the old config version during migration. The
new profile migrates to the Authority-owned Slack relay under stopped
reconfiguration and frozen-pending-work preflight. The old secret is deleted
only after the relay has completed one exact approval round trip, the new
central binding and exact profile are active, and its provider-side
revocation/retirement policy is known.

### Existing global npm installation

The stable launcher imports one exact verified installation into a versioned
directory without modifying it in place. It proves package identity before
switching the service entrypoint. The old global tree is retained until the
new launcher-managed version is healthy and its recovery window closes.

### Invitation compatibility

Current V1 invitation validation remains supported. The signed onboarding plan
may initially travel as a second file in the private package. A future
invitation schema may embed it only after protocol review; the bearer grant is
never put into a non-secret plan or status receipt. The separate files must
carry the exact invitation binding described above.

## Implementation ownership

The expected source boundaries are:

- `packages/organization-api/`: signed onboarding-plan, invitation-binding,
  Slack-relay command/receipt, and terminal onboarding/update receipt
  contracts, validators, canonicalization, and HTTP shapes;
- `services/organization-authority/`: plan ownership, current prerequisite
  checks, derived profile/update status, exact relay and terminal-receipt
  idempotency, Slack approval relay, activation-subject confirmation, and the
  readiness-only permission-check mode;
- `src/product/onboarding/`: coordinator, transaction parser/store, step
  algebra, reconciliation, profile composition, and presentation model;
- `src/product/organization/`: enrollment and plan clients, Slack identity-link
  attempt coordination, Slack approval-relay client, and current access
  refresh;
- `src/product/update/`: exact release claim, versioned candidate lifecycle,
  quarantine, reconciliation, activation, and rollback;
- `src/product/`: profile-aware config, private-store and backup boundaries,
  operator status, doctor, service, and command dispatch;
- `src/adapters/`: employee-owned credential verification and provider-specific
  health without authorization widening;
- `tools/` and release workflows: stable anchor, versioned launcher engine,
  execution gate and resume agent, sealed runtime production, launcher signing,
  publication, and exact-artifact evidence; and
- `tests/product/`, `tests/machine/`, service tests, and protocol tests: failure
  injection and end-to-end qualification.

The coordinator depends on ports for clock, randomness, filesystem,
credential store, launcher, release source, enrollment, plan, adapter setup,
service, doctor, permission readiness, relay, and terminal receipts. Domain step logic
must not call process-global filesystem, terminal, network, launchd, or provider
APIs directly.

## Existing issue ownership

This RFC coordinates existing work rather than hiding it in a new umbrella
implementation:

| Issue | Responsibility in this design |
| --- | --- |
| 25 | Canonical source and release protection remains the publisher-side trust boundary. |
| 26 | The stable launcher consumes one complete offline-installable Darwin arm64 runtime bundle. |
| 30 | Idempotent publication of the exact tested release bytes. |
| 51 | Employee-facing onboarding coordinator and acceptance outcome. |
| 52 | Employee-facing automatic update and recovery outcome. |
| 53 | Cross-issue readiness ordering and closure discipline. |

This RFC does not close issues 18, 19, or the fleet-lease portion of 27.
Minimum V1 supports initial independent pinning, same-pin endpoint/CA rebind,
and one local immutable artifact claim. Any trust-pin/key change becomes
`waiting_for_administrator`; any central lease or multi-installation rollout
claim requires its own reviewed protocol. Those issues remain explicit
dependencies, not table-assigned promises without a mechanism.

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
- Inject a real interruption after one prepared external effect and resume with
  the same operation identity without repeating enrollment or service
  creation.
- Replace the `next_steps` command list with the public status algebra.

Exit: on an already verified compatible installation, one command reaches the
same safe state as the current multi-command ceremony, and `ONB-RESUME-01`
and `ONB-PREAUTH-01` pass. This is source-tested and founder-rehearsal only,
not clean-Mac qualified.

### Slice 2: Signed plan and profile-aware readiness

- Add the signed onboarding plan, exact invitation binding, plan revision and
  profile-reservation adoption fence, and post-enrollment confirmation.
- Add reader, contributor, reviewer, and combined profile composition.
- Make status and doctor require only profile-relevant services/adapters.
- Add the readiness-only target to the existing permission-check family.
- Establish the separate private-store and credential-free backup boundary.
- Remove user-entered IDs and paths now supplied by the plan or central state.

Exit: reader onboarding requires no adapter credential or profile ingestion
LaunchAgent (the machine-wide launcher resume agent is not product work);
contributor and reviewer flows ask only for their required human actions, and
`ONB-PLAN-BIND-01`, `ONB-REISSUE-01`, `ONB-BACKUP-PRIVATE-01`, and
`ONB-PROBE-REVOKED-01` pass.

### Slice 3: Organization-owned Slack onboarding

- Drive Slack link begin/complete inside the coordinator.
- Add the Authority-owned approval-card publish/observe relay and immutable
  decision receipt.
- Persist the bounded private challenge attempt and reconcile or explicitly
  supersede it.
- Poll exact central link, subject-confirmation, binding, and grant state.
- Remove the per-employee Slack bot-token prompt from new profiles.
- Migrate an existing local Slack credential only through stopped exact
  reconfiguration and explicit retirement evidence.

Exit: a reviewer pauses only for the Slack human challenge; no Slack token,
channel ID, user ID, binding ID, or admin command crosses the employee UI. One
contributor decision is published, reacted to, authorized, and resolved
end-to-end with zero local Slack credential, and
`ONB-SLACK-RELAY-01`, `ONB-SLACK-RESPONSE-LOSS-01`, and
`ONB-ACTIVATION-SUBJECT-01` pass.

### Slice 4: Stable sealed launcher

- Build and sign the stable anchor, versioned launcher engine, and complete
  Darwin arm64 runtime bundle.
- Add staged next-exec launcher update, minimum-version/protocol floors, a
  retained compatible engine, and pre-health recovery.
- Install the machine-wide resume agent and execution gate before profile
  activation.
- Install into immutable version directories and use an atomic active pointer.
- Route LaunchAgent execution through the launcher.
- Import or preserve existing global installations without in-place mutation.

Exit: a clean supported Mac begins from one artifact/entrypoint and needs no
preinstalled Node, npm, global package, PATH edit, or terminal recipe;
`LCH-TRUST-01`, `LCH-FLOOR-01`, `LCH-LOCK-REBOOT-01`, and
`LCH-READER-RESUME-01` pass.

### Slice 5: Automatic resumable update

- Reuse launcher verification and versioned installation.
- Add background download/preflight, local exact-artifact claim, seven-state
  reconciliation, execution-gate drain, quarantine, atomic activation, and
  honest rollback boundary.
- Preserve enrollment, key, credential references, config, state, and pending
  frozen work.
- Add one-time sensitive-migration consent; maintenance-window and defer UI
  remain outside minimum V1.

Exit: every healthy profile reaches the exact approved version or returns to
the previous healthy tuple without shell remediation or credential re-entry.
`UPD-EXEC-GATE-01`, `UPD-REJECT-01`, `UPD-CLAIM-RESUME-01`, and the required
exact-artifact hardware rollback `UPD-ROLLBACK-MACHINE-01` pass.

### Slice 6: Fleet status and qualification

- Add derived non-secret central onboarding/update status and actionable admin
  views from Authority facts and terminal receipts; do not add a client event
  stream.
- Run the ten-fixture failure matrix and macOS machine tests.
- Produce exact artifact, config, state, and evidence receipts.
- Update architecture, invariants, failure patterns, runbooks, qualification,
  and release claims only after their corresponding evidence exists.

Exit: `STATUS-TERMINAL-01` passes, and issues 51 and 52 may close only when
their named acceptance outcomes are proven on one exact artifact. Issue 53
remains the broader readiness tracker.

## Test and qualification plan

### Named minimum acceptance rows

These rows are release gates, not illustrative test ideas:

| ID | Required proof |
| --- | --- |
| `ONB-RESUME-01` | Crash immediately before and after the persisted enrollment call and service creation; rerun the same entrypoint and prove the same operation IDs, exactly one enrollment, and exactly one service identity. |
| `ONB-PREAUTH-01` | Fabricated or conflicting pre-enrollment `started`/`waiting` flow IDs create no Authority state; exact signed enrollment response-loss replay yields one server-derived enrollment. |
| `ONB-PLAN-BIND-01` | Any Authority, origin, organization, membership, principal, command, grant-digest, plan-revision, or profile mismatch denies before profile reservation or provider input. |
| `ONB-REISSUE-01` | Reserve a profile, expire and reissue the invitation, then prove the new flow adopts the same membership-derived profile while the stale flow cannot mutate or activate it. |
| `ONB-BACKUP-PRIVATE-01` | Relocate a legacy secret-bearing state safely; prove new backup contains no credential/key bytes, cross-profile or reference-set restore is denied, and restore leaves the private store byte-identical. |
| `ONB-PROBE-REVOKED-01` | Revoke access before the readiness probe; prove closed denial, no activation, no content, and no provider/index/content plane opened. |
| `ONB-SLACK-RELAY-01` | With no local Slack credential, publish one real contributor approval card through the central relay, observe one decisive reaction, authorize it, and resolve the decision from the exact Authority receipt. |
| `ONB-SLACK-RESPONSE-LOSS-01` | Lose responses after challenge post, card post, and decision observation; resume the same attempts/receipts without an unintended duplicate. When the private challenge is irrecoverable, prove explicit terminal supersession before one replacement. |
| `ONB-ACTIVATION-SUBJECT-01` | Exact-subject mismatch creates no binding/grant; confirm-after-link creates no grant until a current administrator confirms the exact observed subject. |
| `LCH-TRUST-01` | Tamper the engine pointer, promotion record, manifest, signature, signer identity, and one engine byte in turn; prove the anchor executes no unverified candidate and uses only a freshly verified retained engine or the signed repair boundary. |
| `LCH-FLOOR-01` | A product plan above the active launcher floor blocks product mutation; launcher-first staged next-exec update succeeds, and failure at every engine-pointer/health boundary restores a compatible retained engine. |
| `LCH-LOCK-REBOOT-01` | A prior-boot diagnostic with a PID reused by an unrelated live process cannot wedge or grant the kernel lock; a real concurrent holder remains exclusive. |
| `LCH-READER-RESUME-01` | Reboot a reader during onboarding and during a claimed update; the machine-wide resume agent reconciles once with no ingestion adapter or content access. |
| `UPD-EXEC-GATE-01` | Hold product work through a provider/append effect, start update, and prove drain waits for its terminal receipt; work started after drain intent is rejected before adapter construction, including after reboot. |
| `UPD-REJECT-01` | An invalid or incompatible candidate before quiesce ends `rejected` with the active tuple unchanged and no rollback claim. |
| `UPD-CLAIM-RESUME-01` | Claim exact candidate bytes, publish a newer directive, crash during switching, and prove resume uses only the original locally claimed bytes. |
| `UPD-ROLLBACK-MACHINE-01` | On the exact signed artifact and real Mac, inject candidate doctor failure after backup/migration and prove old launcher/product pointers, service, config/state digests, and credential references are restored with no external work. |
| `STATUS-TERMINAL-01` | Submit onboarding and update terminal receipts under active installations; prove exact replay returns one projection, alternate IDs/bytes or illegal transitions conflict, and revoked/stale signers cannot change status. Response loss before an activating `ready`/`healthy` outcome is resolved keeps candidate work quarantined; a non-activating result never opens candidate work or stops the retained healthy tuple. |

### Deterministic coordinator tests

- Table-test every state transition and reject unknown or noncanonical journal
  fields.
- Crash before and after every prepared intent, external call, local mutation,
  atomic rename, receipt write, pointer switch, and service transition.
- Re-run from every crash point and assert the same operation identity and
  exactly one accepted effect.
- Inject response loss after the Authority or provider commits successfully.
- Inject a stale or conflicting response for the same operation identity.
- Prove a sanctioned replacement effect requires an explicit terminal
  supersession receipt for the prior attempt.
- Prove cancellation drains owned work and leaves no provider poll or service
  callback alive.

### Onboarding integration matrix

- Clean reader, contributor, reviewer, and combined profiles.
- Wrong pin, wrong Authority, tampered plan, profile escalation, wrong provider
  person, missing provider scope, unavailable provider, and expired invitation.
- Invitation expiry before consumption and response loss after consumption.
- Reissued invitation after profile reservation, stale-flow activation, and
  conflicting plan/invitation binding.
- Slack challenge/card response loss, private-code loss and expiry, exact
  subject mismatch, post-link administrator confirmation, and one end-to-end
  contributor approval with no local Slack credential.
- Revoked access before readiness and legacy state-root secret relocation,
  credential-free backup, and credential-preserving restore.
- Existing healthy install, older updater-capable install, partial local
  staging, retired founder residue, nonlocal filesystem, symlink ancestor,
  wrong owner/mode/ACL, and path alias.
- Reboot or process death at every durable boundary.
- Two concurrent launches for one plan on one Mac, plus ten independent plans
  in separately rooted launcher fixtures or OS accounts, with no identity,
  key, path, credential, or service crossover.
- Secret scans across process arguments, environment summaries, stdout,
  stderr, journal, receipts, private/public boundary projections, service logs,
  and backups.
- Human-pause accounting: every pause maps to an allowed human action and
  deterministic pauses equal zero.

### Update integration matrix

- Already current, one version old, superseded before claim,
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
- Race effectful `run-once` with drain intent; prove no active-tuple mutation
  until its receipt is durable and no new work constructs an adapter after the
  gate leaves `open`.
- Simulate reboot with a reused PID and prove kernel exclusion plus the durable
  gate term, not the persisted PID record, controls recovery.

### Founder and client evidence boundaries

Source tests and CI do not make the flow founder-live or client-live
qualified. The first exact-artifact founder run must record:

- number and type of human pauses;
- time to profile-specific ready;
- exact release, launcher, config, state, plan, and Authority identities;
- resume behavior after at least one real interruption;
- adapter and permission readiness without content in diagnostic evidence;
- update to a second exact release with healthy activation, plus the required
  exact-artifact real-machine rollback row `UPD-ROLLBACK-MACHINE-01`; and
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
   Slack link, approval card, grant, or terminal receipt?
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
11. Does the readiness-only permission check actually exercise the required
    permission dependencies without opening or returning content?
12. Are any administrator prerequisites still converted into employee shell
    instructions?
13. Is any profile field secretly functioning as an authorization allow?
14. Can existing pending approvals be reinterpreted by onboarding or update
    config changes?
15. Which proposed port, schema, or status is unnecessary and can be removed
    without weakening the guarantees?

## First adversarial review resolution

This table records design closure only. Every row remains unimplemented until
its named slice and acceptance proof pass.

| Finding | Root closure in this revision |
| --- | --- |
| F1 | Organization-owned Slack now includes an Authority publish/observe relay and exact decision receipt; Slice 3 requires a real approval round trip without a local token. |
| F2 | Provider credentials and installation keys move to a separate private store; state backup/restore is credential-free and cannot touch that store. |
| F3 | Pre-enrollment progress is local-only; central onboarding status is derived from grant/enrollment facts and post-enrollment signed terminal receipts. |
| F4 | A publisher-root-pinned anchor revalidates every selected engine and owns staged next-exec update, protocol floors, durable promotion, retained-engine recovery, and the fail-closed signed repair boundary. |
| F5 | Stable profile identity is membership-derived; per-invitation flow identity and monotonic plan-revision adoption are separate. |
| F6 | Activation intents permit exact provider subject or post-link administrator confirmation only; wildcard identity cannot create grants. |
| F7 | Every effectful product ingress participates in the launcher execution gate; quiesce drains that same gate before mutation. |
| F8 | Kernel-backed exclusion owns liveness; boot/PID/start diagnostics cannot reclaim or wedge the lock. |
| F9 | Slack challenge secret and operation IDs live in a bounded private attempt; retry reconciles, while replacement requires explicit expiry/supersession. |
| F10 | Local claim and a seven-state update algebra replace the undefined fleet claim; `rejected` closes the untouched pre-mutation path, and issues 18/19/27 are no longer implied. |
| F11 | A machine-wide launcher resume agent owns reboot recovery and reader updates independently of the ingestion service. |
| F12 | The signed plan carries and verifies the exact invitation-binding tuple before reservation or provider input. |
| F13 | The client lifecycle-event stream, maintenance/defer UI, path-policy field, standalone readiness operation, and browser Granola flow were removed from minimum V1. |
| F14 | Slice exits now cite mandatory resume, reissue, revoked-probe, relay, launcher, execution-gate, claim-resume, and real-machine rollback rows. |

## Acceptance decision

Before implementation, adversarial review must resolve:

- the signed plan transport and post-enrollment confirmation;
- the exact invitation binding and membership-derived profile identity;
- the exact launcher anchor/engine trust, self-update, signing, protocol floor,
  and distribution boundary;
- the profile-aware config migration from today's fixed profile;
- the separate private-store and credential-free backup/restore boundary;
- the Authority-owned Slack relay and closed activation-subject boundary;
- the readiness-only permission-check contract;
- the execution-gate, reboot, and reader-resume protocol;
- the update quarantine and activation transaction; and
- the minimum derived status and signed terminal receipts needed for support
  without creating a second mutable source of truth.

Accepted choices should be extracted into ADRs and invariants. Reusable defects
found during implementation should become failure-pattern records. Exact
readiness claims require a qualification matrix and immutable report rather
than updates to this RFC.
