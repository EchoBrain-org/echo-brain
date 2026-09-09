# Authority core evals

Optimize the shared runtime's latency and efficiency as active employees **N**
and retained history grow. The
[core metric contract](../../../docs/product/2026-09-09-authority-core-capacity-metrics-v4.md)
defines the boundary and gates.

V4 replaces the frozen, baseline-not-run V3 profile because the ranking rule
changed: [ADR-0011](../../../docs/decisions/ADR-0011-bm25-lexical-scoring-v1.md)
moves Layer 2 from a term-frequency sum to fixed-point BM25 over the reader's
authorized atoms, and the oracle pins that contract by name and analyzer
digest. V3 had replaced V2 because V2 assigned its 70/30 policy split per
atom, while the canonical approval boundary assigns one policy to all facts in
an approved meeting. Each profile retains its predecessor's definition and
profile digests as historical evidence. No baseline or capacity result carries
forward across any of them.

No provider clients, HTTP fixtures, simulated network waits, extraction-quality
scores or nondeterministic model behavior run inside this benchmark. Canonical
input ports and deterministic processor/generation results replace external
systems. The real scheduler, current-Person checks, approval authorization,
record writes, publication, retrieval, release audits and replay stay inside.

The metric components are:

| File | Purpose |
| --- | --- |
| `metrics.v4.json`, `verify-contract.mjs` | Pin the core-only contract and verify its formulas; `metrics.v2.json` and `metrics.v3.json` are frozen predecessors. |
| `corpus-v1.mjs` | Generate provider-free history templates and logical postings. |
| `oracle-v1.mjs` | Independently check ranking (BM25 fixed-point, ADR-0011), observed heads, content, policy ownership and the complete index. |
| `grading.mjs` | Score every offered operation for diagnostics; failed work is infinite latency. It cannot award a milestone. |
| `retrieval-quality.mjs` | Measure target recall and rank through the real search engine, using the existing corpus generator. |
| `search-generation-fixture.mjs` | Build, warm and clean up one real generation for the ranking benchmark and oracle agreement test. |

```sh
npm run test:capacity
npm run check
```

These commands verify the components. **They do not run a capacity benchmark.**
CI runs the component tests (including ranking quality and 180 oracle/engine
comparisons) and the single-meeting checkpoint after the repository checks.

For a repeatable ranking diagnostic:

```sh
npm run eval:retrieval-quality -- --out /tmp/echo-retrieval-quality.json
```

Defaults: 650 atoms, 300 member-readable target facts, seed
`retrieval-quality-v1`. Each target supplies two rare text terms; the three
query classes add zero, three or five frequent terms. Each reports Recall@10,
MRR@10 and top-1. Targets are selected before scoring, so this measures target
retrieval independently of the formula oracle. `test:capacity` requires every
target to remain first for this default fixture. The runner uses the shipped engine;
there is no alternate scorer implementation. Override `--atoms`, `--queries`
or `--seed` for exploration.

The report includes corpus/query/code hashes, seed, runtime versions and local
build/warm/search timings. Timings are diagnostics, not capacity qualification
or a speedup claim. This artificial-vocabulary test cannot establish natural
language answer quality; [the four-meeting evaluator](../../../demo/README.md)
remains the acceptance path for captured answers, citations and visibility.

The frozen V4 definition names the test's original location under
`tools/evals/retrieval-quality/test/`; it now lives at
`test/oracle-engine-agreement.test.mjs`. The V4 rules and pins are unchanged.

`grading.mjs` is diagnostic arithmetic only. Its measurement result is never a
qualification or milestone result: the actual run-integrity verifier and
milestone protocol remain unimplemented.

No core latency improvement, M1 pass or usable N/history limit has been
established. The earlier provider
profile and abandoned integration harness were removed; their history remains
in Git. The core profile requires its own baseline before claiming any gain.

Stage 1 runs a single synthetic meeting through the real core in a child process:

```sh
npm run capacity:checkpoint
```

The command runs two fresh, separate organizations, one for each visibility
policy. Each receives one meeting with five canonical facts. It checks a complete
durable candidate and delivered presentation, absence of unapproved search
results, durable denial of an unassigned employee's approval, the owner's real
approval, one signed canonical record, actual generation publication, grounded
answers, shared/private reader isolation and same-process duplicate approval
idempotence.
After the child stops, the driver opens the real databases read-only and checks
the frozen input, record, policy facts, active head and each reader's matching
answer release audit. Identical answer text from two readers requires two
separately bound audit entries.

`core-candidate.mjs` composes the existing worker lifecycle, processing cycle,
approval finalizer, record appender and search reconciler. `core-input.mjs`,
`core-approval.mjs`, `core-identity.mjs` and `core-read-routes.mjs` provide the
canonical ports and application setup. Person sessions are real; only the
external verified identity is deterministic. The existing approval storage
format contains Slack-specific fields. The fixture supplies verified-action
inputs at the boundary after transport verification, and deterministic delivery
results; no Slack client, HTTP payload simulator or signature handler runs.
The canonical approval port requests the lifecycle's late-bound, coalesced
publication wake after its durable queue succeeds; the IPC driver does not
request publication itself. Until that binding exists, periodic processing is
the fallback, matching production composition.
Current membership, assignment, connection/link, candidate and policy checks
remain in the production finalizer. No authorization witness is injected.
This directly composes the shared production components; it does not start the
deployed API/provider composition. A change to that composition must also be
checked against this harness before making performance claims.

The worker's default 30-second poll interval and database synchronization modes
are unchanged. Input timing includes the wait for the next poll; there is no
manual intake wake or accelerated clock. Returned timings are parent-observed
single-operation diagnostics on the local machine, with IPC and inspection
overhead. They are **not p95s, capacity limits or milestone passes**. A checkpoint
PASS means these functional assertions passed; it does not mean latency gates
passed. The report always has `qualification: false` and
`milestone_verdict: "not-run"`.

The command prints the private report path and removes its temporary state,
including generated signing/session material. Failure is recorded as FAIL.
Graceful close and duplicate-receipt replay do not prove crash or power-loss
durability. Stage 2 (independent live observations and workload/corpus binding)
and stage 3 (crash/replay and storage faults) are not implemented. No full M1
workload has run.
