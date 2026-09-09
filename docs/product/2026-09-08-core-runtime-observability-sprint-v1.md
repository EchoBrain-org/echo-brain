# Core runtime observability: implementation and acceptance

Status: implemented in PR #152; live acceptance pending. Base: `b760a2d`.
This addresses rehearsal areas 07-09, not GitHub issue numbers. The original
implementation handoff is retained in commit `03223ae`.

## Why this change exists

The four-meeting staging run completed, but telemetry could not explain its
latency. The last approval waited 31.534 seconds for the worker gate, then
spent 61.212 seconds preparing search. Initial card delivery took 353.841
seconds across eight extraction attempts. A skipped stage looked like a retry,
and the recovery email could not identify its originating host.

The [historical measurements](2026-09-08-core-runtime-observability-baseline.json)
retain the timestamps, journeys, token totals, source release and limitations.
Four meetings do not establish capacity or a scaling curve.

## Implementation

Extend the existing journey events, disposable sidecar, content transport,
CloudWatch metrics and Explorer. There is no second telemetry backend.

| Concern | Result |
| --- | --- |
| Missing time and work | Correlated worker gate/timer/execution, model/validation, Slack, search preparation/publication and HTTP/Ask spans; resource and work counters. |
| Misleading retries | V2 accounting separates execution, retry, skip, competing action, recovery and historical uncertainty. Shared builds are linked once. |
| Development evidence | The existing content switch covers meeting input, actual model requests/responses, validation evidence and Ask context/answers, with redaction, chunks and completeness. |
| Monitoring attribution | Existing alert actions remain active. Host-attributed comparison metrics and silent comparison alarms expose the source-to-topic mapping. |

The [observability runbook](../operations/RB-OPERATIONS-001-authority-observability.md)
is the reference for fields, switches, Explorer operations, accounting and
limits. Runtime scheduling, retry intervals, prompts/ranking, authorization,
canonical storage, exact-head checks and audit-before-release are unchanged.
Observer failures cannot control business outcomes. Production content defaults,
retention, access scope and subscriptions are unchanged.

Merge-readiness validation exposed unbatched writes in the existing disposable
search builder. Statements are now prepared once per segment and each plane's
rows commit together. Full SQLite synchronization, root validation, cleanup and
publish ordering remain intact. The full 1,000-atom/16-segment/15,974-posting
permission fixture is retained; the PR records its local before/after timing.

## Offline evidence

Focused regressions reproduce missing search phases and a skip consuming the
first execution attempt. Additional proofs cover V1 migration, interrupted
work, competing clicks, independent queued traces, shared builds, model failure,
content bounds, credential exclusion and observer/transport failure isolation.
The PR records validation results at its current head.

The reusable experiment is
`node tools/evals/authority-core/observation-cost.mjs` after the workspace build.
[Original samples](2026-09-08-core-runtime-observability-overhead.json) retain
8 alternating batches per mode, 10 real empty-corpus builds per batch and
88,000 bytes of identical synthetic content. Median batch times were 140.982 ms
off, 143.764 ms metadata and 165.079 ms content. Endpoint memory, event counts
and output bytes are recorded; GC, warm caches and concurrent work affect timing.
This measures local instrumentation cost, not provider latency or capacity.

## Remaining acceptance

Use the [Authority operator playbook](../operations/PB-OPERATIONS-001-authority-operator-lane.md)
for the exact candidate's four-meeting rehearsal. Verify linked traces, content
completeness, increasing history/concurrency, Slack and Ask outcomes, and the
actual host/log group -> metric -> alarm -> ALARM/OK topic -> subscription chain.
No deployment or live acceptance is claimed by the offline tests.

SQLite lock time, disk latency and client-observed duration remain unavailable.
Rejected extraction HTTP bodies are explicitly uncaptured. Process counters
can overlap operations; local delivery success does not prove CloudWatch
receipt. Missing tails and bounded content remain visibly incomplete.
