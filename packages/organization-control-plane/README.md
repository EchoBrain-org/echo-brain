# Organization control plane

This library contains Organization Authority's provider-integration and
control-database components. It is linked into the Authority and does not own
an HTTP listener.

New Authority code uses the responsibility-named surfaces:
`slack-approval-integration-v1`, `slack-external-identity-integration-v1`,
`organization-control-database-v1`, `record-visibility-policy-contracts-v1`,
and `slack-connection-setup-v1`. The migration-era `clean-*` and `new-lineage-*`
alias exports were retired on 2026-09-06; no workspace imported them. The Slack
approval integration serves the private Slack DM approval path and performs
permission checks against current Authority membership. The earlier Slack
reaction approval path, its owner-attributed activation command, and its
`echo-organization-control-plane-activate-person-slack-*` binaries were removed
on 2026-09-06. The standalone V3 baseline now retires their nine tables.
Historical V1/V2 SQL remains byte-identical in the checkout for offline source
validation. It is excluded from runtime packages and images; historical
appliers now exist only in explicit test fixtures.

`record-visibility-policy-contracts-v1` is provider-neutral, and so is
`application/private-approval-policy-resolution-core-v1`: the durable command
shape, verified assignees, the shared commitment identity, policy binding, and
exact replay matching know no provider. Everything Slack-owned lives under
explicitly declared Slack roots: `application/slack/` binds that core to one
exact Slack human and validates the Slack link proof, Slack integration
contracts are under `application/slack-integration-contracts`, and the
organization tool connection and external identity-link contracts live under
`application/organization-tool-connection-contracts-v2`. The neutral secret
custody contract is `application/organization-secret-store-contracts`.

Private-approval fresh state uses the standalone byte-pinned V3 baseline with
11 active tables. It applies only to an empty database. The
[offline schema-cleanup converter](../../docs/product/2026-09-12-database-migration-cleanup.md)
accepts exact V2 control state within the supported whole-Authority lineage,
writes a separate output, and refuses nonempty retired tables. Current runtime
and stopped-state setup commands require the converted V2-root lineage and V3
control database; neither silently upgrades an existing database.

See [the canonical architecture specification](../../docs/architecture/organization-control-plane.md)
for the complete safety and deferred-scope contract.
