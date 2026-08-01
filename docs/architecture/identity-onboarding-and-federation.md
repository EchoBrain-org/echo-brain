# Identity, onboarding, and federation

**Status:** Current — onboarding and access are live. The local
founder-provenance federation surface (approval capture, attribution, signed
record projection, export bundles, and protected independent copies) is retired
and removed from this build; the "Evidence" and "Signed record boundary"
sections below describe the persisted contracts and the design a future
implementation would restore, not code that runs today.

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
unscoped provider IDs are not canonical identity. Claim scoping is live; the
per-fact capture list below belongs to the retired provenance surface.

Facts are captured when they become known:

- source attribution when a meeting revision is observed;
- processor, model, prompt, and output attribution at extraction;
- candidate and policy at approval request;
- exact presentation and connection at publication;
- actor, reason, and assurance at resolution.

They are not reconstructed later from whichever account, model, or policy is
currently configured.

## Signed record boundary (persisted contract, not implemented in this build)

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

Pre-1.0 Secure Enclave identities are not silently rewritten. A build without
that backend reports `unsupported_legacy_key_backend`; operators must preserve
the old signer for continuity.

A state root left behind by the retired founder-provenance mode is detected and
refused, never downgraded: no product-work command, runtime start, or new
processing cycle resumes on it. One shared observational gate in
`cutover-fence.ts` runs before any directory creation, adapter or component
resolution, credential work, provider or Authority contact, approval read or
mutation, or caller-supplied callback, so a custom identity check, approval
capture, approval store, or runtime cannot resume the mode. It is a fail-closed
gate on trusted in-process callers, not a sandbox. The gate is re-run at every
composition cycle, not only at construction, so residue appearing under a live
composition still fails the next cycle closed; a background access-lease renewal
started by an already-running composition may continue until that composition is
closed.

Diagnosis, preservation, and quiescing stay available on a fenced profile:
`identity-check` still reports it as `identity_enabled` with
`operational_ready: false`, and `validate-config`, `selftest`, general `status`,
`backup`, `restore`, and `service stop`/`status`/`uninstall` remain reachable.
Several of those write; the line is product work, not writes.

Recovery does not cross the fence. The cutover is irreversible and a backup
stays bound to its originating state path, so restore can only return a profile
to itself. Because `backup` refuses while the service is loaded, the executable
order is `service stop`, `backup`, `onboard` a founder-residue-free new state
path, provision the Granola credential that config references, `init`, then
`organization enroll` on that initialized, not-already-enrolled installation.

Organization ingest, search, embeddings, participant resolution, IdP/SCIM,
billing, and multi-organization tenancy are outside this onboarding/access
slice.
