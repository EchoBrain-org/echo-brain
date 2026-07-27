# Organization administrator edge

**Status:** development operator contract; no production deployment or Phase 5
network qualification claimed

This runbook describes how to build, configure, start, rotate, and roll back
the organization administrator HTTPS edge. It defines a target operating
boundary for local and later deployment work. Completing these steps on a
developer machine does not prove a production endpoint and does not close
Phase 5 `P5-NET-001`.

## Deployable and trust boundary

The edge is an exact artifact distinct from both other runtime artifacts:

```text
employee-machine ECHO artifact
single-organization authority artifact
organization administrator edge artifact
```

It is a foreground, stateless transport process. It owns:

- server TLS for one exact administrator origin;
- mandatory client-certificate verification;
- an explicit administrator client-SPKI SHA-256 allowlist;
- canonical request-target, Host, header, framing, size, and timeout checks;
- an exact console route allowlist;
- trusted identity injection on the private loopback hop; and
- the local, non-secret `GET /admin/edge-config` deployment-metadata response.

It does not own membership, organization roles, the administrator bearer
credential, authority browser sessions, CSRF decisions, invitation grant
registration, enrollment, leases, revocation, audit, signing, or any database.
Those remain in the single-organization authority.

```text
administrator browser
  -- HTTPS to exact admin.example.com
  -- valid client certificate
  -- configured SPKI pin
  --> administrator edge
        -- one sanitized, bounded request
        -- one injected Echo-Proxy credential
        -- one cid_ identity derived from authenticated certificate material
        --> http://127.0.0.1:<authority-port>
            organization authority

invitation authority_base_url
  --> https://employee-authority.example.com
      (a separate employee-facing origin, not an admin-edge proxy route)
```

## Exact artifact

Build only from a clean committed source state. The builder requires the
supplied full SHA to equal `HEAD`, materializes that commit independently, and
publishes one tarball, checksum sidecar, and artifact manifest into a new output
directory:

```sh
node tools/organization-admin-edge/build-artifact.mjs \
  --version 0.1.0-dev.admin-edge \
  --source-sha "$(git rev-parse HEAD)" \
  --out-dir /absolute/path/to/admin-edge-artifact
```

Verify the published directory before extracting or executing the candidate:

```sh
node tools/organization-admin-edge/verify-artifact.mjs \
  --artifact-dir /absolute/path/to/admin-edge-artifact \
  --output /absolute/path/to/admin-edge-verification.json
```

The verifier checks the complete file set, manifest, tarball checksum,
per-file hashes, build identity, bundled shared workspaces, runtime dependency
closure, and declared platform. It does not validate operator certificates,
credentials, network policy, or a live deployment.

The artifact must contain no runtime configuration, TLS material, client CA,
proxy token, log, or supervisor state. Installation and service supervision
remain operator-owned. Retain the tarball, manifest, checksum, and verification
record together so rollback can select exact previously verified bytes.

## Runtime files and configuration

Place runtime files outside the immutable installation prefix. Use normalized
absolute paths. The config file and every referenced file must be canonical
regular files owned by the service account, must not be symlinks, and must have
the required private mode (currently `0600`). Do not place secret values inline
in JSON, environment variables, command arguments, readiness output, or logs.

The runtime configuration is exact-shaped. A representative outline is:

```json
{
  "schema_version": 1,
  "kind": "echo-organization-admin-edge-runtime-config",
  "listener": {
    "host": "0.0.0.0",
    "port": 443
  },
  "public_origin": "https://admin.example.com",
  "employee_authority_base_url": "https://employee-authority.example.com",
  "authority_origin": "http://127.0.0.1:39479",
  "tls": {
    "certificate_chain_ref": "file:/absolute/private/admin-edge/server-chain.pem",
    "private_key_ref": "file:/absolute/private/admin-edge/server-key.pem",
    "client_ca_bundle_ref": "file:/absolute/private/admin-edge/admin-client-ca.pem"
  },
  "trusted_proxy_token_ref": "file:/absolute/private/admin-edge/trusted-proxy-token",
  "allowed_admin_client_spki_sha256": [
    "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
  ]
}
```

The example pin is a placeholder and must never be deployed. Compute each pin
from the DER-encoded subject public-key information of the intended
administrator client key, then verify the certificate-to-person mapping
through an independent operator channel.

Configuration rules are fail-closed:

- `public_origin` is one canonical bare HTTPS origin with a DNS hostname. Its
  host is the only accepted TLS SNI and HTTP `Host`/`:authority`.
- `employee_authority_base_url` is one canonical bare HTTPS origin. It is the
  locator embedded in newly generated employee invitations; it grants no
  authority by itself.
- `authority_origin` is one bare loopback HTTP origin using only `127.0.0.1` or
  `[::1]`. It has no path, query, fragment, credentials, DNS resolution,
  redirect, alternative, or remote fallback.
- The server certificate chain, private key, client CA bundle, and trusted
  proxy token use distinct external `file:` references.
- The proxy token contains at least 32 visible ASCII bytes and must match the
  authority's separately configured trusted-proxy credential. It is distinct
  from the administrator bearer credential.
- The client-SPKI pin set is nonempty, bounded, canonical, and duplicate-free.
  A valid chain without a pin match is rejected; a pin match without a valid
  chain is also rejected.

The edge and authority may share one host but remain separate artifacts and
processes. If different service accounts are used, provision the same proxy
token value into separate owner-only files. Do not weaken file permissions or
move the authority origin onto a LAN to share it.

## Startup outline

Before starting:

1. Verify the exact edge artifact and record its artifact and manifest hashes.
2. Verify the authority is the intended process on the configured loopback
   listener and is using the matching trusted-proxy token.
3. Inspect the administrator server certificate for the exact
   `public_origin` hostname and current validity.
4. Inspect the client CA and each allowed client certificate, including
   client-auth usage, validity, and independently verified SPKI pin.
5. Confirm the employee authority HTTPS origin is separately reachable through
   its intended employee deployment path; do not expose its routes through the
   administrator host.
6. Confirm the runtime config and referenced files satisfy ownership, mode,
   canonical-path, size, and distinct-file rules.

Run the packaged no-bind preflight after those operator checks and before
installing the supervisor definition:

```sh
/absolute/admin-edge-install/bin/echo-organization-admin-edge \
  preflight --config /absolute/private/admin-edge/admin-edge.json
```

The command requires the declared `darwin/arm64` Node 22.22.1 runtime. It
reuses the exact configuration, private-file, certificate, key, client-CA, and
TLS-context preparation path used by `serve`, but it opens no listener and
contacts no authority. Success writes one bounded secret-free JSON record and
returns zero. Expected failure returns one with a fixed `failed_check` code;
raw file paths, certificate identities, pins, tokens, private material, and
Node/OpenSSL errors are never included.

The version 1 failure-code set is `release_platform`, `runtime_config`,
`runtime_material`, `server_certificate_parse`,
`server_certificate_hostname`, `server_certificate_purpose`,
`server_certificate_not_yet_valid`, `server_certificate_expired`,
`server_private_key_parse`, `server_private_key_mismatch`, and
`client_ca_or_tls_context`. The packaged README defines each code. A client CA
bundle is accepted only when it contains PEM certificate blocks separated by
whitespace.

Preflight checks local material at one instant. It cannot prove DNS,
firewalling, supervisor behavior, authority reachability or proxy-token
equality, public-chain acceptance, individual administrator certificate
identity or validity, revocation, renewal monitoring, rollback, listener
address or port availability, or permission to bind that listener. Those
remain explicit live acceptance steps.

The packaged binary is intended to run in the foreground under an external
supervisor:

```sh
/absolute/admin-edge-install/bin/echo-organization-admin-edge \
  serve --config /absolute/private/admin-edge/admin-edge.json
```

`serve` enforces the declared runtime cell (`darwin/arm64`, Node `22.22.1`)
before it reads private runtime configuration or opens a listener. npm
`10.9.4` remains the artifact build/install toolchain declaration; the running
edge does not invoke a package manager.

An unsupported developer host may run only a loopback-bound edge by adding
`--acknowledge-unsupported-host-for-development`. That flag emits a structured
non-qualifying warning and is rejected on the declared release cell. Never put
the flag in a production supervisor command, and never use it to claim
deployment or Phase 5 evidence.

The supervisor owns start, stop, restart, resource limits, log destination, and
crash policy. It must not place certificate, key, token, or configuration
content in its unit definition. Missing or invalid configuration, TLS material,
client trust, allowlist, or loopback origin must prevent the public listener
from becoming ready.

After startup, use a deliberately authorized test client to verify:

- a valid client certificate and pin can reach `/admin/login`;
- no client certificate, an untrusted chain, or a non-allowlisted SPKI cannot;
- `GET /admin/edge-config` returns only the exact configured employee origin;
- the authority observes exactly one injected proxy credential and one
  canonical client identity;
- a session established by one client identity cannot be replayed by another;
  and
- private, employee, JSON-administrator, unknown, or malformed routes never
  reach the authority.

Do not log request bodies or raw headers while performing these checks.

## Public request contract

The edge allows only these canonical request targets:

| Handling | Method | Path                                                           |
| -------- | ------ | -------------------------------------------------------------- |
| local    | `GET`  | `/admin/edge-config`                                           |
| proxy    | `GET`  | `/admin`                                                       |
| proxy    | `GET`  | `/admin/`                                                      |
| proxy    | `GET`  | `/admin/login`                                                 |
| proxy    | `GET`  | `/admin/assets/admin.css`                                      |
| proxy    | `GET`  | `/admin/assets/admin.js`                                       |
| proxy    | `POST` | `/admin/login`                                                 |
| proxy    | `POST` | `/admin/logout`                                                |
| proxy    | `POST` | `/admin/memberships`                                           |
| proxy    | `POST` | `/admin/memberships/mem_<canonical-v4-uuid>/enrollment-grants` |
| proxy    | `POST` | `/admin/memberships/mem_<canonical-v4-uuid>/revocations`       |
| proxy    | `POST` | `/admin/installations/ins_<canonical-v4-uuid>/revocations`     |

No allowed target carries a query or fragment. The edge rejects every other
method or target before opening an upstream request, including:

- `/v1/enrollments` and `/v1/access-leases`;
- `/v1/admin/*`;
- `/_echo/runtime-status` and every other `/_echo/*` path;
- arbitrary paths merely beginning with `/admin`;
- `TRACE`, `CONNECT`, `OPTIONS`, upgrades, and WebSockets;
- absolute-form or authority-form targets, double-leading slashes, control
  bytes, dot-segment normalization, encoded traversal, queries, fragments, and
  overlong request targets.

`GET /admin/edge-config` is answered by the edge and is never forwarded. Its
exact JSON body is:

```json
{ "authority_base_url": "https://employee-authority.example.com" }
```

It is non-secret, authenticated deployment metadata with `Cache-Control:
no-store`, an exact JSON content type, a canonical `Content-Length`, and
`X-Content-Type-Options: nosniff`. It has no CORS grant. Missing or invalid
metadata causes browser invitation creation to stop; the browser never falls
back to the administrator page origin. The one-time grant stays in browser
memory and only its digest reaches the authority.

## Header and framing contract

The edge inspects raw incoming headers before relying on normalized values:

- Duplicate header names and malformed names or control-bearing values fail
  closed. `Host`, mutation `Origin`, and request framing are then checked
  against their exact edge contracts; authority-owned credentials and cookies
  remain opaque to the edge.
- Caller-supplied `X-Echo-Proxy-*`,
  `X-Echo-Authenticated-Client-*`, runtime-status, `Forwarded`,
  `X-Forwarded-*`, proxy authorization, hop-by-hop, and
  `Connection`-nominated fields are removed.
- `X-Echo-Admin-CSRF` is the only ECHO browser header deliberately preserved.
- The edge sets the configured public `Host`, injects exactly one
  `X-Echo-Proxy-Authorization`, and injects exactly one
  `X-Echo-Authenticated-Client-Id`.
- Raw certificate names, email addresses, source IPs, and caller-provided
  identity headers never become the authority client identity.

Requests have bounded header bytes and count, target length, body bytes,
connection lifetime, and upstream deadlines. Console mutation bodies are
bounded by the authority's 16 KiB maximum. Conflicting or duplicate
`Content-Length`, any `Content-Length` plus `Transfer-Encoding`, malformed
chunking, incomplete bodies, and over-limit input are rejected and the
connection is closed when framing is ambiguous. A forwarded body has one
canonical framing interpretation. The edge never automatically retries a
`POST`, even when the authority command itself has an idempotency key.

Hop-by-hop and `Connection`-nominated response fields are not forwarded.
Incomplete, malformed, upgraded, or over-limit upstream responses fail closed.
All edge-generated errors are bounded, non-cacheable, and contain no upstream,
certificate, identity, configuration, or credential detail.

## Logs and monitoring

Logs use an allowlist rather than redaction after serialization. They may
contain a generated request ID, canonical route template, method, status,
duration, bounded byte counts, TLS version, and the already privacy-preserving
client digest. They must not contain:

- `Authorization`, `Cookie`, `Set-Cookie`, proxy tokens, client private
  material, raw certificate identity, or administrator email;
- request or response bodies, CSRF values, invitation grants, invitation
  envelopes, runtime-status nonces or proofs;
- full URLs, unbounded path identifiers, or query strings; or
- TLS private keys, file contents, environment dumps, or serialized config.

Keep readiness and metrics credential-free and bounded. A public health route
is not part of the allowlist; bind supervisor diagnostics to a private local
control surface if one is later introduced.

## Rotation

Every rotation is a planned, fail-closed restart. Preserve the last verified
artifact, config, and external files until the replacement is proven.

### Administrator client certificate or SPKI

1. Add the replacement CA material if the issuer changes and add the new SPKI
   pin while retaining the old pin.
2. Restart the edge and verify the new client end to end.
3. Remove the old SPKI pin and obsolete CA only after the replacement succeeds.
4. Restart again and prove the old client is rejected.

For urgent revocation, remove the compromised pin, restart, and close existing
connections. Do not rely only on certificate expiry or source-IP filtering.
Changing SPKI changes the injected client identity and naturally invalidates
authority console sessions bound to the prior identity.

### Server certificate or private key

Stage new owner-only files, verify their key match, chain, SAN, validity, and
configured hostname, update only the file references, and restart. Verify the
served certificate and mTLS policy before removing prior files. Never fall back
to an unrelated default certificate or an HTTP listener.

### Client CA

Use a bounded overlap bundle while migrating issuers and retain explicit SPKI
pins throughout. A broader CA bundle never broadens access without a matching
pin. Remove the old CA after every intended client is on the replacement
issuer.

### Trusted proxy token

Rotate the edge-to-authority credential during a maintenance window:

1. Stop the public edge.
2. Stop or otherwise quiesce the authority using its documented lifecycle.
3. Provision the new value into the authority-owned and edge-owned private
   files without printing it.
4. Start and verify the loopback authority.
5. Start the edge and prove authenticated forwarding.

The authority and edge must never run with mismatched values while public
traffic is accepted. If verification fails, stop the edge before restoring the
previous token files.

### Employee authority URL

Changing `employee_authority_base_url` affects only invitations created after
the edge restarts with the new config. Existing invitations retain their prior
URL. Keep the prior employee origin available until outstanding invitations
expire or explicitly replace them; otherwise the change creates an avoidable
onboarding failure.

## Rollback

The edge has no database, so rollback does not restore or alter authority or
employee state:

1. Stop the edge and confirm the public listener is closed.
2. Select a previously verified exact edge artifact and its compatible
   external runtime config.
3. Restore prior certificate, CA, allowlist, employee URL, and proxy-token
   references only when their security validity has been rechecked.
4. Start the prior artifact and repeat the mTLS, Host, local-config, header
   injection, forbidden-route, and session-isolation checks.
5. Retain the failed candidate and logs as private diagnostic evidence.

Never roll back to a compromised client pin, expired/revoked certificate,
untrusted employee origin, or old proxy token merely to restore availability.
Security-policy failure stays fail-closed.

## Evidence boundary

Artifact build/verification, unit tests, local TLS integration, and a local
operator smoke test demonstrate only that the candidate can satisfy locally
provable contracts. They do not establish:

- a publicly reachable production administrator endpoint;
- production certificate issuance, renewal, revocation, monitoring, firewall,
  supervisor, or incident-response behavior;
- a production authority signer;
- two physical `darwin/arm64` installations or Secure Enclave keys;
- independent authority-pin delivery; or
- Phase 5 `P5-NET-001`.

Do not relabel a local report, self-signed certificate test, development
artifact, or loopback proof as production deployment or Phase 5 completion.
