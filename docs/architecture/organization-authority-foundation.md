# Organization authority foundation

**Status:** experimental; N=2 trust outcome pilot-qualified

This remains a disposable pilot rather than a stable wire protocol or production
runtime integration. Its qualification target is narrow: enroll two independently
keyed installations, accept a signed record from each, revoke installation A,
then prove that A no longer advances while B still does.

The organization authority wraps the existing signed local boundary. It does not
change core processing, local approval, delivery, record IDs, event bytes, or the
meaning of a Founder Live identity manifest.

```text
one-time invitation grant + installation-signed enrollment request
  -> authority verifies grant, key possession, manifest, and policy
  -> authority-signed enrollment receipt
signed local outbox batch
  -> atomic authority ingest
  -> one authority-signed OrganizationBatchReceipt
  -> verified local cursor advancement
```

## Compatibility and trust

`LocalIdentityManifestV1` and its signed `PublicationPolicyV1` remain producer
evidence. The manifest's `local-founder-bootstrap` assertion is self-signed and
cannot establish central organization authority by itself. The authority
therefore provisions the organization, principal, and membership independently
and issues a one-time enrollment grant. The installation signs one enrollment
request that binds that grant to the exact authority, manifest, installation
key, and publication policy. The authority-signed enrollment receipt is a
separate overlay; neither the manifest, policy, nor an existing federated event
is rewritten.

An authority descriptor is pinned through an authenticated setup or invitation
channel outside this library. A descriptor is not allowed to authenticate
itself. Its pinned public key verifies enrollment and batch receipts.

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
- exact signed enrollment requests and authority-signed enrollment receipts;
- one trusted sequence/hash head per installation;
- exact accepted federated-event bytes; and
- one exact authority-signed batch receipt for each accepted, duplicate, or
  revocation-rejected batch.

The database is the authority for current membership, installation status, and
organization acceptance. Client timestamps and the local manifest's active
assertion never override it.

## Enrollment

1. An administrator provisions a principal and active membership, then creates
   a random, time-bounded, one-use enrollment grant. The plaintext grant and
   pinned authority descriptor travel through the invitation channel; the
   authority stores only the grant digest.
2. The installation creates a canonical manifest and publication policy, then
   signs one enrollment request binding their exact digests, the installation
   key, the intended authority and membership, and the enrollment grant.
3. In one transaction the authority validates the current provisioned identity,
   grant, request signature, manifest, policy, key coordinates, and document
   limits; consumes the grant; registers the installation and its empty trusted
   head; and stores an authority-signed enrollment receipt.

An exact retry of the same signed request returns the stored enrollment result.
A wrong, expired, or divergently reused grant; an invalid request signature; or
an ambiguous manifest ID, digest, or key fails without partial registration.

This foundation registers the existing Founder Live manifest shape without
pretending that its self-attestation is central authorization. A later local
join ceremony may introduce an authority-origin manifest shape for employee
setup; it is not required to establish the central ingest boundary here.

## Organization ingest

The manual pilot sends exact canonical `envelope_json` strings already stored
in the signed outbox. File handoff cannot parse and silently reserialize them.
Each batch contains complete contiguous approval groups.

Before committing, the authority verifies:

- canonical schema and document sizes;
- each event signature against the centrally registered installation key;
- exact organization, principal, membership, installation, manifest, key, and
  publication-policy bindings;
- current membership and installation state;
- configuration digests, source ownership, source/processor/approval chronology,
  CLI or Slack actor evidence, and the exact signed publication snapshot;
- canonical organization audiences and organization-scoped named subjects;
- complete approval groups and stable producer identity;
- contiguous installation sequence and previous-event hash;
- unique event and record IDs; and
- byte-identical idempotent retries.

New accepted events, the trusted head, and one signed
`OrganizationBatchReceipt` commit atomically. Exact replays do not create
another organization record. A sequence gap, fork, or divergent event/record
reuse advances nothing and stores no receipt. Accepted records contain only the
already approved signal and bounded evidence carried by the existing envelope.

## Batch receipt and local upload state

`OrganizationBatchReceipt` is separate from both the immutable approved
envelopes and a delivery receipt. It binds the authority and enrollment, exact
submitted batch digest and event count, batch disposition, and previous and
resulting trusted heads or a rejection reason.

The local organization-sync store pins the authority key, stores exact signed
enrollment and batch receipts, and advances its acknowledged head only after a
complete matching accepted or duplicate batch result. Receipt acceptance
cross-checks that result against the exact submitted batch. A malformed,
unsigned, wrong-key, wrong-batch, or incomplete receipt never advances local
sync state. Batch creation and receipt acceptance never delete or mutate outbox
events.

## Revocation

Membership and installation revocations are separate monotonic authority
changes. Revoking a membership disables all of its installations; revoking one
installation leaves the membership and its other installations intact.
Revocation and ingest serialize through the authority database, and revocation
effective time is assigned by the authority clock inside that write lock.
Previously accepted records remain immutable, while later ingest is rejected
according to authority processing order rather than the event's laptop-supplied
occurrence time.

## Manual pilot evidence — July 20, 2026

The artifact built from commit
`c7bfed7fd44c3fdc5748154b6c2d09139e5f3194` completed the N=2 scenario on two
separate Macs with independent installation keys. A and B each reached
acknowledged sequence 1. After A was revoked, A's sequence-2 attempt was
rejected and its acknowledged cursor remained at 1; B's sequence 2 was accepted
and B remained active with an acknowledged cursor of 2.

This qualifies the narrow N=2 trust outcome, not a production product. The run
used synthetic records and manual file exchange and did not integrate the
normal meeting-to-decision runtime. It also exercised the earlier, more
elaborate enrollment and ingest wire format. The lean signed-request and
single-batch-receipt bytes were introduced afterward; the historical human run
does not claim to have exercised those exact bytes.

## Deliberate limits

The library foundation provides a storage/protocol capability with an injected
transport and authority signer. It does not add an HTTP server, secret key
service, browser enrollment UI, invitation-delivery service, IdP/OIDC, SCIM,
general IAM, dashboards, distributed services, participant resolution,
raw-transcript sync, search, embeddings, or an LLM brain. Existing
independent-copy requirements remain in force until a separate operational
cutover explicitly replaces them with central durability evidence.

The manual N=2 tool deliberately uses unencrypted, exportable file-backed keys
and file handoffs. Its records are synthetic pilot records; it does not activate
an employee identity in the normal meeting-to-decision runtime. Secure Enclave
provisioning, key rotation, recovery, authenticated transport, and runtime
integration wait for concrete demand.

This first authority registration supports one exact manifest/key/policy epoch
per installation. Pending history that refers to earlier key epochs or a
cross-manifest source/processor lineage remains locally verifiable but is not
yet centrally ingestible; the local preflight fails closed instead of accepting
unresolved historical references.

Any future network adapter must authenticate administrator operations, deliver
grants only through the invitation channel, apply a request-body limit before
JSON parsing, and pass exact canonical strings to these bounded APIs.

The exact manual ceremony is in the
[Manual N=2 pilot runbook](../runbooks/manual-n2-pilot.md).
