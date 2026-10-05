# Organization control plane

**Status:** current organization-owned Slack onboarding through Nango, Person
Slack identity linking, and private Slack DM approval persistence.

The control plane is a library linked into the Organization Authority. It owns
no HTTP listener. The Authority composes neutral control contracts with the
Slack adapters under `providers/slack/server/src/`. Setup lives in
`organization-setup/` and browser sign-in in `adapters/oidc/`; the other Slack
paths below are relative to its `organization-control-plane/` folder:

| Entry point | Responsibility |
| --- | --- |
| Slack provider `organization-setup/slack-organization-setup-workflow-v1` | The owner's in-app Slack app setup and Nango-backed install ceremony (`person tools setup`/`connect --tool slack`) |
| Slack provider `adapters/slack/slack-app-manifest-provider-v1` | Builds the ECHO Slack app recipe and calls Slack's Manifest API |
| Slack provider `adapters/nango/nango-connection-client-v1` | Nango connect/reconnect sessions and bot-token reads |
| Slack provider `adapters/oidc/slack-browser-identity-provider` | The person's browser sign-in link, with the installed app's own client |
| Slack provider `adapters/slack/slack-web-identity-provider-v1` | Slack `auth.test` checks of an install and the DM-code person link |
| Slack provider `application/organization-tool-connection-contracts-v2` | External human-link and organization-tool connection contracts |
| `security/file-secret-store` | The private secret store for the organization's Slack app credential bundle: client ID/secret, signing secret, and Nango connection ID ([ADR-0025](../decisions/ADR-0025-nango-holds-slack-connection-credentials.md)) |
| Slack provider `slack-approval-integration-v1` | Private DM approval policy resolution, reviewer targeting, and approval persistence |
| `organization-control-database-v1` | Opening the control database and applying the current V3 baseline |
| `record-visibility-policy-contracts-v1` | Provider-neutral Person visibility policy contracts consumed by approval resolution |

## Current behaviors

1. A current Authority owner can make one organization-owned Slack connection
   active only after the Authority independently verifies its provider
   identity, scopes, and workspace through Nango. Nango holds the bot token.
2. A signed-in Person can prove ownership of one Slack human identity and link
   it to their current ECHO membership, review that link under Connected
   tools, and disconnect it. Linking creates no approval capability, role, or
   permission grant.
3. The Authority's private Slack DM approval path persists its pending
   contracts, signed action receipts, denied action receipts, and terminal
   evidence here. It is the only approval surface.

## Ownership boundaries

| Boundary | Owner | Responsibility |
| --- | --- | --- |
| Organization Authority | Customer | Principal, membership, role, Person session, processing, and revocation truth |
| Organization control plane | Customer | Verified provider connection, Person provider identity links, and private approval persistence |
| Organization record | Customer | The append-only log of human-approved decisions and rejections, and the deterministic graph derived from it |
| Authority processing | Customer | Meetings, decisions, server processing, pending approval, and delivery evidence |
| Person client | Person | One private Authority session and bounded authenticated requests |
| Future ECHO entitlement | ECHO | Pseudonymous organization-wide deny/revoke only |

Decision ownership is split deliberately. Authority processing owns the
meeting and pre-record decision state; the organization record owns the
org-wide act once a human approved or rejected it. The control plane owns
neither: it holds verified provider identity and the durable evidence that a
specific human took a specific approval action. No control-plane table exists
for records.

The future ECHO entitlement cannot create a customer membership, grant an
adapter permission, resolve a customer secret, or read customer organization
state. The customer may operate the Authority and control plane internally
without exposing their provider accounts, employees, meetings, or decisions.

## Slack connection onboarding gate

The organization connection has one deliberately small state contract:

```text
no active organization Slack connection
        |
        v
Slack is inactive and unavailable for employee connection
        |
        v
owner runs person tools setup with a configuration token or existing-app input
        |
        v
ECHO creates or adopts the private Slack app and opens a Nango connect session
        |
        v
Authority verifies the app, workspace, bot, and the four required scopes
        |
        v
credential bundle (client ID/secret, signing secret, Nango connection ID) in the
private secret store + opaque handle and public metadata in SQLite
        |
        v
organization Slack connection is active
```

Onboarding is an owner-attributed ceremony run from the owner's Person client
(`person tools setup --tool slack`; the desktop app's Tools page connects
only each person's own tools), not a host credential ceremony. The owner
generates a Slack app configuration token from Slack's own "Your App
Configuration Tokens" page and pastes it once; ECHO creates its private Slack
app for that organization through Slack's Manifest API, then opens a Nango
connect session that carries that app's client ID and secret as a
per-connection override. Nango runs the OAuth install and returns the bot
token; the Authority never
asks the owner for it directly. By default the install requests exactly four
bot scopes: `chat:write`, `im:history`, `im:write`, and `users:read`.
`im:write` opens the verified meeting owner's private DM and `im:history`
reconciles a retry without duplicating that DM card. Six scopes are requested
only when the staging V2 connector rehearsal selects its public-channel context
capability, which adds `channels:history` and `channels:read` on the same app
for public-channel pointer capture, a source proposal recorded in
[ADR-0027](../decisions/ADR-0027-rebind-lost-nango-slack-connection.md). The
stored connection contract names only the four approval scopes as required in
both cases. The public identity-link channel and `reactions:read` stay
retired. The recipe also
declares the user scopes `openid` and `profile` for the person's browser
sign-in alone: the install never requests them and no connection contract
records them. Rerunning setup with a new configuration token updates an
existing app to the current recipe.

Before the organization has any active Slack connection, an owner may instead
run `person tools setup --tool slack --existing-app A0EXAMPLE`. This explicit
option accepts the chosen app's credentials and a configuration token in one
hidden stdin JSON object; it cannot be combined with `--reconnect`. The
Authority updates that app to its current manifest, replaces any pending
credential bundle, and cancels stale pending install attempts before the new
install. It does not delete an earlier external Slack app. An active
organization connection blocks adoption even when the requested app ID matches;
this is not an active-connection migration or replacement path. Standard setup
and reconnect remain unchanged. The [owner instructions](../../deploy/organization-authority/README.md#use-an-existing-slack-app-before-the-first-connection)
define the exact input and the matching client/server release requirement.

Provider verification requires the Nango install to be for the
organization's own app (the credential bundle's app ID) and to grant the four
scopes, then calls Slack `auth.test` with the Nango-held bot token and requires
Slack's report and Nango's to name the same app, workspace, and bot user. The
bundle holds no workspace: verification compares Nango's and Slack's reports
with each other, and a reconnect also compares them against the active
connection. An install for a different app, workspace, or bot is refused and
ECHO writes nothing; a missing scope is refused the same way. A refused
reconnect has still changed Nango's connection, which now holds the other
workspace or bot, so the connection reads "needs reinstall" until the owner
reconnects to the original one. A failed, incomplete, or unavailable
verification leaves no active connection; absence therefore means inactive. A
reconnect of the same app reuses the same Nango connection ID and leaves every
outstanding approval card untouched. It completes only once that connection
reports the current attempt, organization and owner membership tags and fresh
Slack identity and permission checks pass; Nango's `updated_at` is not
completion evidence. When Nango no longer has that connection
(a 404 for it marks the connection "needs reinstall"), the owner's
`person tools setup --tool slack --reconnect` opens a new install and, once it
reproduces the stored verification evidence for the same app, workspace and
bot, rebinds the bundle's Nango connection ID under the same handle; the state
hash and the cards stay unchanged
([ADR-0027](../decisions/ADR-0027-rebind-lost-nango-slack-connection.md),
proposed).

Existing-app adoption preserves these checks. Applying the Slack manifest does
not configure Nango's integration or establish OAuth configuration alignment;
the returned connection still has to identify the chosen app and pass the
same verification before activation.

The Slack bot token is never written to Authority state: Nango holds it, and
the Authority fetches it at use time and caches it in memory for at most five
minutes ([ADR-0025](../decisions/ADR-0025-nango-holds-slack-connection-credentials.md)).
The organization-scoped Authority private secret store instead holds one
credential bundle: the app's client ID and secret, its signing secret, and the
Nango connection ID. `integrations.sqlite` receives only an opaque handle to
that bundle plus the verified workspace, bot identity, app ID, granted scopes,
evidence digests, and activation audit. The database never receives the bot
token, the client secret, or the signing secret.

Startup recovery first materializes every finalized approval and its V4 receipt
without contacting Slack. Terminal-card redraw is a later, optional presentation
step; its scheduling and retry rules are in
[meeting processing core and adapters](meeting-processing-core-and-adapters.md#adapter-responsibilities).
A Nango outage therefore leaves the durable decision intact and the card
pending without delaying Authority readiness. The owner's setup and install
report "Slack setup is unavailable right now". Unavailability and Nango's 401
or 403 never mark the connection "needs reinstall".

The `slack-organization-tool-v1` ready state is accepted only while its opaque
credential reference resolves to a private readable secret during Authority
startup. Private approval additionally needs that same bundle's signing
secret to verify Slack's Interactivity Request URL at
`/v2/integrations/slack/interactions`; the Slack app recipe sets that URL, so
no operator saves it by hand. Event Subscriptions and Socket Mode are not
used.

## Person Slack identity link

A signed-in Person can link one Slack human identity in two ways: Slack's own
browser sign-in, the default, or a DM-code challenge for a machine without a
browser.

The browser link (`person tools connect --tool slack`): the Person client
opens a Slack sign-in page built from the organization app's client ID and
secret, using Slack's OpenID Connect flow with the recipe's `openid` and
`profile` user scopes, and completes into the external
identity link once Slack identifies the human who approved it. Nango is not
involved; the person link stays entirely Authority-owned.

The DM-code challenge
(`person tools connect --tool slack --method dm-code --slack-user U…`): the
Person client keeps a one-time code, the Authority opens a one-to-one DM with
the requested recipient through the organization bot (`conversations.open`
with `return_im=true`), verifies the recipient, and posts a code-free
challenge. Slack identifies the one human who replies with that code in the
exact thread. Completion verifies the exact bot-authored thread and one human
code reply, then rechecks the current session, connection, DM, and recipient
before it creates or reuses that membership's external identity link. No
shared-channel fallback is supported.

Both paths prove one exact Slack `U...` or Enterprise Grid `W...` human in the
exact workspace of the active connection. Provider issuer, tenant, subject,
and granted scopes are derived from the authenticated provider lookup, never
from email, display name, or caller-supplied IDs.

### Employee Connected tools

`GET /v4/person/tools` is a bearer-authenticated read of the current
organization connection and the current member's external identity link; owners
also see the organization setup state. The v3 route and Slack's v2 route remain
for older clients. No
configured tool returns an empty list; an unavailable connection returns an
unavailable row. An active Slack tool reports its workspace separately from
the member's unlinked, linked, or revoked status. Failed reads return an
error, never an inferred link status. The desktop app's Account > Connected
tools page is bound to the signed-in membership and clears when it changes,
including between two employees with the same display name. Ask and Sources
retain their existing Authority permissions without a Slack link.

Disconnect always targets the authenticated Person. It revokes that member's
current link and returns the updated tool list; it does not touch the
organization connection or any other member.

The core runtime observer records `person_tools_status`,
`person_tool_delivery`, and `person_tool_completion` with bounded failure
attribution. These events contain no provider identities, challenge codes,
credentials, or provider response bodies.

## Private DM approval persistence

The Authority resolves the meeting owner's current Slack DM target from the
active connection and that member's active link, posts the frozen approval
card, and verifies each Slack interaction against the signing secret. The
control plane stores, per approval: the pending contract, every signed action
receipt, every denied action receipt, and the terminal evidence. Each
authorization is revalidated inside the Authority transaction against the
current membership tenure and the current link, and the resolution derives the
final approver exclusively from that revalidated authorization.
[INV-IDENTITY-005](../invariants/INV-IDENTITY-005-adapter-to-echo-identity-chain.md)
governs the identity chain.

Policy resolution is split along the provider boundary. The neutral core
(`application/private-approval-policy-resolution-core-v1`) owns the durable
command shape, verified assignees, the shared commitment identity, policy
binding, and exact replay matching. The Slack-owned module
(`providers/slack/server/src/organization-control-plane/application/slack/private-approval-policy-resolution-v1`) binds that core
to one exact Slack human and validates the link proof (`provider: "slack"`,
canonical `U`/`W` subject). The persisted field names
`assigned_owner_slack_identity_link` and `current_slack_identity_link` are
frozen, digested commitments; a second provider composes the core with its own
proof module and its own versioned contract rather than renaming these.

## Storage

Fresh state uses `baselines/organization-control-plane-baseline-v3.sql`,
containing only the 11 active tables below. Its applier requires an empty
database. Runtime and stopped-state setup require its exact digest and the
six-role V2 root manifest. Startup performs no schema migration.

Tables with a current reader or writer:

| Table | Behavior |
| --- | --- |
| `organization_control_plane_metadata` | Pins the organization, Authority, and Authority descriptor |
| `organization_tool_connection_contracts`, `organization_tool_connection_current_state` | The verified Slack connection and its current state |
| `organization_external_human_link_contracts`, `organization_external_human_link_current` | One canonical Slack human bound to one exact principal and membership |
| `organization_person_slack_link_challenges`, `organization_person_slack_link_commands` | Private-DM challenge coordinates and command replay evidence |
| `organization_private_approval_pending_contracts_v2` | The frozen pending approval |
| `organization_private_approval_signed_action_receipts_v2` | Every verified Slack action |
| `organization_private_approval_denied_action_receipts_v2` | Every rejected Slack action |
| `organization_private_approval_terminal_evidence_v2` | The final approve or reject with its revalidated authorization |

Authority `principal_id` and `membership_id` values are opaque references.
They are not foreign keys because the Authority remains the sole source of
those facts.

## Implemented safety

- Only a current Authority owner may activate the organization connection.
  Authority failure denies.
- Derive provider issuer, tenant, subject, and granted scopes from an
  authenticated provider lookup. Never trust email, display name, or
  caller-supplied provider IDs.
- Verify the bot, workspace, required scopes, and canonical non-null app
  identity before creating an active connection. The app ID embedded in a
  reviewed Slack message is never trusted as the connection identity.
- Normalize scopes and require the provider's granted scope set to contain
  every scope required by the selected flow.
- Store the app credential bundle (client ID and secret, signing secret, Nango
  connection ID) in a private mode-0600 file under organization-scoped
  Authority state; the bot token stays in Nango. SQLite stores only an opaque
  handle, never token bytes, authorization codes, or raw OAuth state, nonce, or
  PKCE material.
- Commit the link, receipt, or terminal evidence before publishing success.
- Never reuse a provider event as authorization. Every approval action is
  revalidated inside the Authority transaction against the current membership
  and the current link before it is recorded.
- Keep the private Slack DM card the single resolver. The Person client ships
  no approve or reject command.

The Authority and control plane run in one process. No positive authorization
result is cached.

## Explicitly deferred

The current schema does not persist:

- membership or principal mirrors;
- organization groups or inherited policy;
- quorum and candidate snapshots;
- projection streams or authorization receipts beyond the private approval
  receipts above;
- non-Slack and general-purpose organization workload identities;
- Person-bound approval delegation and record-writer bindings;
- control-plane signing delegation or recovery epochs;
- offline authorization, multi-replica operation, HA, or witnessed backup
  rollback protection;
- explicit organization-tool disconnect and replacing the organization
  connection with a different app or workspace; only a reconnect of the same
  app, or a rebind of its lost Nango connection to the same app, workspace and
  bot, is supported in v1. Organization access is disabled through membership
  revocation; a Person's own link is disabled through the personal disconnect
  or membership revocation.

These are design possibilities, not scheduled schema. They may be added only
when an accepted milestone has an externally observable behavior that cannot
be implemented safely with the current model.

No Teams, Granola, project-management, or other non-Slack organization-tool
onboarding is implemented. The Person CLI dispatches the Slack and server-gated
Jira tool fragments ([connector contracts](connector-contracts.md)); the
server's Connected tools list reports Slack only today.

## Schema growth rule

The current schema is closed by default. A new table, column, enum branch, index, or
trigger must:

1. support a named externally observable milestone behavior;
2. arrive with a failing-then-passing test for that behavior;
3. update the executable exact-schema contract, and for a table be assigned to
   that behavior in `TABLES_BY_OBSERVABLE_BEHAVIOR`; and
4. explain why an existing table or non-persistent implementation is
   insufficient.

“Future-proofing,” “enterprise readiness,” and “we may need it later” are not
valid reasons to add persisted state.
