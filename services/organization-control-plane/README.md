# Organization control plane

Customer-hosted minimum-v1 persistence for:

- one independently verified organization-owned Slack connection; and
- the live Slack-human → Authority membership → adapter grant permission path.

The seven domain tables store provider identity links, opaque connection
handles, exact adapter bindings, direct grants, and append-only audit. The
migration ledger is the eighth table. Authority remains the sole source of
principal, membership, role, installation, and revocation truth; this database
stores no Authority mirror, provider token, or product content.

## Runtime boundary

The organization-authority process opens `integrations.sqlite` only after its
authenticated singleton guard. Initialization creates and pins the database to
the exact organization, Authority, and Authority descriptor. Existing state
requires the explicit `install-integrations` maintenance command; normal
`serve` startup never creates a missing database.

Raw Slack credentials live only in customer-owned mode-0600 secret storage.
SQLite stores their opaque handles. Organization onboarding verifies the bot,
workspace, required scopes, and public channel before activation. Existing
profileless Internal Live connections remain usable by their approval bindings
until the same credential and channel are explicitly reverified.

## Migration invariant

`0002_organization_tool_public_configuration.sql` is immutable checksummed
history. Forward migration `0003_single_canonical_slack_promotion.sql` prevents
a parallel active organization Slack connection and permits only an in-place,
provider-reverified promotion of the existing connection. Its connection ID,
secret handle, binding, and grants remain unchanged.

The minimum-v1 schema is closed by default. New persisted state requires an
accepted observable behavior and an executable schema-contract update.

See [the canonical architecture specification](../../docs/architecture/organization-control-plane.md)
for the complete behavior, safety, and deferred-scope contract.
