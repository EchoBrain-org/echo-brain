# Approval scheduling: implementation handoff

Status: implemented offline on the prepared branch; live acceptance pending.
Issue: [#153](https://github.com/EchoBrain-org/echo-brain/issues/153), rehearsal finding **02**.
Branch: `fix/approval-search-scheduling`. Worktree: `.worktrees/approval-search-scheduling`.
Base: `db5153e09c94c3132fbc8c856df9748af1107d9f`, including merged PR #152.

## Start here

Implement #153 in this worktree while BM25 proceeds separately. The user has
selected implementation handoffs after the collection-only rehearsal; the old
collection restriction does not block this scoped task. Read [AGENTS.md](../../AGENTS.md)
and applicable package instructions. Reproduce, implement, verify, and open a PR
using the [existing template](../../.github/pull_request_template.md). Follow its
Cloud boundary; no live services, secrets, merge, deployment, or Slack messages.
Local candidate acceptance stays with the [operator playbook](../operations/PB-OPERATIONS-001-authority-operator-lane.md).

This handoff and the committed evidence are sufficient. No private Downloads
folder, staging session, invitation, provider access, or temporary file is needed.

## Problem and bounded outcome

The [historical four-meeting evidence](2026-09-08-core-runtime-observability-baseline.json)
shows approval queue waits of 6.235 and 31.534 seconds, followed by finalization
about 21–22 ms after the previous search completed. Verification and enqueue took
41–45 ms. Immediate wakeup already works; search holds the same writer gate.
These measurements predate PR #152's SQLite batching and are not a current speed
baseline. Preserve that optimization and remeasure the unchanged workload.

An unresolved search-enrichment/model call must not stop the next queued approval
from finalizing, appending its approved record, and updating its terminal Slack
card. Approval writes remain serialized. Search remains one bounded operation
at a time and coalesces work toward the latest committed head.

This addresses the cause of finding 02. It does not promise zero card latency,
immediate search readiness, or a throughput target. Source extraction and terminal
Slack calls can still occupy the writer gate. Synchronous SQLite/build work still
occupies the Node event loop. Report these limits instead of hiding them with UI.

## Design constraints

- Keep finalize/append/recovery and existing operator mutations behind the
  existing writer gate. Never detach an append or render a terminal outcome before
  its required durable evidence. Preserve durable enqueue → HTTP acknowledgement
  → deferred publication, competing-click behavior, and retry/recovery ordering.
- Request search after the writer operation completes. One lifecycle-owned task
  should hold at most one active reconciliation plus one coalesced follow-up;
  avoid a task per approval, a second periodic worker, or a general queue framework.
  Defer its start so snapshot/build work does not run inline inside the writer gate.
- The reconciler currently relies on external serialization; its class comment
  is not an internal concurrency guard. Route every post-startup trigger through
  the same search owner. Preserve verified snapshot capture after its read
  transaction closes, immutable validation, exact-head recheck, and atomic pointer
  publication. Keep the head comparison and pointer mutation in a non-yielding
  critical section. Do not introduce concurrent reconcilers or stale reads.
- A head advanced during enrichment makes the old build `superseded`, not current
  or failed. Coalesce an immediate latest-head follow-up after a finite burst.
  Failures must be reported and remain recoverable on normal triggers; never
  spin indefinitely, silently drop a queued wake, or retry failed models in a loop.
- Startup recovery and initial search validation still complete before the API
  binds. On close, reject new requests, cancel pending callbacks and active search,
  await writer/search cleanup, then close database handles and clear the warmed
  handle. Include abort-ignoring delayed adapters in the shutdown reasoning.
- Preserve PR #152's full telemetry and development content capture. Detached
  search owns an independent `observeCoreRuntimeRootV1` with the lifecycle's
  explicit `core_runtime_observation` scope; retain the existing
  `runPhase("search_reconciliation", ...)` reporting. Do not rely on a deferred
  callback inheriting a valid worker trace: composition does not supply the
  reconciler an observer of its own. Coalesced approvals link to actual work. A
  superseded build must leave its waiting journeys eligible for eventual success.
  Do not turn cancelled/superseded work into retries or count shared work twice.
  Phase failures and missing-search signals must remain observable even when the
  periodic writer cycle can succeed independently. Throwing observers remain harmless.
- Preserve the meaning of existing lifecycle consumers. The capacity driver's
  `drain` currently waits only on `runExclusive`; that no longer implies search
  completion once search is detached. Adapt the existing driver/seam narrowly,
  using explicit current-head readiness or a bounded lifecycle drain, not sleeps
  or a second test-only scheduling path. Keep production operator exclusion clear.

Prefer a shared phase seam over copying full cycle functions. No scoring/analyzer
changes, cache/incremental-index framework, optional-enrichment fallback (#110),
extraction concurrency/retry changes, schema migration, or new freshness policy.

## Source map and proofs

Paths below are relative to `services/organization-authority/` unless stated.

| Concern | Starting files |
| --- | --- |
| Gate, approval wake, startup/close | `src/composition/organization-authority-service-lifecycle.ts`; `src/processing/admitted-meeting-processing/serialized-meeting-processing-worker.ts` |
| Search call/result, journey association, database ownership | `src/composition/organization-authority-runtime.ts`; `src/composition/meeting-approval-journey-telemetry-v1.ts` |
| Captured head, supersession, validation/publication | `src/composition/readable-search-generation-reconciler.ts`; read `readable-search-generation-composition.ts` for snapshot/handle ownership |
| Approval durability and terminal rendering | `src/composition/providers/slack/private-approval/private-slack-approval-terminal-coordinator-v1.ts` |
| Existing observations | `src/shared/core-runtime-observation-v1.ts`; `src/processing/admitted-meeting-processing/meeting-processing-worker-lifecycle.ts` |
| Existing capacity lifecycle consumer | repository `tools/evals/authority-core/core-candidate.mjs`, `command("drain")` |

Add focused behavioral tests at these existing seams, with controlled promises
instead of wall-clock sleeps or enlarged timeouts:

1. Hold search enrichment unresolved; submit another approval and prove its real
   finalization/append/terminal-update path completes before releasing enrichment.
   Include durable enqueue and HTTP acknowledgement ordering. This must fail first.
2. Keep approval writes nonoverlapping and search concurrency at one. A finite
   burst during a blocked build leads to one coalesced latest-head follow-up,
   correct records, and no obsolete pointer or cross-policy release.
3. Cover new work arriving at completion/failure boundaries, supersession, actual
   projector failure, and later periodic recovery without a tight retry loop.
4. Prove startup still fails closed and shutdown cancels/awaits detached search
   before closing handles. Verify rejected, duplicate and revoked-member actions.
5. Reconcile independent/coalesced traces to actual durable outcomes; assert
   observer failure isolation and no premature searchable-success event.

Use Node `22.22.1`, npm `10.9.4`, and independent worktree dependencies:

```sh
npm ci --no-audit --no-fund
npm run build:workspaces
npx vitest run --config vitest.config.ts services/organization-authority/test/organization-authority-service-lifecycle.test.ts services/organization-authority/test/readable-search-generation-reconciler.test.ts services/organization-authority/test/processing/admitted-meeting-processing/serialized-meeting-processing-worker.test.ts services/organization-authority/test/composition/providers/slack/private-approval/private-slack-approval-interaction-handler-v1.test.ts services/organization-authority/test/observability/core-runtime-observation-v1.test.ts
npm run test:capacity
npm run capacity:checkpoint
npm run check
```

Extend relevant coordinator/journey/route tests where needed. Measure queue wait,
terminal card outcome, append and search-ready time separately with the same
controlled workload before/after; vary burst size without changing permission
coverage. Reuse existing tests/evals, not a new benchmark suite. The capacity
checkpoint remains `qualification:false`, not a load qualification.

## Parallel work and completion

BM25 owns ranking/analyzer contracts, `packages/organization-retrieval` scoring,
and retrieval-quality evals. Keep this change in lifecycle/scheduling and adjacent
proofs where possible. Do not modify the BM25 worktree. Refresh
`fix/approval-search-scheduling` after BM25 merges and rerun relevant combined
proofs; shared telemetry and batching from
#152 must survive. A small necessary change to the existing capacity drain is in scope.

Remaining rehearsal work is separate: search reuse/availability (03–04, including
#110), extraction reliability/timer waits (06), answer scope/latency (05/11;
#111/#112/#108), and Mac replacement/account clarity (01/10). #97's acknowledgement
is a UI improvement, not a substitute for this scheduling change. PR #152 covers
07–09 in code; its live acceptance and monitoring attribution remain pending.

Completion: focused reproduction/fix, current-head checks and all required CI
green, concise PR linked to #153, measured offline limits, and live rehearsal
explicitly pending. Preparation changes only this document; application code and
deployment state are unchanged.

Preparation baseline: independent dependencies installed; workspace build and
the focused command above passed **51 tests in 5 files** on unchanged application
code. The HTTP acknowledgement test required localhost access outside the sandbox.
This proves the starting suites work, not that the scheduling issue is fixed.
Full checks and the new failing-then-passing behavioral proof belong to implementation.

## Implementation evidence

The lifecycle now runs finalize/append/recovery under the existing writer gate
and requests search after successful writer completion. One deferred search task
owns all post-startup reconciliation, including periodic, approval, supersession,
and operator triggers. It retains one active pass and one pending wake. Failure
does not generate a new wake; an existing wake survives a failure, and normal
periodic cycles can recover later. Supersession immediately schedules the latest
head after a finite burst. Snapshot verification, immutable validation, the
non-yielding exact-head publication boundary, and PR #152 batching remain intact.

Search owns an independent core-runtime root with the explicit lifecycle scope
and retains the `search_reconciliation` phase reporter. The integration proof
links all coalesced journeys to actual search operations, preserves development
content capture, and keeps superseded journeys eligible for publication.
Cancellation closes its attempt without creating a retry on restart, using the
existing telemetry-sidecar observation-kind column; no schema migration is needed.

Operator work still excludes both writers and search. `drain(signal)` waits for
queued publication and search without acquiring operator exclusion or triggering
a retry. The existing capacity candidate and checkpoint use that barrier before
searching. Shutdown stops API ingress (including requests on existing sockets),
cancels queued callbacks, aborts both workers, and awaits cleanup before closing
handles. An adapter that ignores abort delays close until it settles; database
handles are never closed underneath it.

The first regression failed on unchanged scheduling: HTTP-acknowledged later
approvals had durable queue receipts while the record count remained at two.
The final integration proof uses real SQLite finalization, append and retrieval,
real localhost HTTP ingress, and synthetic provider ports. It varies one/four
later Team approvals while always including an Only me approval and a rejection;
an additional case makes the actual projector reject malformed model output.
The second pass publishes the latest head, and member retrieval excludes the
restricted record. Adjacent tests retain duplicate-click, revoked-membership,
authorization-fence, restart, and durable-acknowledgement coverage.

[Offline measurements](2026-09-09-approval-search-scheduling-offline-evidence.json)
compare the identical fixture against `db5153e` and the candidate. Date and
performance use a virtual clock; the first enrichment model is held for 250 ms
after later clicks, with one scheduling tick on either side. These values
describe ordering under a controlled stall, **not wall-clock performance**:

| Later approved journeys, both burst sizes | Before | After |
| --- | ---: | ---: |
| Durable queue receipt to finalization start | 251 virtual ms | 0 virtual ms |
| Durable queue receipt to append completion | 251 virtual ms | 0 virtual ms |
| Durable queue receipt to successful terminal-card update | 251 virtual ms | 0 virtual ms |
| Durable queue receipt to search readiness | 251 virtual ms | 251 virtual ms |

Zero means completion on the first scheduled turn without advancing the virtual
clock. The initial two approvals reach search readiness at 252 virtual ms in
both runs. No zero-latency claim follows from this test. Source extraction and
terminal provider calls can still hold the writer gate; synchronous snapshot,
SQLite, and index building still occupy the Node event loop.

Pre-BM25 validation: the expanded focused command covers 96 tests in nine files;
`npm run test:capacity` passes 27 tests; `npm run capacity:checkpoint` passes both
policy scenarios with `qualification:false`. Its observed acknowledgement/search
times were 3/119 ms for Team and 5/203 ms for Only me while other local checks
were running; these single-meeting observations are not a capacity qualification.
`npm run check` passes 1,710 tests in 156 files, including architecture, docs,
lint, build and type checking. Localhost tests require execution outside the
network sandbox. Live rehearsal and deployment remain pending.

After those checks, BM25 merged in PR #154 at `5d7116e`. This branch incorporates
that main-line change without conflicts. The capacity checkpoint retains its
independent BM25 ranking assertions and the new search drain. Combined focused,
capacity, full-repository and required CI results are recorded on
[PR #155](https://github.com/EchoBrain-org/echo-brain/pull/155).
The virtual-clock measurements above predate BM25 and remain scheduling evidence,
not a new retrieval-quality or capacity baseline.
