# Retrieval quality benchmark

Measures the Layer 2/3 lexical ranking function against ground truth that
does not depend on the ranking function. The capacity hill climb in
`../authority-core` cannot do this: its oracle defines the expected top ten
as whatever the pinned analyzer returns, which is right for capacity and
useless for judging one scorer against another.

Two views, both deterministic, neither calling a model:

| Command | What it measures |
| --- | --- |
| `node tools/evals/retrieval-quality/scifact.mjs --data <dir> --scorer real` | Scorer-level nDCG@10 / Recall@10 / Recall@50 / MRR@10 on BEIR SciFact (5,183 abstracts, 300 test queries, human relevance labels). Tokenization, decision-family expansion and tie-break order come from the built analyzer; `--scorer tfsum` and `--scorer bm25` run reference formulas so a baseline checkout can report both. |
| `node tools/evals/retrieval-quality/synthetic-engine.mjs --atoms 650 --queries 300` | Engine-level Recall@10 / MRR@10 / top-1 through a real `buildReadableSearchGenerationV1` + `searchReadableSearchGenerationV1`, plus build, warm and per-search latency. Corpus shape is `corpus-v1` (Zipf vocabulary, 25 postings per atom, 70/30 policy split). Queries are built from a known target atom: `content` uses two of its rarest terms; `question` adds three top-rank words that occur in most atoms; `question5` adds five. Whatever scorer the engine ships is what gets measured. |

SciFact data is not committed. Download `corpus.jsonl`, `queries.jsonl` and
`qrels_test.tsv` in BEIR layout into a directory and pass it as `--data`.
Published BM25 nDCG@10 on SciFact is about 0.665; a reference `--scorer bm25`
run should land near that, which is the check that tokenization is sane.

Numbers are diagnostic evidence for a scoring decision. They are not a
capacity result and pass no milestone. Latencies are only comparable between
runs on the same machine.

```sh
npm run build:workspaces
node --test tools/evals/retrieval-quality/test/*.test.mjs
```
