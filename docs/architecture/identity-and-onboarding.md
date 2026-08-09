# Identity and onboarding

**Status:** Current — onboarding and access are live; the retired
founder-provenance surface is deleted, with presence-only residue refusal
(see [Product runtime](product-runtime.md#identity-modes)).

Echo processes source data locally while preserving organization attribution.
The installation owns personal provider credentials, raw source data, and its
private signing key. The organization
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
unscoped provider IDs are not canonical identity. The retired provenance
surface's per-fact capture pipeline and signed-record projection are deleted
with it; only claim scoping is live.

## Onboarding and access

Organization tool onboarding precedes employee account linking. An
administrator selects a supported tool and supplies its organization-owned
provider setup. The Authority verifies the provider account, granted scopes,
and required public settings before recording one active organization tool.
An absent or failed setup is inactive. The minimum Slack flow lets an enrolled
installation prove its Slack human through an Authority-posted thread
challenge. The Slack-observed human must match the reviewer already configured
for that installation's exact Slack approval adapter. Completion creates an
identity link and exact adapter binding without granting an action.
Automatically offering and configuring all active
organization tools in employee installations remains a separate milestone.

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
hardware-backed adapter without changing the signed organization documents.

Pre-1.0 Secure Enclave identities are not silently rewritten, exercised, or
diagnosed for readiness. Their residue is sufficient to refuse product work;
operators must preserve the old state for continuity.

A state root left behind by the retired founder-provenance mode is detected
and refused, never downgraded. The shared observational gate, the commands it
fences and spares, and the `service stop` → `backup` → `bootstrap` recovery
path are documented once in
[Product runtime](product-runtime.md#identity-modes).

Organization ingest, search, embeddings, participant resolution, IdP/SCIM,
billing, and multi-organization tenancy are outside this onboarding/access
slice.
