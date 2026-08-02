# Minimum organization control plane v1

**Status:** minimum organization-owned Slack onboarding plus the first live
identity-link and action-time permission slice.

This milestone is intentionally smaller than the eventual organization
platform. It exists to prove two customer-visible behaviors:

1. A current Authority owner can make one organization-owned Slack connection
   active only after the Authority independently verifies its provider
   identity, scopes, and public channel access.
2. The retained live permission path can prove a provider identity such as an
   employee's Slack `U...` user ID, link it to that employee's current Echo
   membership, grant one explicit action on one exact adapter, and deny it
   after either the membership or enrolled installation is revoked.

## Ownership boundaries

| Boundary | Owner | V1 authority |
| --- | --- | --- |
| Organization Authority | Customer | Principal, membership, role, installation, and revocation truth |
| Organization control plane | Customer | Provider links, connection handles, adapter bindings, direct grants, and integration audit |
| Echo Brain product | Customer | Meetings, decisions, local processing, and delivery evidence |
| Future ECHO entitlement | ECHO | Pseudonymous organization-wide deny/revoke only |

The future ECHO entitlement cannot create a customer membership, grant an
adapter permission, resolve a customer secret, or read customer organization
state. The customer may operate the Authority and control plane internally
without exposing their provider accounts, employees, meetings, or decisions.

## V1 behavior

### Organization-tool onboarding gate

The organization connection has one deliberately small state contract:

```text
no active organization Slack connection
        |
        v
Slack is inactive and unavailable for employee connection
        |
        v
current Authority owner submits bot token + public C-channel ID
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
`chat:write`, `reactions:read`, and `users:read`. The selected channel must be
an unarchived public `C...` channel and the verified bot must be a current
member. Its Slack `context_team_id` must equal the workspace proven by the bot
token, and externally shared or pending-external Slack Connect channels are
rejected. Provider verification occurs before activation. A failed,
incomplete, or unavailable verification leaves no active connection; absence
therefore means inactive.

Raw bot-token bytes are written only to the customer-owned Authority secret
directory as a mode-0600 file. `integrations.sqlite` receives an opaque
`sch_*` handle plus the verified workspace, bot identity, granted scopes,
public channel configuration, evidence digests, and activation audit. The
database never receives the token.

The `slack-organization-tool-v1` ready state is accepted only while its opaque
credential reference resolves to a private readable secret during Authority
startup. An enrolled installation can then start a manual Slack link: it keeps
a one-time code locally, the Authority posts a code-free challenge through the
organization bot, and Slack identifies the one human who replies with that
code in the exact thread. The observed human must match the reviewer already
configured for the installation's approval adapter. Completion creates or
reuses that membership's identity link and the installation's exact adapter
binding. It creates no permission grant. A profileless active connection is
compatibility-only.
Automatic tool discovery and configuration propagation into installations are
not implemented in this milestone.

The live database upgrade preserves one active organization-owned Slack
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

### Retained action-time permission path

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
5. `organization_adapter_bindings` permits one exact product installation,
   installation key, and adapter instance to use a connection.
6. `organization_permission_grants` grants one membership exactly one of
   `view`, `approve`, or `reject` on an approval binding.
7. `organization_integration_audit` records mutations and every live
   permission evaluation with an append-only digest chain.
8. `organization_schema_migrations` authenticates database upgrades.

Organization-tool onboarding adds public configuration to the existing tool
connection table. It does not add a domain table: the contract remains seven
domain tables and eight total including the migration ledger.

Authority `principal_id`, `membership_id`, and `installation_id` values are
opaque references. They are not foreign keys because Authority remains a
separate service and the sole source of those facts.

## Implemented v1 safety

The connection and permission service must preserve these rules:

- Recheck the current Authority owner role for every connection/grant
  mutation, and current installation plus target membership state for every
  permission action. Authority failure denies.
- Only a current Authority owner or administrator may mutate links,
  connections, bindings, or grants. Local grants cannot create an
  administrator.
- Derive provider issuer, tenant, subject, and granted scopes from an
  authenticated provider callback or lookup. Never trust email, display name,
  or caller-supplied provider IDs.
- Organization Slack onboarding is an owner-attributed, direct credential
  ceremony rather than OAuth. It verifies the bot, workspace, required scopes,
  and exact public channel access before creating an active organization tool
  connection.
- The earlier combined Slack bootstrap is retained for compatibility and live
  permission-path coverage. An existing profileless approval connection
  remains usable by its existing identity link, binding, and grants. Explicit
  organization-tool onboarding re-verifies its stored credential and channel
  and promotes that same connection ID; it never creates a parallel tool
  connection. After Slack is explicitly ready, an installation-signed manual
  challenge proves one exact Slack human and commits only that identity link
  and installation binding. It creates zero grants. Organization-tool
  onboarding does not create employee-specific records.
- OAuth callbacks and automatic organization-tool discovery/configuration
  propagation remain requirements for a later polished connect flow.
- Normalize scopes, require the provider's granted scope set to contain every
  scope required by the selected flow, and create the terminal attempt plus
  resulting link or connection in the same database transaction.
- Authenticate the local product caller as the exact enrolled installation and
  installation key named by the binding. Loopback networking alone is not
  authentication.
- Store provider tokens in a private mode-0600 file under customer-owned
  Authority state for the one-machine milestone. SQLite stores only an opaque
  `sch_*` handle, never token bytes, authorization codes, or raw PKCE material.
- Acquire an authenticated kernel singleton guard before opening writable
  state or listening.
- Commit the mutation or allow/deny audit record before publishing success.
- Bind the exact channel plus approve/reject reaction names into the adapter
  binding. The product cannot reinterpret a reject reaction as approval.
- Require an installation-signed `/v1/permission-checks` request and verify the
  decisive Slack reaction live before returning an allow. The decision itself is
  not signed. It carries `request_sha256` and `provider_event_sha256`, which
  bind the response to the exact request but do not authenticate it; the
  response is trusted because it arrives over the configured HTTPS origin
  associated with the pinned Authority descriptor, and the product verifies both
  digests before acting on it.
- Bind the live Slack bot, app, workspace, human, channel, message, reaction,
  and opaque approval digest into the installation-signed request. The Authority
  independently requires the bound bot to have authored a message carrying that
  exact approval marker.
- Never send the product processing key, meeting identifier, meeting content,
  decision text, or reason text to the Authority. `approval_id` is an
  irreversible digest used only to name the approval card.
- Never reuse a provider-event result as authorization. Every retry rechecks
  current installation, membership, link, binding, grant, bot identity,
  message marker, and conflicting reactions before appending a new audit
  evaluation.
- Disable direct CLI approve/reject for organization-enrolled profiles until a
  centrally attributable CLI actor policy exists.

The Authority and integration layer run in one process. The permission lookup
is authenticated by the enrolled installation key and never receives the
administrator credential. No positive authorization result is cached in v1.

## Explicitly deferred

V1 does not persist:

- membership or principal mirrors;
- organization groups or inherited policy;
- quorum and candidate snapshots;
- projection streams or authorization receipts;
- non-Slack and general-purpose organization workload identities;
- product cutover state;
- control-plane signing delegation or recovery epochs;
- offline authorization, multi-machine operation, HA, or witnessed backup
  rollback protection;
- Slack credential or channel rotation, explicit organization-tool disconnect,
  and fine-grained operator actions for revoking or replacing provider identity
  links, tool connections, adapter bindings, or individual grants. V1
  organization access is disabled through the implemented membership or
  installation revocation controls; provider lifecycle management is a later
  milestone.

These are design possibilities, not scheduled schema. They may be added only
when an accepted milestone has an externally observable behavior that cannot
be implemented safely with the current model.

No Teams, Granola, project-management, or other non-Slack organization-tool
onboarding is implemented. Automatic organization-tool propagation and a
multi-provider employee connect catalog are also explicitly deferred.

No operator tool creates a permission grant. `organization_permission_grants`
receives rows from exactly one code path: the retained Slack approval
bootstrap behind `POST /v1/admin/integrations/slack-approval-bootstrap`. That
route is reachable only as a raw administrator-authenticated HTTP call; no
administrator CLI verb, administrator console form, or product client invokes
it. Completing an employee Slack identity link therefore always reports
`permission_grants_created: 0`. An employee completes the link ceremony
successfully and is then denied by the action-time permission path, which
finds no active grant. Making grant creation reachable from a shipped
operator interface is a later milestone.

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
