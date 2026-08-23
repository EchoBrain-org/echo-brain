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

The confidential OIDC client must allow
`https://<authority-host>/v2/session/oidc/callback`. Put each source in a
private regular file. The secret values are accepted only from files and are
never placed in command arguments or output. Each credential file contains
exactly one value with no surrounding whitespace; `prepare` installs the fixed
server copies with mode `0600` under a mode-`0700` directory.

```sh
cd deploy/organization-authority
./onboard-clean-v1.sh prepare \
  --release /absolute/private/clean-v1-release.json \
  --runtime-user echo-authority \
  --organization-name 'Example Organization' \
  --owner-display-name 'Founder Name' \
  --owner-email founder@example.com \
  --authority-host authority.example.com \
  --slack-approval-channel-id C0123456789 \
  --oidc-config-file /absolute/private/oidc-config.json \
  --oidc-client-secret-file /absolute/private/oidc-client-secret \
  --slack-bot-token-file /absolute/private/slack-bot-token \
  --granola-credential-file /absolute/private/granola-credential \
  --llm-credential-file /absolute/private/llm-credential
```

`prepare` validates the exact canonical release record, derives its immutable
image, writes fixed `clean-data/private` files with mode `0600`, and renders
the two Compose profiles offline. `--runtime-user` is the existing non-login OS
account that owns the mounted Authority state; on the EC2 deployment it is
`echo-authority`, even when SSM runs Docker lifecycle commands as root. The
wrapper derives that account's UID and GID so the container never inherits the
operator's root identity. It does not build or pull an image. An exact repeat
is safe; a changed release, setup value, runtime user, or private input fails
rather than silently changing this organization.

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

## Release and recovery

After onboarding, use the exact-record replacement and checksum client reinstall
procedure in [the clean-v1 release loop](../release/README.md), including
[update-clean-v1.sh](./update-clean-v1.sh). It supports only
baseline-preserving `clean-v1` image replacements, not schema migrations or
automatic client updates. The current release record and clean state directory
are the recovery unit.
