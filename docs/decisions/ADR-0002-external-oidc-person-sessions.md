---
schema_version: 1
id: ADR-0002
kind: decision
title: External OIDC person sessions
component_ids:
  - CMP-LOCAL-RUNTIME
  - CMP-IDENTITY-ACCESS
  - CMP-CENTRAL-ORGANIZATION
  - CMP-PERMISSIONS
  - CMP-PROTOCOLS-CRYPTO
created_at: 2026-08-18
reviewed_at: 2026-08-18
reviewed_ref: 7948cde286c1be49694762389774437bf26ed47f
status: accepted
supersedes: []
superseded_by: []
updates:
  - ADR-0001
---

# ADR-0002: External OIDC person sessions

## Context and options

[ADR-0001](ADR-0001-organization-operated-server-core.md) moves processing
to the organization-operated Authority and requires the thin client to act as
a Person, not as an enrolled installation. The
[server-core migration plan](../product/2026-08-17-server-core-migration-plan-v3.md)
leaves one Phase-2 choice open: self-host identity and recovery, or delegate
primary authentication to an external identity provider.

Three options were considered:

1. **Self-host email, passwords, or passkeys.** This keeps authentication
   inside the organization box, but makes that box responsible for credential
   enrollment, account recovery, phishing resistance, MFA policy, and the
   security-review evidence for all of them.
2. **Use one provider's proprietary SSO SDK or token format.** This can ship
   quickly, but makes provider claims and refresh behavior part of the product
   contract and makes a later IdP change a Person-identity migration.
3. **Use provider-neutral OpenID Connect.** The Authority uses the
   Authorization Code flow with PKCE, validates an ID token against one exact
   deployment configuration, establishes identity only from `(issuer, sub)`,
   and then issues its own opaque session credentials.

Option 3 has the smallest new authentication and recovery surface while still
having the SSO-capable, revocable shape required by Phase 2. It also keeps the
Authority's authorization and session-revocation decisions independent of the
upstream provider's access-token format.

The existing browser administrator-console session is not an option for
Person authentication. It is an in-memory, process-local convenience created
only after presentation of the Authority administrator credential. It has no
principal or membership identity and naturally dies on Authority restart.

## Decision and consequences

### 1. Use external OIDC Authorization Code plus PKCE S256

Person sign-in uses the OIDC Authorization Code flow. `response_type=code`,
`scope=openid email`, and `code_challenge_method=S256` are mandatory. Email is
requested so the first binding can prove that the signed, verified provider
address matches the exact work email approved by the administrator. It is not
the durable Person identifier; that remains `(issuer, sub)`.
Implicit, hybrid, password, device-code, and caller-supplied bearer-token
sign-in are not accepted. The PKCE verifier is 32 random bytes encoded as
unpadded base64url; the challenge is unpadded base64url SHA-256 of the ASCII
bytes of that exact verifier text.

Every attempt also has independent 32-byte random `state` and `nonce` values.
They are single-use, are bound to the exact attempt, and expire after ten
minutes. SQLite retains only their SHA-256 digests. The PKCE verifier is
sealed before persistence; SQLite stores only the sealed bytes and the exact
sealing-key ID, while the sealing key remains outside the database. Plaintext
state, nonce, and verifier bytes are never persisted or logged.

Success and terminal callback failure complete the attempt in the same
transaction that scrubs both the sealed PKCE bytes and their sealing-key
reference. The terminal row retains only digest and timestamp evidence needed
to refuse replay: attempt identity, frozen configuration and tenant digests,
state and nonce digests, optional login-grant digest, creation/expiry time,
terminal outcome, and completion time. Reaching `expires_at` does not perform
an implicit write. Expired-attempt scrubbing and terminalization are an
explicit maintenance operation with the same replay-evidence retention rule.

The Authority redeems the code at the configured token endpoint and validates
the signed ID token against the issuer's discovered keys. It rejects `none`,
an algorithm outside the deployment's explicit ID-token algorithm allowlist,
an untrusted key, or stale discovery metadata that cannot be refreshed. An
upstream access token, refresh token, authorization code, and ID-token bytes
exist in request-local memory only. They are never logged, returned to the
client, placed in a cookie, or persisted. The Authority does not call
`userinfo`; the ID token is the only upstream identity assertion.

### 2. Freeze one exact deployment configuration

An Authority generation has one versioned OIDC configuration with these
closed fields:

- `issuer`: the exact HTTPS issuer URL. The discovery document's `issuer` and
  every ID token's `iss` must equal it byte for byte; callback input cannot
  select an issuer.
- `client_id`: the exact opaque registered client identifier.
- `redirect_uri`: one exact absolute HTTPS callback URI, with no fragment and
  no wildcard. The Authority sends the same bytes at authorization and code
  redemption; it is never derived from `Host`, forwarding, or callback input.
- `tenant`: either `{kind: issuer}` when the exact issuer is the tenant
  boundary, or `{kind: claim, claim_name, claim_value}` when a shared issuer
  carries the tenant in a configured string claim. Claim mode requires that
  exact claim and value. Email domain, hosted-domain hints, and display claims
  are never tenant proof.
- `id_token_algorithms`: a nonempty closed allowlist fixed by the client
  registration. The token header cannot expand it.

The canonical configuration and tenant digests are recorded with each login
attempt. A successful first callback copies `tenant_constraint_sha256`,
`oidc_configuration_sha256`, and the unique
`initial_login_grant_sha256` provenance to the identity binding. Every family
points to that exact binding and separately records the configuration digest
and verified upstream assertion-issuance time under which it was issued. A
configuration change makes every pending attempt under the old digest
unusable. It never rewrites a binding or extends a family. An issuer change
produces a different `(issuer, sub)` identity and therefore requires a new
grant and binding. Client, redirect, tenant-rule, or algorithm rotation may
reuse the same exact identity binding only through a fresh attempt that passes
the new frozen configuration; an already issued family remains bounded by its
original hard deadline unless it is revoked. A client secret, when the
selected provider requires one, is referenced from the Authority secret store
and is never a session-table value.

The actual issuer, client registration, callback URL, tenant binding, and
algorithm allowlist are deployment inputs. This ADR fixes their shape and
comparison rules; it does not claim that a live provider has been provisioned.

### 3. Validate the ID token strictly

After signature and temporal validation, the callback applies all of these
rules:

- `iss` is the exact configured issuer.
- `sub` is a nonempty opaque string. The stable Person identity is the ordered
  pair `(iss, sub)` and nothing else.
- `aud` contains the exact configured `client_id`. If `aud` has more than one
  value, `azp` is required and equals that client ID. If `azp` is present for a
  single audience, it also equals that client ID.
- `iat` is required and is an integer NumericDate. It cannot be more than 60
  seconds in the future or more than 60 seconds before the login attempt began.
  Together with the attempt's unpredictable signed nonce, it proves a fresh
  identity assertion for this EchoBrain login. It does not claim that the
  provider forced new credential entry or MFA; an existing upstream SSO
  session may satisfy the login. The authorization request uses
  `prompt=select_account` so the person explicitly chooses the account.
- The configured tenant rule succeeds before any identity lookup.
- The returned nonce hashes to the exact unconsumed attempt's `nonce` digest.

For the first binding only, the signed ID token must contain a canonical
lowercase ASCII `email` and strict boolean `email_verified=true`. Its
domain-separated digest must equal the expected-email digest on the bootstrap
grant. Plaintext email is not persisted. This check authorizes the
administrator-declared recipient to create the initial binding; email still
does not become an identity key. Later grantless sign-ins resolve only the
existing `(issuer, sub)` binding and deliberately ignore email changes or
absence. Display name, username, other provider profile fields, and token
possession never find, merge, recover, or rebind a principal.

Before the subject is known, an administrator issues an opaque, digest-only
Person login grant for one exact active Authority organization, principal,
membership, membership type, expected issuer, and canonical invited work email.
Only the domain-separated email digest is retained in the grant and audit. The
administrator neither supplies nor predicts the provider's opaque subject. The
grant expires exactly 15 minutes after issue and cannot be extended or reused.
A lean-v1 grant proves an administrator-declared recipient match; it does not
send or prove delivery of an email invitation.
A bootstrap login attempt references that grant. Its first verified callback
rechecks the exact active membership tuple, expected issuer, and signed verified
email digest, then atomically consumes both attempt and grant, creates the
unique `(issuer, sub)` binding, and issues the first session family. An existing
pair bound to another principal, or an email match without the exact grant,
denies.

Later sign-ins for an existing binding use a grantless attempt. Only after the
ID token passes every check does the Authority resolve the exact existing
`(issuer, sub)` binding, re-read its current membership, consume the attempt,
and issue a new family atomically. A login grant is never required merely
because the opaque subject was not known before redirect.

### 4. Issue Authority-owned opaque session families

Successful sign-in creates an Authority session family and independent opaque
session and refresh credentials from at least 32 random bytes each. Raw
credentials exist only at the client and in the one response that issues
them. Authority persistence stores only canonical `sha256:<64 lowercase hex>`
digests. Authentication uses digest-only lookup and one generic failure
surface; it does not disclose whether a digest, family, binding, or membership
was the failed dependency.

An application/session credential expires at
`min(issued_at + 12 hours, family hard expiration)`. A refresh credential is
single-use, is accepted only at the refresh endpoint, and expires at the
family hard expiration. A family hard-expires exactly seven days after the
verified identity assertion's `iat`; rotation never moves that deadline.
Credentials and families are usable only while `now < expires_at` or
`now < hard_reauthentication_at`; equality denies. Reauthentication creates a
new family through the EchoBrain OIDC flow; it does not promise that the
provider will force the person to re-enter upstream credentials.

Refresh consumes the presented refresh digest and issues a new session and
refresh pair in one write transaction. A second presentation of a consumed,
superseded, or concurrently replayed refresh credential revokes the entire
family and every unexpired credential in it. Logout, administrator
revocation, identity-binding revocation, or membership revocation has the
same family-wide effect. Expiry and revocation take effect on the next
request; there is no positive authorization cache.

The lean-v1 Person transport uses the opaque access credential only in the
`Authorization: Bearer` header. The Authority does not set an authentication
cookie, and the client does not place either credential in a URL, browser
storage, or a request body other than the refresh credential at the refresh
endpoint. Because no ambient browser credential exists, `Origin` and CSRF
tokens are not authorization inputs for this bearer transport. Introducing a
cookie-authenticated browser session would be a distinct transport change and
must add exact Origin and independent CSRF enforcement before it is enabled.

The OIDC callback is protected by the exact single-use state and nonce binding
above and returns the new Authority credential pair as JSON. The Phase-2 thin
client imports that callback result explicitly; automatic browser-to-client
handoff and a polished browser UI remain qualification work rather than a
second credential-delivery protocol in lean v1.
Provider callback metadata such as `scope`, `authuser`, `hd`, and `prompt` is
accepted only as bounded, single-valued ancillary input and is ignored for
identity, tenant, and authorization decisions; those decisions use the
verified ID token exclusively.

The thin client may retain its raw opaque credential only at
`$HOME/.local/share/echo-brain/person/session.v1.json`. Its directory is `0700`
and its live and transition files are `0600`, current-user-owned regular files;
`session-store.ts` is the only Person-client source file permitted to import
`node:fs`. The stored document contains only the Authority origin and ID plus
the Authority-issued Person/session tuple and credential pair. It contains no
general machine database, upstream token, installation key, or access lease.

Refresh atomically moves the live pair behind one unique local claim before
sending the one-time refresh credential. Only that exact claimant may publish
the rotation, and publication cannot replace a newer explicit login. An
ambiguous outcome leaves no usable live credential and is never retried; the
Person signs in again. A completed rotation is installed durably before its
transition files are removed, so a crash after publication recovers the new
pair rather than replaying the old one.

### 5. Re-resolve both session and Person state around every read

Authentication proves possession of one active session credential; it does
not freeze membership or authorization. Every Person-authenticated read,
including an empty-result or metadata read, performs this sequence without
using a cached positive result:

1. Hash the presented credential and read an active, unexpired credential,
   active family, exact identity binding, principal, and current active
   membership.
2. Build the request-scoped authorization and caller binding from those exact
   rows.
3. Select and prepare the candidate response without releasing response
   bytes.
4. Re-read the same credential, family, identity binding, and membership.
   Require all to remain active and require the Person and session state
   digests to equal the values bound at step 2.
5. Commit the allow or deny audit row, then release response bytes.

A revocation, refresh rotation, subject mismatch, membership change, database
failure, or state-digest change at either lookup denies the read. Each read
route needs a negative test in which caller and subject differ, plus a race
test in which membership or session state changes between the two lookups.

### 6. Keep administrator-console sessions separate

The process-local `echo_admin_session` and its CSRF token remain solely an
administrator-console mechanism. They are not stored in migration `0009`, do
not resolve to a Person, cannot call a Person route, cannot be refreshed into a
Person family, and cannot be exchanged for a Person credential. Conversely,
an owner Person session does not satisfy the administrator-credential gate.

The control plane's historical `admin_session_sha256` values continue to name
the exact administrator ceremony that created them. They do not become
Person-session hashes. A future unification, if desired, requires another ADR
and an additive audit version.

### 7. Version caller meaning; never reinterpret installation history

The current readable-search scope binding is v1. Its requester includes
`enrollment_id` and `installation_id`, and its query audit records the meaning
of an authenticated installation acting for the named principal and
membership. Every existing v1 request, record envelope, receipt, eligibility
fact, scope binding, and audit row keeps that meaning forever.

V2 uses two domain-separated receipts in the existing
`caller_binding_sha256` audit field. The stage-1
`echo-authority-person-read-caller-binding-v2` receipt means the exact request
was made by the named `principal_id`, `membership_id`, and `membership_type`
through one active Authority `session_family_id` and the exact presented
session-credential digest. It binds both the fresh Person-state digest and
fresh session-state digest. A start-gate denial retains this stage-1 receipt.

After readable-search opens an opaque scope, every final allow or session
denial instead retains the stage-2 `readable-search-scope-binding-v2` receipt
passed to that scope. Stage 2 nests the stage-1 digest with the generation,
record head, policy contracts, and admitted segments. It is a refinement of
the same decision evidence, not a schema change. Neither stage contains an
`enrollment_id`, `installation_id`, or installation key. The second lookup in
decision 5 must match the v2 Person and session digests, generation, head,
contracts, and selected policy paths before response release.

V2 is a new schema and domain-separated preimage, not a new interpretation of
v1 bytes. Readers and audit tools remain dual-version until historical v1
rows no longer need online serving. No migration backfills installation rows
with family IDs or labels an installation act as a Person-session act.

### 8. Add exactly five session tables in Authority migration 0009

`0009_person_identity_and_sessions.sql` is additive. It creates these five
tables and does not drop, rename, rebuild, or backfill any table created by
migrations `0001` through `0008`:

| Table | Semantic contract |
| --- | --- |
| `authority_person_login_grants` | Current administrator authorization to bind one exact active organization, principal, membership, membership type, expected issuer, and invited work-email digest. Stores only the one-time grant digest, domain-separated email digest, exact target, issue/expiry, and consumption state. It intentionally has no expected subject or plaintext email. |
| `authority_oidc_identity_bindings` | The unique exact `(issuer, sub)` to Authority-principal and membership binding, with `tenant_constraint_sha256`, `oidc_configuration_sha256`, unique `initial_login_grant_sha256`, creation, and explicit revocation state. It has no email-derived key and is never retargeted in place. Bootstrap creation is atomic with grant and attempt consumption. |
| `authority_oidc_login_attempts` | Bounded single-use authorization attempts: exact issuer, client, redirect and tenant/configuration digests; state and nonce digests; nullable sealed PKCE verifier plus sealing-key ID; optional bootstrap-grant digest; and creation, expiry, terminal outcome, assertion-issuance, and completion state. A null grant denotes an existing-binding login. Terminal completion atomically scrubs both sealed fields while retaining digest/timestamp replay evidence; expired rows require explicit maintenance. It stores no authorization code or upstream token. |
| `authority_person_session_families` | One authenticated family bound by exact foreign keys to an identity binding and current Person tuple, with `upstream_assertion_issued_at`, `oidc_configuration_sha256`, creation, the seven-day hard-reauthentication deadline derived from that time, and family-wide revocation reason/time. Its hard deadline is immutable. |
| `authority_person_session_credentials` | Unique SHA-256 digests for typed session or refresh credentials, their family, rotation generation, issue/expiry, refresh consumption, and revocation state. It stores no raw credential; refresh replay closes the family transactionally. |

Migration `0013_person_session_assertion_issued_at.sql` renames the two original
`upstream_auth_time` columns to `upstream_assertion_issued_at`. This preserves
the data and constraints while making the stored guarantee precise.
Migration `0014_person_login_grant_expected_email.sql` adds the required
invited-email digest to bootstrap grants and makes it immutable. It is a
pre-live migration that requires the grant table to be empty; no identity data
is guessed or backfilled.

All five tables bind to the existing Authority organization, principal,
membership, and audit authority. Cross-row constraints enforce exact
principal/binding/family agreement, monotonic credential generation,
single-use grants/attempts/refreshes, and terminal revocation. The schema
must deny direct mutation that could move an identity binding, extend a hard
expiry, unconsume a credential, or reopen a revoked family.

The five tables are the Phase-2 session substrate, not the whole Phase-2 exit.
Later versioned migrations must wire v2 query audits and the broader
record/control-plane caller changes below. The original 14-table Phase-4b
count intentionally excludes these five additive replacements.

### 9. Freeze the Phase-4b retirement disposition

Of the 14 Authority tables present before `0009`, Phase 4b retires six and
retains eight. Historical migration files remain checksummed and immutable;
retirement happens only through a later forward migration after Phase 3.

| Fate | Tables |
| --- | --- |
| Retire (6) | `authority_enrollment_grants`, `authority_enrollments`, `authority_access_states`, `authority_access_lease_requests`, `authority_internal_live_releases`, `authority_internal_live_update_receipts` |
| Retain (8) | `authority_metadata`, `authority_principals`, `authority_memberships`, `authority_audit_log`, `authority_query_decision_audit`, `authority_readable_search_active_generation`, `authority_readable_search_query_audit`, `authority_organization_member_recording_activation` |

The Authority repository has 42 transaction methods. The exact 29-method
retirement is:

| Retired subsystem | Repository transaction methods | Count |
| --- | --- | ---: |
| Enrollment grants | `grant`, `grantByAdminCommand`, `grantsAfter`, `insertGrant`, `consumeGrant` | 5 |
| Enrollments/installations | `enrollmentByGrant`, `enrollmentByRequest`, `enrollmentById`, `enrollmentByInstallation`, `enrollmentByKey`, `enrollmentsForMembership`, `enrollmentsAfter`, `activeEnrollments`, `insertEnrollment`, `revokeEnrollment` | 10 |
| Access state | `currentAccessState`, `accessState`, `accessStateByDigest`, `insertAccessState` | 4 |
| Access-lease requests | `accessLeaseRequestByDigest`, `accessLeaseRequestById`, `insertAccessLeaseRequest` | 3 |
| Internal-live releases | `internalLiveReleaseByCommand`, `internalLiveReleaseBySequence`, `currentInternalLiveRelease`, `insertInternalLiveRelease` | 4 |
| Internal-live receipts | `internalLiveUpdateReceiptByTransaction`, `latestInternalLiveUpdateReceipt`, `insertInternalLiveUpdateReceipt` | 3 |

The 13 retained transaction methods are `metadata`, `membership`,
`membershipByAdminCommand`, `membershipsAfter`, `recentAuditBefore`,
`adminCounts`, `activeReadableSearchGeneration`, `insertMembership`,
`revokeMembership`, `appendAudit`, `appendReviewerQueryAudit`,
`publishReadableSearchActiveGeneration`, and
`appendReadableSearchQueryAudit`. `adminCounts` later loses its installation,
access, and enrollment-grant fields; that is a versioned return-contract
change, not a reinterpretation. Repository lifecycle methods `initialize`,
`read`, `write`, `writeAtLinearization`, and `close` also remain.

### 10. Do not hide the broader re-keying work

The 6/8 and 29/42 dispositions are necessary but not sufficient for deleting
installation identity:

- **Organization record.** The v1 envelope, receipt, append-only log,
  eligibility facts, derived approval-group identity, and
  `UNIQUE (installation_id, idempotency_key)` all bind installation meaning.
  Existing log rows and their hash chain cannot be rewritten. Authority-writer
  envelopes and organization-scoped idempotency require an additive protocol
  and log version that reads v1 history unchanged.
- **Organization control plane.** Adapter bindings name an installation and
  installation key; permission requests are installation-signed; integration
  audit rows preserve `actor_installation_id` in an immutable digest chain.
  Person-session bindings and audit entries require additive schemas and
  dual-version verification. Existing bindings may be revoked and replaced,
  never edited into Person bindings.
- **Authority query audit.** Existing closed reason codes and detail bytes
  describe installation access. V2 Person/session reasons require an additive
  audit contract; the retained v1 tables cannot have their old rows or
  meanings rewritten.
- **Protocols and clients.** Organization API and organization-protocol v1
  requests, access states, envelopes, and receipts keep their installation
  signatures and IDs. V2 gets distinct kinds and validators; accepting either
  version by structural guessing is forbidden.
- **Installation anchors.** The retained `authority_metadata` integrations and
  record *installation anchors* describe installed central workspaces, not an
  employee installation. Their names are not evidence that those anchors
  belong in the six-table retirement.

None of those changes is part of migration `0009`, and none authorizes a
Phase-4 deletion early.

## Migration, rollback, and evidence

This ADR accepts the Phase-2 design choice and freezes its persistence and
retirement plan. It does not claim that Person sessions are implemented,
deployed, qualified, or accepted by a live identity provider.

Implementation order is additive: land and test `0009`; add OIDC callback and
session services; add v2 caller and audit contracts with dual-version readers;
wire every read through the two-lookups rule; ship the web identity link,
member valve, and thin client; then exercise revocation and refresh races.
Migrations `0001` through `0008` are never edited. Database rollback disables
the Person routes and revokes session families; it does not downgrade the
schema or delete `0009` rows. Until the Phase-3 drain, enrolled machines and
their v1 keys remain the operational rollback path.

Phase 2 is not complete while any of these blockers remains:

- `phase1/replay-synthetic-green` leaves the real-corpus Phase-1 evidence gate
  open; the migration plan does not permit Phase-2 exit before Phase 1 exits.
- The additive session schema, OIDC verifier, session-family lifecycle,
  refresh replay handling, and bearer routes are implemented and race-tested
  offline, but no live issuer, client registration, redirect URI, tenant rule,
  algorithm allowlist, or client-secret reference has been provisioned and
  verified.
- The current V2 Person reads have additive caller/audit meanings, start/end
  Person lookups, self-only denials, and revocation races. The remaining
  organization-record, control-plane, protocol, and surviving-operation
  actor re-keying is still open.
- Thin client v0 has the exact private store, crash-safe one-time refresh, and
  file-scoped Phase-4 carve-out described above. Its measured checkpoint and
  live IdP/browser qualification remain separate evidence gates.
- The member exclusion valve and its audited exact-source readers are wired
  offline. Slack identity linking is production-wired and verified offline
  with a fake provider and explicit callback/session import, not yet as the
  live browser flow required for Phase-2 exit.
- Rung-1 and processing-service-principal constitution amendments have not
  completed their review process.
- The additive organization-record, control-plane, query-audit, and protocol
  re-keying described above is not implemented; the six old tables and 29 old
  methods therefore remain live.

The source facts for this disposition are the
[machine-boundary audit](../product/2026-08-16-machine-boundary-audit.md), the
[Authority repository port](../../services/organization-authority/src/application/ports/authority-repository.ts),
the historical Authority migration ledger, record log schema, and control-plane
schema recorded by this ADR. Those executable migrations were retired by the
physical lean V1 closure.
Documentation validation is evidence only that this record and its relations
are well formed; it is not behavior or deployment evidence.
