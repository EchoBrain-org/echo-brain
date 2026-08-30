# Organization retrieval

`readable-search-runtime-v1` is the canonical package entrypoint. The retained
`new-lineage-v1` path is a thin compatibility re-export.

## Clean readable-search lean V1 budget

Lean V1 admits at most 1,024 atoms, 32 permission segments, 4,096 UTF-8
bytes per atom, and 16,384 lexical postings. Admission is checked before a
staging directory is created. The exact budget and the one-entry reader
behavior are inputs to both the Authority retrieval contract and builder
artifact identity.

The process keeps exactly one fully validated active-generation handle. A
reconciler validates every manifest, root, row binding, permission tuple, and
uniqueness constraint before publishing a pointer or reporting an existing
pointer current. Requests never warm it. They fail bounded-unavailable on a
miss and inspect only the member segment plus the caller's exact reviewer
tuple.

The lean V1 acceptance target, defined for the admitted maximum before timing
evidence is considered, is **50 ms** for a real Layer 3 batch of four queries
and **25 ms** event-loop delay on the Cloud development runner. Build and
prewarm happen outside the request path and are recorded separately. Timing is
diagnostic evidence, never a correctness assertion.

Run the representative combined-shape benchmark with:

```sh
npx vitest run --config vitest.config.ts services/organization-authority/test/clean-person-record-search-route.test.ts -t 'releases each policy' --reporter=verbose
```

On 2026-08-26, the 1,000-atom, 16-segment, 15,974-posting fixture measured
4,721.4 ms build, 566.8 ms prewarm, 11.7 ms for the four-query request, and
12.0 ms event-loop delay. The fixture contains member and restricted-reviewer
segments and asserts that a member batch releases only member atoms.
