# Clean V1 Authority deployment

This is the deployable clean V1 Authority only. It uses a new `clean-data/`
directory, never imports previous Authority state, and uses both EC2 Compose
profiles automatically.

## One-time preparation

Provision Docker, Docker Compose v2, Cloudflare Tunnel, and registry access
first. The EC2 security group remains closed to inbound traffic; the tunnel must
target `127.0.0.1:80` for the Authority hostname. The wrapper does not install
or configure host infrastructure. It accepts the release validator at the
source-tree path `../release/clean-v1-release.py` or the installed deployment
path `./release/clean-v1-release.py` used under `/srv/echo-authority-clean-v1`.

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

| File | Purpose |
| --- | --- |
| `onboarding.clean-v1.json` | Ordinary organization configuration, including the observability stack Region. Start from the committed example. |
| `release.json` | Canonical clean-v1 release record. |
| `oidc-config.json` | OIDC configuration, including the exact callback above. |
| `oidc-client-secret` | OIDC client secret. |
| `slack-bot-token` | Slack bot token. |
| `granola-credential` | Organization Granola credential. |
| `llm-credential` | Retained LLM provider credential. |

The secrets are never placed in command arguments or normal wrapper output.
`prepare` installs byte-exact fixed server copies with mode `0600` under its
mode-`0700` private data directory.

```sh
cd deploy/organization-authority
install -d -m 0700 /absolute/private/echo-onboarding
cp onboarding.clean-v1.example.json /absolute/private/echo-onboarding/onboarding.clean-v1.json
# Add the canonical release as release.json and the five provider files listed above.
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

### Replace pre-live rehearsal state

The roster candidate changes the fresh Authority baseline. It cannot start over
an earlier rehearsal lineage. Because that lineage has no live users, retire it
once through the explicit founder attestation:

```sh
./onboard-clean-v1.sh replace-rehearsal --confirm-no-live-users
```

This stops the Compose profile and moves both `clean-data` and its environment
file into a mode-`0700` timestamped `retired-rehearsals/` archive. It does not
delete them. It also accepts a clean rehearsal created before this wrapper, so
no wrapper-specific setup record is required for the one pre-live replacement.
Run `prepare` again with the new exact release record. Never use this command
after the first live-user release; subsequent baseline-preserving updates use
the release procedure below.

## Resumable founder onboarding

Run this same command after each human step:

```sh
./onboard-clean-v1.sh resume
```

It pulls the accepted immutable image only when the host lacks it, calls the
durable clean-founder status command, and advances the next safe stage. It
starts the runtime for browser login and Slack linking, stops it for credential
installation and finalization, then starts it again. It never reads SQLite,
prints secret values, or asks for generated IDs.

When prompted for browser login, transfer the founder invitation to the
founder's current-user machine through a private channel, then run the exact
path and command printed by `resume`. Install the exact Person client from the
same release record first, using [the release installer](../release/README.md).
The received invitation must be a current-user mode-`0600` file inside a
mode-`0700` directory. Do not paste invitation contents into chat or a terminal.
The wrapper also prints the bounded one-note post-finalization Granola, Slack,
list, and search canary. After approving that card and completing both reads,
rerun `resume`, then `status`: a terminal green result additionally requires a
running healthy Authority container on the exact accepted image.

Use this Authority-state read-only progress check after the accepted image is
present locally:

```sh
./onboard-clean-v1.sh status
```

It creates one transient no-dependency local container, prints safe running,
health, exact-image, and clean-founder status booleans, and never pulls an
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

| File | Purpose |
| --- | --- |
| `granola-credential` | Replacement organization Granola credential. |
| `llm-credential` | Replacement LLM provider credential. |

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
baseline-preserving `clean-v1` image replacements, not schema migrations or
automatic client updates. The current release record and clean state directory
are the recovery unit.
