# Architecture decision records

Architecture decision records preserve why an important, expensive, risky, or
hard-to-reverse choice was made.

## Lifecycle

1. Create an ADR as `proposed` when the alternatives and tradeoffs are ready
   for review.
2. Mark it `accepted` or `rejected` after the decision.
3. Do not rewrite accepted or rejected rationale to match later history. Only
   lifecycle and relationship metadata may be appended after disposition.
4. When direction changes, create a new ADR. The old ADR changes to
   `superseded` and links `superseded_by`; the new ADR links `supersedes`.
5. Use `updates` only when both records remain necessary to understand the
   current decision.

Decision status does not imply implementation or qualification. Record those
separately.

## Index

| ADR | Title | Status |
| --- | --- | --- |
| [ADR-0001](ADR-0001-organization-operated-server-core.md) | Organization-operated server-core processing | accepted |
| [ADR-0002](ADR-0002-external-oidc-person-sessions.md) | External OIDC person sessions | accepted |
| [ADR-0003](ADR-0003-server-core-lean-authority-contracts.md) | Server-core lean Authority contracts | proposed |
| [ADR-0004](ADR-0004-founder-authority-clean-state-reset.md) | Founder Authority clean-state reset | proposed |
| [ADR-0005](ADR-0005-person-content-policy-v2-lineage.md) | Person content-policy v2 lineage | accepted |

Other decisions remain embedded in `docs/product/` design contracts and
architecture pages. Extract them incrementally when the affected boundary
changes; do not perform a mechanical rewrite that loses context.

Use the [ADR template](../_templates/adr.md).
