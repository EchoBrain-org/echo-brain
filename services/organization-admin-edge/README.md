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

## Preflight

Run the packaged preflight before placing the edge under a supervisor:

```sh
echo-organization-admin-edge preflight \
  --config /absolute/private/organization-admin-edge.json
```

Preflight requires the declared `darwin/arm64` Node 22.22.1 runtime. It reads
the same external configuration and owner-only files as `serve`, validates the
server certificate hostname, server-auth purpose, and current validity,
verifies that its private key matches, validates every certificate in the
client CA bundle as a current CA permitted for client authentication, and
constructs the same TLS 1.3 context used by the listener. The CA bundle must
contain only PEM certificate blocks separated by whitespace. Preflight does
not open a listener, contact the authority, register signal handlers, or
mutate runtime material.

The command returns zero and writes one secret-free JSON record on success. An
expected failure returns one and names only a bounded `failed_check` code. The
record may contain non-secret deployment origins, listener metadata,
certificate validity times, and counts. It never contains file paths, tokens,
pins, certificate subjects or bodies, private keys, or raw Node/OpenSSL error
text. The packaged
`schemas/organization-admin-edge-preflight.v1.schema.json` file is the closed,
machine-readable shape contract for this version 1 record.

The version 1 failure codes are:

- `release_platform`: the operating system, architecture, or Node version is
  outside the release cell;
- `runtime_config`: the external JSON configuration cannot be read or
  validated;
- `runtime_material`: a referenced owner-only file cannot be safely resolved;
- `server_certificate_parse`: the server certificate cannot be parsed;
- `server_certificate_hostname`: the server certificate does not cover the
  configured administrator hostname;
- `server_certificate_purpose`: the server certificate is a CA or its declared
  extended usage does not permit TLS server authentication;
- `server_certificate_not_yet_valid` and `server_certificate_expired`: the
  server certificate is outside its validity window;
- `server_private_key_parse` and `server_private_key_mismatch`: the private key
  cannot be parsed or does not match the server certificate; and
- `client_ca_or_tls_context`: the client CA bundle is malformed, contains a
  certificate that is not a current client-auth-capable CA, or cannot form the
  listener's TLS context.

Preflight proves only that the local candidate is safe to attempt to start at
that instant. It does not prove that the listener address and port are
available or that the process may bind them. It also does not prove DNS,
firewall, supervisor, authority health, proxy-token equality, public-chain
acceptance, revocation, renewal monitoring, or the identity and validity of
individual administrator client certificates.

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
{ "authority_base_url": "https://authority.example.com" }
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
