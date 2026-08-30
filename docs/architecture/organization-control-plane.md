# Organization control plane

**Status:** current organization-owned Slack onboarding and Person identity
linking, plus a retained installation-bound V1 permission slice with no shipped
caller.

This component implements two current customer-visible behaviors:

1. A current Authority owner can make one organization-owned Slack connection
   active only after the Authority independently verifies its provider
   identity, scopes, and public channel access.
2. A signed-in Person can prove a provider identity such as an employee's Slack
   `U...` user ID and link it to that employee's current ECHO membership. This
   creates no adapter binding or permission grant.

The control plane also retains the installation-signed V1 action-time
permission evaluator because existing approval and record schemas still refer
to it. The old machine runtime and signer are deleted, so that evaluator is a
server compatibility surface, not a current Person workflow.

## Ownership boundaries

| Boundary | Owner | Responsibility |
| --- | --- | --- |
| Organization Authority | Customer | Principal, membership, role, Person session, processing, retained installation compatibility, and revocation truth |
| Organization control plane | Customer | Provider links, connection handles, adapter bindings, direct grants, and integration audit |
| Organization record | Customer | The append-only log of human-approved decisions and rejections, and the deterministic graph derived from it |
| Authority processing | Customer | Meetings, decisions, server processing, pending approval, and delivery evidence |
| Person client | Person | One private Authority session and bounded authenticated requests |
| Future ECHO entitlement | ECHO | Pseudonymous organization-wide deny/revoke only |

Decision ownership is split deliberately. Authority processing owns the
meeting and pre-record decision state; the organization record owns the
org-wide act once a human approved or rejected it. The control plane owns
neither — it holds provider identity and, for the retained V1 path, the
permission evaluation that authorized the act. Organization-record ingest
reads an existing `organization_integration_audit` row read-only before it
appends. No control-plane table exists for records.

The future ECHO entitlement cannot create a customer membership, grant an
adapter permission, resolve a customer secret, or read customer organization
state. The customer may operate the Authority and control plane internally
without exposing their provider accounts, employees, meetings, or decisions.

## Current behavior

### Slack connection onboarding gate

The organization connection has one deliberately small state contract:

```text
no active organization Slack connection
        |
        v
Slack is inactive and unavailable for employee connection
        |
        v
current Authority owner submits bot token + temporary public identity-link C-channel ID
        |
        v
Authority verifies bot, workspace, required scopes, and channel access
        |
        v
mode-0600 customer secret file + opaque handle and public metadata in SQLite
        |
        v
organization Slack connection is active
```

The required Slack scopes are `channels:history`, `channels:read`,
`chat:write`, `im:history`, `im:write`, `reactions:read`, and `users:read`.
The public-channel scopes remain for the current Person identity-link contract;
`im:write` opens the verified meeting owner's private DM and `im:history`
reconciles a retry without duplicating that DM card. The public channel is
identity-link-only: it receives no approval card and creates no approval
binding. Provider verification first
uses Slack `auth.test` for the token-bound workspace, bot user, bot ID, and
granted scopes. It then uses `bots.info` for that exact bot ID and requires the
returned bot ID and user ID to agree, the bot not to be deleted, and a canonical
non-null Slack app ID. If `auth.test` also returns an app ID, it is only a
corroborating value and must agree with `bots.info`; its omission is not proof
that there is no app. The selected channel must be an unarchived public `C...`
channel and the verified bot must be a current member. Its Slack
`context_team_id` must equal the workspace proven by the bot token, and
externally shared or pending-external Slack Connect channels are rejected.
Provider verification occurs before activation. A failed, incomplete, or
unavailable verification leaves no active connection; absence therefore means
inactive.

Raw bot-token bytes are written only to the organization-scoped Authority
private directory as a mode-0600 file. `integrations.sqlite` receives an opaque
`sch_*` handle plus the verified workspace, bot identity, granted scopes,
public channel configuration, evidence digests, and activation audit. The
database never receives the token.

The `slack-organization-tool-v1` ready state is accepted only while its opaque
credential reference resolves to a private readable secret during Authority
startup. A signed-in Person can then start a manual Slack link: the Person
client keeps a one-time code, the Authority posts a code-free challenge through
the organization bot, and Slack identifies the one human who replies with that
code in the exact thread. Completion creates or reuses that membership's
external identity link. It creates no adapter binding or permission grant.

Private approval V1 needs the same app's Interactivity Request URL at
`/v2/integrations/slack/interactions` and signing secret. It does not currently
need Event Subscriptions, Socket Mode, or a Slack OAuth redirect flow.

The retained V1 installation-signed challenge still expects an installation's
configured reviewer and can create an installation adapter binding. No shipped
client can initiate that compatibility flow. A profileless active connection
is compatibility-only. Automatic multi-provider tool discovery and Person-bound
approval configuration remain later work.

The database migration preserves one active organization-owned Slack
connection. Migration `0002_organization_tool_public_configuration.sql` is an
immutable, checksummed historical migration: it backfilled the earlier
combined-bootstrap configuration without assigning the employee-connectable
readiness profile. Its profileless connection, binding, identity link, and
grants remain usable by the existing action-time approval path.

Migration `0003_single_canonical_slack_promotion.sql` is the forward correction.
It makes the profileless compatibility connection and a ready connection
mutually exclusive, so an organization cannot gain a parallel active Slack
credential. Explicit organization-tool onboarding against a profileless
connection must re-verify the exact stored bot credential, workspace, complete
scope set, and existing public channel. If every value still agrees, the same
connection ID is promoted in place to `slack-organization-tool-v1`; its existing
binding and grants continue to reference that connection. A mismatch fails
closed. This ceremony is promotion, not credential or channel rotation.

Migration `0004_slack_enterprise_grid_user_ids.sql` changes no table or
persisted relationship. It replaces only the Slack connection guards so the
bot and human user namespaces accept Slack's documented `U...` and Enterprise
Grid `W...` IDs while retaining every other v3 invariant.

Migration `0005_slack_app_identity_promotion.sql` is a narrow forward repair
for historical profileless and ready v1 Slack tools created before canonical app
identity was required. It does not infer or backfill an app ID, and it does not
change an active tool during startup. It permits only the explicit
re-onboarding ceremony to replace the exact stored `null` app ID with a freshly
verified non-null app ID, in the same transaction as the equivalent update to
every active exact Slack approval binding on that connection. The connection
ID, binding IDs, secret handle, direct grants, and existing audit history
remain unchanged; a new owner-attributed audit entry records the
re-verification. Any other tool or binding shape, provider mismatch, missing
app proof, or concurrent change fails closed. This is identity repair, not
credential rotation, channel rotation, or a general lifecycle operation.

### Retained V1 action-time permission path

This path is still implemented and tested server-side, but it has no caller in
the Person product:

```text
verified provider event
        |
        v
active provider identity link
        |
        v
exact Authority principal + membership -- live Authority check --> active?
        |
        v
active direct view / approve / reject grant
        |
        v
active adapter binding + active connection
        |
        v
authenticated enrolled installation and key match
        |
        v
allow or deny, then append audit before returning
```

Every dependency is an intersection. Missing, revoked, expired, unverifiable,
or unreachable state denies.

The replacement server approval path must preserve that intersection under
[INV-IDENTITY-005](../invariants/INV-IDENTITY-005-adapter-to-echo-identity-chain.md).
It removes installation authentication from the chain; it does not collapse or
discard the verified provider connection, adapter identity/instance/binding,
tenant-scoped external identity link, exact principal/membership tenure,
explicit action capability, frozen provider object, or integration-audit
proof. A Person identity link still grants no action by itself.

## Closed v1 schema

The schema contains seven domain tables plus its migration ledger:

1. `organization_control_plane_metadata` pins the organization, Authority, and
   Authority descriptor.
2. `organization_connection_attempts` provides a short-lived, single-use
   provider connection ceremony.
3. `organization_external_identity_links` maps one canonical provider human to
   one exact Authority principal and membership.
4. `organization_tool_connections` records immutable provider account identity,
   granted scopes, verified public configuration, and an opaque customer
   secret-store handle.
5. `organization_adapter_bindings` retains the V1 permission for one exact
   installation, installation key, and adapter instance to use a connection.
6. `organization_permission_grants` grants one membership exactly one of
   `view`, `approve`, or `reject` on an approval binding.
7. `organization_integration_audit` records mutations and every live
   permission evaluation with an append-only digest chain.
8. `organization_schema_migrations` authenticates database upgrades.

Organization-tool onboarding adds public configuration to the existing tool
connection table. It does not add a domain table: the contract remains seven
domain tables and eight total including the migration ledger.

Authority `principal_id`, `membership_id`, and retained `installation_id`
values are opaque references. They are not foreign keys because Authority
remains the sole source of those facts.

## Implemented v1 safety

The connection and permission service must preserve these rules:

- Recheck the current Authority owner role for every connection/grant
  mutation, and, on the retained V1 permission path, current installation plus
  target membership state for every action. Authority failure denies.
- Only a current Authority owner or administrator may mutate links,
  connections, bindings, or grants. Local grants cannot create an
  administrator.
- Derive provider issuer, tenant, subject, and granted scopes from an
  authenticated provider callback or lookup. Never trust email, display name,
  or caller-supplied provider IDs.
- Organization Slack onboarding is an owner-attributed, direct credential
  ceremony rather than OAuth. It verifies the bot, workspace, required scopes,
  canonical non-null app identity, and exact public channel access before
  creating an active organization tool connection. `auth.test` establishes the
  token-bound bot context; `bots.info` for that bot is the required app-identity
  proof. The app ID embedded in a reviewed Slack message is never trusted as
  the connection identity.
- Existing profileless approval connections and their links, bindings, and
  grants remain readable for compatibility. Explicit organization-tool
  onboarding re-verifies the stored credential and channel and promotes that
  same connection ID; it never creates a parallel tool connection. The current
  Person-session-authenticated challenge proves one exact Slack human and commits only the
  identity link. The retained installation-signed challenge and
  owner-attributed grant activation are not callable by the Person client.
  Organization-tool onboarding creates no employee-specific state.
- A historical profileless or ready v1 tool with a `null` Slack app ID is not
  silently accepted as an exact reviewer identity. An owner must explicitly
  re-onboard it. The Authority verifies the retained private credential again
  and the control plane atomically promotes the connection plus every exact
  active Slack approval binding to the same canonical app ID. IDs, grants, and
  prior audit entries are retained; a new audit entry identifies the repair.
- OAuth callbacks and automatic organization-tool discovery/configuration
  propagation remain requirements for a later polished connect flow.
- Normalize scopes, require the provider's granted scope set to contain every
  scope required by the selected flow, and create the terminal attempt plus
  resulting link or connection in the same database transaction.
- On the retained V1 path, authenticate the caller as the exact enrolled
  installation and installation key named by the binding. Loopback networking
  alone is not authentication.
- Store provider tokens in a private mode-0600 file under organization-scoped
  Authority state for the single-Authority milestone. SQLite stores only an
  opaque `sch_*` handle, never token bytes, authorization codes, or raw PKCE
  material.
- Acquire an authenticated kernel singleton guard before opening writable
  state or listening.
- Commit the mutation or allow/deny audit record before publishing success.
- Bind the exact channel plus approve/reject reaction names into the adapter
  binding. A server adapter cannot reinterpret a reject reaction as approval.
- On the retained V1 path, require an installation-signed
  `/v1/permission-checks` request and verify the
  decisive Slack reaction live before returning an allow. The decision itself is
  not signed. It carries `request_sha256` and `provider_event_sha256`, which
  bind the response to the exact request but do not authenticate it; the
  response is trusted only after a compatible caller verifies its configured
  HTTPS Authority and both digests. No current Person operation consumes this
  decision.
- Bind the live Slack bot, app, workspace, human, channel, message, reaction,
  and opaque approval digest into the installation-signed request. The Authority
  independently requires the bound bot to have authored a message carrying that
  exact approval marker.
- The installation-signed `/v1/permission-checks` request never sends the V1
  processing key, meeting identifier, meeting content, decision text,
  or reason text to the Authority's action-time authorization path.
  `approval_id` is an irreversible digest used only to name the approval card.
- Never reuse a provider-event result as authorization. Every retained V1 retry
  rechecks current installation, membership, link, binding, grant, bot identity,
  message marker, and conflicting reactions before appending a new audit
  evaluation.
- Keep the Slack approval surface the single resolver. The Person CLI ships no
  approve/reject command. The bundled Slack approval adapter is composed into
  the Authority meeting runtime when the retained installation-bound binding
  exists; the missing piece is a Person/server approval activation contract,
  not Slack runtime composition.

The Authority and integration layer run in one process. The retained V1
permission lookup is authenticated by the enrolled installation key and never
receives the administrator credential. No positive authorization result is
cached.

## Explicitly deferred

V1 does not persist:

- membership or principal mirrors;
- organization groups or inherited policy;
- quorum and candidate snapshots;
- projection streams or authorization receipts;
- non-Slack and general-purpose organization workload identities;
- Person-bound approval and record-writer bindings;
- control-plane signing delegation or recovery epochs;
- offline authorization, multi-replica operation, HA, or witnessed backup
  rollback protection;
- Slack credential or channel rotation, explicit organization-tool disconnect,
  and fine-grained operator actions for revoking or replacing provider identity
  links, tool connections, adapter bindings, or individual grants. V1
  organization access is disabled through the implemented membership or
  installation revocation controls; provider lifecycle management is a later
  milestone. Current Person access is disabled through session or membership
  revocation; installation revocation applies only to the retained V1 path.

These are design possibilities, not scheduled schema. They may be added only
when an accepted milestone has an externally observable behavior that cannot
be implemented safely with the current model.

No Teams, Granola, project-management, or other non-Slack organization-tool
onboarding is implemented. A multi-provider Person connect catalog is also
explicitly deferred.

`organization_permission_grants` receives NEW Slack approval grants only
through the retained installation-bound activation path. The administrator
command names an existing V1 identity link and exact installation adapter
binding; its Authority route creates or reuses only direct `approve` and
`reject` grants. It does not call Slack, accept a bot token, create a provider
identity, or create an adapter binding. Person-v2 Slack completion creates or
reuses only an external identity link and cannot feed this old activation
contract. Therefore no current Person product path creates a new approval
grant; the replacement must be additive and server-owned.

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
