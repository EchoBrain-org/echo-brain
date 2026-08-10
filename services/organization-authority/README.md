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
- `POST /v1/admin/installations/:installation_id/access-recoveries`
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

### Recovering stale installation access

An installation refreshes its own lease, and the Authority recovers exactly one
skipped head automatically. An installation left further behind than that —
because signed renewal responses were lost before it could store them, or
because its local state is otherwise missing heads the Authority already
issued — cannot renew, since its local head is neither the Authority's current
head nor that head's immediate predecessor. That automatic policy is unchanged;
this is its deliberately narrow operator fallback.

The administrator-authenticated
`POST /v1/admin/installations/:installation_id/access-recoveries` route accepts
two fields: `local_access_state_sequence`, the sequence the operator read from
the stranded installation, and a bounded `reason`. The Authority acts only when
the enrollment and its membership are active, current access is active, and the
current sequence is at least two ahead of the reported one. The reported
sequence is the operator's word and is never proof of what the installation
holds; it only rules out the one-head gap automatic recovery already covers.
Once eligible, the two cases differ: an expired current head is repaired by
appending exactly one ordinary Authority-signed active head with the normal
next sequence and the normal lease TTL, audited as
`installation.access_recovered`, while a still-live current head is returned
unchanged with `changed: false` and nothing is appended, so a retry is safe.
Nothing is rewritten or deleted, and no revoked membership, enrollment, or
access head is revived.

The response carries no signed or secret material — only `installation_id`,
`changed`, the reported `local_access_state_sequence`, the current
`access_state_sequence`, and its `valid_until`.

```sh
npm run organization-authority:admin -- installation access-recover \
  --config /absolute/operator/authority.json \
  --installation-id 'ins_<UUIDv4>' \
  --local-access-sequence 254 \
  --reason 'Missed issued heads through lost lease responses'
```

The repaired head is not in that response and is never handed to the operator.
It reaches the installation through the ordinary lease route: the next
`POST /v1/access-leases` signed from the stale local head is answered with the
usual `409` stale-state response, and that response body carries the repaired
head, which the installation verifies and stores like any other.

So the recovery is only half done when the command returns. The stranded
machine must run

```sh
echo-brain organization refresh --config /absolute/path/runtime.json
```

before the `valid_until` the command reported. The repaired head is an ordinary
lease with the ordinary TTL, so if it expires first nothing is broken and
nothing is recovered — run the administrator recovery again and refresh inside
the new window.

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
the database-marker pair before committing the immutable Authority anchor. A
completed repetition is read-only. Partial legacy state, a partial unanchored
record-database pair, or mismatched anchored state is refused rather than
guessed at; nothing here is automatic recovery, and no command rebuilds a log.
Missing or mismatched integration state always makes `serve` fail closed.

### Activating the two-person permission pilot

Activation is an operator-confirmed local maintenance act, not an HTTP
administrator act or proof of a named founder. Stop the Authority, create a
current-user mode-0600 canonical JSON command outside mutable state, and run:

```sh
npm run organization-authority:cli -- activate-permission-pilot \
  --config /absolute/operator/authority.json \
  --command /absolute/operator/permission-pilot-activation.json
```

The exact command shape is:

```json
{
  "schema_version": 1,
  "kind": "echo-organization-permission-pilot-activation-command",
  "command_id": "ppa_<UUIDv4>",
  "authority_id": "oau_<UUIDv4>",
  "organization_id": "org_<UUIDv4>",
  "policy_id": "pilot-member-readable-v1",
  "presentation_policy_id": "pilot-two-person-audience-v1",
  "audience": [
    { "membership_id": "mem_<UUIDv4>", "label": "First Person" },
    { "membership_id": "mem_<UUIDv4>", "label": "Second Person" }
  ],
  "requested_at": "2026-08-10T08:00:00.000Z",
  "reason": "Operator-confirmed two-person post-activation read pilot."
}
```

The audience must be sorted by membership ID. Both memberships must currently
be active, and each label must exactly equal its Authority principal display
name. First creation requires `requested_at` within five minutes of execution.
The command takes the same authenticated singleton runtime lock as `serve`,
verifies the record chain, and writes one immutable marker at the current log
head. An exact command-ID-and-digest retry returns that marker even after later
appends or membership changes; any different command is refused.

Successful output contains the non-secret marker and its canonical
`presentation_descriptor`. Install that exact descriptor in both pilot
approval-surface configurations before accepting live approvals. The marker
opens only notice-qualified records appended after its recorded boundary; it
does not disclose pre-activation history.

The authority remains a foreground process. Process restart and persistent
volume backup belong to the container or service manager.

### Rebuilding the derived record store

`record-derived.sqlite` is the only rebuildable file in the state directory:
it holds nothing the log does not already prove. Stop the authority and snapshot
the whole state directory exactly as-is before mutation, then recreate a missing
projection or replace a stale or content-corrupt one:

```sh
npm run organization-authority:cli -- rebuild-derived \
  --config /absolute/operator/authority.json
```

The command acquires the same authenticated singleton ownership `serve` and
`install-integrations` take, so a running authority refuses it rather than
having the file it is serving replaced underneath it. Stop the authority first.
If stop failed or the projection is already missing or corrupt, label the
pre-rebuild snapshot not-known-good and retain the last known-good backup.

It opens `record-log.sqlite` read-only and never writes to it, verifies the
whole hash chain, then replays through the same follower and projector `serve`
uses into a new sibling database. It refuses installed `-journal`, `-wal`, or
`-shm` sidecars rather than deleting or guessing about them. Only after replay
reaches the verified log head and the staged database validates does one atomic
rename replace the derived path. A pre-swap failure leaves that path unchanged.
The installation marker and its Authority anchor are never rewritten because
they bind the canonical paths, not the derived file's inode.

Output is one strict JSON line. `head_position` is the verified log head the
new database was replayed to, and `derived_content_sha256` is the derived
graph's canonical content digest. Because derived content is a pure function of
log content, repeating the rebuild against an unchanged log reports the same
digest — the command is idempotent, and an empty log rebuilds to a valid
derived store at head 0.

This rebuilds the projection and nothing else. It does not restore, repair, or
recreate `record-log.sqlite`, does not complete a partial installation, and
does not stand in for a backup. A missing or mismatched log, record marker, or
Authority anchor is refused and never written: restore the complete state
directory. A deterministic projection fault in the log is reproduced and
reported rather than skipped. An existing derived target that is not a
current-user `0600` canonical regular file is also refused for investigation or
restore.

### Taking a known-good backup

A file-level backup is valid only when it is taken from a **stopped** authority
whose stop **succeeded**. Stopping is not just quiescence: it drains the record
derive follower and walks the record log's hash chain while both handles are
still open, and it fails loudly when either step does not hold. A stop that
reported a failure means the state on disk is not a consistent recovery unit —
investigate before copying it, and never copy it as a good backup.

1. Stop the authority (`SIGTERM`, or the service manager's stop) and confirm it
   exited without a shutdown error and with exit code 0. A non-zero exit after a
   derive failure means the same thing: do not treat that state as a backup.
2. Copy the whole state directory as one unit. Every protected file below is
   mandatory. A known-good backup also includes the derived file; it is the only
   file that may instead be rebuilt from the verified log before serving:
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
3. Restore all protected state together. If only `record-derived.sqlite` is
   absent, run `rebuild-derived` while still stopped, then serve. Any other
   partial restore — most sharply, one missing the record log — is refused: the
   record anchor in `authority.sqlite` proves this authority already published a
   log, and no command recreates one. A fresh empty log would look healthy while
   every receipt already in members' hands pointed at records it no longer holds.

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
