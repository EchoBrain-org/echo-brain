# Organization retrieval

`readable-search-engine-v1` is the canonical and only package entrypoint; the
`new-lineage-v1` compatibility re-export was retired on 2026-09-06.
`application/readable-search-contracts` owns the builder's named read-model
contracts.

## Readable-search capacity budget

The current capacity contract admits at most 1,024 atoms, 32 permission
segments, 4,096 UTF-8 bytes per atom, 17,408 lexical postings, and 4,096
segment-local related-atom pairs. Admission is
checked before a staging directory is created. The exact budget and the
one-entry reader behavior are inputs to both the Authority retrieval contract
and builder artifact identity.

The process keeps exactly one fully validated active-generation handle. A
reconciler validates every manifest, root, row binding, permission tuple, and
uniqueness constraint before publishing a pointer or reporting an existing
pointer current. Requests never warm it. They fail bounded-unavailable on a
miss and inspect only the member segment plus the caller's exact reviewer
tuple.

The acceptance target, defined for the admitted maximum before timing
evidence is considered, is **50 ms** for a real Layer 3 batch of four queries
and **25 ms** event-loop delay on the Cloud development runner. Build and
prewarm happen outside the request path and are recorded separately. Timing is
diagnostic evidence, never a correctness assertion.

Run the representative combined-shape benchmark with:

```sh
npx vitest run --config vitest.config.ts services/organization-authority/test/person-record-search-route.test.ts -t 'releases each policy' --reporter=verbose
```

On 2026-08-26, the 1,000-atom, 16-segment, 15,974-posting fixture measured
4,721.4 ms build, 566.8 ms prewarm, 11.7 ms for the four-query request, and
12.0 ms event-loop delay. The fixture contains member and restricted-reviewer
segments and asserts that a member batch releases only member atoms.
