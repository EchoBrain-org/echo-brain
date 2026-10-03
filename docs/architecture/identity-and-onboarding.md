# Identity and onboarding

**Status:** Current — the shipped machine identity is an Authority-issued
Person session. The current Authority exposes Person-authenticated access.

ECHO processes organization meeting data on the organization Authority. A
person's machine owns only its private Authority origin and rotating Person
session credentials. The Authority owns OIDC verification, principals,
memberships, organization authorization, meeting-source and provider
credentials, processing state, and revocation. Nango holds the organization's
Slack bot token and its OAuth install copy of the Slack app client secret;
the Authority retains its own private client-secret copy for person-link
sign-in and the signing secret for inbound-interaction verification
([ADR-0025](../decisions/ADR-0025-nango-holds-slack-connection-credentials.md)).

## Durable identity

- A principal is one person; a membership is one tenure in one organization.
- An OIDC identity binding records the verified external issuer and subject
  that may authenticate that principal.
- A Person session family is the current machine-facing authentication and
  revocation unit. Access and refresh credentials are private bearer secrets,
  not durable identities.
- Organization provider connections represent organization-owned provider
  accounts. A person-bound read grant, such as the gated Jira connection, is a
  separate per-membership connection in provider-owned state; it creates no
  identity link or membership.
  External identity links bind a provider-observed human, such as a Slack user,
  to one exact principal and membership.
- Meeting participants remain source observations until explicitly resolved.

[INV-IDENTITY-005](../invariants/INV-IDENTITY-005-adapter-to-echo-identity-chain.md)
makes the provider/adapter-to-ECHO chain load-bearing. A verified provider
connection, adapter instance/binding, tenant-scoped external human link,
principal, membership tenure, and explicit action capability are distinct
edges. None implies another, and no display name, email, bare provider user ID,
source owner, or meeting participant substitutes for one. Provider identity is
resolved into the exact ECHO actor when a consequential human act is admitted;
permission-aware read later resolves the current Person independently from
canonical policy facts.

## Active Person onboarding and access

For a new identity, an Authority administrator creates the membership and a
one-time Person login grant. The Person client begins Google OIDC login against
the Authority. The Authority verifies the provider callback and organization
admission policy, binds the external subject to the exact principal and
membership, and issues a rotating Person session. A returning bound identity
can begin login without another bootstrap grant.

The Person client stores the installed session below
`~/.local/share/echo-brain/person/` and sends the access credential only to its
stored Authority origin. Refresh consumes and rotates the refresh credential.
An ambiguous or refused refresh outcome cannot replay it: the client releases
its claim and is signed out. Only a refresh that never left the machine (no
connection was made, for example before the network is up) keeps the stored
session, since its credential is certainly unused. Logout removes
local authority even if the remote revocation outcome is unknown. Every Person
read and integration-link request rechecks the current session, membership, and
revocation state on the Authority.

Organization-tool onboarding is an owner operation done from the owner's own
ECHO client, not an Authority administrator operation on the host. An owner
runs `echo-brain person tools setup --tool slack`; ECHO creates the
organization's private Slack app and installs it through Nango, and the
Authority activates the connection only after verifying it. The
owner may choose an existing app with `--existing-app` only before an active
organization Slack connection exists. The
[Slack connection onboarding gate](organization-control-plane.md#slack-connection-onboarding-gate)
defines that ceremony and its credential custody.

Granola is one organization-owned meeting export and admission bridge. Its
credential and canonical owner-email binding stay on the Authority; people do
not connect Granola from the Person client or supply individual Granola keys.
It emits revisions through the existing meeting-source admission and approval
path before any meeting becomes readable context.

After that organization tool is active, a signed-in Person runs
`echo-brain person tools connect --tool slack` (browser sign-in, or a DM-code
challenge without a browser). The Authority verifies the exact Slack human and
creates or reuses that membership's external identity link; the
[Person Slack identity link](organization-control-plane.md#person-slack-identity-link)
defines both methods. The Person flow creates no shared-channel/reaction
adapter binding or approve/reject grant. Private meeting-owner approvals are
instead delivered as signed Block Kit DMs. The visibility selector defaults to
**Only me** (`restricted-reviewer-person-v2`); before clicking Approve the owner may select
**Team** (`organization-member-readable-person-v2`) or, with an active project,
**Projects** (`project-members-readable-person-v1`) and one to twenty of their
projects. A separate **Share transcript with the selected audience** checkbox,
off by default, also releases the exact meeting transcript to that audience.
The selected policy, projects and transcript choice bind only at approval;
Reject creates no V4 record.

Jira is a person-bound read connection, not an organization tool:
`echo-brain person tools connect --tool jira` binds one membership's Nango-held
Jira grant. The production Authority keeps it behind the
[ADR-0026](../decisions/ADR-0026-jira-person-live-evidence-nango.md) release
gate. See [shared connector contracts](connector-contracts.md).

## Evidence boundary

Identity claims are scoped by issuer, tenant, and subject and record their
verification method. Display names, unverified email text, token possession,
and unscoped provider IDs are not canonical identity. Provider credentials and
raw meeting content never enter Person session state or Person CLI output.

Multi-organization tenancy, IdP/SCIM provisioning, a server-side provider
catalog, and Person-bound record publication are outside this minimum V1
identity foundation.
