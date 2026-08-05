# Identity, onboarding, and federation

**Status:** Current — onboarding and access are live. The local
founder-provenance federation surface (approval capture, attribution, signed
record projection, export bundles, and protected independent copies) is
retired and deleted from this build, with no plan to restore that local lane;
what remains of it is presence-only residue detection and refusal.

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
hardware-backed adapter without changing the federation documents.

Pre-1.0 Secure Enclave identities are not silently rewritten, exercised, or
diagnosed for readiness. Their residue is sufficient to refuse product work;
operators must preserve the old state for continuity.

A state root left behind by the retired founder-provenance mode is detected and
refused, never downgraded: no product-work command, runtime start, or new
processing cycle resumes on it. Old founder state is never parsed — the readers
that validated or recovered it are deleted, and detection is presence-only. One
shared observational gate in `src/product/retired-founder-provenance.ts` runs
before any directory creation, adapter
resolution, credential work, provider or Authority contact, approval read or
mutation, or caller-supplied callback, so an injected approval store or callback
cannot resume the mode. It is a fail-closed
gate on trusted in-process callers, not a sandbox. The gate is re-run at every
composition cycle, not only at construction, so residue appearing under a live
composition still fails the next cycle closed; a background access-lease renewal
started by an already-running composition may continue until that composition is
closed.

Inspection, preservation, and quiescing stay available on a fenced profile:
`validate-config`, general `status`, `backup`, `restore`, and `service
stop`/`status`/`uninstall` remain reachable.
Several of those write; the line is product work, not writes.

Recovery does not cross the fence. `backup` stays available for a fenced
profile: regular state-tree files are copied byte-for-byte and the SQLite
database is captured as a consistent SQLite backup, while the external cutover
guard remains beside the original state path, outside the backup. `restore`
refuses — before its safety pre-backup, durable
marker, staging, or any live change — whenever the live target holds founder
residue or the validated backup payload would reintroduce it, and it stops
without touching interrupted restore artifacts that involve that residue.
Because `backup` refuses while the service is loaded, the executable
order is `service stop`, `backup`, then `bootstrap` onto a founder-residue-free
new config and state path with the administrator-issued invitation and
Authority PIN; that one command provisions the credentials, initializes, and
enrolls the new installation. Fresh central bootstrap is the only forward
path.

Organization ingest, search, embeddings, participant resolution, IdP/SCIM,
billing, and multi-organization tenancy are outside this onboarding/access
slice.
