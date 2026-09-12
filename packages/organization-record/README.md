# Organization record

This library owns the append-only organization record.
`organization-record-api-v1` exposes the V4 record appender, the
permission-aware Person reader, and the retrieval-source snapshot port.

The V4 canonical envelope bytes and their authorization and provider-action
proof digests are immutable contracts. Reads resolve current permissions for
multi-person organizations and preserve member-readable and restricted-reviewer
policy behavior.

Provider-neutral policy-fact and approver-projection contracts live in
`application`. The Slack policy projector lives under
`providers/slack/server/src/organization-record`. Composition selects the
protocol decoder; the read route checks its coordinates and resolves a current
display name. The approver port derives identity only from an already
permission-filtered envelope. Unknown references and generic HumanAct
references without an actor have no optional approver metadata. Derived
metadata never changes canonical records.

Fresh logs use the byte-pinned V3 baseline, applied only to an empty database.
Person reads and search generation use the canonical log and permission facts.
The V2 state-lineage root has six roles: Authority, control plane, record log,
and the facts, lexical, and content retrieval planes. Current runtime rejects
unsupported or mixed state before writable opening; there is no startup
migration.

The log remains truth and retrieval generations remain disposable. See the
[append/derive design](../../docs/product/2026-08-07-org-decision-record-append-derive-design.md)
for the historical rationale.
