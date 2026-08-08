# Organization authority

The authority is the centrally hosted onboarding and access service for one
organization. It manages principals, memberships, one-time enrollment grants,
installation enrollment, short access leases, revocation, and append-only
organization decision records. It does not store raw meetings, reasoning
state, or embeddings.

One process and four persistent SQLite databases are the supported topology:
`authority.sqlite` remains the source of membership and installation truth,
while `integrations.sqlite` contains customer-owned provider links,
connections, adapter bindings, direct grants, and integration audit.
`record-log.sqlite` is the append-only record of truth, and
`record-derived.sqlite` contains its replayable projection. All four databases
are owned by the same authenticated singleton process. There is no tenant
registry, organization switcher, billing layer, or multi-replica coordination.

## HTTP surface

The employee and administrator surfaces share one listener and one public
origin:

- `GET /v1/authority-descriptor`
- `POST /v1/enrollments`
- `POST /v1/access-leases`
- `POST /v1/permission-checks`
- `POST /v1/integration-links/slack/challenges`
- `POST /v1/integration-links/slack/completions`
- `GET /v1/admin/overview`
- `GET /v1/admin/memberships`
- `GET /v1/admin/installations`
- `GET /v1/admin/enrollment-grants`
- `GET /v1/admin/audit`
- `GET /v1/admin/integrations`
- `POST /v1/admin/memberships`
- `POST /v1/admin/memberships/:membership_id/enrollment-grants`
- `POST /v1/admin/memberships/:membership_id/revocations`
- `POST /v1/admin/installations/:installation_id/revocations`
- `POST /v1/admin/integrations/slack`
- `POST /v1/admin/integrations/slack-approval-activation`

The browser administrator console occupies the `/admin` namespace:

- `GET /admin` and `GET /admin/login`
- `GET /admin/assets/admin.css` and `GET /admin/assets/admin.js`
- `POST /admin/login`
- `POST /admin/logout`
- `POST /admin/memberships`
- `POST /admin/memberships/:membership_id/enrollment-grants`
- `POST /admin/memberships/:membership_id/revocations`
- `POST /admin/installations/:installation_id/revocations`
- `POST /admin/integrations/slack`

`GET /_echo/runtime-status` is a private nonce-challenged liveness route that
the ingress contract below keeps unreachable from outside.

Administrator requests use `Authorization: Bearer <token>`. Enrollment uses
`Authorization: Echo-Enrollment <grant>`. Lease refresh and permission checks
use installation-signed commands.

The Slack administrator routes implement the minimum-v1 organization-tool
contract documented in
[`organization-control-plane.md`](../../docs/architecture/organization-control-plane.md).
An active owner supplies a bot token and public channel; the Authority verifies
the exact provider identity, required scopes, and channel before storing the
token in mode-0600 secret storage. A historical profileless connection remains
usable by its existing binding and grants, but becomes employee-connectable
only after explicit re-verification promotes that same connection in place.

The browser console creates invitation secrets locally with Web Crypto and
sends only their digest to the authority. Its invitation records the current
HTTPS origin as the employee authority URL. The administrator credential is
exchanged for a bounded in-memory session with CSRF protection and is not
stored in JavaScript, cookies, or SQLite. The organization-tool form sends the
bot token only to the same-origin Authority and never places it in browser
storage or renders it back into the console.

An enrolled installation can perform the minimum manual Slack identity-link
challenge after the organization tool is active. The Authority derives the
membership from the installation signature, derives the human from the exact
Slack thread reply, requires that human to match the installation's configured
Slack reviewer, and creates no permission grants. The configured approval
surface must already use the organization-approved channel and contain one
`reviewer.slack_user_id`.

The manual ceremony is:

1. run `echo-brain organization slack-link-begin --config '<path>'`;
2. copy only the one-time code into a reply to the exact Slack challenge
   thread;
3. retain the returned attempt ID and Slack message timestamp;
4. read the code without terminal echo using
   `read -r -s ECHO_SLACK_LINK_CODE`, then run the emitted
   `slack-link-complete` command and immediately
   `unset ECHO_SLACK_LINK_CODE`;
5. give the returned membership, installation, identity-link, and binding IDs
   to an owner, who runs
   `echo-organization-admin slack approval activate --config '<Authority
   config>' --administrator-membership-id '<owner mem_...>'
   --target-membership-id '<employee mem_...>' --installation-id '<ins_...>'
   --identity-link-id '<clm_...>' --adapter-binding-id '<bnd_...>'`;
6. run `echo-brain doctor --config '<path>'` before restarting the service.

Do not paste the one-time code into tickets, chat, logs, or a command-line
argument. Automatic tool
propagation, non-Slack tools, credential or channel rotation, and fine-grained
integration lifecycle controls remain deferred. Membership and installation
revocation are the v1 access controls.

Approval authority is activated only after the employee's manual ceremony has
created an identity link and adapter binding. The administrator-authenticated
`POST /v1/admin/integrations/slack-approval-activation` route accepts six flat
strings: `command_id` (`adm_` UUIDv4, the idempotency handle),
`administrator_membership_id`, `target_membership_id`, `installation_id`,
`identity_link_id`, and `adapter_binding_id`. It creates only the exact
`approve` and `reject` grants for those existing records. It accepts no Slack
credential or provider configuration, makes no Slack API call, and does not
create or replace an identity link or adapter binding. In v1 the target
membership must own the enrolled installation. The call is audited as
`slack_approval.activated`.

## Ingress contract

The built-in server listens on loopback. A standard TLS reverse proxy must:

1. remove externally supplied `X-Echo-Proxy-Authorization` and
   `X-Echo-Authenticated-Client-Id` headers;
2. set `X-Echo-Proxy-Authorization: Echo-Proxy <trusted-proxy-token>`;
3. set `X-Echo-Authenticated-Client-Id: cid_<base64url-sha256>`;
4. keep `/_echo/runtime-status` private.

The shared token is stored in the initialized state directory. The client ID
is a bounded rate-limit identity, not authorization. Missing or malformed proxy
identity fails before routing.

The portable one-machine deployment is in
[`deploy/organization-authority`](../../deploy/organization-authority/README.md).

## Operator lifecycle

Build and initialize once:

```sh
npm run build:workspaces
npm run organization-authority:cli -- init-development \
  --config /absolute/operator/authority.json \
  --state-dir /absolute/operator/authority-state \
  --organization-name "Example Company"
npm run organization-authority:cli -- serve \
  --config /absolute/operator/authority.json
```

Initialization creates private state, two distinct credentials, the software
authority signing key, every database, and a config bound to that exact state:

```text
authority.json
authority-state/
  authority.sqlite
  integrations.sqlite
  record-log.sqlite
  record-derived.sqlite
  authority-identity.v1.json
  authority-initialization.v1.json
  authority-integrations-installation.v1.json
  authority-record-installation.v1.json
  keys/authority-development-key.v1.json
  credentials/admin-token
  credentials/trusted-proxy-token
```

Both installation markers exist in one piece with an anchor in
`authority.sqlite`. The record anchor is what makes a deleted decision log
loud: once an authority has published its record store, `serve` and
`install-integrations` both refuse a missing log, derived store, or marker
rather than recreating one. Only a state directory that was never anchored —
provably published before the record store existed — is bootstrapped by
`install-integrations`.

Successful organization-tool onboarding adds the private integration secret:

```text
authority-state/
  credentials/integrations/sch_<opaque-id>.secret
```

All files are current-user private. Integration secret files are created
mode-0600 and SQLite stores only their opaque `sch_*` handles. Repeating the
exact initialization is read-only. `serve` never creates replacement state,
and `status` verifies the config/state binding, signing identity, all four
database identities, and runtime ownership.

An authority state created before `integrations.sqlite` was introduced must be
upgraded explicitly while the authority is stopped:

```sh
npm run organization-authority:cli -- install-integrations \
  --config /absolute/operator/authority.json
```

The command checks the existing Authority identity, acquires the same
authenticated singleton ownership used by `serve`, and installs the new
database without replacing an anchored file. It durably publishes and verifies
the database-marker pair before committing the immutable Authority anchor, so a
retry can finish an interrupted target-schema installation. A completed
repetition is read-only, while partial legacy or mismatched anchored state is
refused. Missing or mismatched integration state always makes `serve` fail
closed.

The authority remains a foreground process. Process restart and persistent
volume backup belong to the container or service manager.

### Taking a backup

A file-level backup is valid only when it is taken from a **stopped** authority
whose stop **succeeded**. Stopping is not just quiescence: it drains the record
derive follower and walks the record log's hash chain while both handles are
still open, and it fails loudly when either step does not hold. A stop that
reported a failure means the state on disk is not a consistent recovery unit —
investigate before copying it, and never copy it as a good backup.

1. Stop the authority (`SIGTERM`, or the service manager's stop) and confirm it
   exited without a shutdown error and with exit code 0. A non-zero exit after a
   derive failure means the same thing: do not treat that state as a backup.
2. Copy the whole state directory as one unit. Every file below is part of the
   recovery unit; a backup missing any of them cannot be restored:
   - `authority.sqlite` — identity, memberships, enrollments, and the
     integrations and record installation anchors
   - `integrations.sqlite` — the control plane, including the permission audit
     that record ingest reads
   - `record-log.sqlite` — the organization decision record log. Truth.
   - `record-derived.sqlite` — the derived graph. Rebuildable, but copied so a
     restore does not have to replay
   - `authority-integrations-installation.v1.json` and
     `authority-record-installation.v1.json` — the installation markers whose
     digests are anchored in `authority.sqlite`; a restore without them fails
     closed rather than recreating what they describe
   - `authority-identity.v1.json` and `authority-initialization.v1.json`
   - `keys/` — the authority signing key
   - `credentials/` — the admin and trusted-proxy tokens
3. Restore all of it together. Restoring a subset — most sharply, a state
   directory whose record log is missing — is refused: the record anchor in
   `authority.sqlite` proves this authority already published a log, and neither
   `serve` nor `install-integrations` will recreate one. That refusal is the
   design: a fresh empty log would look healthy while every receipt already in
   members' hands pointed at records it no longer holds.

Databases use `journal_mode = DELETE`, so a stopped state has no WAL or SHM
sidecars and every file is readable read-only exactly as copied.

Runtime ownership is authenticated through a private Unix socket beside its
lock. The portable Docker deployment sets
`ECHO_AUTHORITY_COORDINATION_ROOT` to a dedicated shared Docker volume so the
guard has native Linux socket semantics without placing ephemeral artifacts in
durable organization state. A direct process deployment defaults to the state
directory. An authenticated live owner is never replaced; an invalid or
ambiguous proof fails closed. A stale lock is recovered only when the shared
socket listener is absent.

The separate administrator CLI speaks HTTP only and never opens SQLite:

```sh
npm run organization-authority:admin -- member create \
  --config /absolute/operator/authority.json \
  --display-name "Ada Lovelace" \
  --membership-type employee
```

The included private-key adapter is an explicitly labeled exportable software
key for the pilot. A later hardware-backed adapter can implement the same
signer port without changing enrollment or lease protocols.
