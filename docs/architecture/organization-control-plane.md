# Organization control plane

**Status:** current organization-owned Slack onboarding, Person Slack identity
linking, and private Slack DM approval persistence. Historical paths are
listed under [Retired paths](#retired-paths); nothing in that section is
callable today.

The control plane is a library linked into the Organization Authority. It owns
no HTTP listener. The Authority composes it through five entry points:

| Entry point | Responsibility |
| --- | --- |
| `slack-connection-setup-v1` | The owner-attributed Slack connection ceremony and its CLI |
| `slack-external-identity-integration-v1` | Slack identity provider, external human-link contracts, and the secret store |
| `slack-approval-integration-v1` | Private DM approval policy resolution, reviewer targeting, and approval persistence |
| `organization-control-database-v1` | Opening the control database and applying the frozen baselines |
| `record-visibility-policy-contracts-v1` | Provider-neutral Person visibility policy contracts consumed by approval resolution |

## Current behaviors

1. A current Authority owner can make one organization-owned Slack connection
   active only after the Authority independently verifies its provider
   identity, scopes, and public channel access.
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
current Authority owner submits bot token + public channel ID
        |
        v
Authority verifies bot, app, workspace, required scopes, and channel access
        |
        v
mode-0600 customer secret file + opaque handle and public metadata in SQLite
        |
        v
organization Slack connection is active
```

Onboarding is an owner-attributed direct credential ceremony, not OAuth. The
required Slack scopes are `channels:history`, `channels:read`, `chat:write`,
`im:history`, `im:write`, `reactions:read`, and `users:read`. `im:write` opens
the verified meeting owner's private DM and `im:history` reconciles a retry
without duplicating that DM card. The configured public channel is verified
for bot membership only; it receives neither Person identity challenges nor
approval cards.

Provider verification first uses Slack `auth.test` for the token-bound
workspace, bot user, bot ID, and granted scopes. It then uses `bots.info` for
that exact bot ID and requires the returned bot ID and user ID to agree, the
bot not to be deleted, and a canonical non-null Slack app ID. If `auth.test`
also returns an app ID, it is only a corroborating value and must agree with
`bots.info`; its omission is not proof that there is no app. The selected
channel must be an unarchived public `C...` channel and the verified bot must
be a current member. Its Slack `context_team_id` must equal the workspace
proven by the bot token, and externally shared or pending-external Slack
Connect channels are rejected. A failed, incomplete, or unavailable
verification leaves no active connection; absence therefore means inactive.

Raw bot-token bytes are written only to the organization-scoped Authority
private directory as a mode-0600 file. `integrations.sqlite` receives an opaque
handle plus the verified workspace, bot identity, app ID, granted scopes,
public channel configuration, evidence digests, and activation audit. The
database never receives the token.

The `slack-organization-tool-v1` ready state is accepted only while its opaque
credential reference resolves to a private readable secret during Authority
startup. Private approval additionally needs the same app's Interactivity
Request URL at `/v2/integrations/slack/interactions` and its signing secret.
Event Subscriptions and Socket Mode are not used.

## Person Slack identity link

A signed-in Person can link one Slack human identity in two ways.

The manual challenge: the Person client keeps a one-time code, the Authority
opens a one-to-one DM with the requested recipient through the organization
bot (`conversations.open` with `return_im=true`), verifies the recipient, and
posts a code-free challenge. Slack identifies the one human who replies with
that code in the exact thread. Completion verifies the exact bot-authored
thread and one human code reply, then rechecks the current session,
connection, DM, and recipient before it creates or reuses that membership's
external identity link. No shared-channel fallback is supported.

The browser link: when the owner has configured the optional Slack browser
OAuth file during onboarding, the Person client can instead open a browser
attempt that proves the same Slack human through Slack's OAuth redirect and
completes into the same external identity link. Without that configuration
the browser route reports unavailable and the manual challenge remains.

Both paths prove one exact Slack `U...` or Enterprise Grid `W...` human in the
exact workspace of the active connection. Provider issuer, tenant, subject,
and granted scopes are derived from the authenticated provider lookup, never
from email, display name, or caller-supplied IDs.

### Employee Connected tools

`GET /v2/person/tools` is a bearer-authenticated read of the current
organization connection and the current member's external identity link. No
configured tool returns an empty list; an unavailable connection returns an
unavailable row. An active Slack tool reports its workspace separately from
the member's unlinked, linked, or revoked status. Failed reads return an
error, never an inferred link status. The native Account > Connected tools
screen clears state when the membership changes, including two employees with
the same display name. Ask and Sources retain their existing Authority
permissions without a Slack link.

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
(`application/slack/private-approval-policy-resolution-v1`) binds that core
to one exact Slack human and validates the link proof (`provider: "slack"`,
canonical `U`/`W` subject). The persisted field names
`assigned_owner_slack_identity_link` and `current_slack_identity_link` are
frozen, digested commitments; a second provider composes the core with its own
proof module and its own versioned contract rather than renaming these.

## Storage

Fresh state is initialized from the composed baseline: the retained
`baselines/organization-control-plane-baseline-v1.sql` plus
`baselines/organization-control-plane-private-approval-v2.sql`. It applies
only to an empty database; existing state with a different baseline digest is
refused rather than migrated. There is no migration runner and no migration
ledger table. Re-onboard disposable staging against a new artifact; an
in-place upgrade requires a separately reviewed, versioned schema change and
state-lineage qualification.

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

Nine further V1 tables (`organization_approval_binding_*`,
`organization_approval_action_capability_*`,
`organization_approval_activation_*`,
`organization_person_slack_pending_approval*`, and
`organization_provider_human_action_evidence`) belonged to the retired
reaction-approval path. No runtime code reads or writes them. They remain in
the frozen V1 baseline because the exact-schema tests and baseline digest
protect installed schema identity; removing them is a deliberate versioned
schema revision, not a cleanup edit.

Authority `principal_id` and `membership_id` values are opaque references.
They are not foreign keys because the Authority remains the sole source of
those facts.

## Implemented safety

- Only a current Authority owner may activate the organization connection.
  Authority failure denies.
- Derive provider issuer, tenant, subject, and granted scopes from an
  authenticated provider lookup. Never trust email, display name, or
  caller-supplied provider IDs.
- Verify the bot, workspace, required scopes, canonical non-null app
  identity, and exact public channel access before creating an active
  connection. The app ID embedded in a reviewed Slack message is never trusted
  as the connection identity.
- Normalize scopes and require the provider's granted scope set to contain
  every scope required by the selected flow.
- Store provider tokens in a private mode-0600 file under organization-scoped
  Authority state. SQLite stores only an opaque handle, never token bytes,
  authorization codes, or raw OAuth state, nonce, or PKCE material.
- Commit the link, receipt, or terminal evidence before publishing success.
- Never reuse a provider event as authorization. Every approval action is
  revalidated inside the Authority transaction against the current membership
  and the current link before it is recorded.
- Keep the private Slack DM card the single resolver. The Person client ships
  no approve or reject command.

The Authority and control plane run in one process. No positive authorization
result is cached.

## Explicitly deferred

V1 does not persist:

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
- Slack credential or channel rotation, explicit organization-tool disconnect,
  and operator actions for replacing the organization connection. Organization
  access is disabled through membership revocation; a Person's own link is
  disabled through the personal disconnect or membership revocation.

These are design possibilities, not scheduled schema. They may be added only
when an accepted milestone has an externally observable behavior that cannot
be implemented safely with the current model.

No Teams, Granola, project-management, or other non-Slack organization-tool
onboarding is implemented. A multi-provider Person connect catalog is also
explicitly deferred; the Connected tools response is a single-Slack contract
today.

## Schema growth rule

The v1 schema is closed by default. A new table, column, enum branch, index, or
trigger must:

1. support a named externally observable milestone behavior;
2. arrive with a failing-then-passing test for that behavior;
3. update the executable exact-schema contract, and for a table be assigned to
   that behavior in `TABLES_BY_OBSERVABLE_BEHAVIOR`; and
4. explain why an existing table or non-persistent implementation is
   insufficient.

“Future-proofing,” “enterprise readiness,” and “we may need it later” are not
valid reasons to add persisted state.

## Retired paths

These are recorded so that older design documents and the frozen V1 tables
stay explainable. None is callable.

- **Installation-signed reaction approval (removed 2026-09-06).** Slack
  reaction approval, the installation-signed `/v1/permission-checks` request,
  adapter bindings, direct `view`/`approve`/`reject` grants, and the
  owner-attributed activation command were removed. The private DM card
  replaced them.
- **Installation-signed Person Slack identity linking.** The earlier
  installation-signed challenge and its API types were removed with the
  installation model. Linking is Person-session-authenticated only.
- **Migration ledger and historical migrations.** The earlier
  `organization_schema_migrations` ledger and numbered migrations were
  replaced by frozen, checksummed baselines applied only to empty databases.
- **Migration-era alias exports.** The `clean-*` and `new-lineage-*` facade
  aliases were retired on 2026-09-06; no workspace imported them.
