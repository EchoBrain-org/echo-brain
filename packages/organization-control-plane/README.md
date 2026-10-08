# Organization control plane

This library contains Organization Authority's provider-neutral control
contracts and SQLite persistence. It is linked into the Authority and owns no
HTTP listener. Provider-specific implementations live under `providers/`.

`organization-control-database-v1` opens the database and applies the current
V4 baseline. `record-visibility-policy-contracts-v1` owns the visibility
policy identifiers and contract digests.
`application/organization-secret-store-contracts` defines secret custody
through opaque handles.

The Slack integration and identity-link ceremony live in
`providers/slack/server` and compose these neutral contracts. The control
plane stores no approval state.

Fresh state uses the byte-pinned V4 baseline with 7 active tables. It applies
only to an empty database. Runtime and stopped-state setup require the exact
baseline digest and the six-role V2 root lineage; neither upgrades existing
state. Historical schemas and their one-off converter are available in Git
history, outside the supported runtime and release path.

See [the canonical architecture specification](../../docs/architecture/organization-control-plane.md)
for the safety and deferred-scope contract.
