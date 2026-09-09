# Authority core capacity metrics V4

No capacity milestone has passed. The executable coordinates are
[metrics.v4.json](../../tools/evals/authority-core/metrics.v4.json).
`node tools/evals/authority-core/verify-contract.mjs` checks its definition and
predecessor bytes, profile pins, analyzer pin, and numeric invariants. That
check is not a run and never passes a milestone.

## Normative V3 incorporation

Except for the enumerated V4 amendments below, this profile incorporates the
entire immutable [V3 definition](2026-09-06-authority-core-capacity-metrics-v3.md)
and its executable [V3 contract](../../tools/evals/authority-core/metrics.v3.json)
by reference, and through V3 the entire immutable
[V2 definition](2026-09-05-authority-core-capacity-metrics-v2.md). That
includes every workload and gate, anti-shortcut rule, independent-evidence and
run-integrity requirement, durability condition, hardware coordinate, and
NOT-RUN limitation. V4 does not relax, replace, or omit any of them.

V4 verifies the raw V3 definition digest
`df7cee016b4ed58251db5e6618daa79e3b250e781f128f3d3ea50562e30a382f`, the
raw V3 contract digest recorded in `metrics.v4.json`, and the V3 profile
digest `63377b3809575957218bbecee34ea51f32e3d2f963976bf33ac949d5729857e5`.
V3 remains historical and immutable. Its baseline was NOT-RUN, so V4 carries
no baseline, capacity result, or performance comparison forward.

## V4 amendments only

1. The pinned ranking rule is the scoring contract of
   [ADR-0011](../decisions/ADR-0011-bm25-lexical-scoring-v1.md),
   `echo-bm25-fixed-point-v1`: Okapi BM25 with `k1 = 1.2` and `b = 0.75`,
   `idf = ln(1 + (N - df + 0.5) / (df + 0.5))`, fixed-point integer scores at
   scale `1e6`, corpus statistics over exactly the atoms the reader is
   authorized to read, the closed decision family weighted as a constant unit
   instead of IDF, and the unchanged tie-break (score descending, log position
   descending, atom order ascending, atom ID bytes). V2/V3 pinned the
   term-frequency sum by analyzer digest without naming it; V4 names the
   formula so the independent oracle can be reviewed against the definition
   rather than against candidate source.

2. The analyzer pin moves to the V4 analyzer source digest recorded in
   `tools/evals/authority-core/corpus-v1.mjs`. The oracle reimplements the
   contract without importing the candidate; a test in
   `tools/evals/retrieval-quality/test/` asserts that oracle and engine return
   identical ordered top tens for held-out queries under member-only and
   reviewer scopes.

3. Query classes keep their V2 shapes and candidate-count minimums. Selective
   probes still require the designated atom in the expected ordered top ten;
   under BM25 that top ten is computed by the V4 rule, and the sealed
   generator constructs targets accordingly. Candidate counts are unchanged
   because they are defined before ranking.

4. V4 changes profile version and executable paths from V3 to V4. Its profile
   pin requires a V5 profile and new baseline for any later rule or definition
   change. V4 remains frozen, baseline NOT-RUN, full runner not implemented,
   and makes no capacity claim.
