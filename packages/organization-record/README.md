# Organization record

This library owns the append-only organization record.
`organization-record-api-v1` exposes the V4 record appender, the
permission-aware Person reader, and the retrieval-source snapshot port.

The V4 canonical envelope bytes and their authorization and provider-action
proof digests are immutable contracts. Reads resolve current permissions for
multi-person organizations and preserve restricted-reviewer and
project-members policy behavior.

Provider-neutral policy-fact and approver-projection contracts live in
`application`. The approval-decision policy and approver projectors live in
`services/organization-authority/src/composition/approval-decision-projection-v1.ts`.
Composition selects the
protocol decoder; the read route checks its coordinates and resolves a current
display name. The approver port derives identity only from an already
permission-filtered envelope. Unknown or unsupported references have no
optional approver metadata. Derived metadata never changes canonical records.

Fresh logs use the byte-pinned V6 baseline,
`baselines/organization-record-log-baseline-v6.sql`, applied only to an empty
database. It keeps immutable project-audience and project-association facts,
which hold project IDs, never resolved reader identities. V5 dropped V4's
meeting transcript grant: no record shares a transcript (ADR-0046), and the
appender refuses one that claims to. V6 lets a record its approver alone reads
be filed in projects, binding those association rows to its approval
(ADR-0049).
Person reads and search generation use the canonical log and permission facts.
The V2 state-lineage root has six roles: Authority, control plane, record log,
and the facts, lexical, and content retrieval planes. Current runtime rejects
unsupported or mixed state before writable opening; there is no startup
migration.

The log remains truth and retrieval generations remain disposable. See the
[append/derive design](../../docs/product/2026-08-07-org-decision-record-append-derive-design.md)
for the historical rationale.
