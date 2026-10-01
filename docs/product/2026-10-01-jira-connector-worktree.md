# Jira live connector worktree

The founder selected Jira on 2026-10-01 as the ticketing source alongside Slack
and Granola meeting exports. This worktree prepares the provider implementation
against the tested shared contracts. It does not activate a Jira connection or
make Jira evidence available in Ask yet.

## Starting point

- Worktree: `.worktrees/ticketing-connector`
- Branch: `feat/ticketing-connector`
- Shared base: `a62ab22239d6c4b724ffa32c0847d1ba39094d0b`
- Contract guide: [Shared connector contracts](../architecture/connector-contracts.md)

There is no Jira provider in this base. The shared boundary supplies personal
identity/read status, typed ticket citations, bounded releases, audit-before-
release behavior and request-owned item/cursor handles. Its permission and
audit implementations are injected ports, rather than installed services.

## Provider scope

Own `providers/jira/**`, including the provider package, API parsing, verified
external identity and tenant coordinates, transport, reader factory and fixture
tests. Coordinate the package's workspace/source-boundary registration with the
shared integration work; it should contain registration only, without shared
behavior changes. Coordinate dependency lock changes if a new SDK is selected.

Implement `PersonLiveEvidenceReaderV1<PersonTicketCitationV1>` from the kernel's
public `shared/person-live-evidence-v1` export. The factory receives one trusted
ECHO person's binding. The model cannot choose a person, tenant, grant or Nango
connection. Validate the external account and tenant through the chosen
provider flow; matching an email or trusting client-supplied coordinates alone
does not establish that binding.

The minimum reader provides:

- Search for tickets the asking person can currently read.
- Open a provider handle previously issued inside that request.
- List tickets within a provider-validated project/container, with opaque
  continuations and the shared limit/date semantics.
- Revalidate the connection and visibility of all released citations,
  including metadata and earlier reads. A usable token alone is insufficient.

Normalize each result into the shared citation, label, optional text, visibility
and supported attributes. Compute the digest of the exact bounded text released.
Validate the tenant's ticket URLs and coordinates before returning a result.
Ticket text, titles and provider cursors remain in request memory; use the
shared audited source wrapper for releases rather than building a retained
ticket index. Display visibility never grants another person access.

## Nango decision

Start by verifying the supported Jira deployment, authentication flow, minimum
read scopes and Nango configuration against current primary documentation.
Do not assume Cloud and server deployments share the same flow. Record the
chosen support boundary before implementing OAuth or tenant selection.

Nango may handle OAuth and token storage/refresh. The provider still owns account
and tenant verification, request authorization and Jira API interpretation.
Choose direct API calls or Nango Proxy after checking the relevant behavior;
neither is required by the shared contract. No Nango sync, bulk ticket copy or
credential retrieval is part of worktree setup.

## Validation and completion

Use provider fixtures and fake transport to prove tenant/subject binding,
missing permissions, malformed payload refusal, correct text digests,
pagination, cancellation and changed visibility. Run the adapter through the
shared audited boundary. Code changes need focused tests and `npm run check`.
Local fixtures do not prove a real account connection.

The isolated implementation and its verified Cloud 3LO/direct-transport
decision are documented in [the Jira provider](../../providers/jira/README.md).
Its focused tests use the shared audited ticket boundary, including inventory
visibility revalidation. The authenticated-fetch port still requires trusted
server composition; this worktree does not implement an OAuth callback or a
live Nango connection.

Shared integration still owns authoritative read-grant/current-membership
checks, durable release audit, connector-access endpoints, Evidence Desk
registration and a versioned Ask/evidence response that admits tickets.
Keep changes to the released API/kernel contracts and Authority composition
in that lane. The Slack onboarding worktree is independently active and also
owns its bot setup and approval callbacks.

Completion for this provider slice means a tested person-bound reader and a
documented authentication/support boundary. Claim end-to-end Jira Ask only
after the shared integration and separately authorized account validation are
complete. Worktree setup itself does not authorize credentials, live account
connection or deployment.
