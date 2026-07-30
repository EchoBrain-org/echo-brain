# Identity, onboarding, and federation

Echo processes source data locally while preserving organization attribution.
The installation owns personal provider credentials, raw source data, its
private signing key, and the signed records it produces. The organization
authority owns shared membership, enrollment, access leases, revocation, and
organization-level provider app credentials that an administrator explicitly
onboards. Provider secret bytes remain in the customer-owned secret store at
the boundary that uses them; SQLite stores only opaque secret handles.

## Durable identity

- Organization, principal, membership, device, installation, provider
  connection, and adapter binding are distinct.
- A principal is a person; a membership is one tenure.
- An installation is the signing and revocation unit. A replacement machine
  receives a new ID and key.
- Credentials are not identities. Connections represent provider accounts;
  bindings represent product capabilities using them.
- Meeting participants remain source observations until explicitly resolved.

One local state root has at most one active organization enrollment and
installation profile while retaining immutable history.

## Evidence

Identity claims are scoped by issuer, tenant, and subject and record their
verification method. Display names, email addresses, token possession, and
unscoped provider IDs are not canonical identity.

Facts are captured when they become known:

- source attribution when a meeting revision is observed;
- processor, model, prompt, and output attribution at extraction;
- candidate and policy at approval request;
- exact presentation and connection at publication;
- actor, reason, and assurance at resolution.

They are not reconstructed later from whichever account, model, or policy is
currently configured.

## Signed record boundary

Approved signals become immutable signed envelopes containing bounded
attribution, approval, and publication evidence. Credentials, raw provider
payloads, complete transcripts, and sibling signal bodies remain outside.

Per-installation sequencing and hash chaining make gaps and forks detectable.
A delivery receipt proves an output reached a configured surface; it is not an
organization enrollment or access fact.

## Onboarding and access

Organization tool onboarding precedes employee account linking. An
administrator selects a supported tool and supplies its organization-owned
provider setup. The Authority verifies the provider account, granted scopes,
and required public settings before recording one active organization tool.
An absent or failed setup is inactive. Employee installations may later offer
only active organization tools for personal account linking; that propagation
and employee connect experience is a separate milestone.

An administrator creates a membership and one-time enrollment invitation. The
installation independently verifies the authority pin, creates its local key,
signs the enrollment request, and stores the verified receipt before treating
itself as enrolled.

Access leases are short, signed, and monotonic. Missing, expired, corrupted, or
rolled-back local access state fails closed. Revoking one installation does not
erase history or revoke a different active installation. Ending a membership
revokes all its installations.

The current portable signer uses a private file-backed P-256 key and explicitly
records software-key assurance. The CLI requires an explicit acknowledgement
before creating that exportable key. The signer interface permits a later
hardware-backed adapter without changing the federation documents.

Pre-1.0 Secure Enclave identities are not silently rewritten. A build without
that backend reports `unsupported_legacy_key_backend`; operators must preserve
the old signer for continuity or explicitly perform a continuity-breaking
re-bootstrap.

Organization ingest, search, embeddings, participant resolution, IdP/SCIM,
billing, and multi-organization tenancy are outside this onboarding/access
slice.
