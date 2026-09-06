# Authority core capacity metrics V3

No capacity milestone has passed. The executable coordinates are
[metrics.v3.json](../../tools/evals/authority-core/metrics.v3.json).
`node tools/evals/authority-core/verify-contract.mjs` checks its definition and
predecessor bytes, profile pins, and numeric invariants. That check is not a run
and never passes a milestone.

## Normative V2 incorporation

Except for the enumerated V3 amendments below, this profile incorporates the
entire immutable [V2 definition](2026-09-05-authority-core-capacity-metrics-v2.md)
and its executable [V2 contract](../../tools/evals/authority-core/metrics.v2.json)
by reference. That includes every workload and gate, anti-shortcut rule,
independent-evidence and run-integrity requirement, durability condition,
hardware coordinate, and NOT-RUN limitation. V3 does not relax, replace, or
omit any of them.

V3 verifies the raw V2 definition digest
`07dab5141e4e4d3f609ec18a4c3f4bea0284ee9b591e5cb590a8350fd8c81db5`, the
raw V2 contract digest
`61ff8a837248037ee66dfc030a95cbbb1eb9f4f7bba51efe676f6fb492f2473e`, and the
V2 profile digest
`c4f8e08d201c284f7fd3f6a2ae69a433f404b10a8ac6f08abf6e3f2789fdb7ca`.
V2 remains historical and immutable. Its baseline was NOT-RUN, so V3 carries
no baseline, capacity result, or performance comparison forward.

## V3 amendments only

1. V3 assigns the shared/restricted policy at the approved-meeting boundary.
   All five facts from one source meeting have one policy, owner, reviewer
   binding, age bucket, and source age. V2 assigned the policy split per atom,
   a shape the canonical approval boundary cannot produce.

2. The shared-policy count is
   `floor(0.7 * approved_meeting_count)`; every remaining approved meeting is
   restricted-reviewer. M1 has 49 shared and 21 restricted meetings; M2 has
   3,062 and 1,313; M3 has 30,625 and 13,125. M2 is the only non-integral
   70/30 split and uses this stated floor rule.

3. V3 changes profile version and executable paths from V2 to V3. Its profile
   pin requires a V4 profile and new baseline for any later rule or definition
   change. V3 remains frozen, baseline NOT-RUN, full runner not implemented,
   and makes no capacity claim.
