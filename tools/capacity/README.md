# Authority capacity lab

This directory implements the prerequisites for the pinned
[V1 metric contract](../../docs/product/2026-09-05-authority-capacity-metrics-v1.md).
**No M1 baseline or capacity limit has been measured.** Unit tests, local HTTP
checks, dry plans and environment preflights cannot earn a milestone.

The V1 profile is
`a8d4e85f3d15cf9b35a6968a1849829ea6b167dc25030102005f5e1d0620cbfc`.
The worktree began at source commit
`a1fad694e10ed8a65fd3bf2d9c8191750a3b9dd9` before instrumentation. A future
candidate registration must name the actual built artifact and its final source
and configuration digests. No search admission constant, ranking algorithm,
publication strategy, permission check or SQLite synchronization mode has been
optimized for this work.

Run the local checks from the repository root after installing dependencies:

```sh
npm run build
npm run test:capacity
npm run check
node tools/capacity/infrastructure.mjs validate
node tools/capacity/infrastructure.mjs plan
node tools/capacity/runner.mjs --dry-run --milestone M1
```

Socket tests need permission to bind loopback ports. The production transport
tests create disposable test certificates and trust them through the standard
Node CA mechanism; TLS verification stays enabled. All provider data and
credentials are synthetic. No live model is called and no extraction quality is
scored.

| Component | What its checks establish |
| --- | --- |
| `verify-contract.mjs` | The document and JSON still match the accepted V1 digest and metric formulas. |
| `corpus-v1.mjs`, `oracle-v1.mjs` | Independent synthetic corpus, analyzer, ranking and complete logical posting checks; ordinary searches require observed offer/release heads. |
| `manifest-v1.mjs` | Deterministic M1 workload from verifier sealing material, with dependent approval decisions, hidden peak/kill and prescribed wait samples. Synthetic atom identities still require binding to real approved records. |
| `fixtures.mjs`, `provider-http.mjs` | Production wire envelopes, offer binding, causal tokens, evidence-packet checks, provider-effect accounting and signed Slack interactions over actual HTTP. |
| `oidc-fixture.mjs` | Synthetic HTTPS OIDC discovery, RSA/JWKS and code redemption exercised through the production provider and session application. |
| `registry.mjs` | Fsynced local hash chain with externally signed RFC 3161 timestamp receipts; duplicate candidate registration is rejected in this registry. |
| `runner.mjs`, `environment.mjs` | Registration/sealing order, scheduled-offer accounting and a qualification preflight that rejects unsupported hosts or missing independent attestations. |
| `grading.mjs` | Offered-denominator arithmetic, failed work as infinite latency, dependent approvals and per-population wait diagnostics. Independent proof functions and evidence are mandatory. |
| `infrastructure.mjs` | Offline checks for the isolated lab proposal; it performs no AWS action. |
| `storage-faults.mjs` | Read-only Linux/device preflight, the four required fault boundaries and recovery-evidence validation. The actual fault executor remains to be implemented. |

The committed timestamp fixture is public evidence for a **diagnostic hash**.
It is not a candidate registration. The trusted runner still controls run
execution and collection; a timestamp authenticates a particular commitment,
not the completeness of an unobserved runner's history. Milestone claims must
include every registered attempt for that artifact, including failures.

Before the first measured attempt, finish the real Authority workflow driver:
bootstrap and approve the historical corpus through the normal durable paths,
establish all users through the production identity client, bind synthetic
expectations to independently verified record IDs/heads, and observe complete
cards, publication membership and durable release audits out of band. The
process-boundary and flush-aware storage-fault suites must run against that same
artifact. Mocked evidence and self-reported `verified` flags do not satisfy these
prerequisites.

The reference run then requires the pinned c7i.xlarge Linux x64 environment, a
separate driver/fixture host, the exact reviewed environment lock, enforced
candidate resource/network/filesystem isolation, and third-party commitment
receipts before offers. See [infrastructure review](infrastructure.md) for the
current proposal and its remaining operator inputs. The local Mac and ARM Docker
engine are diagnostic environments only.

M1 is the first checkpoint: N = 10, history = 30 calendar / 20 working days,
350 approved historical atoms and 8,750 logical postings. It must run before any
capacity optimization. Its being below today's admission ceilings does not
establish a usable capacity result. The prescribed eight hours and crash-affected
denominators apply even if a slow restart causes a near miss; scripted-wait p95
helps attribute that outcome and does not excuse it.
