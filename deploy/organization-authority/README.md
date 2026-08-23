# Single-origin authority deployment

## Clean founder onboarding V1

[`compose.clean-v1.yaml`](./compose.clean-v1.yaml) is a separate, opt-in
founder re-onboarding profile. It uses the existing Authority image, but starts
only `clean-live-main.js` over a new `clean-data/` bind mount. It neither
reads `data/` nor selects this directory's default legacy Compose stack. Do not
combine its two compose files, data directories, or Caddy volumes.

The profile expects a confidential OIDC client. Create its private files and
the empty clean state directory before starting anything. The OIDC JSON must
declare `client_secret_basic` or `client_secret_post`, must name
`https://<host>/v2/session/oidc/callback` as its redirect URI, and contains no
secret. Keep both private files mode 0600 and the containing directory mode 0700.

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

The clean founder path is three phases: bootstrap while stopped, sign in and
link Slack while the profile runs, then finalize while stopped. Bootstrap owns
timestamps, IDs, PKCE location, connection ID, and invitation path. It reads
the Slack token once from stdin and issues the 15-minute invitation last.

After the first live-user release, use the exact-record server replacement and
checksum client reinstall procedure in
[the clean-v1 release loop](../release/README.md). It supports only
baseline-preserving `clean-v1` image replacements; it is not a schema migration
or automatic client updater.

On the EC2 host behind the existing Cloudflare Tunnel, include
`compose.clean-v1.ec2.yaml`. The override disables local image builds, requires
an immutable remote image reference, exposes only HTTP port 80 on `127.0.0.1`,
and selects `Caddyfile.clean-v1.ec2`. The EC2 security group remains closed to
inbound traffic; Cloudflare Tunnel is the only public path. Before starting the
clean profile, bring the retained EC2 Compose project down without `-v`, since
both projects claim `127.0.0.1:80`. Keep the retained `data/` directory and its
volumes intact. The existing Tunnel route must target that loopback port and
use the same hostname named by `ECHO_CLEAN_AUTHORITY_HOST`.

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
invitation path and next instruction.
It leaves a private, non-secret `0600` manifest at
`clean-data/state/onboarding/clean-founder-v1.json`.

Start only this opt-in profile with `compose_clean up -d`. Its health check fetches
the clean descriptor at loopback; Caddy forwards to that listener without the
legacy authenticated-proxy headers. Securely transfer the mode-0600 invitation
to the founder's current-user machine, then follow the clean Person login and
Slack-link steps in
[the Authority runbook](../../services/organization-authority/README.md#clean-founder-onboarding-rehearsal).
`echo-brain person login --invitation <path>` prints the browser URL, then
waits for the browser to return the session directly to a one-use loopback
receiver. Nothing is pasted into the terminal. `echo-brain person slack-link`
prints a code to reply with in Slack and waits only for Enter; it retains the
code and opaque handles in memory.

After founder OIDC login and Slack linking succeed, stop the profile again.
Only now copy the live-processing inputs into the private mount, then run the
single credential installer. It validates all three sources before replacing
any fixed destination.
Each source contains only its value, with no trailing newline or other
whitespace, and remains current-user mode `0600`.
Source admission requires the completed founder OIDC binding and matching owner
email. Use the exact lowercase OIDC email as the entire owner-email file. Source
admission starts at a fresh live-only cutoff and does not import older Granola
notes.

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

This profile and runbook cover founder identity, Slack linking, clean Slack
approval activation, and live-only Granola/LLM source admission. The same
`compose_clean up -d` starts an idle Person server before finalization, then,
after the stopped-state finalize and restart, the admitted Granola poller,
Slack approval finalizer, and V4 record writer. Its manifest supplies the
Authority URL, OIDC configuration, PKCE key, and approval channel; do not
repeat them when restarting the profile.

Clean V1 reconciles Layer 2 automatically: once at clean-live startup and
again after a coalesced cycle appends an approved record, but only when the
exact Layer-1 record head has advanced. It builds a new immutable generation
outside the record append and publishes its pointer only if that generation
still matches the exact head. A query never starts a build. Until an
exact-head generation is published, `echo-brain person records --query ...`
can report that search is catching up while ordinary Layer-1 `records` reads
remain available. Wait one worker cycle and retry the same query. A failed or
superseded build leaves the existing pointer untouched and retries on the next
worker cycle.

For the live-only smoke, create a new Granola note after finalization. Approve
one generated Slack card and confirm it with
`echo-brain person records --limit 20`, then confirm the searchable result
with `echo-brain person records --query '<term>'`; reject another and confirm
that it does not appear in either result. Existing Granola notes are
intentionally outside the new cutoff.

## Retained legacy deployment

This is the pilot deployment for one organization. One public HTTPS origin
serves Person login, session, read, exclusion, and Slack-link routes plus the
`/admin` console. Retained V1 installation enrollment and access routes share
the listener for server compatibility, but no shipped machine client calls
them. Caddy strips external proxy-identity headers, authenticates its loopback
hop, and supplies the bounded client identity expected by the Authority.

Set a public DNS name and initialize the persistent state once:

```sh
cd deploy/organization-authority
AUTHORITY_HOST=authority.example.com
(
  set -eu
  test ! -e .env || {
    echo '.env already exists; update it without discarding deployment settings' >&2
    exit 1
  }
  umask 077
  printf \
    'ECHO_AUTHORITY_HOST=%s\nECHO_AUTHORITY_UID=%s\nECHO_AUTHORITY_GID=%s\nECHO_AUTHORITY_IMAGE=%s\n' \
    "$AUTHORITY_HOST" "$(id -u)" "$(id -g)" \
    'echo-organization-authority:local' > .env
  chmod 0600 .env
  install -d -m 0700 data
  docker compose build authority
  docker compose run --rm authority \
    init-development \
    --config /echo/authority.json \
    --state-dir /echo/state \
    --organization-name "Example Company"
  docker compose up -d
)
```

Compose reads the deployment UID, GID, and host from the private `.env` file on
every later command and reboot. Do not rely on shell-only `export` values:
losing them can start the authority as a different user or image. If `.env`
already exists, preserve its other deployment-specific settings and ensure
these four values remain present.

Open `https://authority.example.com/admin`. The generated administrator token is
`data/state/credentials/admin-token`; treat the whole `data` directory as
private state and back it up accordingly. The path is excluded from Git and
from the Docker build context.

The authority runs with the host UID/GID supplied above instead of root. Caddy
is the trusted TLS proxy that injects the bounded authenticated client headers.
Of the authority's private state, Caddy's filesystem mounts expose only the
trusted-proxy token, not the administrator token, databases, or authority
signing key. The private runtime-status route is not forwarded by the public
proxy.

The Authority container owns four private SQLite files in the same durable
state directory: `authority.sqlite` for membership, Person identity and
sessions, retained installation compatibility, and bounded pre-record
processing state; `integrations.sqlite` for provider connections and grants;
`record-log.sqlite` for append-only organization record truth; and
`record-derived.sqlite` for its rebuildable projection. A
readable-search-capable Authority also publishes
immutable retrieval generations below
`data/state/record-retrieval/generations/`; they are not a fifth mutable source
of truth. All run in one process under one authenticated singleton guard.

## Release boundary

[`QUAL-20260814-194049-001`](../../docs/qualification/QUAL-20260814-194049-001-readable-search-minimum-v1.md)
immutably records one exact deployed, founder-live-qualified readable-search
run, including its source, image, state identities, and non-claims. It is
historical evidence, not a mutable pointer to the running deployment, and it
does not claim client-live qualification or release. Resolve the selected
deployment identity from protected release evidence and create new exact
evidence for any later promotion rather than editing that report.

In this document, a **readable-search-capable image** is a selected exact image
whose reviewed release evidence names compatible readable-search commands and
state. Capability comes from that selected artifact, not from an old image tag
or a status sentence in this runbook.

For a state initialized by an older build, build the exact target image first,
then stop and back up the complete state before running the one-time upgrade.
Set `AUTHORITY_HOST` below to the deployment's existing hostname. The
compatibility block creates `.env` when the older export-only instructions
left none, using the durable state's verified numeric owner rather than the
unsafe Compose defaults:

```sh
(
  set -eu
  AUTHORITY_HOST=authority.example.com
  STATE_UID="$(stat -f '%u' data/state 2>/dev/null || stat -c '%u' data/state)"
  STATE_GID="$(stat -f '%g' data/state 2>/dev/null || stat -c '%g' data/state)"
  case "$STATE_UID:$STATE_GID" in
    *[!0-9:]* | :* | *:) exit 1 ;;
  esac
  if ! test -f .env; then
    (umask 077 && printf \
      'ECHO_AUTHORITY_HOST=%s\nECHO_AUTHORITY_UID=%s\nECHO_AUTHORITY_GID=%s\nECHO_AUTHORITY_IMAGE=%s\n' \
      "$AUTHORITY_HOST" "$STATE_UID" "$STATE_GID" \
      'echo-organization-authority:local' > .env)
  fi
  chmod 0600 .env

  compose() {
    env \
      -u ECHO_AUTHORITY_HOST \
      -u ECHO_AUTHORITY_UID \
      -u ECHO_AUTHORITY_GID \
      -u ECHO_AUTHORITY_IMAGE \
      -u ECHO_AUTHORITY_RUNTIME_VOLUME \
      -u ECHO_PROXY_CLIENT_ID \
      docker compose --env-file .env "$@"
  }
  RESOLVED_ENV="$(compose config --environment)"
  printf '%s\n' "$RESOLVED_ENV" | grep -Fqx \
    "ECHO_AUTHORITY_HOST=$AUTHORITY_HOST"
  printf '%s\n' "$RESOLVED_ENV" | grep -Fqx \
    "ECHO_AUTHORITY_UID=$STATE_UID"
  printf '%s\n' "$RESOLVED_ENV" | grep -Fqx \
    "ECHO_AUTHORITY_GID=$STATE_GID"
  printf '%s\n' "$RESOLVED_ENV" | grep -Fqx \
    'ECHO_AUTHORITY_IMAGE=echo-organization-authority:local'
  compose config --images | grep -Fqx \
    'echo-organization-authority:local'

  BACKUP_ROOT="${ECHO_AUTHORITY_BACKUP_ROOT:-${XDG_DATA_HOME:-$HOME/.local/share}/echo-brain/organization-authority-backups}"
  case "$BACKUP_ROOT" in
    /*) ;;
    *) printf '%s\n' 'ECHO_AUTHORITY_BACKUP_ROOT must be absolute' >&2; exit 1 ;;
  esac
  install -d -m 0700 "$BACKUP_ROOT"
  chmod 0700 "$BACKUP_ROOT"
  BACKUP_ROOT="$(cd "$BACKUP_ROOT" && pwd -P)"
  REPOSITORY_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
  if test -n "$REPOSITORY_ROOT"; then
    REPOSITORY_ROOT="$(cd "$REPOSITORY_ROOT" && pwd -P)"
    case "$BACKUP_ROOT/" in
      "$REPOSITORY_ROOT"/*)
        printf '%s\n' 'authority backups must be outside the Git worktree' >&2
        exit 1
        ;;
    esac
  fi
  STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
  BACKUP_DIRECTORY="$(mktemp -d "$BACKUP_ROOT/upgrade-$STAMP.XXXXXX")"
  chmod 0700 "$BACKUP_DIRECTORY"
  BACKUP_ID="$(basename "$BACKUP_DIRECTORY")"
  BACKUP="$BACKUP_DIRECTORY/organization-authority-data.tar.gz"
  ROLLBACK_RECORD="$BACKUP_DIRECTORY/rollback.env"

  OLD_CONTAINER="$(compose ps -q authority)"
  test -n "$OLD_CONTAINER"
  OLD_IMAGE_ID="$(docker inspect --format '{{.Image}}' "$OLD_CONTAINER")"
  ROLLBACK_IMAGE="echo-organization-authority:rollback-$BACKUP_ID"
  docker image tag "$OLD_IMAGE_ID" "$ROLLBACK_IMAGE"
  test "$(docker image inspect "$ROLLBACK_IMAGE" --format '{{.Id}}')" = \
    "$OLD_IMAGE_ID"

  compose build authority
  AUTHORITY_IMAGE_ID="$(docker image inspect \
    echo-organization-authority:local --format '{{.Id}}')"
  test -n "$AUTHORITY_IMAGE_ID"

  compose down
  (umask 077 && tar -czf "$BACKUP" data)
  chmod 0600 "$BACKUP"
  tar -tzf "$BACKUP" >/dev/null
  BACKUP_SHA256="$(shasum -a 256 "$BACKUP" | awk '{print $1}')"
  printf '%s  %s\n' "$BACKUP_SHA256" "$BACKUP"
  (set -C; umask 077; printf \
    'BACKUP=%s\nBACKUP_SHA256=%s\nOLD_IMAGE_ID=%s\nROLLBACK_IMAGE=%s\n' \
    "$BACKUP" "$BACKUP_SHA256" "$OLD_IMAGE_ID" "$ROLLBACK_IMAGE" \
    > "$ROLLBACK_RECORD")
  chmod 0600 "$ROLLBACK_RECORD"

  compose run --rm --no-deps authority \
    install-integrations --config /echo/authority.json
  compose up -d --no-build
  test "$(docker inspect --format '{{.Image}}' \
    "$(compose ps -q authority)")" = "$AUTHORITY_IMAGE_ID"
  compose exec -T authority \
    node services/organization-authority/dist/main.js \
    status --config /echo/authority.json
)
```

`serve` never creates a missing integration database. The maintenance command
refuses to run while a live authority owns the state and never replaces an
anchored database. A successful installation first publishes and verifies the
database-marker pair, then records the same fact immutably in
`authority.sqlite`. If power is lost before that final anchor, repeating the
command resumes the exact unanchored target-schema state: it adopts a verified
database-only publication, completes a verified pair, or discards a valid
marker that has no database before starting again. A partial legacy state is
still refused because it cannot be distinguished safely from operator data
loss. Once the independent authority anchor exists, any missing or mismatched
sibling file requires restoring the complete backup instead of recreating
authorization state.

The fail-fast subshell stops before mutation if ownership, host, image,
shutdown, or backup verification fails. It also saves the old running image
under an immutable timestamped rollback tag and writes its tag plus the backup
path to the private `rollback.env` record. Both files live in a private backup
directory outside the Git worktree; set `ECHO_AUTHORITY_BACKUP_ROOT` to another
absolute out-of-worktree directory when required. The final image ID check
proves the restarted authority is the exact image built before the backup
window.

If the upgrade fails after shutdown, keep the stack stopped. Move the failed
`data` directory aside, restore the complete archived `data` directory, retag
the recorded rollback image as `echo-organization-authority:local`, and start
with `--no-build`. Never restore only one SQLite file or remove either
installation anchor to force recreation.

Check a running authority from inside its existing container:

```sh
docker compose exec -T authority \
  node services/organization-authority/dist/main.js \
  status --config /echo/authority.json
```

To rebuild only `record-derived.sqlite`, stop the whole stack and snapshot the
current `data` directory exactly as-is before mutation. Use a private backup root
outside the Git worktree:

```sh
(
  set -eu
  compose() {
    env \
      -u ECHO_AUTHORITY_HOST \
      -u ECHO_AUTHORITY_UID \
      -u ECHO_AUTHORITY_GID \
      -u ECHO_AUTHORITY_IMAGE \
      -u ECHO_AUTHORITY_RUNTIME_VOLUME \
      -u ECHO_PROXY_CLIENT_ID \
      docker compose --env-file .env "$@"
  }
  compose down
  BACKUP_ROOT=/absolute/private/echo-authority-rebuild-snapshots
  install -d -m 0700 "$BACKUP_ROOT"
  BACKUP_DIRECTORY="$(mktemp -d "$BACKUP_ROOT/rebuild-XXXXXXXX")"
  (umask 077 && tar -czf "$BACKUP_DIRECTORY/data.tar.gz" data)
  chmod 0600 "$BACKUP_DIRECTORY/data.tar.gz"
  tar -tzf "$BACKUP_DIRECTORY/data.tar.gz" >/dev/null
  shasum -a 256 "$BACKUP_DIRECTORY/data.tar.gz"
  compose run --rm --no-deps authority \
    rebuild-derived --config /echo/authority.json
  compose up -d --no-build --wait --wait-timeout 90
  compose exec -T authority \
    node services/organization-authority/dist/main.js \
    status --config /echo/authority.json
)
```

If shutdown failed or the derived file was already missing or corrupt, this is
an incident snapshot, not a known-good backup; retain the last known-good backup.
The fail-fast block stops on a shutdown or backup-verification error. If shutdown
itself fails, preserve the stopped state as-is before investigating or retrying.
The command never rebuilds the log and refuses record-database SQLite sidecars.
Use `docker compose run` only for one-time initialization or stopped maintenance.
`run` creates another container; it is not the live authority.
The authority's singleton guard is a private authenticated Unix socket in the
shared `authority_runtime` Docker volume, so any second container using this
compose service must prove the existing owner and is refused while it remains
active. Durable keys and all four database files remain in the host-mounted
`data` directory; the coordination volume contains no organization content and
may be recreated only while the whole authority stack is stopped.

For an Authority initialized before organization-member recording existed,
activation is a separate one-time stopped operation. First stop the complete
stack and take the same private whole-`data` snapshot. Then place the strict
mode-0600 canonical `rpa_` command in a private host directory mounted beneath
`/echo` and run:

```sh
compose run --rm --no-deps authority \
  activate-organization-member-recording \
  --config /echo/authority.json \
  --command /echo/operator/activate-organization-member-recording.json
```

The command binds the immutable initialization manifest and initialized
runtime-config digests, the exact current owner tuple, and the one fixed
organization-member-readable target mapping. It appends an immutable
Authority activation and leaves both initialization files unchanged. An exact
retry is read-only. The command is one-way: restore the complete stopped
pre-activation snapshot if activation must be abandoned before qualification.
Do not edit the config, initialization manifest, or activation journal.

First creation also requires the mapping's exact approval-surface instance to
already be an active `slack-reactions` binding to the current active Slack
organization tool. Its public configuration pins Slack identity, channel, and
reactions, not the product-local `presentation_mode`; a missing, inactive, or
drifted instance refuses activation.

Starting the Authority after this operation enables only the retained V1
installation-bound record-admission capability. No shipped Person client
submits that envelope or has a product-reconfigure command. Do not treat this
activation as enabling the current Person product; a Person-bound record
writer is a later additive server path.

For this retained legacy readable-search-capable image, use the same stopped
snapshot boundary before activation, a generation rebuild, or query-audit
maintenance. The route is unavailable until an exact-record-head generation is
published; any later append makes it return fixed `503` until the next stopped
rebuild. The verifier deliberately rejects that stale pointer/head; rebuilding,
not verification, repairs the staleness. This stopped maintenance flow does not
apply to the clean V1 path above.

```sh
(
  set -eu
  compose() { docker compose --env-file .env "$@"; }
  compose down
  BACKUP_ROOT=/absolute/private/echo-authority-readable-search-snapshots
  install -d -m 0700 "$BACKUP_ROOT"
  INCIDENT_DIRECTORY="$(mktemp -d "$BACKUP_ROOT/incident-XXXXXXXX")"
  (umask 077 && tar -czf "$INCIDENT_DIRECTORY/data.tar.gz" data)
  chmod 0600 "$INCIDENT_DIRECTORY/data.tar.gz"
  tar -tzf "$INCIDENT_DIRECTORY/data.tar.gz" >/dev/null
  shasum -a 256 "$INCIDENT_DIRECTORY/data.tar.gz"
  compose run --rm --no-deps authority \
    rebuild-readable-search --config /echo/authority.json
  compose run --rm --no-deps authority \
    verify-readable-search-backup --config /echo/authority.json
  VERIFIED_DIRECTORY="$(mktemp -d "$BACKUP_ROOT/verified-XXXXXXXX")"
  (umask 077 && tar -czf "$VERIFIED_DIRECTORY/data.tar.gz" data)
  chmod 0600 "$VERIFIED_DIRECTORY/data.tar.gz"
  tar -tzf "$VERIFIED_DIRECTORY/data.tar.gz" >/dev/null
  shasum -a 256 "$VERIFIED_DIRECTORY/data.tar.gz"
  compose up -d --no-build --wait --wait-timeout 90
)
```

The first archive above is an **unverified incident snapshot**: it preserves
the stale pre-rebuild state for investigation and must not replace the last
known-good backup. The second archive follows a successful verifier receipt and
is the recovery-grade backup. For routine stopped backups with an already
exact-head generation, run the verifier before creating the only archive.

For a readable-search-capable image, `verify-readable-search-backup` must run
while stopped before a recovery-grade archive and again after a restore, before
any external reconciliation. It returns `verified` for an admitted active
generation or `not_built` when no active pointer exists; it otherwise rejects
the pointer/head mismatch, bad contract or generation, staging directories, or
SQLite sidecars. The archive must retain the complete `data` directory,
including `record-retrieval/`; never copy, repair, or restore a generation
directory independently of `authority.sqlite` and the record databases.

Stopped readable-search query-audit maintenance uses the same boundary:

```sh
docker compose run --rm --no-deps authority \
  readable-search-query-audit-export --config /echo/authority.json \
  --command /absolute/private/export-command.json \
  --output /absolute/private/readable-search-query-audit.json

docker compose run --rm --no-deps authority \
  readable-search-query-audit-expire --config /echo/authority.json \
  --command /absolute/private/expiry-command.json
```

The signed `sqa_` commands require the current active owner and five-minute
first-execution freshness. Export output is create-once and must remain outside
managed `data`.

The volume has the deployment-stable Docker name
`echo-organization-authority-runtime`, so changing Compose project names does
not create a second coordination island. If one Docker host runs more than one
organization authority, set a different, durable
`ECHO_AUTHORITY_RUNTIME_VOLUME` value for each organization and never change it
while that authority state is in use.

Because this portable compose file deliberately puts Caddy in the authority
container's network namespace, Compose restarts `proxy` whenever it explicitly
restarts `authority`. Use Compose, rather than `docker restart`, for a focused
Authority restart:

```sh
docker compose restart authority
```

To restart every service intentionally, use `docker compose restart`.

Treat the complete `data` directory as one recovery unit. Stop the stack before
a file-level backup and archive all four SQLite databases, signing key,
credentials, identity, and installation manifests together. For a
readable-search-capable image, also run `verify-readable-search-backup` first
and capture its active pointer and immutable retrieval generation only after a
`verified` or `not_built` result. The derived database is the only SQLite file
that may be absent and rebuilt from a verified log before restart; for a
readable-search-capable image, a missing retrieval generation may be rebuilt
only from verified current Layer 1 while stopped. Every protected file must
otherwise be restored together. A stale readable-search generation copy is an
unverified incident snapshot until a stopped rebuild and fresh verification
produce a separate recovery-grade archive.

Before making any restored Authority available, complete the external operator
evidence checklist in
[`AWS-EC2.md`](./AWS-EC2.md#restore-boundary). Keep the Tunnel and reviewer
route offline until current Person roots, the integration audit chain, complete
record log, and applicable client-held receipts have been reconciled against
independently retained evidence. For a readable-search-capable image, keep
readable search offline as well until its policy-fact, active-pointer, and
generation evidence has been reconciled. A restored database cannot serve as
evidence that its own historical state is current. A successful restore and
verifier result establish only structural recovery admissibility; by
themselves they add, renew, or inherit no source, deployment, founder-live,
client-live, or release qualification.

That `data` archive is sufficient for this in-place upgrade rollback because
`docker compose down` leaves the named Caddy volumes intact. It is not by
itself a host-loss disaster-recovery backup. Localhost and private-CA clients
trust Caddy's root certificate, whose private CA key lives in `caddy_data`; back
up and restore the `caddy_data` and `caddy_config` named volumes with the same
recovery generation, or use an externally managed stable TLS certificate and
CA. Losing that CA while retaining Authority state makes clients that trusted
it reject the replacement TLS identity.

For `localhost`, Caddy uses its local CA. Export its public root after the stack
starts only if it will be installed into the client operating system's trust
store:

```sh
docker compose exec -T proxy \
  cat /data/caddy/pki/authorities/local/root.crt \
  > data/caddy-local-root.crt
chmod 0600 data/caddy-local-root.crt
```

The Person client uses the operating system's HTTPS trust and has no
`--authority-ca` option or installation-enrollment command. Prefer a public DNS
name for live use; ports 80 and 443 must reach this host so Caddy can obtain and
renew its certificate. Preserve `caddy_data` and `caddy_config` with Authority
state so an intentionally trusted local CA does not change after recovery.

The default proxy client ID intentionally represents this one pilot proxy, not
individual employees. Replace `ECHO_PROXY_CLIENT_ID` with a stable canonical
`cid_` digest when the ingress authenticates distinct client identities.
Caddy separately overwrites `X-Echo-Proxy-Source-Address` with the transport
source IP. The Authority hashes that proxy-authenticated value only for
pre-authentication admission isolation; it is not treated as employee
identity or authorization evidence.
