# Organization Authority deployment

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

On the exact `authority-staging.echobrain.org` host, run
`./update-clean-v1.sh canary`, approve its private Slack card, and complete the
two Person reads printed by `resume`. This synthetic path is staging-only. A
non-staging deployment still needs durable progress from its admitted live
source before it can become terminal green.

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

## Resumable initial-owner onboarding

Run this same command after each human step:

```sh
./onboard-clean-v1.sh resume
```

It pulls the accepted immutable image only when the host lacks it, calls the
durable `clean-founder` compatibility status command, and advances the next safe stage. It
starts the runtime for browser login and Slack linking, stops it for credential
installation and finalization, then starts it again. It never reads SQLite,
prints secret values, or asks for generated IDs.

When prompted for browser login, transfer the initial-owner invitation to the
initial owner's current-user machine through a private channel, then run the exact
path and command printed by `resume`. Install the exact Person client from the
same release record first, using [the release installer](../release/README.md).
The received invitation must be a current-user mode-`0600` file inside a
mode-`0700` directory. Do not paste invitation contents into chat or a terminal.
The wrapper prints the bounded synthetic private-DM staging canary plus the
Slack, list, and search steps. After approving that card and completing both
reads, rerun `resume`, then `status`: a terminal green result additionally
requires a running healthy Authority container on the exact accepted image.

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

The release recovery unit above restores accepted deployment configuration. It
does not reconstruct `clean-data/` if the Authority root volume is lost or
corrupted. Until the later retained-data-volume and replaceable-host programme
exists, the whole current root volume is the off-host protection boundary for
`clean-data/`, including its `state/`, `release/`, and `private/` directories.

Use [RB-OPERATIONS-002](../../docs/operations/RB-OPERATIONS-002-authority-recovery-floor.md)
to complete the active root-volume encryption evidence gate, create the
scheduled AWS Backup protection, and rehearse one quiesced recovery point. The
release installation procedure must first install the exact reviewed
`backup-authority-maintenance.sh` at
`/srv/echo-authority-clean-v1/backup-authority-maintenance.sh`, owned by root
with mode `0755`, and verify its SHA-256 against the private review receipt.
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
