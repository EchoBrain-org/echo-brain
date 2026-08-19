# Identity and onboarding

**Status:** Current — the shipped machine identity is an Authority-issued
Person session. Installation enrollment and access leases remain server-side
V1 compatibility only.

ECHO processes organization meeting data on the organization Authority. A
person's machine owns only its private Authority origin and rotating Person
session credentials. The Authority owns OIDC verification, principals,
memberships, organization authorization, meeting-source and provider
credentials, processing state, and revocation.

## Durable identity

- A principal is one person; a membership is one tenure in one organization.
- An OIDC identity binding records the verified external issuer and subject
  that may authenticate that principal.
- A Person session family is the current machine-facing authentication and
  revocation unit. Access and refresh credentials are private bearer secrets,
  not durable identities.
- Provider connections represent organization-owned provider accounts.
  External identity links bind a provider-observed human, such as a Slack user,
  to one exact principal and membership.
- Meeting participants remain source observations until explicitly resolved.
- Installation and enrollment rows describe the retained V1 protocol. They are
  not a second current machine identity mode.

## Active Person onboarding and access

For a new identity, an Authority administrator creates the membership and a
one-time Person login grant. The Person client begins Google OIDC login against
the Authority. The Authority verifies the provider callback and organization
admission policy, binds the external subject to the exact principal and
membership, and issues a rotating Person session. A returning bound identity
can begin login without another bootstrap grant.

The Person client stores the installed session below
`~/.local/share/echo-brain/person/` and sends the access credential only to its
stored Authority origin. Refresh consumes and rotates the refresh credential;
an ambiguous refresh outcome cannot replay it. Logout removes local authority
even if the remote revocation outcome is unknown. Every Person read, exclusion,
and integration-link request rechecks the current session, membership, and
revocation state on the Authority.

Organization-tool onboarding remains an Authority administrator operation. An
owner supplies the organization Slack bot credential and public channel; the
Authority verifies the workspace, app, bot, scopes, and channel before storing
the secret in its private credential store. SQLite receives only an opaque
secret handle and verified public identity.

After that organization tool is active, a signed-in Person can run the
`echo-brain person slack-link-begin` and `slack-link-complete` challenge. The
Authority posts the challenge, observes the exact Slack human replying in the
exact thread, and creates or reuses that membership's external identity link.
The Person flow creates no adapter binding or approve/reject grant. Those
Person-bound approval capabilities require a later additive server path.

## Retained V1 compatibility

The Authority still implements installation enrollment, installation-signed
access leases, V1 permission checks, and V1 record ingest because existing
server-side record and approval schemas still refer to those identities.
Historical migrations and rows remain immutable. The old machine runtime,
installation signer, enrollment CLI, local database, and lease-renewal daemon
have been deleted, so no current product artifact can create or refresh that
state.

These compatibility routes are not the onboarding path for a new Person and
must not be presented as one. They can be retired only after Person-bound
approval and record-writer contracts replace the surviving server call sites
and retained rows have a defined historical treatment.

## Evidence boundary

Identity claims are scoped by issuer, tenant, and subject and record their
verification method. Display names, unverified email text, token possession,
and unscoped provider IDs are not canonical identity. Provider credentials and
raw meeting content never enter Person session state or Person CLI output.

Multi-organization tenancy, IdP/SCIM provisioning, generalized provider
catalogs, and Person-bound record publication are outside this minimum V1
identity foundation.
