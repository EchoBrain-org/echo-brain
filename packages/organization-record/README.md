# Organization record

This library owns the append-only organization record. The retained
`organization-record-api-v1` is the canonical and only package entrypoint; the
`new-lineage-v1` compatibility re-export was retired on 2026-09-06. The API
exposes the V4 record appender, the permission-aware person reader, and the
record retrieval-source snapshot port.

The V4 canonical envelope bytes and their authorization and provider-action
proof digests are immutable contracts. Reads resolve current permissions for
multi-person organizations and preserve both member-readable and
restricted-reviewer policy behavior.

Provider-neutral policy-fact registry contracts remain in `application`. The
Private Slack Block Kit policy projector is an adapter under
`adapters/record-policy-projection/slack`; the public API retains its exports.
Shared derived-fact contracts are separate from the kernel and registry so
adapters do not depend on the kernel. The record-owned approver projection
port returns only a derived identity from an already permission-filtered
envelope. Composition selects the protocol decoder; the read route checks
its coordinates and resolves a current display name. Unknown references, and
generic HumanAct references without an actor, have no optional approver
metadata. No derived metadata is added to canonical records.

Fresh log and derived stores are created only from the two byte-pinned SQL
baselines. Historical migrations, broad append and maintenance barrels,
reviewer compatibility APIs, and derived compatibility paths are not shipped.

The derived database is retained by the seven-role state-lineage contract.
Bootstrap creates its metadata and cursor, but the shipped application has no
materializer or reader for its seven graph/projection tables. Current Person
reads and search generation use the canonical log and permission facts.
Retiring this database therefore requires a versioned lineage transition,
including initializer, verifier, backup and restore changes; its existence is
not a reason to restore the retired graph implementation.

The log remains truth and derived state remains disposable. See the
[append/derive design](../../docs/product/2026-08-07-org-decision-record-append-derive-design.md)
for the typed historical rationale.
