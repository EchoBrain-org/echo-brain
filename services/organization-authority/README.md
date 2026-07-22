# Organization authority service

**Status:** Phase 4 single-organization onboarding/access runtime

This service is centrally hosted for exactly one configured organization. It
implements administrator-authenticated membership and one-time enrollment-grant
commands, installation-signed enrollment and lease refresh, and monotonic
membership and installation revocation. It does not ingest meetings,
decisions, reasoning state, embeddings, or signed outbox batches.

The initial deployment is bound to one configured organization identity. It has
no tenant registry, organization switcher, global operator UI, billing, or
cross-organization query. Multi-organization operation is a later architecture
phase, not a dormant code path here.

The central SQLite schema has eight tables: singleton authority metadata,
principals, memberships, digest-only enrollment grants, enrollments, immutable
access states, idempotent access-lease commands, and an append-only audit log.
It is intended for one process on one persistent volume. Multi-replica and
multi-organization operation require a later persistence design.

The built-in JSON HTTP presentation binds only to loopback for use behind an
authenticated TLS terminator. The terminator-to-origin hop is authenticated
with `X-Echo-Proxy-Authorization: Echo-Proxy <token>`, configured through
`ECHO_ORGANIZATION_AUTHORITY_TRUSTED_PROXY_TOKEN`. The terminator must strip
both ECHO proxy headers supplied by external clients, then set that header and
`X-Echo-Authenticated-Client-Id: cid_<base64url-sha256>`. The client ID is a
canonical 32-byte SHA-256 digest of the terminator's stable authenticated
client identity; raw client identifiers and `X-Forwarded-For` are not trusted.
Missing, duplicated, malformed, or incorrectly authenticated proxy identity
fails closed before routing. POST rate limits are isolated by authenticated
client and route class, so clients do not share the loopback proxy's bucket.

Administrator routes use
`Authorization: Bearer <token>`. Enrollment uses
`Authorization: Echo-Enrollment <canonical-base64url-32-bytes>`. Access refresh
uses the enrolled installation's signed command rather than a bearer token.
Only administrator 401 responses advertise `WWW-Authenticate: Bearer`; only
enrollment 401 responses advertise `Echo-Enrollment`. Signed-request failures
do not advertise an unrelated bearer scheme.
The exact routes are:

- `GET /v1/authority-descriptor`
- `POST /v1/admin/memberships`
- `POST /v1/admin/memberships/:membership_id/enrollment-grants`
- `POST /v1/enrollments`
- `POST /v1/access-leases`
- `POST /v1/admin/memberships/:membership_id/revocations`
- `POST /v1/admin/installations/:installation_id/revocations`

The two administrator creation routes are sufficient for the controlled manual
Phase 5 gate, but they are not safe for an automated client to retry after an
ambiguous network failure. In particular, a server-generated grant cannot be
replayed after its response is lost because the authority deliberately retains
only its digest. Before an administrator UI is allowed to retry automatically,
the contract must use client-generated grant material, send only its digest to
the authority, and persist bounded request IDs and request hashes in the
existing membership and grant tables. That preserves eight tables and
digest-only grant storage. Until then, these routes are not a production-ready
administrator API.

The only included private-key adapter is an explicitly enabled, unencrypted
development-file signer. Production hosting must replace that adapter behind
the signer port. Enrollment signing, installation private-key use,
authority-result verification, and local high-watermark storage remain
installation-owned.

## Development lifecycle

Run `node dist/main.js init-development` once with the explicit development
signer opt-in, authority/organization IDs, and private key directory. It emits
the descriptor and pin for independent retention. Then run
`node dist/main.js serve` with that same identity plus the pin, database path,
organization display name, a 32-character-or-longer admin token, and an
independent 32-character-or-longer trusted-proxy token. The serving process
requires those two tokens to be different credentials and rejects SQLite
`:memory:`; its authority database must live on persistent storage.
Configuration uses the `ECHO_ORGANIZATION_AUTHORITY_*` variables defined and
validated in `src/composition/config.ts`; no default enables the file signer,
permits an unauthenticated proxy hop, or exposes a non-loopback listener.

Revocation is monotonic, but an already issued active lease remains usable only
until its signed `valid_until`; with the accepted configuration that propagation
window is never more than five minutes.
