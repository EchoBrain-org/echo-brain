# Authority core capacity hill climb

Optimize the shared runtime's latency and efficiency as active employees **N**
and retained history grow. The
[core metric contract](../../docs/product/2026-09-05-authority-core-capacity-metrics-v2.md)
defines the boundary and gates.

No provider clients, HTTP fixtures, simulated network waits, extraction-quality
scores or nondeterministic model behavior run inside this benchmark. Canonical
input ports and deterministic processor/generation results replace external
systems. The real scheduler, current-Person checks, approval authorization,
record writes, publication, retrieval, release audits and replay stay inside.

The retained code has four jobs:

| File | Purpose |
| --- | --- |
| `metrics.v2.json`, `verify-contract.mjs` | Pin the core-only contract and verify its formulas. |
| `corpus-v1.mjs` | Generate provider-free history templates and logical postings. |
| `oracle-v1.mjs` | Independently check ranking, observed heads, content, policy ownership and the complete index. |
| `grading.mjs` | Score every offered operation for diagnostics; failed work is infinite latency. It cannot award a milestone. |

```sh
npm run test:capacity
npm run check
```

These commands verify the retained components. **They do not run a capacity
benchmark.** Synthetic template identities still need binding to real canonical
records, and the core driver, independent runtime observations and fault
executor are not implemented. Missing work is explicit rather than represented
by dry-run infrastructure or a runner that cannot execute the target.

`grading.mjs` is diagnostic arithmetic only. Its measurement result is never a
qualification or milestone result: the actual run-integrity verifier and
milestone protocol remain unimplemented.

Production Authority code matches the pre-hill-climb baseline. No optimization,
M1 pass or usable N/history limit has been established. The earlier provider
profile and abandoned integration harness were removed; their history remains
in Git. The core profile requires its own baseline before claiming any gain.
