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
workspace, required scopes, public channel, and a canonical non-null Slack app
ID before activation. `auth.test` supplies the token-bound bot context and
`bots.info` for that exact bot supplies the app proof; a missing app ID from
`auth.test` is not an identity value. Existing profileless Internal Live
connections remain usable by their approval bindings until the same credential
and channel are explicitly reverified.

## Migration invariant

`0002_organization_tool_public_configuration.sql` is immutable checksummed
history. Forward migration `0003_single_canonical_slack_promotion.sql` prevents
a parallel active organization Slack connection and permits only an in-place,
provider-reverified promotion of the existing connection. Its connection ID,
secret handle, binding, and grants remain unchanged.

Forward migration `0005_slack_app_identity_promotion.sql` installs the narrow
guard for historical profileless and ready tools whose stored Slack app ID is
`null`. It performs no automatic backfill. Only explicit owner re-onboarding,
after fresh `auth.test` plus `bots.info` proof, may atomically set the canonical
app ID on that connection and all its exact active Slack approval bindings. The
repair preserves connection and binding IDs, opaque secret handles, direct
grants, and historical audit rows; it appends a new audit record instead of
rewriting history.

The minimum-v1 schema is closed by default. New persisted state requires an
accepted observable behavior and an executable schema-contract update.

See [the canonical architecture specification](../../docs/architecture/organization-control-plane.md)
for the complete behavior, safety, and deferred-scope contract.
