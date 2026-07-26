# Organization administrator edge

**Status:** provider-neutral, single-origin authenticated HTTPS edge for the
organization authority's browser administrator console

This workspace is a separate foreground process. It terminates HTTPS, requires
a valid client certificate from the configured client CA, and then requires the
certificate's SHA-256 SPKI pin to appear in the explicit administrator
allowlist. CA trust alone does not grant access.

For an allowed certificate, the edge derives
`cid_<base64url-sha256(spki-der)>`, removes untrusted forwarding and ECHO
headers, and injects the configured proxy credential and derived client ID on
one loopback-only HTTP hop to the organization authority. The only ECHO request
header retained from a browser is `X-Echo-Admin-Csrf`.

The edge does not expose administrator JSON APIs, enrollment/access APIs, or
the authority runtime-status endpoint. It has no database and does not read the
authority administrator credential.

## Runtime config

The `serve` command accepts one current-user `0600` canonical regular JSON
file:

```json
{
  "schema_version": 1,
  "kind": "echo-organization-admin-edge-runtime-config",
  "listener": {
    "host": "0.0.0.0",
    "port": 443
  },
  "public_origin": "https://admin.example.com",
  "employee_authority_base_url": "https://authority.example.com",
  "authority_origin": "http://127.0.0.1:39479",
  "tls": {
    "certificate_chain_ref": "file:/absolute/private/edge/server-chain.pem",
    "private_key_ref": "file:/absolute/private/edge/server-key.pem",
    "client_ca_bundle_ref": "file:/absolute/private/edge/admin-client-ca.pem"
  },
  "trusted_proxy_token_ref": "file:/absolute/private/edge/trusted-proxy-token",
  "allowed_admin_client_spki_sha256": [
    "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
  ]
}
```

Every `file:` reference must contain a normalized absolute path. Each referenced
file must be a current-user-owned, non-symlink, canonical `0600` regular file.
The certificate chain, private key, client CA bundle, and proxy token must use
distinct files. The proxy token must contain 32–4096 visible ASCII bytes with
no newline and must exactly match the token configured at the loopback
authority origin.

`public_origin` and `employee_authority_base_url` are canonical bare HTTPS
origins without a trailing slash. `public_origin` must use a DNS hostname
covered by the server certificate's subject alternative names. The edge
requires that hostname as TLS SNI and requires the origin's exact `Host` value.
`employee_authority_base_url` is returned only to an authenticated
administrator browser so invitation generation can name the separate
employee-facing authority origin. It must differ from `public_origin`.

The administrator pin is:

```text
sha256:<lowercase hex SHA-256 of the client certificate public key's DER SPKI>
```

Issue a different client certificate and private key per administrator device.
Removing a pin and restarting the edge denies that certificate. Reissuing a
certificate with a different key produces a different pin and client ID and
therefore invalidates sessions bound to the old identity.

## Run

From the repository:

```sh
npm run build:workspaces
node services/organization-admin-edge/dist/main.js serve \
  --config /absolute/private/organization-admin-edge.json
```

`serve` fails closed unless the runtime is the declared release cell:
darwin/arm64 with Node 22.22.1. npm 10.9.4 remains the artifact build/install
toolchain declaration and is not a service-runtime dependency. A local
unsupported-host development or one-machine rehearsal may cross the runtime
fence only with an exact loopback listener (`127.0.0.1` or `::1`) and the
explicit acknowledgement:

```sh
node services/organization-admin-edge/dist/main.js serve \
  --config /absolute/private/organization-admin-edge.json \
  --acknowledge-unsupported-host-for-development
```

That acknowledgement emits a structured non-qualifying warning. It must never
appear in a public deployment or service-supervisor command, and it is rejected
when the process already runs on the declared release platform.

The packaged artifact exposes the same command as
`echo-organization-admin-edge`. The process prints one secret-free readiness
record, stays in the foreground, and closes on SIGINT or SIGTERM. Service
supervision, certificate issuance/renewal, client-key protection, firewalling,
and DNS remain deployment responsibilities.

The authority origin must run in the same host or network namespace because the
edge accepts only a bare `127.0.0.1` or `::1` HTTP origin. Never place that
origin on a routable interface.

## External route boundary

Only these request shapes are accepted:

- `GET /admin`
- `GET /admin/`
- `GET /admin/login`
- `GET /admin/assets/admin.css`
- `GET /admin/assets/admin.js`
- `GET /admin/edge-config`
- `POST /admin/login`
- `POST /admin/logout`
- `POST /admin/memberships`
- `POST /admin/memberships/:membership_id/enrollment-grants`
- `POST /admin/memberships/:membership_id/revocations`
- `POST /admin/installations/:installation_id/revocations`

The subject identifiers in parameterized paths must be canonical UUIDv4-backed
ECHO IDs. Queries, absolute request targets, traversal forms, other methods,
request bodies on GET, and every other path fail before an origin request.

`GET /admin/edge-config` is answered by the edge itself with exact JSON:

```json
{"authority_base_url":"https://authority.example.com"}
```

It is mTLS-, pin-, SNI-, and Host-protected; has no CORS or redirect behavior;
uses `Cache-Control: no-store`; and never reaches the authority origin.

Every POST requires the exact HTTPS `Origin` and a canonical bounded
`Content-Length`. Transfer encoding, content encoding, upgrades, expectations,
duplicate raw headers, ambiguous framing, and more than 64 headers are rejected.
The edge buffers at most the organization API's 16 KiB request limit before
opening the origin request. It buffers at most 1 MiB from the origin, never
automatically retries a POST, strips hop-by-hop response headers, and adds a
one-year HSTS policy. Absolute upstream and downstream deadlines bound slow
drips and stalled readers, and every completed response closes its TLS
connection.

The implementation does not log request bodies, cookies, credentials,
certificate contents, raw identities, invitations, or full request targets.

## Tests

Tests generate short-lived CA, server, and client material in a private
temporary directory with the local `openssl` executable. No TLS private key is
committed.

```sh
npm test --workspace @echo-brain/organization-admin-edge
```
