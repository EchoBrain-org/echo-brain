# Organization Authority deployment

Coding agents follow
[PB-OPERATIONS-001](../../docs/operations/PB-OPERATIONS-001-authority-operator-lane.md)
before local exercise, staging, onboarding, or deploy. Do not add a
tool-specific procedure.

Current-host staging updates use the shared
[`authority:staging-release` automation](../release/README.md#automated-current-host-staging-lane).
It transfers only reviewed non-secret tooling and release artifacts, and invokes
named installed updater actions with exact-target and accepted-record checks.
It does not automate initial onboarding, change infrastructure, or infer the
human Slack approval and final release decision.

This is the deployable Organization Authority. Its current `clean-v1`
compatibility profile uses a new `clean-data/` directory, never imports
previous Authority state, and uses both EC2 Compose profiles automatically.

[ADR-0008](../../docs/decisions/ADR-0008-echo-hosted-authority-by-default.md)
defines the operator. ECHO operates the default deployment in ECHO's AWS
account. When an organization requests its own account before provisioning,
that organization or its explicitly authorized support operator runs this
procedure. The selected account controls the volume, backups, encryption
boundary, logs, and infrastructure credentials.

For local synthetic Authority development, do not create `clean-data/` beside
this deployment directory and do not run this deployment wrapper. Use
[`npm run authority:local`](../../README.md#local-authority-exercise) from the
repository root. That separate harness creates only sentinel-owned state outside
the checkout and applies a local overlay to the base profile; it never uses this
EC2 profile or reads provider credentials.

## One-time preparation

Provision Docker, Docker Compose v2, Cloudflare Tunnel, and registry access
first. The EC2 security group remains closed to inbound traffic; the tunnel must
target `127.0.0.1:80` for the Authority hostname. The wrapper does not install
or configure host infrastructure. It accepts the release and runtime-profile
validators at their source-tree paths under `../release/` or their installed
deployment paths under `./release/` in `/srv/echo-authority-clean-v1`.

Deploy
[`authority-observability-v1.template.json`](./authority-observability-v1.template.json)
before the first `prepare`. It takes the public Authority host, the existing
EC2 host-role name, and one alert email. Confirm the SNS email subscription.
The stack output `DockerRuntimeLogGroupName` must equal
`/echo-brain/authority/<authority-host>`. Use
[RB-OPERATIONS-001](../../docs/operations/RB-OPERATIONS-001-authority-observability.md)
for the change-set review, deployment, notification rehearsal, controlled
outage, and recovery checks. This intentionally creates one small observable
loop, not a dashboard or tracing platform.

### Staging journey overview and Explorer

The journey overview is the separate staging-only
`authority-staging-journey-observability-v1.template.json` stack. A read-only
inspection on 2026-09-08 verified the staging overview, Explorer stack, and
redacted journey view. That is dated evidence, not a substitute for checking
the current stack and dashboard before a change. The template accepts only the
exact `authority-staging.echobrain.org` Authority log group and creates only
the staging journey dashboard, its worker-cycle metric filter, and three
quick-detection alarms. It must not be added to, or deployed through, the generic
`authority-observability-v1.template.json` flow because that flow accepts an
arbitrary Authority host and is also used outside staging.

The overview emits content-free metrics beside canonical journey events and
uses the existing 14-day log retention. The Explorer exposes only fixed,
redacted `describe`, recent `list`, and UUID-scoped `detail` operations; it has
no public endpoint, direct Logs access, application credential, or mutation
operation. It fails closed for incomplete history, unknown events, and result
limits.

The companion policy permits only invocation of the fixed Lambda from a
dedicated staging-only Identity Center assignment. Keep dashboard sharing
disabled; review the effective assignment rather than attaching policy to an
`AWSReservedSSO` role. For the dashboard contract, change procedure, and
rehearsal evidence, use
[RB-OPERATIONS-001](../../docs/operations/RB-OPERATIONS-001-authority-observability.md#staging-journey-overview-and-explorer).

The confidential OIDC client must allow
`https://<authority-host>/v2/session/oidc/callback`. Create one private input
directory, owned by the account running the wrapper and with mode `0700`.
Put exactly these mode-`0600` regular, non-symlink files inside it:

| File                       | Purpose                                                                                                                             |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `onboarding.clean-v1.json` | Ordinary organization configuration, including the observability stack Region. Start from the committed example.                    |
| `release.json`             | Canonical clean-v1 release record.                                                                                                  |
| `runtime-profile.json`     | Exact canonical runtime profile referenced by the release record. It contains the reviewed Compose and Caddy bytes, never a secret. |
| `oidc-config.json`         | OIDC configuration, including the exact callback above.                                                                             |
| `oidc-client-secret`       | OIDC client secret.                                                                                                                 |
| `slack-bot-token`          | Slack bot token.                                                                                                                    |
| `slack-signing-secret`     | Slack app signing secret used only to verify inbound interactive approval requests.                                                 |
| `granola-credential`       | Organization Granola credential.                                                                                                    |
| `llm-credential`           | Retained LLM provider credential.                                                                                                   |

Check that directory before spending an AWS session on it:

```
npm run authority:staging-onboarding-transfer -- preflight --input <config.json>
```

`preflight` reads no file contents, makes no AWS call, and names every required
file that is missing, empty, oversized, or not a private regular file. It also
reports the aggregate byte limit with the exact bytes over it and an
unexpected-file count without exposing unexpected filenames. It exits `2` when
the input is not ready, so it can gate the rest of a run. Without it, a missing
credential surfaces only after authentication, planning, and the archive step, as one opaque
`input_directory_shape_invalid`.

For a fresh four-meeting rehearsal, add the prepared fixture directory to the
same private controller JSON:

```json
{
  "stagingSyntheticMeetingsDir": "/absolute/private/staging-four-meetings"
}
```

The directory must be a current-user mode-`0700` directory containing exactly
the four mode-`0600` fixture files named below. The transfer includes those
files in the checksum-bound courier archive and records the selected source in
the private receipt, so `execute` does not depend on the controller still
existing. `preflight` reports the fixture directory separately and applies the
aggregate size limit to both directories. Leave this property out for ordinary
onboarding; the established nine-file archive and host invocation are unchanged.
Before planning this selected source, install matching reviewed host tooling
through the [current-host staging release lane](../../deploy/release/README.md#automated-current-host-staging-lane).
An older installed wrapper does not accept the selected-source flag; its failed
prepare command cleans the bounded courier rather than preserving a usable
fixture transfer.

The secrets are never placed in command arguments or normal wrapper output.
`prepare` installs byte-exact fixed server copies with mode `0600` under its
mode-`0700` private data directory.

### Slack re-onboarding for private approval V1

Before `doctor` and `prepare`, update the same Slack app's scopes and reinstall
it in the staging workspace. Do not enable or save an Interactivity Request URL
at this stage. Its bot token must be from that reinstalled app and have
`channels:history`, `channels:read`, `chat:write`, `im:history`, `im:write`,
`reactions:read`, and `users:read`. `im:write` and `im:history` enable the
private meeting-owner DM lane. Stage the signing secret for this exact same
Slack app as `slack-signing-secret`: one no-newline value in a current-user
`0600` regular non-symlink file. Do not put any secret in this README command
or a shell argument.

`slack_approval_channel_id` in the onboarding JSON is a transitional legacy
field. It names only the public initial-owner identity-link channel used during
onboarding. It never receives approval cards and no shared approval binding is
created from it. Run the re-onboarding only with a wholly fresh provider-
neutral V4 staging lineage; do not reuse an older V3 or shared-channel rehearsal
state directory, database, or approval binding.

After that setup, the ordinary release updater only replaces artifacts within
this same lineage: Authority V4, private-approval control-plane V2, and
record-log V2. It refuses older or mixed persisted state before runtime,
configuration, or state mutation. This is deliberately a replacement boundary,
not a hidden migration path; use `replace-rehearsal --confirm-no-live-users`
for unreleased rehearsal state that does not meet this floor.

Complete the bootstrap, initial-owner identity link, credential installation, and
finalization, then start the active runtime. `resume` stops at this point and
prints the exact URL. Only once that runtime is healthy, enable
**Interactivity & Shortcuts**, save this Request URL, then run the supported
release-bound synthetic staging canary and rerun `resume`:

```text
https://<staging-authority-host>/v2/integrations/slack/interactions
```

```sh
./onboard-clean-v1.sh resume
```

On the exact `authority-staging.echobrain.org` host, the human runs
`./update-clean-v1.sh canary` and approves its private Slack card. The local
operator on the initial-owner Mac verifies the accepted release's installed
client and completes the two Person reads printed by `resume`. This synthetic
path is staging-only. A non-staging deployment still needs durable progress from
its admitted live source before it can become terminal green.

The endpoint intentionally returns `503` before finalization. Do not attempt to
validate it against a pre-finalize runtime. Event Subscriptions, Socket Mode,
and a Slack OAuth redirect are not required for this V1.

```sh
cd deploy/organization-authority
install -d -m 0700 /absolute/private/echo-onboarding
cp onboarding.clean-v1.example.json /absolute/private/echo-onboarding/onboarding.clean-v1.json
# Add the canonical release and runtime profile, plus the provider files listed
# above, including slack-signing-secret. Do not place any secret in this command.
chmod 600 /absolute/private/echo-onboarding/*
chmod 700 /absolute/private/echo-onboarding
./onboard-clean-v1.sh doctor --input-dir /absolute/private/echo-onboarding
./onboard-clean-v1.sh prepare --input-dir /absolute/private/echo-onboarding
```

`doctor` is read-only: it emits one safe JSON result, stops at the first local
precondition failure, makes no provider calls, and does not pull an image. It
checks the host tools, active `cloudflared-echo-authority.service`, private
directory shape, canonical release, runtime user, persisted-path safety, and
exact OIDC callback. It cannot prove that the tunnel is publicly routed or that
the callback has been registered with Google; finish those provider steps
before continuing. It also validates `aws_region`; `prepare` uses that Region
and the Authority host to bind Docker to the retained stack log group. `prepare`
repeats the same checks, derives the
immutable image, writes fixed `clean-data/private` files with mode `0600`, and
renders the two Compose profiles offline. `runtime_user` in the manifest is
the existing non-login OS account that owns mounted Authority state; on EC2 it
is `echo-authority`, even when SSM runs Docker lifecycle commands as root. The
wrapper derives that account's UID and GID so the container never inherits the
operator's root identity. An exact repeat is safe; a changed release, setup
value, runtime user, or private input fails rather than silently changing this
organization.

### Replace unreleased rehearsal state

The roster candidate changes the fresh Authority baseline. It cannot start over
an earlier rehearsal lineage. Because that lineage has no live users, retire it
once through the explicit initial-owner attestation:

```sh
./onboard-clean-v1.sh replace-rehearsal --confirm-no-live-users
```

This stops the Compose profile, copies and verifies the contents of the retained
`clean-data` mount in a mode-`0700` timestamped `retired-rehearsals/` archive,
moves its environment file into that archive, and empties the live mount for
fresh preparation. It does not delete the archived rehearsal. It also accepts
a clean rehearsal created before this wrapper, so no wrapper-specific setup
record is required for the one unreleased-rehearsal replacement.
Run `prepare` again with the new exact release record. Never use this command
after the first user release; subsequent baseline-preserving updates use
the release procedure below.

### Fresh four-meeting staging rehearsal

Use the normal clean Authority for a fresh staging rehearsal with the four
synthetic meeting notes. This is a selected staging source in the normal
runtime, not a separate demo service. It is available only for
`authority-staging.echobrain.org`.

The source and its admission are frozen at finalization. To replace these notes
or start with a clean corpus, first use `replace-rehearsal` to archive the
unreleased state, then prepare again. There is no selective corpus reset or
post-finalize source change.

Prepare a separate current-user-owned mode-`0700` directory containing exactly
these mode-`0600` files. Use the fixture preparer to make the owner-specific
copy; it replaces `owner@example.test` with the lowercase email in the
onboarding manifest and rejects extra or missing files.

```sh
# In a reviewed checkout, create the private owner-specific copy.
node ../../demo/staging/prepare-fixtures.mjs \
  --source ../../demo/meetings \
  --output /absolute/private/staging-four-meetings \
  --owner owner@example.com

# Add `stagingSyntheticMeetingsDir` to the private onboarding-transfer
# controller. Its bounded courier delivers this exact directory together with
# the ordinary nine input files and invokes doctor and prepare with it.
```

The four required filenames are
`01-revenue-signal-calibration.json`, `02-data-handling-review.json`,
`03-implementation-capacity-triage.json`, and
`04-commercial-exception-review.json`. `prepare` copies the approved corpus
into `clean-data/meetings`, binds the normal Compose environment to it, and
keeps the normal release profile, AWS logs, and runtime observability. The
ordinary credential bundle still includes a Granola credential, but this
selected synthetic source never polls Granola. Without the optional directory,
the normal admitted Granola source remains unchanged. The wrapper carries the
same selected directory through setup finalization and normal service startup;
the Compose default is empty.

Continue the usual human browser login and Slack-link steps with `resume`.
When the selected source becomes ready, `resume` starts the normal runtime and
prints the four-card proof: approve the first three records as Team and the
commercial exception as Only me; verify the release-installed owner client can
list and search the approved notes; then verify the employee can read Team
records and cannot read the commercial exception. Rerun `resume` and `status`
after the approved head and search generation are current. Terminal green
requires all four distinct admitted fixture meetings to have published approval
records, a current search generation, and later owner list and search reads.
It does not verify the chosen visibility policies or employee access: the
three-Team/one-Only-me choices and employee read/denial checks are separate
required manual rehearsal evidence. Do not run the
single-record `update-clean-v1.sh canary` for this initial fixture proof. It
does not change the separate final approval required to promote a candidate
release.

### Reuse provider credentials for a fresh staging rehearsal

Use this path when the current staging Authority is complete and healthy but
the original Mac onboarding input directory is unavailable. Provider credentials
stay on the host. The organization, memberships, sessions, signing identity and
knowledge base are still recreated by the ordinary fresh onboarding flow.

Roll back any staged candidate, then install the reviewed host tooling through
the current-host release lane. Verify the accepted Authority is complete and
healthy before capturing provider inputs. Host tooling may advance independently of the exact
server image, Person client and runtime profile selected for the new rehearsal.

Create a private input directory containing only `onboarding.clean-v1.json`,
`release.json` and `runtime-profile.json`. Supply the separately prepared four
meeting files and select the reuse mode in the private transfer controller:

```json
{
  "region": "us-west-2",
  "operationId": "onboarding-fresh-four-meetings-001",
  "stackName": "echo-authority-staging-v1",
  "privateInputDir": "/absolute/private/new-rehearsal-input",
  "archiveDir": "/absolute/private/new-rehearsal-transfer",
  "stagingSyntheticMeetingsDir": "/absolute/private/staging-four-meetings",
  "reuseCurrentProviderInputs": true
}
```

Run the same transfer `preflight`, `plan`, change-set review and `execute`
sequence. This mode sends exactly three configuration/release files and four
meeting files. The bounded remote action stages them under the operation ID;
it does not capture credentials, stop the Authority, reset data or prepare a
new organization. The transfer retains a nonsecret completion receipt after
removing its temporary S3 object and access grant.

After that transfer completes, the human host operator runs the named wrapper
commands in Session Manager, using the operation ID from the receipt:

```sh
./onboard-clean-v1.sh replace-rehearsal --confirm-no-live-users \
  --reuse-provider-inputs onboarding-fresh-four-meetings-001 \
  --content-telemetry true
./onboard-clean-v1.sh prepare-rehearsal \
  --operation-id onboarding-fresh-four-meetings-001
./onboard-clean-v1.sh resume
```

Before stopping the old Authority, replacement validates the staged inputs,
the current accepted release and completed healthy runtime, and the same
staging host, owner, runtime user, Region and Slack identity-link channel.
It copies only the six provider input files into a private host directory
outside `clean-data`. The Granola and model-provider source files are used;
old installed credentials, databases and signing keys are not carried into the
new organization. Normal onboarding verifies the providers again.

The existing archive-and-reset procedure preserves the old rehearsal for
recovery. `prepare-rehearsal` consumes the operation-bound inputs through normal
preparation and removes the temporary credential copies only after preparation
succeeds. A failed preparation retains its inputs for an exact retry. Preserve
an interrupted operation's receipt and lock, and follow the shared recovery
procedure instead of deleting them or starting a competing operation.

The new environment is rendered from its release-matched profile. Region and
host remain bound to the existing log group. Without `--content-telemetry`, the
current explicit staging journey content-telemetry setting is preserved. The
provider-reuse command may explicitly select `true` or `false`; the selection is
bound into its receipt before reset and is reused by every `prepare-rehearsal`
retry. The wrapper still requires the running value to match the verified
Compose setting. Duplicate or malformed settings, or a new profile unable to
support content telemetry, stop replacement before data is reset. No old
environment file is copied into the new rehearsal. Continue with the browser
login, Slack link and four-card permission proof above.

## Resumable initial-owner onboarding

The human host operator runs this command when the preceding handoff is complete:

```sh
./onboard-clean-v1.sh resume
```

It pulls the accepted immutable image only when the host lacks it, calls the
durable `clean-founder` compatibility status command, and advances the next safe stage. It
starts the runtime for browser login and Slack linking, stops it for credential
installation and finalization, then starts it again. It never reads SQLite,
prints secret values, or asks for generated IDs.

At each pause, route the task using the
[playbook's actor table](../../docs/operations/PB-OPERATIONS-001-authority-operator-lane.md#human-decisions-and-operator-work).
An `ACTION:` prefix does not require another approval for an already authorized
operator task. For browser login, privately transfer its named invitation and accepted release to
the initial owner's machine and use the matching
[release kit](../release/README.md). The invitation must be a current-user
mode-`0600` file inside a mode-`0700` directory; never paste its contents into
chat or a terminal. Continue until `resume` reports completion, then run
`status`. Terminal green also requires a healthy Authority container on the
exact accepted image.

After human Slack-card approval, the local operator may run both authenticated
Person reads on the designated initial-owner Mac. Verify the client against
the accepted release before reading; a matching version string alone is not
sufficient. Use the kit-installed absolute path printed by `resume`, and retain
only bounded record/generation identifiers and pass/fail results. For ordinary
release-canary onboarding, both reads must positively return that release's
canary. For the fresh four-meeting source, follow its fixture and permission
checks above. An empty successful owner response does not pass. If that Mac is
unavailable to the operator, the human runs the commands.
Host-local `resume` and `status` still require the human host operator.

### Private invitation export to the initial-owner Mac

After `resume` prints `complete_founder_browser_login`, the invitation exists
on the host. The browser Session Manager terminal is not the private file
handoff. Do not display or copy the invitation JSON through terminal output.
The staging onboarding-transfer CLI has a bounded outbound mode for the two
fixed files named by `resume`: `founder-person-invitation.json` and
`current.clean-v1.json`.

Use reviewed tooling from a clean checkout. Create a current-user mode-`0700`
output directory outside the checkout and a mode-`0600` controller JSON:

```json
{
  "outputDir": "/absolute/private/initial-owner-handoff",
  "release": "/absolute/private/current.clean-v1.json"
}
```

The local `release` must be the independently held canonical accepted record,
not a record inferred from the public endpoint. On the initial-owner Mac:

```sh
npm run authority:staging-onboarding-transfer -- export-plan \
  --input /absolute/private/invitation-export-input.json

# Review the target, accepted release and recipient; reuse approval for that exact scope.
npm run authority:staging-onboarding-transfer -- export-execute \
  --receipt /absolute/private/initial-owner-handoff/invitation-export.json
```

Plan only inspects the staging target and creates a local recipient key and
receipt. Execute rechecks the account, stack, instance and volume, holds the
existing host operation guard, verifies the mounted volume and healthy accepted
image, and reads only those two fixed files. It encrypts their contents for
the requesting Mac before returning through SSM. The private key and plaintext
invitation never enter SSM arguments or output. There are no S3, IAM, runtime
configuration or observability changes. The temporary host guard is removed
after the bounded command finishes normally.

Successful export writes both files mode `0600`, deletes the local recipient
key, and prints paths only. For `export_pending_retry_same_receipt`, repeat
`export-execute` with that same receipt to poll the existing command. An
unconfirmed submission, failed command, changed target, candidate or busy host
guard stops this lane; never create a second request to bypass the refusal.

With the already verified release-matched kit, run:

```sh
"<release-matched-kit>/Start ECHO.command" \
  /absolute/private/initial-owner-handoff/founder-person-invitation.json
```

Browser login, identity changes, Slack approval and host wrapper actions remain
human steps. The local operator handles authorized export, kit verification and
installation, receipt polling, and the post-approval Person reads. Existing
private-handoff approval continues to cover the same target, accepted release
and recipient; a changed scope needs review. Export does not advance onboarding
or authorize a release.

Use this Authority-state read-only progress check after the accepted image is
present locally:

```sh
./onboard-clean-v1.sh status
```

It creates one transient no-dependency local container, prints safe running,
health, exact-image, and `clean-founder` compatibility status booleans, and never pulls an
image implicitly. If the image is absent, use `resume`, whose pull is explicit.
Re-running `resume` is also idempotent after terminal completion.

This wrapper follows the accepted release only. While
`update-clean-v1.sh stage` has a candidate record, `status` reports a staged
handoff with `terminal_green=false` and `resume` refuses to start or act on the
candidate. Use `update-clean-v1.sh status`, then promote or roll back that
candidate before returning to accepted-onboarding commands.

## Activate replacement provider credentials

Granola and LLM credentials are loaded when the Authority process starts.
Replacing a file by hand does not activate it in the running process and is not
a supported status claim. Put both current replacement values in a separate
current-executor-owned mode-`0700` directory containing exactly these
mode-`0600` regular files:

| File                 | Purpose                                      |
| -------------------- | -------------------------------------------- |
| `granola-credential` | Replacement organization Granola credential. |
| `llm-credential`     | Replacement LLM provider credential.         |

Then run the single activation operation:

```sh
./onboard-clean-v1.sh activate-provider-credentials \
  --input-dir /absolute/private/echo-provider-credentials
```

The operation requires a completed, healthy Authority on the accepted image.
It holds the same single-operation lock as release stage, promotion, rollback,
and status, so credential activation cannot race an image change.
The scripts never auto-reclaim an existing lock: a killed wrapper can leave a
Compose child or Docker Engine operation running after the wrapper PID exits.
It validates both private inputs before stopping anything, installs both values
through the Authority's fixed stopped-state credential destinations, restarts
the same accepted release, and waits for both container health and a public
descriptor that exactly matches the local Authority. Its result contains
only the release ID and boolean activation/health outcomes. If the replacement
cannot start healthily, the previous two credentials are restored and the old
runtime is started again. Durable records, staged candidates, and Slack
approval state are not rewritten. OIDC client-secret and Slack-token rotation
have separate identity/link semantics and are intentionally outside this
operation.

### Recover an interrupted operation lock

For a bounded staging-release operation, a root-owned
`.staging-release-guard` outside `clean-data` is an additional interlock. Preserve
it and the original operation receipt if execution is unconfirmed or reports
`control_path_changed`. The legacy-lock cleanup below does not authorize
removing this guard. Follow the [automated release lane](../release/README.md#automated-current-host-staging-lane)
and investigate the exact command and pinned control-state identity first.

If an activation or release wrapper was killed without running its exit trap,
leave `clean-data/.authority-operation-lock` in place until the old Docker work
is conclusively stopped. On the EC2 Authority host:

1. Restart the host before recovery. This is the lean V1 way to terminate an
   orphaned Compose client and any in-flight operation whose state cannot be
   proven from the dead wrapper PID alone. Wait for Docker to become responsive.
2. From this directory, inspect without deleting anything:

   ```sh
   authority_lock=clean-data/.authority-operation-lock
   cat "$authority_lock/owner-pid"
   ps -p "$(cat "$authority_lock/owner-pid")" -o pid=,ppid=,command=
   docker compose --env-file .env.clean-v1 \
     -f compose.clean-v1.yaml -f compose.clean-v1.ec2.yaml ps --all
   find clean-data/private clean-data/state/credentials -maxdepth 1 \
     -type f -name '.*.previous.*' -print
   ```

3. If the recorded process still exists, a container is starting or restarting,
   or any `.previous` credential rollback copy is listed, keep the lock. For a
   credential interruption, restore a known Authority-state recovery unit; when
   there are no live users, `replace-rehearsal --confirm-no-live-users` is the
   supported clean replacement path.
4. Only when the old process is absent, Docker is settled, and no rollback copy
   exists, remove exactly the owner file and empty lock directory:

   ```sh
   rm -- "$authority_lock/owner-pid"
   rmdir -- "$authority_lock"
   ```

5. If `clean-data/release/candidate.clean-v1.json` exists, run
   `./update-clean-v1.sh status` and then promote or roll back that candidate.
   Otherwise run `./onboard-clean-v1.sh status`. Do not start another mutation
   until that status is understood.

## Release and recovery

After onboarding, use the exact-record replacement and checksum client reinstall
procedure in [the clean-v1 release loop](../release/README.md), including
[update-clean-v1.sh](./update-clean-v1.sh). It supports only
baseline-preserving `clean-v1` replacements, not schema migrations or automatic
client updates. This routine path preserves the existing Google identity,
Slack link and configuration, provider credentials, private-DM assignment, and
Authority data; do not rerun initial-owner onboarding for an ordinary update. Use
`update-clean-v1.sh canary` to create the release-bound synthetic private-DM
rehearsal instead of making a new Granola note. A routine promotion is refused
until that exact candidate has a persisted `staged` receipt and the operator
confirms the Slack approval plus permission-aware reads. The recovery unit is
the accepted image, its exact runtime profile, and the saved environment tuple;
the release wrapper restores those together before it claims a recovered public
Authority.

### Current-host recovery floor

For environment drift that prevents staging, follow the release loop's
[secret-safe diagnosis and guarded repair](../release/README.md#environment-drift-before-staging).
The current-host wrapper can recover accepted-only staging content-telemetry
drift without inventing a candidate. Unknown changes remain blocked; never
overwrite an accepted snapshot to make the equality check pass.

The release recovery unit above restores accepted deployment configuration. It
does not reconstruct `clean-data/` if the Authority root volume is lost or
corrupted. Until the later retained-data-volume and replaceable-host programme
exists, the whole current root volume is the off-host protection boundary for
`clean-data/`, including its `state/`, `release/`, and `private/` directories.

Use [RB-OPERATIONS-002](../../docs/operations/RB-OPERATIONS-002-authority-recovery-floor.md)
to complete the active root-volume encryption evidence gate, create the
scheduled AWS Backup protection, and rehearse one quiesced recovery point. The
host bundle/bootstrap now includes the exact reviewed
`backup-authority-maintenance.sh` at
`/srv/echo-authority-clean-v1/backup-authority-maintenance.sh`, owned by root
with mode `0755`. Existing recognized legacy staging hosts use the
[named tooling migration](../release/README.md#live-operator-boundary); otherwise
the release installation procedure must install it and verify its SHA-256
against the private review receipt.
Application release rollback does not replace this host tool. The
template cannot itself inspect source-volume encryption. EBS recovery points
inherit the source-volume encryption and are not independently re-encrypted by
the backup vault. The current same-account `aws/ebs` AWS-managed key is valid;
it prevents a future cross-account copy. Moving to a customer-managed key is a
later data-volume/foundation migration, not this recovery floor. The runbook's
qualifying point uses
`backup-authority-maintenance.sh` under `systemd-run`, not a manual Compose
stop, and proves an automatic exact-tuple/public-descriptor restart after the
external backup coordinator acknowledges the completed job. Its restore is
intentionally isolated: a restored root volume attaches to a clean helper only
as a secondary device, mounts read-only without journal replay, and is
inspected by `tools/verify-authority-recovery.mjs`. It is never booted or used
to start a second Authority.

Before approving that outage, run
`sudo /srv/echo-authority-clean-v1/backup-authority-maintenance.sh preflight`.
It must report `maintenance_preflight_ready=true`; otherwise leave the
scheduled protection active and resolve the release/onboarding precondition
through its normal procedure without stopping the Authority for this drill.

The recurring schedule provides crash-consistent recovery points after the
recorded evidence gate. The separate quiesced drill proves only structural
readability and lineage on an offline copy; it does not prove current data,
provider reconciliation, exact image availability, or a terminal-green serving
Authority. [Issue #20](https://github.com/EchoBrain-org/echo-brain/issues/20)
remains open for that full recovery path.
