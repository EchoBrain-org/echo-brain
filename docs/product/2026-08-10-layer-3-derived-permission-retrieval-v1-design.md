# Split record: reviewer permission V1 and trusted searchable Layer 2

**Status:** superseded combined design. This file is a non-normative index and
review-provenance record. Do not implement from it.

The former combined design has been split at the architectural boundary
identified during founder review:

1. **Job A - permission awareness for the minimum reviewer feature:**
   [A: Reviewer permission minimum V1 with append-atomic log facts](2026-08-11-reviewer-permission-v1-log-facts-design.md)
2. **Job B - trustworthiness for a mutable permission-aware search corpus:**
   [B: Trusted permission-aware searchable Layer 2](2026-08-11-trusted-permission-aware-searchable-layer-2-design.md)

## Why the split exists

The original design put a per-record reviewer index into
`record-derived.sqlite` and therefore also required manifests, projection
roots, enriched cursors, readiness, rebuild admission, restore reconciliation,
and a full cross-database consistency fence.

That combined two different jobs:

- **A:** add the missing exact policy/membership key, a text-free index, narrow
  facts/content ports, current-Person resolution, and audited release; and
- **B:** make a separate mutable/rebuildable corpus trustworthy enough for
  search, ranking, embeddings, graphs, and later model access.

The reviewer-V1 fact is wholly derivable from one immutable record. It needs
no cross-record computation. A therefore uses a policy-specific append-side
index committed atomically with the Layer 1 record and re-proves every selected
item from the canonical envelope. B begins later, only when an approved
operation needs Layer 2's unique cross-record/search capability.

This is a sequencing choice, not a fork in permission semantics. Exact policy,
record/item identity, reviewer principal, and reviewer membership remain the
stable bridge from A to a future B rebuild.

## Normative allocation

| Concern | Owner |
| --- | --- |
| Human-visible approval consequence and frozen release draft | A |
| Envelope-v2 policy and exact reviewer principal/membership | A |
| Append-atomic immutable reviewer facts and current self-read | A |
| Current Person state, final authorization, audit, and response bytes | Layer 3 in A; remains Layer 3 when B exists |
| Rebuildable text-free permission facts and protected content planes | B |
| Projection manifests, roots, cursor/build/readiness, rebuild, and publication | B |
| Lexical/vector/graph candidate-first filtering and scoped statistics | B |
| Grants, attendance identity, discovery, and models | Neither; separate future designs |

A does not pretend its log-side index is Layer 2. B does not become an
authorization authority and cannot reinterpret A's approval proof.

## Review provenance

The combined predecessor completed the requested sequential process:

1. initial Claude Fable + Codex design;
2. Fable-coordinated Opus 5 industry-atlas review;
3. Fable + Codex current-code grounding;
4. landed and proposed invariant review;
5. reconciliation and verdict; and
6. minimum-V1 lean-down with focused Fable/Codex verification.

Its final verified content SHA-256 was
[`064ac93553bccde09f2f9af07b21b94a4dcb7e1dd94c7cdf2a0ab6d9a14186f1`](2026-08-10-layer-3-derived-permission-retrieval-v1-design.superseded.md).
That review remains evidence for the approval proof, exact-membership rule,
facts-before-text boundary, failure algebra, and final audit-before-bytes
contract.

The founder's later A/B split changes index placement, serving dependencies,
and build sequence. Consequently, neither new document inherited the old
CLEAN verdict. A subsequently completed fresh code-grounding, storage/port,
wire-contract, scope, and invariant reviews and is now an
[approved implementation contract](2026-08-11-reviewer-permission-v1-log-facts-design.md).
B still needs a fresh review when a concrete search or cross-record operation
reaches its entry gate.

## Authorization boundary

This non-normative split index authorizes no action by itself. A independently
authorizes only its specified implementation. Neither this index nor A
authorizes merge, deployment, migration, cutover, founder-live testing, or
release. B remains a proposal and authorizes no implementation.
