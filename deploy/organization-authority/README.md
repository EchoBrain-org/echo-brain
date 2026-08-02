# Single-origin authority deployment

This is the pilot deployment for one organization. One public HTTPS origin
serves employee enrollment/access routes and the `/admin` console. Caddy strips
external proxy-identity headers, authenticates its loopback hop, and supplies
the bounded client identity expected by the authority.

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

The authority container owns two private SQLite files in the same durable
state directory: `authority.sqlite` for membership and installation truth, and
`integrations.sqlite` for provider connections, exact adapter bindings,
direct grants, and integration audit. They run in the same process under one
authenticated singleton guard.

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

Use `docker compose run` only for the one-time initialization while the stack
is stopped. `run` creates another container; it is not the live authority.
The authority's singleton guard is a private authenticated Unix socket in the
shared `authority_runtime` Docker volume, so any second container using this
compose service must prove the existing owner and is refused while it remains
active. Durable keys and both database files remain in the host-mounted `data`
directory; the coordination volume contains no organization content and may be
recreated only while the whole authority stack is stopped.

The volume has the deployment-stable Docker name
`echo-organization-authority-runtime`, so changing Compose project names does
not create a second coordination island. If one Docker host runs more than one
organization authority, set a different, durable
`ECHO_AUTHORITY_RUNTIME_VOLUME` value for each organization and never change it
while that authority state is in use.

Because this portable compose file deliberately puts Caddy in the authority
container's network namespace, restart the stack as one unit:

```sh
docker compose restart
```

Restarting only `authority` replaces that namespace and strands the existing
proxy process until `proxy` is also restarted.

Treat the complete `data` directory as one recovery unit. Stop the stack before
a file-level backup so both SQLite databases, the signing key, credentials, and
identity and installation manifests are captured consistently.

That `data` archive is sufficient for this in-place upgrade rollback because
`docker compose down` leaves the named Caddy volumes intact. It is not by
itself a host-loss disaster-recovery backup. Localhost and private-CA clients
pin Caddy's root certificate, whose private CA key lives in `caddy_data`; back
up and restore the `caddy_data` and `caddy_config` named volumes with the same
recovery generation, or use an externally managed stable TLS certificate and
CA. Losing that CA while retaining Authority state makes already-enrolled
clients reject the replacement TLS identity.

For `localhost`, Caddy uses its local CA. Export its public root after the stack
starts, then supply it during product enrollment:

```sh
docker compose exec -T proxy \
  cat /data/caddy/pki/authorities/local/root.crt \
  > data/caddy-local-root.crt
chmod 0600 data/caddy-local-root.crt

echo-brain organization enroll \
  --config /absolute/path/runtime.json \
  --invitation /absolute/path/echo-organization-invitation.json \
  --authority-pin sha256:PIN_FROM_A_SEPARATE_TRUSTED_CHANNEL \
  --authority-ca /absolute/path/to/data/caddy-local-root.crt \
  --allow-exportable-software-key
```

The product persists this public CA with the verified authority connection so
background lease renewal uses the same TLS trust after restart. For a public
DNS name, ports 80 and 443 must reach this machine so Caddy can obtain and
renew the certificate; `--authority-ca` is then normally unnecessary.

The default proxy client ID intentionally represents this one pilot proxy, not
individual employees. Replace `ECHO_PROXY_CLIENT_ID` with a stable canonical
`cid_` digest when the ingress authenticates distinct client identities.
Caddy separately overwrites `X-Echo-Proxy-Source-Address` with the transport
source IP. The Authority hashes that proxy-authenticated value only for
pre-authentication admission isolation; it is not treated as employee
identity or authorization evidence.
