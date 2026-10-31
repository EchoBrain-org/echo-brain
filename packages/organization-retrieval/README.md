# Organization retrieval

`readable-search-engine-v1` is the canonical and only package entrypoint; the
`new-lineage-v1` compatibility re-export was retired on 2026-09-06.
`application/readable-search-contracts` names the storage planes and the
validation error shared by the analyzer and persistence layers.

## Readable-search capacity budget

The current capacity contract admits at most 8,192 atoms, 128 permission
segments, 4,096 UTF-8 bytes per atom, and 204,800 lexical postings. Admission is
checked before a staging directory is created, and a refused build names the
limit it exceeded (`readableSearchExceededLimitV1`). The exact budget and the
one-entry reader behavior are inputs to both the Authority retrieval contract
and builder artifact identity. A build stages beside `generations/`, in
`record-retrieval/.staging-*`, and renames the finished generation into it, so
a process killed mid-build still passes the state-lineage guard at its next
start; the next build removes the leftover. Once a pointer names a new
generation, the Authority deletes every other one
(`retireReadableSearchGenerationsV1`); each is renamed out of `generations/`
first, so an interrupted deletion also leaves nothing the guard reads.

The process keeps exactly one fully validated active-generation handle. A
reconciler validates every manifest, root, row binding, permission tuple, and
uniqueness constraint before publishing a pointer or reporting an existing
pointer current. Requests never warm it. They fail bounded-unavailable on a
miss and inspect only the member segment, the caller's exact reviewer segment,
and project segments whose audience names one of the caller's current
projects.

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

On 2026-10-31, the engine alone at the admitted maximum (8,192 atoms in 128
segments, 204,800 postings) measured about 2.5 s build, 0.5 s prewarm and
under 7 ms per query for a reader admitted to every segment, on an
Apple-silicon development Mac.
