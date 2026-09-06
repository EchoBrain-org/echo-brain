# Organization control plane

This library contains Organization Authority's provider-integration and
control-database components. It is linked into the Authority and does not own
an HTTP listener.

New Authority code uses the responsibility-named surfaces:
`slack-approval-integration-v1`, `slack-external-identity-integration-v1`,
`organization-control-database-v1`, `record-visibility-policy-contracts-v1`,
and `slack-connection-setup-v1`. Migration-era `clean-*` and `new-lineage-*`
exports remain compatibility aliases for installed clients. The Slack approval
integration serves the private Slack DM approval path and performs permission
checks against current Authority membership. The earlier Slack reaction
approval path, its owner-attributed activation command, and its
`echo-organization-control-plane-activate-person-slack-*` binaries were removed
on 2026-09-06; their baseline tables remain in the frozen V1 baseline until a
versioned schema migration retires them.

`record-visibility-policy-contracts-v1` is provider-neutral. Its public facade
re-exports the application policy contracts consumed by the private approval
resolution; Slack integration contracts are separately named under
`application/slack-integration-contracts`, and the organization tool
connection and external identity-link contracts live under
`application/organization-tool-connection-contracts-v2`.

Private-approval fresh state is initialized from the composed V2 baseline:
the retained `baselines/organization-control-plane-baseline-v1.sql` plus
`baselines/organization-control-plane-private-approval-v2.sql`. It applies
only to an empty database; existing V1 state is refused rather than migrated.
Historical migration runners and generic control-plane root APIs are not
shipped.

See [the canonical architecture specification](../../docs/architecture/organization-control-plane.md)
for the complete safety and deferred-scope contract.
