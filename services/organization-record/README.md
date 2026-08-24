# Organization record

This library owns the clean V1 append-only organization record. The retained
surface is `new-lineage-v1`, the V4 append implementation, the permission-aware
Person reader, and the clean V4 Layer 1 snapshot implementation.

The V4 canonical envelope bytes and their authorization and provider-action
proof digests are immutable contracts. Reads resolve current permissions for
multi-person organizations and preserve both member-readable and
restricted-reviewer policy behavior.

Fresh log and derived stores are created only from the two byte-pinned SQL
baselines. Historical migrations, broad append and maintenance barrels,
reviewer compatibility APIs, and derived compatibility paths are not shipped.

The log remains truth and derived state remains disposable. See the
[append/derive design](../../docs/product/2026-08-07-org-decision-record-append-derive-design.md)
for the typed historical rationale.
