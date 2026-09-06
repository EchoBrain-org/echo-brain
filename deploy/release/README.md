# Organization Authority release and update procedure

This directory contains the small release boundary used after the first live
organization release. It is deliberately an artifact-selection process, not a
schema migration or client fleet-management system.

The runtime-profile field is current-only. A pre-beta Authority prepared with
an older release record has no compatibility bridge. `clean-v1` describes an
artifact replacement loop, not a database migration: it accepts only the
current provider-neutral Authority V4, private-approval control-plane V2, and
record-log V2 state lineage. For populated state, `stage` pulls the immutable
candidate and runs its state-lineage and admitted-processor verifiers in an
isolated read-only container before any runtime, configuration, or state
mutation. While there are no live users,
run `onboard-clean-v1.sh
replace-rehearsal --confirm-no-live-users`, then prepare the organization again
with the new release record and matching profile. Do not point this updater at
the older accepted record.

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

For an accepted staging Authority only, an explicit `--content-telemetry true` or
`--content-telemetry false` may follow those arguments. The option sets
`ECHO_STAGING_JOURNEY_CONTENT_TELEMETRY_V1` in the new candidate's saved
environment before activation and verifies the effective container setting.
The source environment must use the literal format described below.
It never modifies the accepted snapshot. Without the option, the candidate
inherits the accepted setting. Do not enable telemetry by editing `.env.clean-v1`
after promotion: that creates environment drift and blocks the next release.

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
does not query SQLite or print credentials. A change that needs a schema
migration is not eligible for this loop; make an explicit migration decision
instead. If persisted state is older or otherwise not that exact V4/V2/V2
lineage, `stage` refuses before activating or recording the candidate. It does
not attempt to repair, infer, or migrate the state.

### Environment drift before staging

If `status` refuses an environment mismatch, a human on the exact reviewed
staging host runs the installed wrapper:

```sh
./update-clean-v1.sh diagnose-environment
```

This checks the selected release's stored tuple and materialized profile,
but does not query Docker or assert runtime health. Its JSON reports the
selected release ID, candidate presence, whether environment bytes match,
the fixed allowlisted setting name when changed, whether other bytes differ,
and pending-repair state. Arbitrary setting names, values, and raw diffs are
never printed. `repair_eligible` describes environment eligibility only;
execution separately verifies the exact accepted runtime.

For an accepted release with no staged candidate, the only automatic repair
allowed is restoring the saved environment when every difference is confined
to one canonical `ECHO_STAGING_JOURNEY_CONTENT_TELEMETRY_V1=true|false` line
(or that line's presence). Every other byte must be unchanged. Both files must
be private, current-operator-owned regular files. A non-staging Authority,
unrelated change, malformed or duplicate switch, unsafe file, or mismatched
repair evidence is refused. Do not paste environment files into chat.

Automatic repair and the explicit candidate override accept only the
onboarding writer's literal `NAME=value` lines (plus blank/comment lines).
Quoted or multiline values, interpolation, escape syntax, alternate
assignment syntax, and noncanonical line endings are deliberately refused;
the diagnostic reports `environment_format_supported=false`. This prevents a
setting-looking line inside private content from being classified as a safe
configuration change. Other valid Compose environment formats require review,
not automatic rewriting.

After reviewing the diagnostic and the effect of restoring the saved setting,
the human binds the operation to that exact accepted release ID:

```sh
./update-clean-v1.sh repair-environment \
  --expected-release-id <accepted-release-id-from-diagnostic> --restore-accepted
./update-clean-v1.sh status
```

The restore may disable content telemetry if it was enabled after acceptance.
It atomically restores the accepted environment and restarts/checks the exact
accepted image, profile, proxy, public descriptor, and effective telemetry
setting. It does not replace the accepted record, change its snapshot, create
a candidate, or infer canary approval. The private original file is retained
as `clean-data/release/environment-repairs/<release-id>.before.env`; a private
verification receipt is stored alongside it. These files are immutable and
not overwritten with different evidence for another repair of the same release.

A durable `environment-repair.pending.json` blocks status success, staging,
canary, promotion, and rollback until recovery is verified. After an
interruption or failed restart, rerun the same repair command for the same
release; diagnostics remain available. An unrelated intervening change stops
the retry. Do not remove or edit the pending marker, backup, or accepted
snapshot. An already matching, verified accepted runtime is a no-op.

Once repair and status succeed, stage the next reviewed candidate with the
intended `--content-telemetry` option, then follow the normal canary and human
approval gates. General configuration or credential drift requires separate
review; this command is not a blanket environment reset.

## Automated current-host staging lane

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

Plan one named action. For `install`, supply the full source SHA corresponding
to the independently reviewed *currently installed* tooling. Unknown installed
bytes stop instead of being overwritten. Replacing tooling saves private old
copies and hashes; it never edits the accepted release or environment.

When an install returns only `precondition_failed`, create a separate
`inspect-install` plan with the same inputs and `--previous-tooling-source`.
Inspection shares the installer's identity, mount, ownership/control-path,
accepted-record, literal environment and hostname, candidate, old-or-new tool
hash, and pending-repair guards. It returns `ready` or a fixed refusal
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
order and does not claim readiness. A pending-repair refusal can include a
complete safe inventory. Failures before tooling inspection, or unexpected
diagnostic/control-path failures, return no inventory (`null`). Invalid inventory
is redacted to `inspection_failed` on the host before SSM sees it, and the local
validator independently rejects malformed or contradictory state/hash bindings.
Older saved version-1 diagnostics remain pollable with their original shapes
and request/parameters hashes; existing receipts are never rewritten to add an
inventory. A refused or interrupted inspection is not an
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
runtime wrapper, restarts containers, repairs the environment, changes release
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
| `diagnose` | Returns the fixed secret-safe diagnostic; no runtime-health claim. |
| `repair` | Requires accepted-only eligible telemetry drift or its exact pending repair; restores the saved environment and verifies the accepted runtime. May temporarily disable telemetry. |
| `status` | Fresh installed-wrapper runtime check, not a cached polling receipt. |
| `stage` | No staged candidate; uses exact candidate/profile. Add `--content-telemetry true` or `false` to this plan only. |
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

New plans use request version 2 and a checksum-bound XZ-compressed text bundle
containing the exact reviewed runner and non-secret files. The fixed loader
checks its digest and size, reconstructs the canonical request and checks its
digest before invoking the runner. Compression uses the existing operator
Python 3 standard-library `lzma` module with a fixed preset; decoding is bounded
by both output size and memory. No third-party package or manual courier is
needed. The 60-KiB command cap is unchanged. Old
version-1 receipts can still be polled with their original transport binding;
unsubmitted version-1 plans cannot execute in the new CLI. Preserve old receipts
and reconcile any unfinished command before planning a new operation.

Host-side request/result journals live under
`clean-data/release/remote-operations/<operation-id>/`. A duplicate exact request
returns its completed receipt; incomplete prior execution does not run again.
If the release pathname no longer names the pinned inode, the operation returns
`control_path_changed`, writes only through the original pinned directory, and
retains its root-owned guard and inputs. A replacement tree is never treated as
the accepted control state. Stop for investigation; do not remove or relocate
the guard or any release directory to force a retry.

Never delete a lock, pending repair, or journal to force progress. Unknown
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
For a fresh post-promotion `status` or `diagnose`, pass that new accepted record
to both `--accepted-release` and `--release`, with its matching profile. This
does not stage a candidate or require inventing a future release.

## First-cohort employee onboarding kit

The supported first-cohort employee path is one private macOS Apple-silicon
kit plus that employee's one-use invitation. The kit carries the exact Person
client, the matching `ECHO.app` hotkey overlay, and a pinned Node 22.22.1
runtime. The employee does not install Node, npm, Homebrew, or a repository
checkout and does not edit `PATH`.

From the accepted release record and exact Person-client artifact, create the
kit on a reviewed macOS arm64 build machine running Node 22.22.1:

```sh
npm run kit:person-onboarding -- \
  --release /absolute/private/current.clean-v1.json \
  --artifact /absolute/private/echo-brain-person-client-0.1.0-internal.1.tgz \
  --app /absolute/private/ECHO.app.zip \
  --output /absolute/private/echo-person-onboarding-clean-v1-20260824-001.tar.gz
```

The builder rejects an overlay whose embedded build identity does not match the
release source SHA, exact Person-client version, macOS, and arm64. The manifest
hash-binds that exact app archive alongside the release record, client artifact,
runtime version, platform, architecture, and Node binary. It emits the private
archive and its SHA-256 receipt without replacing either. Keep the receipt with
the owner-side delivery record and transfer the kit through an authenticated
private channel. That channel is the first-cohort trust boundary: the kit is
internally hash-bound but is not yet independently signed by ECHO.

Immediately before onboarding, the signed-in owner issues or reissues the
employee's invitation and transfers that file privately. On the employee Mac:

1. Extract the kit.
2. Double-click `Start ECHO.command`.
3. Choose the invitation file when macOS asks.
4. Complete Google sign-in in the browser that opens.

The command verifies the kit, installs the versioned client under
`~/Library/Application Support/ECHO`, and validates then installs the matching
overlay at `~/Applications/ECHO.app`. A different valid prior ECHO app is moved
to a private backup before the new bundle is atomically switched into place;
an invalid or non-ECHO bundle is left untouched. The command never launches or
foregrounds the overlay. It copies the selected invitation into a temporary
private file, completes the existing loopback login, and makes one bounded
permission-aware record request. It prints `phase: "ready"` only after that
request succeeds. Reinstalling the same kit preserves an existing Person
session. If `Start ECHO.command` sees any existing session, it stops instead of
silently applying a possibly different person's invitation; use the installed
client for the current person, or log out before onboarding another person.

This rehearsal's membership display name is carried in the server-issued
session and shown by the overlay. It is a required session field, so use a
fresh invitation and onboarding flow after this release instead of reusing an
older local session.
The invitation remains separate because it is employee-bound, short-lived, and
may need reissue without rebuilding the release kit. Authority remains the
source of truth for invitation validity so modest client clock skew cannot
reject a valid invitation. If Authority rejects an unused invitation, the
client makes one bounded existing-identity login attempt without the invitation
grant; if no identity exists, it stops before opening Google and tells the
employee to request a reissued invitation.

The first cohort supports macOS arm64 only. A signed and notarized graphical
installer is a later distribution improvement; it is not required for the
operator-assisted cohort.

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
