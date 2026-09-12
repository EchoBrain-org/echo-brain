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

Fresh logs use the standalone byte-pinned V3 baseline. Current Person reads
and search generation use the canonical log and permission facts. The unused
nine-table derived database is retired from fresh initialization and the V2
six-role state-lineage contract. The log's redundant member-readable lookup
index is also removed; its UNIQUE constraint still supplies the same index.

Historical baseline bytes and compatibility fixtures remain for explicit source
validation. The derived initializer and database definition are removed from
runtime source and the public API; only a test fixture can create that old role. Existing V1-root state cannot be opened by the current runtime:
the [offline schema-cleanup converter](../../docs/product/2026-09-12-database-migration-cleanup.md)
accepts only the exact supported predecessor, preserves retained records and
receipts, and refuses nonempty retired evidence. There is no startup migration.

The log remains truth and derived state remains disposable. See the
[append/derive design](../../docs/product/2026-08-07-org-decision-record-append-derive-design.md)
for the typed historical rationale.
