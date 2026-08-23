# Clean V1 Authority deployment

This directory deploys the clean V1 Authority only. It starts
`clean-live-main.js` over `clean-data/`; it never reads or modifies any other
Authority state directory. Do not reuse state, Compose volumes, or credentials
from an earlier deployment.

## Founder onboarding

The profile expects a confidential OIDC client. Create its private files and
the empty clean state directory before starting anything. The OIDC JSON must
declare `client_secret_basic` or `client_secret_post`, and must name
`https://<host>/v2/session/oidc/callback` as its redirect URI. The JSON itself
contains no secret. Keep both private files mode `0600` and the containing
directory mode `0700`.

```sh
cd deploy/organization-authority
umask 077
install -d -m 0700 clean-data/private
install -m 0600 /absolute/private/oidc-config.json clean-data/private/oidc-config.json
install -m 0600 /absolute/private/oidc-client-secret clean-data/private/oidc-client-secret
ECHO_CLEAN_AUTHORITY_HOST=authority.example.com
ECHO_CLEAN_AUTHORITY_URL="https://${ECHO_CLEAN_AUTHORITY_HOST}"
ECHO_CLEAN_SLACK_APPROVAL_CHANNEL_ID=C0123456789
ECHO_CLEAN_OWNER_EMAIL=founder@example.com
ECHO_CLEAN_AUTHORITY_UID="$(id -u)"
ECHO_CLEAN_AUTHORITY_GID="$(id -g)"
{
  printf 'ECHO_CLEAN_AUTHORITY_HOST=%s\n' "$ECHO_CLEAN_AUTHORITY_HOST"
  printf 'ECHO_CLEAN_AUTHORITY_URL=%s\n' "$ECHO_CLEAN_AUTHORITY_URL"
  printf 'ECHO_CLEAN_AUTHORITY_UID=%s\n' "$ECHO_CLEAN_AUTHORITY_UID"
  printf 'ECHO_CLEAN_AUTHORITY_GID=%s\n' "$ECHO_CLEAN_AUTHORITY_GID"
  printf 'ECHO_CLEAN_AUTHORITY_IMAGE=%s\n' echo-organization-authority:local
  printf 'ECHO_CLEAN_SLACK_APPROVAL_CHANNEL_ID=%s\n' "$ECHO_CLEAN_SLACK_APPROVAL_CHANNEL_ID"
  printf 'ECHO_CLEAN_OWNER_EMAIL=%s\n' "$ECHO_CLEAN_OWNER_EMAIL"
} > .env.clean-v1
chmod 0600 .env.clean-v1
```

The founder path has three phases: bootstrap while stopped, sign in and link
Slack while the profile runs, then finalize while stopped. Bootstrap owns
timestamps, IDs, PKCE location, connection ID, and invitation path. It reads
the Slack token once from stdin and issues the 15-minute invitation last.

On EC2 behind the Cloudflare Tunnel, use both Compose files. The override
disables local image builds, requires an immutable remote image reference,
exposes only HTTP port 80 on `127.0.0.1`, and selects
`Caddyfile.clean-v1.ec2`. Ensure no other process owns that loopback port. The
EC2 security group remains closed to inbound traffic; Cloudflare Tunnel is the
only public path and targets that loopback port with the hostname named by
`ECHO_CLEAN_AUTHORITY_HOST`.

```sh
compose_clean() {
  docker compose --env-file .env.clean-v1 -f compose.clean-v1.yaml "$@"
}
# On EC2, define the helper with both files instead:
# compose_clean() {
#   docker compose --env-file .env.clean-v1 -f compose.clean-v1.yaml \
#     -f compose.clean-v1.ec2.yaml "$@"
# }
set -a
. ./.env.clean-v1
set +a

# For ECHO_CLEAN_AUTHORITY_IMAGE=echo-organization-authority:local:
compose_clean build authority
# For an immutable remote image reference instead, use:
# compose_clean pull authority

SLACK_BOT_TOKEN_FILE=/absolute/private/slack-bot-token
compose_clean run --rm --no-deps --entrypoint node authority \
  services/organization-authority/dist/clean-founder-main.js \
  bootstrap \
  --state-dir /echo-clean/state \
  --organization-name 'Example Organization' \
  --owner-display-name 'Founder Name' \
  --owner-email "$ECHO_CLEAN_OWNER_EMAIL" \
  --authority-url "$ECHO_CLEAN_AUTHORITY_URL" \
  --oidc-config /echo-clean/private/oidc-config.json \
  --slack-approval-channel-id "$ECHO_CLEAN_SLACK_APPROVAL_CHANNEL_ID" \
  < "$SLACK_BOT_TOKEN_FILE"
```

The token file contains exactly the token with at most one trailing newline,
with mode `0600`; do not add whitespace or a second line. Bootstrap outputs the
invitation path and next instruction. It leaves a private, non-secret `0600`
manifest at `clean-data/state/onboarding/clean-founder-v1.json`.

Start the profile with `compose_clean up -d`. Its health check fetches the clean
descriptor at loopback; Caddy forwards to that listener without using external
identity headers. Securely transfer the mode-0600 invitation to the founder's
current-user machine, then follow the clean Person login and Slack-link steps
in [the Authority runbook](../../services/organization-authority/README.md#clean-founder-onboarding-rehearsal).
`echo-brain person login --invitation <path>` prints the browser URL, then waits
for the browser to return the session directly to a one-use loopback receiver.
Nothing is pasted into the terminal. `echo-brain person slack-link` prints a
code to reply with in Slack and waits only for Enter; it retains the code and
opaque handles in memory.

After founder OIDC login and Slack linking succeed, stop the profile. Only now
copy the live-processing inputs into the private mount, then run the single
credential installer. It validates all three sources before replacing any fixed
destination. Each source contains only its value, with no trailing newline or
other whitespace, and remains current-user mode `0600`. Source admission
requires the completed founder OIDC binding and matching owner email. Use the
exact lowercase OIDC email as the entire owner-email file. Source admission
starts at a fresh live-only cutoff and does not import older Granola notes.

```sh
compose_clean down

install -m 0600 /absolute/private/granola-organization-key clean-data/private/granola-organization-key
install -m 0600 /absolute/private/llm-provider-credential clean-data/private/llm-provider-credential
(umask 077 && printf %s "$ECHO_CLEAN_OWNER_EMAIL" > clean-data/private/granola-owner-email)

compose_clean run --rm --no-deps --entrypoint node authority \
  services/organization-authority/dist/clean-founder-main.js \
  credentials-install \
  --state-dir /echo-clean/state \
  --granola-credential-file /echo-clean/private/granola-organization-key \
  --granola-owner-email-file /echo-clean/private/granola-owner-email \
  --llm-credential-file /echo-clean/private/llm-provider-credential

compose_clean run --rm --no-deps --entrypoint node authority \
  services/organization-authority/dist/clean-founder-main.js \
  finalize --state-dir /echo-clean/state

compose_clean up -d
```

This profile and runbook cover founder identity, Slack linking, Slack approval
activation, and live-only Granola/LLM source admission. The same
`compose_clean up -d` starts an idle Person server before finalization, then,
after the stopped-state finalize and restart, the admitted Granola poller,
Slack approval finalizer, and V4 record writer. Its manifest supplies the
Authority URL, OIDC configuration, PKCE key, and approval channel; do not
repeat them when restarting the profile.

Clean V1 reconciles Layer 2 automatically: once at clean-live startup and again
after a coalesced cycle appends an approved record, but only when the exact
Layer-1 record head has advanced. It builds a new immutable generation outside
the record append and publishes its pointer only if that generation still
matches the exact head. A query never starts a build. Until an exact-head
generation is published, `echo-brain person records --query ...` can report that
search is catching up while ordinary Layer-1 `records` reads remain available.
Wait one worker cycle and retry the same query. A failed or superseded build
leaves the existing pointer untouched and retries on the next worker cycle.

For the live-only smoke, create a new Granola note after finalization. Approve
one generated Slack card and confirm it with `echo-brain person records --limit
20`, then confirm the searchable result with `echo-brain person records --query
'<term>'`; reject another and confirm that it does not appear in either result.
Existing Granola notes are intentionally outside the new cutoff.

## Release and recovery

After the first live-user release, use the exact-record server replacement and
checksum client reinstall procedure in [the clean-v1 release loop](../release/README.md).
It supports only baseline-preserving `clean-v1` image replacements; it is not a
schema migration or automatic client updater. The current release record and
the clean state directory are the recovery unit. Do not start a replacement
until the accepted release record, exact image, and state lineage have been
verified by the release procedure.
