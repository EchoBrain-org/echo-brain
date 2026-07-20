# Organization authority foundation

**Status:** experimental N=2 protocol prototype

This is a disposable pilot, not a stable wire protocol or production runtime
integration. The current qualification target is one manual two-installation
walkthrough: enroll A and B, accept a signed record from each, revoke A, then
prove that A no longer advances while B still does.

This prototype adds one organization authority around the existing signed local
boundary. It does not change core processing, local approval, delivery, record
IDs, event bytes, or the meaning of a Founder Live identity manifest.

```text
one-time invitation grant + signed local manifest/policy
  -> installation-key challenge
  -> authority enrollment receipt
signed local outbox approval groups
  -> authority ingest
  -> immutable accepted records + trusted chain head
  -> authority-signed ingest receipts
  -> verified local receipt store
```

## Compatibility and trust

`LocalIdentityManifestV1` and its signed `PublicationPolicyV1` remain producer
evidence. The manifest's
`local-founder-bootstrap` assertion is self-signed and cannot establish central
organization authority by itself. The authority therefore provisions the
organization, principal, and membership independently, issues a one-time
enrollment grant over the authenticated invitation channel, then binds the
exact manifest, installation key, and signed publication policy through a
one-use challenge. The resulting enrollment receipt is a separate signed
overlay; neither the manifest, policy, nor an existing federated event is
rewritten.

An authority descriptor is pinned through an authenticated setup or invitation
channel outside this library. A descriptor is not allowed to authenticate
itself. That pinned public key verifies enrollment and ingest receipts.

## Authority state

One private SQLite database owns:

- one immutable organization identity;
- organization-scoped principals and membership tenures;
- monotonic active/revoked membership state;
- enrolled installations, their exact keys and manifest digests, and monotonic
  active/revoked installation state;
- immutable registered manifest and signed publication-policy bytes;
- only SHA-256 digests of one-time 32-byte enrollment grants, never their
  plaintext values;
- one-use enrollment challenges and exact signed enrollment receipts;
- one trusted sequence/hash head per installation;
- exact accepted federated-event bytes; and
- exact authority-signed ingest receipt bytes.

The database is the authority for current membership, installation status, and
organization acceptance. Client timestamps and the local manifest's active
assertion never override it.

## Enrollment

1. An administrator provisions a principal and active membership in the
   authority, then creates a random 32-byte, time-bounded enrollment grant. The
   plaintext grant and pinned authority descriptor travel through the same
   authenticated invitation/setup channel; the authority stores only the grant
   digest.
2. The installation presents that grant with a canonical, self-signed local
   manifest and signed publication policy. The authority checks manifest
   semantics, provisioned display/identity facts, policy signature and audience,
   exact key coordinates, and document-size limits.
3. In one transaction the authority consumes the grant and creates a short-lived
   signed challenge. The challenge binds the authority, organization, principal,
   membership, installation, key, manifest ID/digest, publication policy
   ID/version/digest, nonce, and expiry.
4. The installation verifies all of those bindings and signs an exact proof of
   possession with the installation key.
5. In one transaction the authority consumes the challenge, rechecks current
   authority state, registers immutable manifest and policy bytes, registers the
   installation, creates its empty trusted head, and stores an authority-signed
   enrollment receipt.

An exact grant redemption returns the same stored challenge, and an exact
completion retry returns the existing enrollment result. A wrong, expired, or
divergently reused grant; a challenge reused for different bytes; an ambiguous
manifest ID/digest/key; or completion after expiry fails without partial
registration.

This foundation registers the existing Founder Live manifest shape without
pretending that its self-attestation is central authorization. A later local
join ceremony may introduce an authority-origin manifest shape for employee
setup; it is not required to establish the central ingest boundary here.

## Organization ingest

The local uploader sends exact canonical `envelope_json` strings already stored
in the signed outbox. A transport cannot parse and silently reserialize them.
Each batch contains complete contiguous approval groups.

Before committing, the authority verifies:

- canonical schema and document sizes;
- each event signature against the centrally registered installation key;
- exact organization, principal, membership, installation, manifest, key, and
  publication-policy bindings;
- current active membership and installation state;
- configuration digests, source ownership, source/processor/approval chronology,
  CLI or Slack actor evidence, and the exact signed publication snapshot;
- canonical organization audiences and organization-scoped named subjects;
- complete approval groups and stable producer identity;
- contiguous installation sequence and previous-event hash;
- unique event and record IDs; and
- byte-identical idempotent retries.

New accepted events, the trusted head, and their signed receipts commit
atomically. Exact replays do not create another organization record. A sequence
gap, fork, or divergent event/record reuse advances nothing. Accepted records
contain only the already approved signal and bounded evidence carried by the
existing envelope.

## Receipts and local upload state

`OrgIngestReceiptV1` is separate from both the immutable approved envelope and a
delivery receipt. It binds the authority key, enrollment, organization,
membership and installation state versions, event and record IDs, exact event
and batch digests, evaluated policy version, disposition, and resulting trusted
head.

The local organization-sync store pins the authority key, stores exact signed
enrollment and ingest receipts append-only, and advances its acknowledged head
only after a complete matching accepted/duplicate response. It cross-checks
that acknowledged head against the immutable local outbox on every upload. A
malformed, unsigned, wrong-key, wrong-event, or noncontiguous receipt never
advances local sync state. The uploader never deletes or mutates outbox events.

## Revocation

Membership and installation revocations are separate monotonic authority
changes. Revoking a membership disables all of its installations; revoking one
installation leaves the membership and its other installations intact.
Revocation and ingest serialize through the authority database, and revocation
effective time is assigned by the authority clock inside that write lock.
Previously accepted records remain immutable, while later ingest is rejected
based on authority receipt time, regardless of the event's laptop-supplied
occurrence time.

## Deliberate limits

The library foundation provides a storage/protocol capability with an injected
transport and injected authority signer. It does not add an HTTP server, secret
key service, browser enrollment UI, invitation-delivery service, IdP/OIDC,
SCIM, general IAM, dashboards, distributed services, participant resolution,
raw-transcript sync, search, embeddings, or an LLM brain. It centralizes
membership, installation revocation, chain acceptance, and receipts only.
Existing independent-copy requirements remain in force until a separate
operational cutover explicitly replaces them with central durability evidence.

The manual N=2 tool deliberately uses unencrypted, exportable file-backed keys
and file handoffs. Its records are synthetic pilot records used to exercise the
organization trust path; it does not activate an employee identity in the
normal meeting-to-decision runtime. Secure Enclave provisioning, key rotation,
recovery, authenticated transport, and runtime integration wait until the
walkthrough demonstrates concrete demand.

This first authority registration supports one exact manifest/key/policy epoch
per installation. Every uploaded event, source snapshot, processor snapshot,
and publication reference must resolve to that enrolled epoch. The existing
local outbox and export verifier can retain and verify historical per-event key
epochs and cross-manifest attribution, but this central store does not yet
register their complete immutable lineage. An installation with such pending
history must not cut over to this uploader until a lineage-registration
extension exists; the local preflight fails closed instead of accepting
unresolved historical references.

Any future network adapter must authenticate the administrator operations,
deliver grants only through the invitation channel, apply a request-body limit
before JSON parsing, and pass exact canonical strings to these bounded APIs.
