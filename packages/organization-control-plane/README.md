# Organization control plane

This library contains Organization Authority's provider-neutral control
contracts and SQLite persistence. It is linked into the Authority and owns no
HTTP listener. Provider-specific implementations live under `providers/`.

`organization-control-database-v1` opens the database and applies the current
V3 baseline. `record-visibility-policy-contracts-v1` and
`application/private-approval-policy-resolution-core-v1` own visibility policy,
verified assignees, commitment identity, policy binding, and exact replay
matching. `application/organization-secret-store-contracts` defines secret
custody through opaque handles.

The Slack integration, identity-link ceremony, and approval adapter live in
`providers/slack/server`. They compose these neutral contracts and revalidate
approval actions against current Authority membership and provider identity.

Fresh state uses the byte-pinned V3 baseline with 11 active tables. It applies
only to an empty database. Runtime and stopped-state setup require the exact
baseline digest and the six-role V2 root lineage; neither upgrades existing
state. Historical schemas and their one-off converter are available in Git
history, outside the supported runtime and release path.

See [the canonical architecture specification](../../docs/architecture/organization-control-plane.md)
for the safety and deferred-scope contract.
