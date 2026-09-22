# Project context V1 integration evidence

Status: synthetic checkpoint only. Real cross-layer qualification and live
capability evidence are pending. This directory records PC-06 results and
candidate-specific evidence requirements; the existing
[Authority operator playbook](../PB-OPERATIONS-001-authority-operator-lane.md)
remains the sole operator router.

Foundation: `ae0481e635367c561a19f5d42098475839dc8408` (PC-00/PC-01).
Worktree: `.worktrees/project-context-pc06-integration`.
Branch: `feat/project-context-pc06-integration`.

## Synthetic checkpoint

The [harness](../../../services/organization-authority/test/project-context-integration/synthetic.test.ts)
has 18 passing cases. It uses real V7 persistence, frozen codecs and enrichment
eligibility with explicitly simulated authentication, delivery and model
completion. Its [fixture notes](../../../tests/fixtures/project-context-integration/README.md)
define the exact assurance limits. No host, provider or installed product was
used.

| Scenario | Bounded proof |
| --- | --- |
| Two projects; overlapping/disjoint members; join history | Member discovery, permitted feed/search, generic versus scoped reads |
| Private association, team originals, separate audience project | No audience widening, no lead bypass, immutable receipt coordinates |
| Cursor/identifier misuse | Project, requester, operation, query and limit scope rejection |
| Revocation during release | Project, organization and synthetic session changes release no response or audit |
| Exact response/audit failure | Committed digest matches released response; failed audit releases nothing |
| Optional hints | Original read and search before, during, after success and after failure |
| Enrichment revocation | Before/during handoff, remove/rejoin and revoked tenure discard hints; association-only removal does not cancel |
| Timeout, restart, replay | One original/work row after post-commit lost reply and SQLite reopen; changed request conflicts |
| Rejoined organization tenure | No inherited project grant |
| Unsupported clients and exclusions | Strict version/audience codec rejection, frozen list-only availability fixture, no extra tables or meeting/approval rows |

Focused command:

```sh
./node_modules/.bin/vitest run --config vitest.config.ts services/organization-authority/test/project-context-integration
```

## Committed integration gates

Only committed feature heads may be integrated. Rebuild in this worktree, run
the focused harness after each integration, and record the SHA, command and
result here. A foundation-only head is not an implementation checkpoint.

| Lane | Observed committed SHA | Qualification status |
| --- | --- | --- |
| PC-02 | `85002118b6fdfb06458f05323fdec6c5acbf9383` | Application checkpoint available; worker binding pending; not yet integrated |
| PC-03 | `ae0481e635367c561a19f5d42098475839dc8408` | Foundation only; real HTTP/runtime pending |
| PC-04 | `ae0481e635367c561a19f5d42098475839dc8408` | Foundation only; CLI transport pending |
| PC-05 | `e44adf9e599a17732efdf92578027cbccba5d35d` | Prior home snapshot only; CLI-bound project UI pending |

The final gate requires real application/worker + HTTP composition + CLI
transport + native CLI-bound UI, then the complete repository check. Synthetic
green alone cannot satisfy it.
