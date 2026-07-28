# Organization authority

The authority is the centrally hosted onboarding and access service for one
organization. It manages principals, memberships, one-time enrollment grants,
installation enrollment, short access leases, revocation, and an append-only
audit log. It does not store meetings, decisions, reasoning state, or
embeddings.

One process and one persistent SQLite database are the supported topology.
There is no tenant registry, organization switcher, billing layer, or
multi-replica coordination.

## HTTP surface

The employee and administrator surfaces share one listener and one public
origin:

- `GET /v1/authority-descriptor`
- `POST /v1/enrollments`
- `POST /v1/access-leases`
- `GET /v1/admin/overview`
- `GET /v1/admin/memberships`
- `GET /v1/admin/installations`
- `GET /v1/admin/enrollment-grants`
- `GET /v1/admin/audit`
- `POST /v1/admin/memberships`
- `POST /v1/admin/memberships/:membership_id/enrollment-grants`
- `POST /v1/admin/memberships/:membership_id/revocations`
- `POST /v1/admin/installations/:installation_id/revocations`
- `/admin` browser console

Administrator requests use `Authorization: Bearer <token>`. Enrollment uses
`Authorization: Echo-Enrollment <grant>`. Lease refresh uses an
installation-signed command.

The browser console creates invitation secrets locally with Web Crypto and
sends only their digest to the authority. Its invitation records the current
HTTPS origin as the employee authority URL. The administrator credential is
exchanged for a bounded in-memory session with CSRF protection and is not
stored in JavaScript, cookies, or SQLite.

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
authority signing key, the database, and a config bound to that exact state:

```text
authority.json
authority-state/
  authority.sqlite
  authority-identity.v1.json
  authority-initialization.v1.json
  keys/authority-development-key.v1.json
  credentials/admin-token
  credentials/trusted-proxy-token
```

All files are current-user private. Repeating the exact initialization is
read-only. `serve` never creates replacement state, and `status` verifies the
config/state binding, signing identity, database, and runtime ownership.

The authority remains a foreground process. Process restart and persistent
volume backup belong to the container or service manager.

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
