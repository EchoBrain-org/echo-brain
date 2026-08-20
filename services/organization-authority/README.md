# Organization authority

The Authority is the centrally hosted identity, processing, and data service
for one organization. Its current machine-facing identity is an external-OIDC
Person session. It manages principals, memberships, rotating sessions,
revocation, provider integrations, and append-only organization decision
records. Installation enrollment and access leases remain as server-side V1
compatibility; no shipped machine client calls them. Its governed pre-record
tables may retain raw canonical meetings and deterministic extraction state
for processing; they have no human-readable application route and become
cleanup-eligible 30 days after terminal approval or rejection. The Authority
stores no embeddings.

One process and four persistent SQLite databases are the supported topology:
`authority.sqlite` is the source of membership, Person identity and session,
retained installation compatibility, and source-bound pre-record processing
truth, while
`integrations.sqlite` contains customer-owned provider links,
connections, adapter bindings, direct grants, and integration audit.
`record-log.sqlite` is the append-only record of truth, and
`record-derived.sqlite` contains its replayable projection. All four databases
are owned by the same authenticated singleton process. Readable-search-capable
builds also keep immutable retrieval generations below
`record-retrieval/generations/`; those directories are not a fifth mutable
source of truth. There is no tenant registry, organization switcher, billing
layer, or multi-replica coordination.

## Release boundary

The bounded two-policy readable-search path has one exact deployed
founder-live run recorded by
[`QUAL-20260814-194049-001`](../../docs/qualification/QUAL-20260814-194049-001-readable-search-minimum-v1.md).
That immutable report owns the source, image, state, and non-claims; this
README does not mirror mutable deployment identity. Operators must require
the route, generation, verifier, and query-audit procedures whenever the
selected image is readable-search-capable. Historical images may not contain
those commands.

## Stopped one-meeting processing command

`process-one-meeting` is a disabled-by-default founder-live ingress rung. It
acquires the same singleton as `serve`, requires an exact active member/source
binding and an operator-asserted organization-scoped Granola credential, pulls
at most one meeting, runs only the deterministic structured-text processor,
and stages the result as pending in `authority.sqlite`. It emits sanitized
counts and opaque approval IDs only.

The command is not a worker or complete product loop. It cannot run beside the
HTTP Authority, does not resolve approval, deliver, append a record, advance a
pending cursor, or start itself again. The EC2 stop/checkpoint/run/restart gate
is documented in
[`deploy/organization-authority/AWS-EC2.md`](../../deploy/organization-authority/AWS-EC2.md).

`process-one-meeting` remains the deterministic stopped-state provisioning
path. When `serve` finds the exact persisted source and Slack approval bindings,
it composes the serialized live worker with the Granola source, the existing
LLM decision processor over OpenRouter, Slack approval, record-first final
delivery, and Authority SQLite state. Minimum V1 pins
`deepseek/deepseek-r1` with strict structured output. The API key is read once
at startup from the dedicated current-user `0600` credential file; it is not
stored in Authority config, a database, Compose, or logs.

## HTTP surface

The Person, retained compatibility, and administrator surfaces share one
listener and one public origin. Current Person routes are:

- `POST /v2/session/oidc/begin`
- `GET /v2/session/oidc/callback`
- `POST /v2/session/refresh`
- `POST /v2/session/revocations`
- `POST /v2/recent-decisions`
- `POST /v2/reviewer-recent-decisions`
- `POST /v2/readable-search`
- `POST /v2/member-exclusions`
- `POST /v2/member-exclusions/list`
- `POST /v2/integration-links/slack/challenges`
- `POST /v2/integration-links/slack/completions`
- `POST /v2/admin/memberships/:membership_id/person-login-grants`
- `POST /v2/admin/member-exclusions/break-glass`

The following V1 routes remain for installation-bound compatibility:

- `GET /v1/authority-descriptor`
- `POST /v1/enrollments`
- `POST /v1/access-leases`
- `POST /v1/permission-checks`
- `POST /v1/readable-search` (readable-search-capable image only)
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
`Authorization: Echo-Enrollment <grant>`. Lease refresh, permission checks,
and V1 readable search use installation-signed commands. Current Person routes
use the Authority-issued Person bearer access token.

The compatibility access-lease route accepts both request versions. V1 keeps
the operator-configured lifetime of at most five minutes; V2 signs an explicit
requested maximum of at most 30 minutes. The current Person product uses
neither version: its access and refresh expirations are part of the Person
session protocol. Retained installation state and matching old client state
must still be restored together when investigating that historical path.

When a readable-search-capable image is selected,
`POST /v1/readable-search` provides the bounded two-policy behavior. It is
not an operational release. It accepts only a canonical RFC 8785 signed request body
with no URL query, searches the two closed policy families, and returns at most
ten whole decision/action/rationale items. It has no pagination, totals,
scores, snippets, filters, cache, external provider, vector, graph, or model
surface. A missing, stale, partial, corrupt, or otherwise unadmitted generation
returns the fixed no-store `503`; invalid request bytes return `400`, and
authentication/resource denials use their fixed complete `401`/`404` bodies.

The Slack administrator routes implement the minimum-v1 organization-tool
contract documented in
[`organization-control-plane.md`](../../docs/architecture/organization-control-plane.md).
An active owner supplies a bot token and public channel; the Authority verifies
the exact provider identity, required scopes, canonical non-null Slack app ID,
and channel before storing the token in mode-0600 secret storage. The app proof
comes from `bots.info` for the bot established by `auth.test`, not from an app
ID that might be absent from `auth.test` or from a Slack message. A historical
profileless connection remains usable by its existing binding and grants, but
becomes employee-connectable only after explicit re-verification promotes that
same connection in place.

The same owner-only Slack onboarding operation also repairs a historical
profileless or ready tool whose stored app ID is `null`. This is explicit
re-onboarding, never a startup migration or a raw database edit: the Authority
reads the retained opaque secret handle privately, verifies it with Slack
again, requires the submitted credential to match rather than rotating it, and
asks the control plane to promote the connection and every exact active Slack
approval binding atomically. Connection IDs, binding IDs, grants, secret
handles, and prior audit rows are preserved; the repair appends a fresh audit
entry. The bot token is neither returned by the route nor logged, rendered,
stored in SQLite, or placed in browser storage.

The browser console still exposes V1 installation invitation creation for
server compatibility, but no shipped client consumes those invitations. It
creates their secrets locally with Web Crypto and sends only the digest to the
Authority. The administrator credential is exchanged for a bounded in-memory
session with CSRF protection and is not stored in JavaScript, cookies, or
SQLite. The organization-tool form sends the bot token only to the same-origin
Authority and never places it in browser storage or renders it back into the
console.

After the organization tool is active, a signed-in Person performs the manual
Slack identity proof with:

1. `echo-brain person slack-link-begin`;
2. reply with the returned one-time challenge code in the exact Slack thread;
3. retain the returned challenge-attempt ID and message timestamp; and
4. pass the code on standard input to `echo-brain person slack-link-complete`
   with those two identifiers.

The Authority re-authenticates the Person session, derives the human from the
exact Slack thread reply, and creates or reuses only the external identity
link for that exact principal and membership. Do not paste the one-time code
into tickets, chat, logs, or a command-line argument. This Person flow creates
no adapter binding and no permission grant.

The administrator-authenticated
`POST /v1/admin/integrations/slack-approval-activation` route remains a V1
installation-bound compatibility surface. It accepts
`administrator_membership_id`, `target_membership_id`, `installation_id`, an
existing identity link, and an existing adapter binding, then creates the exact
`approve` and `reject` grants. The Person identity-link flow cannot satisfy
that old binding contract. A Person-bound approval activation path is not yet
implemented. The retained installation-signed V1 Slack link remains the narrow
way to create that exact binding. Once its grants and a processing source are
ready, `serve` composes the bundled Slack approval adapter into the serialized
meeting worker. `process-one-meeting` remains a bounded stopped-state admission
command and does not publish an approval card.

### Retained installation access recovery

This section describes server-side V1 compatibility, not a current Person
operation. An old installation refreshes its own lease, and the Authority
recovers exactly one
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
It can be recovered only by an installation-signed `POST /v1/access-leases`
request from matching retained V1 client state. The shipped Person client has
no installation signer, lease-refresh command, or `runtime.json`, so the admin
command alone cannot make a legacy installation operational. Do not use this
route for Person-session recovery.

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

The portable single-Authority deployment is in
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
  record-retrieval/
    generations/<sha256-generation-id>/
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

`record-retrieval/` is absent after ordinary initialization and appears only
after a stopped readable-search rebuild publishes a complete immutable
generation. The active-generation pointer remains in `authority.sqlite`; a
generation directory must never be copied, repaired, or swapped on its own.

### Readable-search and retained V1 recording configuration

This section applies only to a readable-search-capable image. Historical
images without these commands retain their own immutable runbook requirements.

The Authority config format retains an optional closed
`organization_recording_policy_v1` object for source compatibility. The
current initializer leaves it absent, and an operator must not add it by
editing an initialized config. When present in an already materialized
baseline it contains exactly:

```json
{
  "schema_version": 1,
  "kind": "organization-recording-policy-v1",
  "decision_processor_adapter_instance_id": "<legacy producer provenance instance>",
  "approval_surface_adapter_instance_id": "<centrally enforced surface instance>",
  "presentation_mode": "organization-member-readable-v1",
  "policy_contract_sha256": "sha256:<matching policy contract>"
}
```

`presentation_mode` is either `restricted-reviewer-v1` or
`organization-member-readable-v1`; the contract digest must match that exact
mode. Its absence never enables organization-member-readable admission.

An Authority initialized before this mapping existed keeps its original
runtime config and initialization manifest immutable. Enable the one supported
organization-member-readable capability with the stopped, one-way activation
command instead of
editing either file:

```sh
npm run organization-authority:cli -- \
  activate-organization-member-recording \
  --config /absolute/operator/authority.json \
  --command /absolute/private/activate-organization-member-recording.json
```

The mode-0600 canonical command contains exactly:

```json
{
  "schema_version": 1,
  "kind": "echo-organization-member-recording-activation-command",
  "command_id": "rpa_<uuid-v4>",
  "authority_id": "oau_<uuid-v4>",
  "organization_id": "org_<uuid-v4>",
  "initialized_runtime_config_sha256": "sha256:<initialized-config-digest>",
  "initialization_manifest_sha256": "sha256:<initialization-manifest-digest>",
  "owner_principal_id": "prn_<uuid-v4>",
  "owner_membership_id": "mem_<uuid-v4>",
  "target_policy": {
    "schema_version": 1,
    "kind": "organization-recording-policy-v1",
    "decision_processor_adapter_instance_id": "<legacy producer provenance instance>",
    "approval_surface_adapter_instance_id": "<exact active Slack surface instance>",
    "presentation_mode": "organization-member-readable-v1",
    "policy_contract_sha256": "sha256:<exact-built-in-contract>"
  },
  "requested_at": "<canonical-UTC-millisecond-time>",
  "reason": "<bounded operator reason>"
}
```

The command requires the exact current active owner, both initialized baseline
digests, the built-in organization-member-readable policy digest, and a fresh
first execution within five minutes. First creation also refuses unless the
target `approval_surface_adapter_instance_id` is an exact active
`slack-reactions` approval-surface instance bound to the current active Slack
organization tool. The control-plane binding's public configuration pins the
Slack identity, channel, and reaction pair; it does not contain the product's
local `presentation_mode`.

The immutable Authority journal entry is the runtime overlay; the
initialization manifest remains history. Repeating the exact command is
read-only and returns `created: false`; reusing its ID for different bytes or
trying to activate a different policy is refused.

This activates retained V1 installation-bound admission only. It does not
switch a current producer: the Person client does not submit record envelopes,
and the deleted machine product has no supported reconfigure command. The
activation adds member-v3 admission without replacing the existing reviewer-v2
family. There is no generic policy editor or in-place rollback in V1.

For schema-v3 ingest, the installation-signed envelope contains a bounded
processor instance as signed provenance. Authority validates it structurally
but does not compare that string with the activation, a control-plane binding,
or the authorization audit; a different processor string alone does not reject
ingest. Authority instead re-proves the exact allowed authorization audit named
by the signed envelope and requires that audit's approval-surface instance,
adapter binding, and evidence commitments to match the activated surface. The
central gate is the built-in policy digest plus the exact active and audited
approval-surface instance; `presentation_mode` is not stored in control-plane
public configuration.

Stop the Authority and snapshot the complete state directory before any
maintenance command. The shared initialization and authenticated runtime locks refuse
maintenance while a live Authority owns the state:

```sh
npm run organization-authority:cli -- rebuild-readable-search \
  --config /absolute/operator/authority.json

npm run organization-authority:cli -- readable-search-query-audit-export \
  --config /absolute/operator/authority.json \
  --command /absolute/operator/readable-search-query-audit-export.json \
  --output /absolute/private/readable-search-query-audit.json

npm run organization-authority:cli -- readable-search-query-audit-expire \
  --config /absolute/operator/authority.json \
  --command /absolute/operator/readable-search-query-audit-expiry.json
```

`rebuild-readable-search` verifies the Authority, integration, record, and
both policy-fact families; builds one complete private generation; then
atomically publishes its pointer at the exact record head. A new record append
does not wait for Layer 2, but immediately makes that pointer stale and the
route returns `503` until another stopped rebuild publishes an exact-head
generation. Rebuild never mutates an active generation in place; a failed
rebuild leaves the prior pointer untouched, which may still be unavailable if
its head is stale.

The readable-search decision audit is isolated from generic admin audit listing
and retained immutably for 180 days. Export and expiry use distinct canonical
`sqa_` commands, require the exact current active owner, and require a
five-minute freshness window for first execution. Export accepts only a
positive, non-future range of at most 31 days and writes a create-once,
current-user `0600` file under a current-user `0700` parent outside managed
Authority state; its output path digest must match the signed command. Expiry
uses its Authority transaction time and deletes only elapsed complete rows,
recording an immutable receipt in the same transaction.

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

`record-derived.sqlite` is the only replaceable SQLite projection in the state
directory: it holds nothing the log does not already prove. Retrieval
generations are separately rebuilt and published only through
`rebuild-readable-search`; no individual generation file is repairable. Stop
the authority and snapshot the whole state directory exactly as-is before
mutation, then recreate a missing projection or replace a stale or
content-corrupt one:

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
2. For a readable-search-capable image, before copying run
   `verify-readable-search-backup` below. It returns the
   text-free `verified` receipt for an admitted exact-head generation, or the
   benign `not_built` receipt when no active pointer exists. Either result may
   precede a recovery-grade archive. A stale pointer/head mismatch, corrupt
   generation, staging directory, or sidecar is a failure, not a valid backup
   result.
3. Copy the whole state directory as one unit. For a readable-search-capable
   image, do so only after that successful verification. Every
   protected file below is
   mandatory. A known-good backup also includes the derived file and, if an
   active readable-search generation exists, its complete immutable generation
   directory; `record-derived.sqlite` is the only SQLite file that may instead
   be rebuilt from the verified log before serving:
   - `authority.sqlite` — identity, memberships, enrollments, and the
     integrations and record installation anchors
   - `integrations.sqlite` — the control plane, including the permission audit
     that record ingest reads
   - `record-log.sqlite` — the organization decision record log. Truth.
   - `record-derived.sqlite` — the derived graph. Rebuildable, but copied so a
   restore does not have to replay
   - `record-retrieval/` — the active-generation directory and any retained
     immutable generations. The active pointer in `authority.sqlite` must refer
     to a complete generation at the restored record head before search can
     serve
   - `authority-integrations-installation.v1.json` and
     `authority-record-installation.v1.json` — the installation markers whose
     digests are anchored in `authority.sqlite`; a restore without them fails
     closed rather than recreating what they describe
   - `authority-identity.v1.json` and `authority-initialization.v1.json`
   - `keys/` — the authority signing key
   - `credentials/` — the admin and trusted-proxy tokens
4. Restore all protected state together. If only `record-derived.sqlite` is
   absent, run `rebuild-derived` while still stopped. A missing readable-search
   generation may be rebuilt only from verified current Layer 1 while stopped;
   a stale generation must remain unavailable. Any other partial restore — most
   sharply, one missing the record log — is refused: the record anchor in
   `authority.sqlite` proves this authority already published a log, and no
   command recreates one. A fresh empty log would look healthy while every
   receipt already in members' hands pointed at records it no longer holds.

Databases use `journal_mode = DELETE`, so a stopped state has no WAL or SHM
sidecars and every file is readable read-only exactly as copied.

For a readable-search-capable image, before archiving and again after
restoring, run the stopped validation command:

```sh
npm run organization-authority:cli -- verify-readable-search-backup \
  --config /absolute/operator/authority.json
```

It is the B validation gate for active pointer/head equality, runtime retrieval
contract, complete generation manifests and roots, temporary build directories,
and retrieval SQLite sidecars. A tar/copy archive is recovery-grade for the
retrieval state only when it follows a stopped `verified` or `not_built` result
at the appropriate checkpoint; it still does not authorize serving after
restore without the external reconciliation below.

If the command rejects a stale pointer/head after an authorized append, keep
the Authority stopped. A pre-rebuild copy may be retained only as an
**unverified incident snapshot**, never as a known-good recovery backup. Run
`rebuild-readable-search`, rerun this verifier, and only then take a separate
recovery-grade archive. The rebuild is what repairs intended Layer 2 staleness;
the verifier never repairs it.

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

The included Authority private-key adapter is an explicitly labeled exportable
software key for the pilot. A later hardware-backed Authority adapter can
implement the same signer port. This is server key custody; the Person client
has no installation signing key.
