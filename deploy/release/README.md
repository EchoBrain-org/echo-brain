# Organization Authority release and update procedure

This directory contains the small release boundary used after the first live
organization release. It selects exact artifacts, never migrates state, and does
not manage client fleets.

For a change that needs matching server and client versions, follow
[Coordinated server and client release](#coordinated-server-and-client-release).
Staging alone does not finish that workflow or make a client available to
`echo-brain update`.

The runtime-profile field is current-only. A pre-beta Authority prepared with
an older release record has no compatibility bridge. `clean-v1` describes an
artifact replacement loop, not a database migration: it accepts only the
current Authority V12, private-approval control-plane V3, record-log V4,
retrieval facts V3, retrieval content/lexical V2, and six-role V2 root lineage.
For populated state, `stage` pulls the immutable
candidate and runs its state-lineage and admitted-processor verifiers in an
isolated read-only container before any runtime, configuration, or state
mutation. V12 is fresh-state only: the founder confirmed that existing
development data is disposable and there are no live users, so the earlier
pre-V10 staging conversions and offline copiers were removed (git history keeps
them). The historical project-context sprint used fresh V7 state and PC-06 reset/reseed,
as described in the [PC-01 handoff](../../docs/product/2026-09-21-project-context-pc01-persistence.md).
An incompatible baseline requires a new, explicitly designed migration or an
authorized reset. For an authorized reset with no live users,
run `onboard-clean-v1.sh
replace-rehearsal --confirm-no-live-users`, then prepare the organization again
with the new release record and matching profile. Ordinary `stage` never migrates an older baseline.

Historical baseline verification now uses Git history. The retention statements
in [ADR-0017](../../docs/decisions/ADR-0017-project-meeting-approval-v1.md)
and [ADR-0018](../../docs/decisions/ADR-0018-project-settings-v1.md) describe
the checkout before this cleanup; the exact SQL and loaders remain available at
commit `83c8eb63aed78ba760678294ecf7fef863743e06`. They are no longer shipped
in the current packages or image.

Before installing this tooling over an older host wrapper, confirm that no
staged candidate has a migration operation under
`clean-data/release/state-v5-to-v6/` or `state-v8-to-v9/`. The current wrapper
does not read those journals. An outstanding migration must be reconciled
using its matching historical tooling before replacement; preserve its state
and evidence. Source cleanup does not perform that host transition.

## Coordinated server and client release

This is the end-to-end **staging** release procedure under the
[Authority operator playbook](../../docs/operations/PB-OPERATIONS-001-authority-operator-lane.md).
It joins the existing host-release and signed-feed commands into one operator
workflow. They keep separate receipts and recovery rules; there is no atomic
transaction between the server and feed. This procedure does not authorize
production/client-live deployment or change their approval boundaries.

| Phase | What it proves |
| --- | --- |
| Prepared | Exact candidate artifacts and unsigned feed inputs exist for review. Nothing has been accepted or published. |
| Staged | The candidate is running on the staging host. The prior record remains accepted. Existing clients already reach the candidate. |
| Server accepted | Promotion completed and a fresh host status confirms the candidate as accepted. The client feed may still advertise the prior release. |
| Client published | The signed feed and both platform artifacts are verified and currently installable. This does not prove a client has updated. |
| Client verified | Representative native Mac and Linux clients activated the published release and passed authenticated read and cited-Ask checks. |

Report a coordinated release complete only after the last phase and any affected
desktop distribution checks. State the environment and seats actually verified;
representative acceptance is not proof that every enrolled seat updated.

### Prepare the transition before staging

1. Record the accepted server, candidate, currently published feed and actual
   clients that use this Authority. Compare API routes, request/response schemas
   and installation types using source SHA and artifact identity, not just the
   displayed product version. A version string may be reused. `update --status`
   is saved local state; `update --check` contacts the configured signed feed.
2. Review compatibility **before `stage`**, because it replaces the running
   server on the shared staging host. Prefer a transition that keeps existing
   clients working while updates arrive. If compatibility is absent, require
   an explicitly coordinated maintenance/update window with the affected seats
   and recovery plan identified before activation. A candidate canary after
   staging cannot protect those seats from a breaking API change.
3. Prepare one canonical release record, immutable image, matching runtime
   profile and exact Person-client tarball using the sections below. Build both
   CLI kits from that release: macOS arm64 and Linux x64/glibc. Preserve the
   accepted baseline and operation receipts. Prepare any affected Electron
   desktop artifact through its own packaging lane; the CLI feed does not
   distribute desktop apps.
4. Prepare the unsigned feed bundle using the existing
   [feed preparation command](../../docs/features/client-updates-v1.md#preparing-an-approved-feed).
   `prepare` needs no final authorization and can use the candidate's canonical
   record. Keep the enrolled feed URL, channel and public key, advance the
   sequence, and choose sufficient validity for approval and distribution.
   For replacement, bind the predecessor to the preserved most-recent succeeded
   publication/replacement receipt's `hashes.feed.json`, not a guessed value
   from the mutable endpoint. Ensure the existing hosting and signer are ready.

Current Ask follows [ADR-0022](../../docs/decisions/ADR-0022-agentic-ask-only.md):
`/v1/person/ask` and `/v2/person/ask` are retired and return 404; matching clients
use `/v3/person/ask`. There is no implemented legacy bridge or dedicated
"update required" response to rely on. A transition plan must reflect that
contract. Do not treat this guide as implementing such a bridge.

A release that ships [ADR-0024](../../docs/decisions/ADR-0024-person-list-open-and-mine-scope.md)
(Person list, open by ref and the mine scope) has no compatible transition:

- Every non-Slack Ask citation gains `ref`, while the answer stays
  `echo-clean-person-answer-v4` schema 4. Clients built before ADR-0024
  validate citations with exact keys, so from `stage` onward every cited Ask
  answer fails closed on them. Stage it only inside an announced update window
  with the affected seats named.
- Updated desktops read project pages and Mine through `POST /v1/person/list`
  and `POST /v1/person/open`, which an older server does not serve, so the
  server goes first.
- Publish the CLI feed right after promotion. Desktops embed their own Person
  client and do not update themselves: reinstall each desktop seat through its
  packaging lane.
- Select the minimum client by committed source SHA, not by answer kind or
  schema, which did not change.
- Add a `person list` (global and `--mine`) and a `person open --ref` of a
  listed row to the candidate-client checks, beside record search and cited
  Ask.
- There is no joint rollback after promotion or feed publication; recovery is
  a reviewed forward fix or compatible recovery release (see ADR-0024).

### Qualify and review the exact release once

Use the [automated current-host lane](#automated-current-host-staging-lane) to
stage, run the synthetic canary, obtain the human's private Slack-card approval,
and install/check the exact candidate client. Preserve the candidate's positive
record search and cited Ask evidence. A failing required check stops acceptance.

After those checks, present one final review containing the candidate release
record hash, Person-client artifact hash, canary/read evidence, prepared manifest
hash, channel, sequence, expiry, both platform targets, and expected predecessor
hash for a replacement. Include the compatibility plan and any affected desktop
artifact identity. The human may approve server acceptance and these exact feed
inputs together; reuse that approval while its scope and bytes remain unchanged.
The earlier Slack-card approval remains a separate human action.

Only after that decision create the existing release authorization JSON shown
in the automated lane. Keep its schema unchanged. The separate manifest digest
approval goes to the existing signer/publisher arguments. Unsigned preparation
is available before this decision; **signing preview also requires final
release authorization**, so do not set `release_authorized: true` merely to get
a preview. Review the prepared manifest bytes and digest directly instead.

Sign and seal the approved manifest, then prepare the first-publication or
replacement plan using the [feed guide](../client-updates/README.md). Planning
can establish publication prerequisites before promotion without uploading
objects. If manifest expiry requires new bytes, obtain approval for the new
digest; do not silently substitute it under the prior approval.

### Promote, publish, and verify delivery

1. Plan and execute `promote` through `authority:staging-release` with the exact
   release authorization. Confirm completion through its receipt. Then create
   and execute a **fresh** `status` action using the new record for both
   `--accepted-release` and `--release`, with its matching runtime profile.
   Polling the promotion receipt alone is not a fresh runtime check.
2. After that status passes, execute the approved feed publication/replacement
   and inspect its own `status`/`replace-status`. Require `state: "succeeded"`,
   `metadata_fresh: true`, and the reviewed release, manifest and both targets.
   The feed validator verifies authorization and artifact identity but does
   **not** inspect the host's accepted release. Promotion-before-publication is
   an operator requirement, not a cross-service guard implemented by the CLI.
3. On representative native Mac and Linux seats still running release A, verify
   the availability notice while the Person command remains on A, then run
   `echo-brain update` explicitly to install B through the configured signed
   feed. Complete the
   [client acceptance checks](../client-updates/README.md#verify-mac-and-linux-client-activation).
   Preserve existing sessions and use the account's actual permissions. A
   Linux employee's check must use that employee's account and readable
   fixtures; the private owner canary is not an employee test. Record source,
   artifact/release identity, actor, command path and bounded read/Ask outcomes.
4. For an affected desktop app, complete its separate artifact installation and
   authenticated acceptance checks. If the installed desktop is already
   compatible, record that evidence and why an installation is unnecessary.
   Do not infer desktop delivery from a successful CLI update.

Keep one private handoff record linking the release authorization, server action
receipts and fresh status, prepared manifest and publication receipt, both
platform activation/read proofs, and desktop evidence when applicable. Record
remaining seats explicitly. Publication makes the release available; automatic
CLI checks notify on later commands, and installation requires an explicit
`echo-brain update`. Older clients retain their existing update behavior until
the new client is installed; publication does not push this policy to the fleet.

### Resume a partial release

| Observed result | Required continuation |
| --- | --- |
| Remote operation submitted or unconfirmed | Poll the same receipt with its original tooling source. Reconcile that action before creating another; never resend to bypass uncertainty. |
| Staged candidate fails required checks | Run a fresh host status and use the existing exact-candidate rollback lane. Do not publish its feed. |
| Server accepted; publication incomplete | Preserve the accepted record and both lanes' receipts. Diagnose/resume the existing publication operation under its status rules. Report the partial result; do not restage or edit accepted state to make it look complete. |
| Feed published; activation/read proof incomplete | Keep the publication receipt, installation locks and prior releases. Diagnose the actual client/wrapper and resume its supported updater path. Account for already-upgraded seats before another server/feed change. |
| Published metadata expired | Historical `succeeded` with `metadata_fresh: false` is not current delivery proof. Prepare and approve a fresh manifest with a higher sequence through the existing replacement lane. |

The host rollback action requires a staged candidate and unchanged accepted
record. After promotion it is not a general undo button; a required server
recovery needs a separately reviewed compatible release/recovery plan. The feed
has no lower-sequence rollback command. Never delete locks, mutate receipts,
overwrite feed objects manually, or infer a new authorization from partial
success.

## Release record

For each candidate, create exactly one non-secret JSON record containing the
source commit, immutable Authority image reference, Person-client package
version and artifact, the reviewed Authority runtime profile, and compatibility
class. The only supported compatibility class is `clean-v1`.

Use the committed-source pack command first. Its JSON output supplies the
client version and SHA-256:

```sh
npm run pack:person-client -- /absolute/private/release-artifacts
```

Build the Authority image from that same committed source with the guarded
build command. Supply the successful CI run ID (`github.run_id`), never the
workflow run number. It refuses a dirty worktree, derives the source SHA
itself, checks that the source stays unchanged during the build, and verifies
the OCI revision label, build-number label, telemetry capability, and image
environment bindings. The deploy verifier requires those identity bindings
for telemetry-capable images and verifies the effective container environment;
older retained images remain rollback-compatible with telemetry disabled.
The release record's `source_sha` must be that exact value; the deploy command
checks the pulled image label before it starts the container.

```sh
npm run build:authority-image -- echo-organization-authority:release-candidate \
  --build-number <successful-ci-run-id>
```

CI separately builds and exercises the Authority for Linux arm64, binding the
commit SHA and successful CI run ID into the image's labels and environment.
That is build provenance, not release authority: CI has no registry credentials.
Publishing the verified image and supplying its immutable ECR digest remain the
release-operator boundary; the digest is the artifact identity accepted by the
release record.

Create the runtime profile from the four reviewed deployment files in the same
committed source, then validate and record its digest. This profile is a
canonical, non-secret capture of both Compose and Caddy files. The release
operator publishes or transfers it alongside the release record; CI never
pushes it or an image to a registry.

```sh
npm run profile:authority-deployment -- \
  deploy/organization-authority \
  /absolute/private/release-artifacts/runtime-profile.json
node tools/clean-v1-runtime-profile.mjs validate \
  /absolute/private/release-artifacts/runtime-profile.json
node tools/clean-v1-runtime-profile.mjs digest \
  /absolute/private/release-artifacts/runtime-profile.json
```

Create a non-secret draft record from the reviewed image digest and pack output,
then canonicalize it once. The output path must not already exist.

```sh
node tools/clean-v1-release.mjs create release-draft.json \
  /absolute/private/release-records/clean-v1-20260822-001.json
node tools/clean-v1-release.mjs validate \
  /absolute/private/release-records/clean-v1-20260822-001.json
```

Its canonical shape is:

```json
{
  "authority_image": {
    "reference": "<aws-account-id>.dkr.ecr.us-west-2.amazonaws.com/echo-brain/authority@sha256:<64-lowercase-hex>"
  },
  "baseline_compatibility_class": "clean-v1",
  "kind": "echo-clean-v1-release",
  "person_client": {
    "artifact_sha256": "<64-lowercase-hex>",
    "artifact_url": "https://downloads.example/echo-brain-person-client.tgz",
    "package": "@echo-brain/person-client",
    "version": "0.1.0-internal.1"
  },
  "release_id": "clean-v1-20260822-001",
  "released_at": "2026-08-22T20:00:00Z",
  "runtime_profile": {
    "artifact_sha256": "<64-lowercase-hex>",
    "artifact_url": "https://downloads.example/echo-brain-authority-runtime-profile.json",
    "profile_version": "clean-v1-profile-1"
  },
  "schema_version": 1,
  "source_sha": "<40-lowercase-hex>"
}
```

The angle-bracket text above is explanatory only; it is not valid record data.
The record contains neither an Authority credential nor an employee session,
invitation, Slack, Granola, or model secret.

## EC2 Authority replacement

For the existing staging host, prefer the
[automated current-host lane](#automated-current-host-staging-lane). The direct
host commands below remain the installed-wrapper contract and human fallback;
they are not permission for an agent to open a shell session.

Keep the three operator lanes separate:

- A new organization uses `onboard-clean-v1.sh prepare` and `resume` for the
  one-time initial-owner setup and finalization.
- An existing organization uses this replacement loop. It preserves identity,
  Slack, provider credentials, private state, and approved records.
- A new employee receives the client kit and a fresh invitation; that does not
  restart initial-owner setup or replace the Authority.

Copy the release validators and operational commands from the exact reviewed
source checkout into the deployment directory beside the clean Compose files.
Before copying, compare the SHA-256 of each source file with the private review
receipt for that source commit. For a normal update, do not edit or pre-install
`current.clean-v1.json` by hand:

```sh
cd /srv/echo-authority-clean-v1
install -d -m 0755 release
install -m 0755 /absolute/reviewed/clean-v1-release.py release/clean-v1-release.py
install -m 0755 /absolute/reviewed/clean-v1-runtime-profile.py release/clean-v1-runtime-profile.py
install -m 0755 /absolute/reviewed/update-clean-v1.sh ./update-clean-v1.sh
install -o root -g root -m 0755 \
  /absolute/reviewed/backup-authority-maintenance.sh \
  ./backup-authority-maintenance.sh
install -d -m 0700 clean-data/release
sha256sum ./backup-authority-maintenance.sh
python3 release/clean-v1-release.py validate /absolute/private/release.json
python3 release/clean-v1-runtime-profile.py validate /absolute/private/runtime-profile.json
./update-clean-v1.sh stage --release /absolute/private/release.json \
  --runtime-profile /absolute/private/runtime-profile.json
```

The printed maintenance-script digest must equal the reviewed receipt before
the script is used. It is root-owned host tooling, not application state:
release rollback does not replace or remove it. Replace or remove it only as a
separately reviewed host-tooling change, and record the old and new digests in
the private operator receipt.

For an ordinary baseline-preserving replacement, stage the exact candidate in
the same way. The command refuses floating images, a reused release ID, a
baseline mismatch, a stopped accepted runtime, or a runtime image digest that
does not match the accepted record. It pulls the candidate digest, starts it,
checks the actual running container image digest plus descriptor and safe setup
status, but does not accept it yet.

```sh
./update-clean-v1.sh stage --release /absolute/private/candidate-release.json \
  --runtime-profile /absolute/private/candidate-runtime-profile.json
```

Apart from its release identity and the release-bound `agentic_ask_v1` and
`small_scope_shortcut` switches,
the candidate's saved environment carries forward every accepted setting, including the staging
`ECHO_STAGING_JOURNEY_CONTENT_TELEMETRY_V1` value that onboarding sets. It never
modifies the accepted snapshot. Do not change telemetry or any other setting by
editing `.env.clean-v1` after promotion: that creates environment drift and
blocks the next release.

`agentic_ask_v1` and `small_scope_shortcut` are the only candidate
configuration settings accepted by this release record. They are booleans in
the canonical candidate bytes, default to `false` for legacy records that
predate them, and are materialized as `ECHO_AGENTIC_ASK_V1=true|false` and
`ECHO_AGENTIC_ASK_SMALL_SCOPE_SHORTCUT=true|false` in that candidate's saved
environment tuple. A true `small_scope_shortcut` requires
`agentic_ask_v1=true`. Since
[ADR-0022](../../docs/decisions/ADR-0022-agentic-ask-only.md) the Authority
ignores `ECHO_AGENTIC_ASK_V1`: agentic Ask is the only Ask and is on whenever
an answer model is configured. The field stays in the record so earlier
records keep their bytes; set it to `true` in new records. The candidate record SHA already bound to the staging
request covers both values. Rollback restores the accepted tuple verbatim,
including earlier flag values or legacy absence. No command accepts arbitrary
environment names or values.

Run the bounded private-DM canary through the selected running release. It
prefers a staged candidate, otherwise uses the accepted release. It refuses any
host except Authority staging, verifies the exact running release, and calls
only the in-container private socket. The printed receipt has only the release
identity, outcome, and opaque approval identity. A `delivery_pending` outcome
is safe to retry; every release uses one stable canary and one Slack message.
Only `staged` succeeds. Other outcomes stop the command without creating
promotion evidence. During a replacement, the accepted image must also
advertise `org.echobrain.authority.state-capability.staging-synthetic-meeting-canary-v1=true`
before the candidate can create synthetic canary state, so the rollback image
can read that state if recovery is needed.

On the designated canary Mac, build and install the candidate release's
verified offline bundle using
[Advanced client-only install or reinstall](#advanced-client-only-install-or-reinstall).
Its default installer exposes the exact candidate binary at
`$HOME/.local/bin/echo-brain`. Approve the resulting private card, then use
that binary to search for the exact release ID and ask one cited question
before making the human promotion confirmation explicit:

```sh
./update-clean-v1.sh canary
"$HOME/.local/bin/echo-brain" person records --query '<candidate-release-id> private owner approval delivery'
"$HOME/.local/bin/echo-brain" person ask --question 'What did we decide for synthetic staging release <candidate-release-id>?'
./update-clean-v1.sh promote --release /absolute/private/candidate-release.json --canary-passed
```

The canary command stores a private receipt bound to the exact selected release.
Every candidate staged by the update tool requires its own `staged` receipt
before promotion. The `--canary-passed` flag remains the operator's explicit
confirmation that the card was approved and both permission-aware reads
succeeded; a receipt from the currently accepted release cannot promote a
different candidate.

If it fails, restore the prior **same-clean-v1** image, runtime profile, and
environment tuple and leave the accepted record unchanged:

```sh
./update-clean-v1.sh rollback
```

For a first deployment, where no accepted release record exists yet, the same
command is an abort: it stops the staged candidate before archiving that
candidate as failed and does not create an accepted record. After it succeeds,
stage the next candidate with a new release ID.

The operation lock prevents concurrent changes. The environment, active
profile, and four materialized deployment files are replaced individually, so
a host power loss or `SIGKILL` during activation can leave a mixed local cache.
The staged candidate record remains the recovery marker: inspect with `status`,
then run `rollback` to rematerialize and verify the complete accepted tuple
before retrying. Do not edit individual tuple files to recover.

For a replacement, rollback must restart and re-check the prior exact image,
profile, and public descriptor before claiming recovery; otherwise it reports
recovery as unconfirmed.

`./update-clean-v1.sh status` inspects the actual running Authority container
and its image digest, not only `.env`; a stopped or drifted runtime fails. It
does not query SQLite or print credentials. No state migration operation
exists; a schema change requires fresh state.
If persisted state lacks the candidate's exact V12/V3/V4 databases, current retrieval schemas, and
V2 root lineage, `stage` refuses before activating or recording the candidate. It does
not attempt to repair, infer, or migrate the state.

### Environment drift before staging

`status`, `stage`, `canary` and `promote` refuse when `.env.clean-v1` differs
from the selected release's saved environment snapshot. There is no automatic
diagnosis or repair: drift blocks staging, and a human on the exact reviewed
staging host investigates the change before any further release action. Do not
paste environment files into chat, and never overwrite an accepted snapshot to
make the equality check pass.

## Automated current-host staging lane

### Local acceptance before review

Run `npm run test:staging-journey` from the working branch before opening a
release-tooling PR. Iterate on that branch until this connected rehearsal and
the focused regressions pass, then run `npm run check` and review the complete
change once. Local tests do not require a merge or permission to deploy.

The rehearsal starts with the reviewed tooling installed, executes the real
release planner, host runner and updater, and connects their canary to a real
local Authority, SQLite state, private socket, card builder and Slack delivery
adapter. It proves unknown-tool refusal, candidate staging, failed-card
publication followed by restart-safe retry, and a durable pending approval
bound to one published card. It never clicks approval, appends an approved
record, or promotes the candidate. The test is included in `npm run check`.

AWS/SSM, container lifecycle/image identity, public TLS routing and provider
responses are simulated. This is an offline integration gate, not proof of an
ECR artifact, real Slack scopes/delivery, live credentials, host state or the
Cloudflare edge. CI retains the separate real-POSIX isolation proof and image
checks. After review/merge, perform one live validation and stop at the actual
human Slack approval boundary. Keep environment-only failures distinct from
code defects; do not claim all external failures can be ruled out locally.

### Live operator boundary

`npm run authority:staging-release` is the local operator's bounded alternative
to copying files into Session Manager. It is restricted to the repository-pinned
staging AWS account, region `us-west-2`, and `echo-authority-staging-v1`. It does not
replace the host, change IAM/CloudFormation/Cloudflare, use the onboarding
transfer bucket, handle invitations, or permit production/client-live release.
Cloud coding tasks still stop before every live operation.

The CLI requires a clean checkout whose exact HEAD is reachable from fetched
`origin/main`. The reviewed CLI and host-runner source, updater and validators
are taken from that commit. Installation also checksum-verifies and updates the
onboarding, retained-restore and backup-maintenance wrappers' interlock checks;
it does not invoke their actions. All six installed tools are checked before
any replacement.
The candidate image/client/profile keep their own
release source identity; a tooling-only update does not rebuild those artifacts.
Fetch and verify reviewed source before planning. The previous tooling source
must also be a full reviewed-main ancestor, not an arbitrary file or command.

Keep the accepted canonical record, candidate canonical record, matching runtime
profile and operation receipts in an operator-owned mode-`0700` directory outside
the checkout; input records/profile and receipts must be mode `0600`. Never add
environment files, tokens, invitations, or credential material. URL metadata
with userinfo, query or fragment is refused. The profile's four files must match
the candidate's committed source exactly.

Plan one named action. Before installing this tooling over older tooling, run a
separate `inspect-install` plan with the same inputs and
`--previous-tooling-source` to confirm that
`clean-data/release/environment-repair.pending.json` is absent. The reviewed
runner checks the already-pinned release directory with `lstat`: any marker,
including a regular file, unsafe symlink, or dangling symlink, returns the fixed
`environment_invalid` refusal without reading marker contents or a target. A
`ready` inspection is the supported confirmation. A present or unsafe marker
requires the human host operator's repair lane; other inspection refusals follow
their existing diagnostic and recovery rules. The updater no longer checks this
marker. For `install`, supply the full source SHA corresponding
to the independently reviewed *currently installed* tooling. Unknown installed
bytes stop instead of being overwritten. Replacing tooling saves private old
copies and hashes; it never edits the accepted release or environment.

`inspect-install` shares the installer's identity, mount, ownership/control-path,
accepted-record, literal environment and hostname, candidate, and old-or-new
tool hash guards, including the environment-repair-marker absence check. It returns `ready` or a fixed refusal
category; `tool_missing`, `tool_file_invalid`, and `tool_hash_unknown` identify one of the six
fixed reviewed tool names. Once the preceding identity, path, accepted-state
and environment-format guards pass, the version-2 diagnostic also includes a
complete `inventory` keyed by those same six names. Each entry has exactly
`state` and `sha256`: `new`, `old`, or `unknown` with a lowercase 64-character
SHA-256 fingerprint, or `missing`/`invalid` with `sha256: null`. New takes
precedence when the old and new reviewed bytes are identical. These labels
describe equality with the request's reviewed hashes, not installation history.

The inventory uses the existing no-follow, regular-file, owner, mode, link-count
and size checks before hashing. It never hashes the environment or follows a
tool symlink to another file. All six entries are collected even when one is
unknown or unsafe; the result retains the first tool refusal in the fixed tool
order and does not claim readiness. Failures before tooling inspection, or unexpected
diagnostic/control-path failures, return no inventory (`null`). Invalid inventory
is redacted to `inspection_failed` on the host before SSM sees it, and the local
validator independently rejects malformed or contradictory state/hash bindings.
A refused or interrupted inspection is not an
installation failure and is never reported as success. No exception text,
wrapper output, environment value, unknown setting name, host-supplied path, or
file content is returned. Identity and retained-mount failures are distinct;
deployment-path, data-ownership and release-control failures have separate
categories. Invalid/unreadable private records and environment files also
produce bounded classifications. Unexpected diagnostic or cleanup failures
return `inspection_failed`, never a successful inspection.

The `installation_failed` result identifies an error during tool installation;
it does not prove that no tooling bytes changed. Generic `precondition_failed`
results, including historical receipts, remain valid and may also represent
partial installation. Inspection
does not retroactively diagnose an old attempt or authorize overwriting unknown
tools. Compare a returned inventory with reviewed repository/artifact history
to establish compatible provenance for the full tool set. Do not infer a
previous source from the candidate image, try arbitrary revisions until a guard
passes, automatically allowlist an unknown digest, or overwrite unknown bytes.
The inventory is evidence, not installation or release authorization.
A ready inspection proves only current prerequisites, not runtime health
or installation completion. Continue to stop on unknown state.

```sh
npm run authority:staging-release -- plan \
  --action install \
  --accepted-release /absolute/private/releases/accepted.json \
  --release /absolute/private/releases/candidate.json \
  --runtime-profile /absolute/private/releases/runtime-profile.json \
  --previous-tooling-source <full-reviewed-installed-tooling-sha> \
  --output /absolute/private/releases/install-operation.json
npm run authority:staging-release -- execute \
  --receipt /absolute/private/releases/install-operation.json
npm run authority:staging-release -- status \
  --receipt /absolute/private/releases/install-operation.json
```

Substitute `--action inspect-install` and use a distinct receipt path for the
non-mutating guard inspection. It never replaces tooling, invokes an updater or
runtime wrapper, restarts containers, changes the environment or release
state, clears locks, or forces progress. It does take the transient root-owned
staging interlock and creates the existing request/result operation journal for
serialization and idempotency. Those bounded files are removed or retained
according to the same guard and changed-control-path rules as every release
action, so inspection must not be described as making zero filesystem writes.

Plans contain non-secret artifacts and expire after 30 minutes. `plan` performs
read-only account, stack, exact-instance, retained-volume and SSM-online checks;
it does not send a command. `execute` repeats target checks before submission.
Plan/execute are mechanical operator steps within the founder's staging
delegation, not a new approval prompt for each command. The only commands sent
are generated from the fixed reviewed host runner. Its compressed non-secret
payload and checksums fit under the CLI's conservative 60-KiB command cap; it
refuses larger artifacts rather than selecting another courier implicitly.

The host independently checks IMDSv2 identity, the mounted retained volume,
its bootstrap-required service ownership (`999:988`, mode `0700`), root-owned
deployment and release-control paths, the literal staging hostname, accepted-record
digest and candidate state. It opens the release directory without following
symlinks, validates the opened inode, and pins the runner's working directory
to it. The updater inherits that working directory and uses relative release
state paths, including exclusive temporary-file creation and publication without
converting relative paths back through `abspath`. Candidate inputs are copied
into the root-owned deployment
interlock, so the updater's input canonicalization cannot follow a swapped
service-owned path. No runtime profile or data-volume permission is changed.

The root-owned `.staging-release-guard` interlock is outside `clean-data` and
outside the container's writable mount. The runner refuses an existing guard
or legacy `clean-data/.authority-operation-lock`; it never deletes that legacy
lock. Updated update/onboarding/backup-maintenance wrappers acquire this same root-owned guard
before their legacy lock and hold it for the entire operation, even if the
service renames the legacy lock. Retained restore holds it through materialization,
onboarding resume, and terminal-status verification without an unlocked handoff.
Only its direct root resume child can inherit the guard, after checking the
private root-owned guard and parent PID; that child never releases the parent
guard. Backup maintenance retains
both locks when restart proof fails, preserving the deliberate-recovery boundary.
Only the runner's updater
child uses the exact nested lock inside its already-held guard.
Keep the single-operator rule, including during the first tooling installation
and retained-host recovery. No raw environment, arbitrary
setting name, wrapper stdout/stderr, or exception string is returned to SSM.

Make a **new plan and receipt** for each subsequent action, reusing the same
accepted/candidate/profile inputs. Omit `--previous-tooling-source` once tooling
is installed; the new installed tools must match the executing reviewed source.

| Action | Preconditions and result |
| --- | --- |
| `inspect-install` | Checks the actual install guards and old-or-new reviewed tooling hashes without replacing tools or invoking runtime behavior. Returns a strictly allowlisted readiness/refusal diagnostic. |
| `status` | Fresh installed-wrapper runtime check, not a cached polling receipt. |
| `stage` | No staged candidate; uses exact candidate/profile. A drifted environment returns `environment_drift`. |
| `canary` | Requires the exact staged candidate; stops for the human to approve its private Slack card. `delivery_pending` is safe to retry with a new canary operation after the first invocation has definitively completed. |
| `rollback` | Requires the exact staged candidate and unchanged accepted record; existing wrapper recovery semantics apply. |
| `promote` | Requires the exact staged candidate, its stored canary receipt, successful exact-client checks, and the separate final founder authorization below. |

`status --receipt` polls that existing operation; it is not `plan --action status`,
which creates a fresh host-runtime check. A `submitted` or `submitting` result
is not success. Poll the same receipt; `execute` on it never sends twice.
The local receipt is synced before `SendCommand`, which has no request-id token.
If its response is lost, polling reconciles the unique operation comment and
exact target. If no command can be established, retain the receipt and stop;
do not create a replacement operation to bypass uncertainty. AWS invocation
visibility can lag submission. Timeout/cancellation/terminal transport failure
is `unconfirmed`, not proof that the runtime stopped or recovery succeeded.
These semantics follow the [Run Command API](https://docs.aws.amazon.com/systems-manager/latest/APIReference/API_SendCommand.html)
and [invocation status contract](https://docs.aws.amazon.com/cli/latest/reference/ssm/get-command-invocation.html).

Plans use request version 4 and a checksum-bound XZ-compressed text bundle
containing the exact reviewed runner and non-secret artifacts. Installed tools travel as checksum witnesses;
`install` carries bytes for changed tools, and witnesses for unchanged tools.
Every installed file still passes owner, mode and old/new hash checks before
any action. Candidate records and profiles always include their exact bytes. The fixed loader
checks its digest and size, reconstructs the canonical request and checks its
digest before invoking the runner. Compression uses the existing operator
Python 3 standard-library `lzma` module with preset 6; only a bundle that otherwise exceeds the command
cap retries preset 6 with extreme search and zero position bits for unaligned
text, retaining the same dictionary size.
Decoding is bounded by both output size and memory. No third-party package or
manual courier is needed. The 60-KiB command cap is unchanged. The CLI and host
runner accept only the current version-4 request, which has no
`content_telemetry` field. Receipts planned by earlier tooling, including
earlier version-4 receipts, can no longer be polled with this CLI: before
switching to it, finish or poll every `planned`, `submitting`, `submitted` or
`unconfirmed` receipt with the commit that planned it. Reconcile any unfinished
command before planning a new operation.

Host-side request/result journals live under
`clean-data/release/remote-operations/<operation-id>/`. A duplicate exact request
returns its completed receipt; incomplete prior execution does not run again.
If the release pathname no longer names the pinned inode, the operation returns
`control_path_changed`, writes only through the original pinned directory, and
retains its root-owned guard and inputs. A replacement tree is never treated as
the accepted control state. Stop for investigation; do not remove or relocate
the guard or any release directory to force a retry.

Never delete a lock or journal to force progress. Unknown
tooling, state mismatch, unsupported environment syntax, unconfirmed execution,
and destructive/infrastructure changes require investigation outside this lane.

After the canary, the human approves the Slack card. The local operator can
install the already-built, checksum-verified offline Person bundle on the
designated canary Mac and run both exact absolute-path Person commands above.
The client's authenticated permission checks remain intact; login/MFA stays
human. Empty records or an uncited/negative answer are not passing checks.
Retain the safe check evidence and ask for the final decision on the exact
candidate. Only after that decision create a private authorization JSON:

```json
{
  "kind": "echo-staging-release-founder-authorization-v1",
  "release_sha256": "<candidate-record-sha256>",
  "person_client_sha256": "<candidate-person-client-artifact-sha256>",
  "slack_approved": true,
  "person_records_passed": true,
  "person_ask_passed": true,
  "release_authorized": true
}
```

This records operator-attested evidence and the human decision; it is not a
cryptographic signature or a replacement for doing the checks. The CLI never
creates it automatically. `plan --action promote` additionally requires
`--approval /absolute/private/releases/founder-authorization.json`. A mismatched
digest or false/missing confirmation refuses before any host command. Blanket
automation permission, code-review approval, a merge, and a canary receipt do
not authorize promotion. After promotion, use the newly accepted record as the
accepted input for subsequent operations and keep the old record as history.
For a fresh post-promotion `status`, pass that new accepted record
to both `--accepted-release` and `--release`, with its matching profile. This
does not stage a candidate or require inventing a future release.

## Person command-line kits

The Person kit is command-line only. The native Swift app, its paired
installer and the graphical `ECHO Setup.app` setup are retired, and no kit
carries a desktop app. There are two kits. Both are built by the same command
from the same accepted release record and exact Person-client tarball:

| Kit | Builder flags | Manifest | Stable command |
| --- | --- | --- | --- |
| macOS arm64 | `--target darwin-arm64 --installation cli-kit` | schema 3, `echo-person-cli-kit-v1` | `~/Library/Application Support/ECHO/cli/bin/echo-brain` |
| Linux x64 | `--target linux-x64 --update-config <public-bootstrap.json>` | schema 2, `echo-person-onboarding-kit-v2` | `${XDG_DATA_HOME:-~/.local/share}/echo/person/bin/echo-brain` |

Each kit is a flat ZIP of eight files under `echo-person-onboarding-kit/`:
`Start-ECHO.sh`, the pinned Node 22.22.1 runtime `node`, `release.json`,
`person-client.tgz`, `build-identity.v1.json`, `kit-manifest.v1.json`, and the
kit's own `verify-person-onboarding-kit.mjs` and `clean-v1-release.mjs`. The
manifest hash-binds the release record, client artifact, build identity and
runtime. The signed [client update feed](../../docs/features/client-updates-v1.md)
delivers these same ZIPs.

The builder refuses anything else. A kit that was already delivered carries its
own installer and verifier, so it keeps working, and the update-feed publisher
checks each kit's setup sources against that release's own source commit.

### macOS arm64 command-line kit

Build on a reviewed macOS arm64 machine running Node 22.22.1, from the clean
commit that the release record names:

```sh
npm run kit:person-onboarding -- \
  --target darwin-arm64 --installation cli-kit \
  --release /absolute/private/current.clean-v1.json \
  --artifact /absolute/private/echo-brain-person-client-0.1.0-internal.1.tgz \
  --runtime-node /absolute/private/node-v22.22.1-darwin-arm64/bin/node \
  --output /absolute/private/ECHO-cli-macos-arm64-source-sha12.zip
```

The runtime must be a thin arm64 Mach-O Node 22.22.1. `--runtime-node`
defaults to the Node that runs the builder. The builder requires clean
committed source that matches the release, rereads the setup sources after
building, and publishes the ZIP and its SHA-256 receipt without replacing
either. Transfer both through an authenticated private channel. The kit is
hash-bound but is not signed by ECHO.

On the Mac:

```sh
unzip ECHO-cli-macos-arm64-source-sha12.zip
./echo-person-onboarding-kit/Start-ECHO.sh --install-only
```

`--install-only` is the only accepted mode; any other argument prints usage.
The installer checks for macOS 14 or later on Apple silicon and for the bundled
runtime, then runs the kit's verifier. It installs a versioned release under
`~/Library/Application Support/ECHO/cli/releases` and atomically replaces the
stable command `~/Library/Application Support/ECHO/cli/bin/echo-brain`. It
prints that path. Use the absolute path or add its directory to `PATH`; setup
never edits shell profiles. It launches nothing and never touches
`~/Applications`. Reinstalling the same release is safe. Earlier releases are
retained, and a private lock blocks a concurrent or interrupted installation.

Then sign in with the installed command:

```sh
"$HOME/Library/Application Support/ECHO/cli/bin/echo-brain" person login \
  --invitation /absolute/private/ECHO-invitation-XXXXXXXX/person-invitation.json \
  --open-browser
```

An existing member uses `person login --authority-url <url> --open-browser`
instead. After sign-in, `person records --limit 20` checks one
permission-aware read. Owners issue, reissue, list and
revoke invitations with `person employee invite|reissue|list|revoke`. The
Person session stays at `~/.local/share/echo-brain/person`. Installing or
updating the CLI never moves it. Enrolling the installed command in the signed
update feed is described in
[client updates](../../docs/features/client-updates-v1.md#trusted-bootstrap).

### Employee machine requirements and handoff

The shipped targets are **macOS ARM64 (Apple silicon)** and **Linux x64
(x86_64)**. CPU architecture alone does not identify a compatible kit.

| Kit | Required machine | Bundled executables and tools |
| --- | --- | --- |
| macOS ARM64 | macOS 14 or later, Apple silicon | The only bundled native executable is Node 22.22.1, a thin arm64 Mach-O. The installer checks the macOS version, the CPU and the runtime header before activation. Standard macOS utilities are used during installation. CLI only. |
| Linux x64 | Linux kernel 4.18 or later, glibc 2.28 or later, x86_64 | The only bundled native executable is Node 22.22.1. Its system libraries must be available, including libstdc++; the installer checks that this exact runtime can start. Bash, unzip, tar/gzip and standard core utilities are required. CLI only. |

The Linux prerequisites follow the pinned [Node 22.22.1 build contract](https://github.com/nodejs/node/blob/v22.22.1/BUILDING.md).
Ubuntu 22.04+ and Debian 12+ are the intended distro class; passing prerequisite
checks is not certification of every distro at the numeric floor. Neither kit
uses system Node/npm, downloads dependencies, or requires a compiler during
installation. `--install-only` is offline and needs no invitation or login.

Before activation, installers check OS/CPU and OS/libc floors, start the bundled
runtime, verify matched kit artifacts, and stage writes/extraction in the install
destination. A write or extraction failure stops activation and gives permission
and free-space guidance. Space is tested by doing the actual staged writes, not
by promising that a compressed archive's size predicts free-space needs. Existing
integrity, same-release and atomic activation checks remain authoritative. A
successful install prints the command path and bundled Node version; the
absolute command works in every shell. The printed PATH export is optional and
lasts for the current shell only; setup never edits profiles.

The owner issues an invitation with
`echo-brain person employee invite --name <name> --email <email> --out <absolute-path>`.
`--out` must name a new file in a current-user `0700` directory. Privately send
that file alongside the correct kit, and give the employee its absolute path
after transfer. Do not paste invitation contents into chat or a shell command.
Linux rejects a relative path, a missing file and a symlink with separate
recovery instructions. If transfer changes the
current user's file to mode 0644, use the printed, quoted `chmod 600 <path>`
command, then retry. Ownership, file size, canonical content and symlink checks
still apply; changing permissions does not make an invalid invitation valid.

An invitation expires **15 minutes after issue**. Each browser attempt lasts
**up to 10 minutes**, independently bounded by its printed `expires_at`; the
CLI explains both absolute deadlines. Keep the command running. Use a
browser on the same machine that can reach its loopback address (`127.0.0.1`).
Opening the URL on a different computer does not complete a remote/headless
client's callback. Use an interactive supported machine; this kit supplies no
remote-login forwarding or device-code protocol. If automatic opening fails,
configure a default browser or use CLI login without `--open-browser` and open
its `authorization_url` locally. After timeout, retry; ask the owner to reissue
an expired invitation. An already-bound person can sign in on another machine
using `person login --authority-url <url>` without a new invitation.

Intel macOS and Linux ARM64 are follow-up ports, **not supported targets**.
Intel macOS needs an x64 Node runtime, matching packaging and verification
identities, and native install/reinstall/update/browser proof.
Linux ARM64 needs the pinned arm64 Node runtime, ELF/identity/installer support,
and native distro and browser proof. Changing an architecture check or mocking
`uname` proves neither port. Windows, 32-bit x86 and musl/Alpine remain outside
this scope. The macOS kit is not signed by ECHO, and a browser-downloaded
archive has not had a quarantine/Gatekeeper rehearsal. Do not bypass OS
protection to claim support.

The existing smoke helper now supports both shipped native targets:

```sh
node tests/fixtures/person-onboarding-smoke.mjs
```

Run from clean committed source on the matching target. It builds the host's
command-line kit, checks its digest and file list, installs into an
empty temporary HOME/XDG path containing spaces and Unicode, starts CLI version
and signed-out status, reinstalls, and checks tampering cannot replace the active
command. Installer PATH contains only OS utilities, with no Node/npm/compiler or
network command, and Mac developer tools are disabled for that step. CI reuses
its already-built Mac kit through `--kit-root`; the helper copies it before
negative tests. This is isolated native-host proof, **not a pristine OS image or
real browser-login proof**; host libraries remain available.

| Validation | What it establishes | Still required before distribution |
| --- | --- | --- |
| Linux shell tests on Mac | Mocked OS/libc/ELF failure paths, staged write failure, reinstall preservation | Native Linux kit smoke; a Mac skip is not a Linux pass |
| Native Mac smoke and existing Mac CI | Real packaged client and command-line kit, fresh user state, restricted tool PATH, install/start/reinstall | Clean macOS 14 and current macOS machines; downloaded archive/quarantine and browser sign-in |
| Native Linux smoke in existing Ubuntu CI | Real Linux Node and packaged client, fresh state, offline install/start/reinstall | Ubuntu 22.04 and Debian 12 floor-class hosts; actual browser opening, deadlines, invitation transfer modes and permission-aware reads |

The previous 3b663a7 Linux rehearsal on Debian 13/glibc 2.41 is evidence for
that earlier artifact and host, not this PR's resulting artifact. Record the
source SHA, archive checksum, OS/CPU/libc, native vs emulated environment and
browser/read outcome for each new manual rehearsal. No fixture success marks a
candidate accepted; release authority stays in the operator playbook.

### Person contract candidate qualification

`person status` reports local `installed_version` and
`client_build: { source_sha, source_kind }` in either sign-in state. Only
`materialized-commit` identifies a committed package; `worktree-head-unverified`
explicitly does not. Neither the version, installed path nor client source SHA
identifies the Authority actually serving a request. Status makes no network call.
Use the existing operator lane's release/image evidence and correlated request
audit or telemetry to identify that Authority independently.

The candidate implements [ADR-0012](../../docs/decisions/ADR-0012-person-public-response-privacy.md).
Current clients decode `echo-clean-person-record-search-v2` and, from
`person ask`, `echo-clean-person-answer-v4` (schema 4); older exact-shape
clients are incompatible. Decoding answer-v4 schema 4 does not by itself make
a client current: a client built before ADR-0024 decodes that kind and schema
but refuses the citation `ref` its Authority now sends.
Select clients by committed source and tarball SHA-256, not a reused product version.
The implementation contract is accepted; coordinated live qualification and
the exact candidate's release decision remain required.

For both native targets, build from the same committed source and feed the
existing smoke helper the same canonical release and tarball:

```sh
node tests/fixtures/person-onboarding-smoke.mjs \
  --release /absolute/private/candidate.clean-v1.json \
  --artifact /absolute/private/person-client.tgz
```

This builds the host's kit and installs into disposable user state. Its receipt
contains the release-record and tarball hashes, client source/kind, platform,
and `serving_authority: "not-observed-offline"`. Compare both platforms' exact
hashes. `--kit-root` verifies an already-built kit instead. The no-argument mode
is a local smoke build; independent invocations are not evidence of one shared
release or tarball. Native Linux execution is still owed when working on a Mac.

Retire the one-off Mac-pinned stress checker as a qualification workflow; keep
its old evidence outside Git. Use this smoke path plus the existing
`demo/evaluate-rehearsal.mjs` captured-result gate. Capture stdout, stderr, exit
code, termination signal and launch errors separately. NUL argv and `E2BIG`
fail at process launch; do not label them HTTP/input-validation failures or add
another stdin/file question path. Successful JSON is on stdout; structured
Authority failures are on stderr with a nonzero exit.

After offline proof, the owner control must run on the owner device and bounded
Q4/63-byte/64-byte employee repetitions on the employee device, retaining failed
attempts as well as successes. Keep exact internal generation/head and serving
image correlation in operator-only evidence, with the returned-response digest.
No session copying, owner substitution or client-SHA inference qualifies the
employee journey. Offline fixtures do not prove model reliability or release
acceptance.

### Linux x64 terminal kit

The Linux kit supports glibc x86_64 machines (Ubuntu 22.04+ / Debian 12+ class).
It installs the same Person CLI as the macOS kit, with invitation login,
status, records, Ask, and server-authorized organization commands. This terminal
kit contains no desktop app. Separate Linux x64 desktop `.deb` and `.tar.gz`
packages are described in the [desktop README](../../product/echo-desktop/README.md).
Linux arm64, musl/Alpine, and Windows are unsupported kit targets.

Build on Linux x64 from the clean release commit. Supply the official Node
22.22.1 Linux x64 binary after checking its download against Node's
`SHASUMS256.txt`. `zip` is a build tool; employees need only Bash, unzip, tar,
and standard Linux utilities. They do not need Node, npm, Python, a compiler,
sudo, or a repository checkout.

```sh
npm run kit:person-onboarding -- \
  --target linux-x64 \
  --update-config /absolute/private/bootstrap-config.json \
  --release /absolute/private/current.clean-v1.json \
  --artifact /absolute/private/echo-brain-person-client-0.1.0-internal.1.tgz \
  --runtime-node /absolute/private/node-v22.22.1-linux-x64/bin/node \
  --output /absolute/private/ECHO-linux-x64-source-sha12.zip
```

For a release offered on both platforms, reuse the **same canonical release
record and exact Person-client tarball**. The Authority image is shared too;
the employee's CPU architecture does not select a different server. The kits
differ in their bundled Node runtime and installer. Linux uses a strict v2
manifest binding its runtime, release, client, kit build identity, and validated
public bootstrap for update checks. The bootstrap must target `cli-kit` and set
`automatic` to true to enable checks and availability notices. Normal setup
installs it privately without another user command; reinstall and signed updates
preserve existing trust, checkpoints, and the choice to disable automatic
checks. Existing Linux seats run this configured kit's
`Start-ECHO.sh --install-only` once to enroll automatic checks while keeping
their session. Available releases install only with an explicit
`echo-brain update`. Legacy Linux kits without the field still install but
cannot enroll themselves. The macOS kit uses `--installation cli-kit`, a schema-3 manifest with the same
bindings, and its own CLI root.

Send a folder named `ECHO-Employee-Onboarding-linux-x64-<source_sha12>` containing
the ZIP, `SHA256SUMS.txt`, and a short `README.txt` with the commands below and
the installed command path. Keep the employee's one-use invitation separate.
Send the archive digest through the authenticated owner channel; the checksum
file by itself is not independent proof of origin. The shared kit contains no
invitation, session, or provider credentials.

```sh
sha256sum -c SHA256SUMS.txt
unzip ECHO-linux-x64-source-sha12.zip
./echo-person-onboarding-kit/Start-ECHO.sh '/absolute/path/ECHO-invitation-XXXXXXXX/person-invitation.json'
```

Use `Start-ECHO.sh --install-only` to install without signing in. Without an
invitation or that flag, it prints usage and exits. Sign-in prints a browser
handoff; optional `person login --invitation <absolute-path> --open-browser`
uses `xdg-open` when available. A headless machine needs a browser that can
reach the client's loopback callback; this kit adds no device-code login.

Installation lives under `${XDG_DATA_HOME:-$HOME/.local/share}/echo/person`.
The installer prints the absolute `bin/echo-brain` path and an optional PATH
command; it does not edit shell profiles. Releases are versioned, activation
is atomic, and reinstalling an identical release is safe. Earlier releases
are retained. A private lock blocks concurrent or interrupted installations
until the prior installer has finished or its state has been inspected.
Existing Person sessions remain at `~/.local/share/echo-brain/person` and are
preserved; applying another invitation requires explicitly signing out first.

Run `node tests/fixtures/person-onboarding-smoke.mjs` on a clean Linux
x64 checkout for the offline packaging proof. The existing Ubuntu CI job runs
it with system Node/npm absent from the installer's PATH. Its fixture release
uses non-fetchable `rehearsal.invalid` URLs and an undeployed image digest.
This proves packaging and local installation; accepted release selection,
real invitation redemption, and permission-aware server reads remain live
release checks. An offline fixture kit is not an employee release.

## Advanced client-only install or reinstall

The lower-level offline bundle remains available for development and recovery.
Create it from the accepted canonical release record
and the exact client artifact. Use a staged candidate only on the explicitly
designated canary machine before promotion. The bundle builder rejects a
noncanonical record, a mismatched artifact checksum, or a packaged build
identity whose version/source commit does not match that record. Its output
directory must be a canonical, current-user-owned directory with mode `0700`.

```sh
npm run bundle:person-client -- \
  --release /absolute/private/current.clean-v1.json \
  --artifact /absolute/private/echo-brain-person-client-0.1.0-internal.1.tgz \
  --output /absolute/private/echo-brain-person-client-clean-v1-20260822-001.tar.gz
```

The builder atomically publishes each of the archive and its detached
`<bundle>.sha256` sidecar without replacing an existing file. Transfer both
privately. The owner must send the exact 64-character archive digest through
the employee's private invitation channel (or an equivalently authenticated
private channel). That out-of-band owner transfer is the trust boundary; the
sidecar is a transfer receipt, not an authority to trust a newly received
archive.

Before extraction, the employee verifies the received archive against the
digest sent by the owner. On an employee machine with Node 22.22.1 and npm
10.9.4:

```sh
export EXPECTED_BUNDLE_SHA256='exact-64-lowercase-hex-from-owner'
test "$(cat echo-brain-person-client-clean-v1-20260822-001.tar.gz.sha256)" = \
  "$EXPECTED_BUNDLE_SHA256  echo-brain-person-client-clean-v1-20260822-001.tar.gz"
printf '%s  %s\n' "$EXPECTED_BUNDLE_SHA256" \
  echo-brain-person-client-clean-v1-20260822-001.tar.gz | shasum -a 256 -c -
tar -xzf echo-brain-person-client-clean-v1-20260822-001.tar.gz
cd echo-brain-person-client-clean-v1-20260822-001
./install.sh
```

The archive contains exactly the canonical release record, exact client
artifact, release validator, checksum installer, and this zero-argument
wrapper. It contains no Authority image, server state, provider configuration,
or credentials. The installer verifies the release record and artifact
SHA-256 before npm is allowed to unpack it, installs with scripts, audit,
funding notices, and registry access disabled, checks the exact Node/npm
versions, installed package version, and non-secret packaged build identity
against the release source commit, then runs
`echo-brain person status`. That status output contains only the installed
version, whether a local session exists, the server-issued membership display
name and safe owner/employee membership type, and the connected public
Authority origin. It never prints the session, refresh token, invitation grant,
or IDs.

The default per-user prefix is `$HOME/.local`, so the installed `echo-brain`
normally lands in `$HOME/.local/bin`; the installer prints the one PATH command
needed when that bin directory is not active. Re-running `./install.sh` is the
V1 update mechanism. It replaces packaged code only; it leaves the employee's
private session state in place. There is no background updater, MDM integration,
public artifact bucket, signed download URL, or automatic rollback.
