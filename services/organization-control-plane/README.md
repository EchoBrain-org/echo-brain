# Organization control plane

This library contains the clean V1 organization control-plane facades. It is
linked into the Authority and does not own an HTTP listener.

The supported surface is `clean-founder-v1`, `clean-runtime-v1`,
`clean-slack-identity-v1`, and `new-lineage-genesis-v1`, plus the two clean
Slack connection and approval-activation commands. The runtime keeps both the
member-readable and restricted-reviewer policies and performs permission
checks against current Authority membership.

New state is initialized only from
`baselines/organization-control-plane-baseline-v1.sql`. Historical migration
runners and generic control-plane root APIs are not shipped.

See [the canonical architecture specification](../../docs/architecture/organization-control-plane.md)
for the complete safety and deferred-scope contract.
