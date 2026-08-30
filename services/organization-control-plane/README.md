# Organization control plane

This library contains Organization Authority's provider-integration and
control-database components. It is linked into the Authority and does not own
an HTTP listener.

New Authority code uses the responsibility-named surfaces:
`slack-approval-integration-v1`, `slack-external-identity-integration-v1`,
`organization-control-database-v1`, `record-visibility-policy-contracts-v1`,
and `slack-connection-setup-v1`. The
retained installation-bound reaction activation command is isolated behind
`legacy-slack-reaction-approval-activation-v1`. Migration-era `clean-*` and
`new-lineage-*` exports remain compatibility aliases for installed clients.
The Slack approval integration keeps both the member-readable and
restricted-reviewer policies and performs permission checks against current
Authority membership.

Private-approval fresh state is initialized from the composed V2 baseline:
the retained `baselines/organization-control-plane-baseline-v1.sql` plus
`baselines/organization-control-plane-private-approval-v2.sql`. It applies
only to an empty database; existing V1 state is refused rather than migrated.
Historical migration runners and generic control-plane root APIs are not
shipped.

See [the canonical architecture specification](../../docs/architecture/organization-control-plane.md)
for the complete safety and deferred-scope contract.
