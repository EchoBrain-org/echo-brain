## Issue

Closes #47

## Outcome

Bound clean-V1 search work per authorized request so an admitted generation
cannot monopolize the Authority event loop, without changing permissions,
freshness fencing, released atoms, or compact read audit semantics.

## Root cause

`searchCleanReadableSearchGenerationV1` synchronously reopens and fully hashes
every admitted segment on each query, scans postings and facts, and sorts all
matching candidates. Query terms and returned results are bounded, but corpus,
segment, text-byte, posting, and candidate work are not.

## Lean V1 implementation constraints

- Define named, documented static limits for the generation dimensions that
  dominate synchronous work: total atoms, policy segments, per-atom text bytes,
  and total postings. Derive the smallest defensible values from representative
  tests/measurement and leave clear room for the first cohort.
- Enforce limits deterministically at generation build/admission before
  publication. An over-budget generation must never become the active exact-head
  generation; Layer 3 should retain its existing bounded unavailable behavior.
- Keep current immutable full validation per request for this sprint unless a
  cache can be proven with a materially smaller change. Do not add a broad cache,
  timer-based cancellation, worker pool, or compatibility layer merely to close
  this issue.
- Use bounded top-ten selection instead of sorting all candidates only if it can
  preserve the exact existing score and tie-break order with straightforward
  proof.
- Preserve member/restricted segmentation, exact-head fencing, final
  reauthentication, released atom identity, and audit-before-release.

Likely code and tests:

- `services/organization-retrieval/src/new-lineage-v1.ts`
- `services/organization-retrieval/test/clean-generation-build.test.ts`
- `services/organization-authority/test/clean-person-record-search-route.test.ts`

## Required proof

Write focused tests red first, covering:

1. a maximum allowed member plus restricted-reviewer corpus returns correct
   authorized results, at most ten, with isolation unchanged;
2. each over-limit dimension is rejected before publication;
3. ordinary members cannot expand work through inaccessible reviewer segments;
4. concurrent append/publication and exact-head mismatch remain safe; and
5. workload bounds use deterministic row/posting counts. Record timing and event
   loop observations as evidence, not as a flaky wall-clock assertion.

Run focused retrieval and Authority search tests, then `npm run check`.
Self-review the final diff for correctness and scope. Update this pull request
with the selected limits, rationale, and exact proof. Delete this temporary task
file before the final commit. Do not deploy, call AWS/SSM, access production,
merge the PR, or close the issue directly.
