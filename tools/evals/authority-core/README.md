# Authority core capacity hill climb

Optimize the shared runtime's latency and efficiency as active employees **N**
and retained history grow. The
[core metric contract](../../../docs/product/2026-09-06-authority-core-capacity-metrics-v3.md)
defines the boundary and gates.

V3 replaces the frozen, baseline-not-run V2 profile because V2 assigned its
70/30 policy split per atom, while the canonical approval boundary assigns one
policy to all facts in an approved meeting. V3 rounds the shared-policy count
at the whole-meeting level and retains V2's definition/profile digests as
historical evidence. No baseline or capacity result carries from V2 to V3.

No provider clients, HTTP fixtures, simulated network waits, extraction-quality
scores or nondeterministic model behavior run inside this benchmark. Canonical
input ports and deterministic processor/generation results replace external
systems. The real scheduler, current-Person checks, approval authorization,
record writes, publication, retrieval, release audits and replay stay inside.

The metric components are:

| File | Purpose |
| --- | --- |
| `metrics.v3.json`, `verify-contract.mjs` | Pin the core-only contract and verify its formulas. |
| `corpus-v1.mjs` | Generate provider-free history templates and logical postings. |
| `oracle-v1.mjs` | Independently check ranking, observed heads, content, policy ownership and the complete index. |
| `grading.mjs` | Score every offered operation for diagnostics; failed work is infinite latency. It cannot award a milestone. |

```sh
npm run test:capacity
npm run check
```

These commands verify the components. **They do not run a capacity benchmark.**
CI runs the component tests and the single-meeting checkpoint after the repository
checks.

`grading.mjs` is diagnostic arithmetic only. Its measurement result is never a
qualification or milestone result: the actual run-integrity verifier and
milestone protocol remain unimplemented.

Production Authority code matches the pre-hill-climb baseline. No optimization,
M1 pass or usable N/history limit has been established. The earlier provider
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
