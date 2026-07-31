# Organization authority

The authority is the centrally hosted onboarding and access service for one
organization. It manages principals, memberships, one-time enrollment grants,
installation enrollment, short access leases, revocation, and an append-only
audit log. It does not store meetings, decisions, reasoning state, or
embeddings.

One process and two persistent SQLite databases are the supported topology:
`authority.sqlite` remains the source of membership and installation truth,
while `integrations.sqlite` contains customer-owned provider links,
connections, adapter bindings, direct grants, and integration audit. Both
databases are owned by the same authenticated singleton process. There is no
tenant registry, organization switcher, billing layer, or multi-replica
coordination.

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
- `POST /v1/admin/integrations/slack-approval-bootstrap`

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
5. run `echo-brain doctor --config '<path>'` before restarting the service.

Do not paste the one-time code into tickets, chat, logs, or a command-line
argument. Automatic tool
propagation, non-Slack tools, credential or channel rotation, and fine-grained
integration lifecycle controls remain deferred. Membership and installation
revocation are the v1 access controls.

Approval authority itself is granted only by
`POST /v1/admin/integrations/slack-approval-bootstrap`, an administrator
bearer-token route with no console form or CLI verb yet. Its JSON body is
eleven flat strings — `command_id` (`adm_` UUIDv4, the idempotency handle),
`administrator_membership_id`, `target_membership_id`, `installation_id`,
`adapter_instance_id`, `adapter_version`, `channel_id`, `approve_reaction`,
`reject_reaction`, `slack_user_id`, and `slack_bot_token` — validated in
`src/composition/organization-integrations.ts`. One call verifies the provider
identities and creates the employee's identity link, adapter binding, and
`approve`/`reject` grants together, so for pilot employees it replaces rather
than follows the manual link ceremony, which by itself leaves every reaction
denied. The call is audited as `slack_approval.bootstrap`.

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
authority signing key, both databases, and a config bound to that exact state:

```text
authority.json
authority-state/
  authority.sqlite
  integrations.sqlite
  authority-identity.v1.json
  authority-initialization.v1.json
  authority-integrations-installation.v1.json
  keys/authority-development-key.v1.json
  credentials/admin-token
  credentials/trusted-proxy-token
```

Successful organization-tool onboarding adds the private integration secret:

```text
authority-state/
  credentials/integrations/sch_<opaque-id>.secret
```

All files are current-user private. Integration secret files are created
mode-0600 and SQLite stores only their opaque `sch_*` handles. Repeating the
exact initialization is read-only. `serve` never creates replacement state,
and `status` verifies the config/state binding, signing identity, both database
identities, and runtime ownership.

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
volume backup belong to the container or service manager. Stop the authority
before taking a file-level backup so `authority.sqlite`,
`integrations.sqlite`, the signing key, and credentials form one consistent
recovery unit.

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
