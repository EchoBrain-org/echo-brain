---
schema_version: 1
id: ADR-0011
kind: decision
title: BM25 lexical scoring V1
component_ids:
  - CMP-ORGANIZATION-AUTHORITY
  - CMP-PERMISSIONS
created_at: 2026-09-09
reviewed_at: 2026-09-09
reviewed_ref: 9f186bc2d045d4dfe4737959bed19058fa56a2e3
status: proposed
supersedes: []
superseded_by: []
updates:
  - ADR-0007
---

# ADR-0011: BM25 lexical scoring V1

## Context and options

Layer 2 ranks atoms by the plain sum of query-term frequencies. Every word
counts the same, so a function word that occurs in most atoms weighs as much
as the one term that identifies the fact, and an atom that repeats a word
three times scores three times a single mention. Nothing observes this in the
demo corpus, where a handful of atoms all fit in one answer context. It is
measurable as soon as the corpus is larger than the top ten.

Measured on 2026-09-09 (`tools/evals/retrieval-quality`, container, same
tokenizer for both scorers):

| View | Term-frequency sum | BM25 |
| --- | --- | --- |
| BEIR SciFact, 300 human-labeled queries, nDCG@10 | 0.096 | 0.662 |
| Same, Recall@10 | 0.182 | 0.791 |
| Real engine, 650 synthetic atoms, two content terms, Recall@10 | 1.00 | 1.00 |
| Same query plus three function words present in ~90% of atoms | 0.55 | 1.00 |
| Same query plus five function words | 0.25 | 1.00 |

Published BM25 on SciFact is about 0.665 nDCG@10, so the tokenizer and the
reference formula are sane.

ADR-0007 requires a decision before Layer 2 retrieval behavior changes and
asks for evidence from real question evaluations before adding a refinement
round. This decision is narrower than a refinement round: it replaces the
scoring formula inside the existing single deterministic retrieval, with no
new model call, no new read authority and no change to what is released.

Options considered:

1. Keep term-frequency sum. Rejected: it is below the lexical floor every
   comparable system starts from, and the capacity hill climb would freeze it
   into a baseline that later has to be discarded.
2. BM25 with corpus statistics over the whole generation. Rejected: a member's
   scores would depend on how often a term occurs in private segments the
   member cannot read.
3. BM25 with corpus statistics over the union of the segments the reader is
   admitted to. Chosen.
4. Embeddings, hybrid retrieval or a reranker. Out of scope: each adds a model
   or a network call to the Layer 3 read path that ADR-0007 keeps model-free.

## Decision and consequences

Layer 2 scores each admitted atom with Okapi BM25, contract id
`echo-bm25-fixed-point-v1`:

- `k1 = 1.2`, `b = 0.75`.
- `idf(term) = ln(1 + (N - df + 0.5) / (df + 0.5))`, where `N` and `df` are
  counted over exactly the segments the authenticated reader is admitted to:
  the organization-member segment plus the reader's own exact reviewer segment.
  No statistic from any other segment participates.
- Document length is the sum of term frequencies including the controlled
  category posting; the average length is taken over the same admitted union.
- Scores are fixed-point integers: each term's IDF is rounded to units of
  `1e-6` before multiplying by the length-normalized term frequency, each
  product is rounded, and the integer contributions are summed. The tie-break
  order is unchanged: score descending, log position descending, atom order
  ascending, atom ID bytes.
- The closed decision family (`decision`, `decisions`, `decide`, `decided`,
  `deciding`) is a controlled category, not vocabulary. Its members score with
  a constant unit weight (`1.0` at the fixed-point scale) instead of IDF, so
  the item-kind boost does not vanish once every decision atom carries the
  category term. Query expansion over the family is unchanged.

Consequences:

- Per-segment statistics (document count, total length, document frequency,
  per-atom length) are derived once from the validated immutable postings when
  a generation is activated. No lexical schema or baseline changes. Query cost
  stays one scan of the admitted postings.
- The analyzer release descriptor moves to V4 and records the scoring
  contract. Every existing generation therefore fails its contract check and
  is rebuilt by the normal disposable-generation path; nothing is migrated.
- The independent capacity oracle reimplements the same contract without
  importing the candidate, and a test asserts that oracle and engine return
  identical ordered top tens for held-out queries under member-only and
  reviewer scopes. The capacity metrics profile that pins the analyzer moves
  to V4 with the new analyzer digest; no baseline had been run on V3.
- The evidence rule in ADR-0007 continues to govern anything beyond this
  baseline: query-time iteration, a second retrieval round, or any scorer
  that is not a documented lexical standard still needs question-evaluation
  evidence first.

## Migration, rollback, and evidence

Rollout needs no state reset. The next reconciliation cycle rebuilds the
active generation under the V4 analyzer contract. Rollback is reverting the
analyzer release to V3, which rebuilds again under the previous scorer.

Evidence: `packages/organization-retrieval/test/analyzer.test.ts` (IDF
ordering, saturation, controlled-term weight, caller-supplied scope);
`packages/organization-retrieval/test/readable-search-generation.test.ts`
(private-segment statistics never move a member's results);
`tools/evals/retrieval-quality/test/oracle-engine-agreement.test.mjs`
(oracle and engine agree on 180 held-out top tens);
`tools/evals/retrieval-quality/README.md` (how the numbers above are produced).
Acceptance is not a capacity result and not a claim about answer quality;
the mechanically enforceable claim is the ranking contract above.
