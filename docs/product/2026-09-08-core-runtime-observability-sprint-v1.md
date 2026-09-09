# Area 1: core runtime observability implementation handoff

**Status:** prepared for a separate implementation session; no implementation or deployment yet.
**Branch:** `feat/core-runtime-observability`.
**Base:** fetched `origin/main` at `b760a2dd5187e63b98db0417f049b110d1d0b296` (PR #151).
**Observed runtime:** `clean-v1-20260908-four-meetings-9f186bc`, source `9f186bc2d045d4dfe4737959bed19058fa56a2e3`, CI run `34272767863`.
**Local worktree:** `.worktrees/core-runtime-observability` under the operator's repository checkout.

## Start here

Implement area 1 on `feat/core-runtime-observability`: complete core-runtime telemetry, correct retry/duplicate-action attribution, and make monitoring attribution diagnosable. These are rehearsal issue IDs **07, 08 and 09**, not GitHub issue numbers. Do not use `Closes #07` or equivalent without identifying an actual GitHub issue.

The user asked for this isolated handoff so the learning session can continue independently. The prior collection-only restriction still applies to the other five areas. This handoff is the task for the separate implementation session; do not interpret older notes saying all implementation is deferred as a reason to request permission again for area 1.

Read [AGENTS.md](../../AGENTS.md), any applicable package AGENTS.md, and the existing source before editing. The [Authority operator playbook](../operations/PB-OPERATIONS-001-authority-operator-lane.md) remains the sole deployment router; this document does not replace it. Follow the Codex Cloud boundary. Implement and test offline, then open a PR using the [repository template](../../.github/pull_request_template.md). Do not merge, deploy, call live AWS/application/provider APIs, retrieve credentials, change the staging organization, or send Slack/email messages. A local operator will validate the resulting candidate separately.

This document and its [sanitized measurement file](2026-09-08-core-runtime-observability-baseline.json) are self-contained. No invitation, login session, private meeting record, AWS access, or `/private/tmp` artifact is needed to begin. The historical source paths discussed below match deployed `9f186bc` at this base.

## Goal and scope

The user requires full telemetry on the core runtime before choosing latency and scalability fixes. For any meeting, approval, search build or Ask request, an operator must be able to explain time spent, work performed, outcomes, retries and remaining unknowns from the existing observability system.

Extend the current structured events, disposable journey sidecar, content capture, CloudWatch metrics and Journey Explorer. Prefer shared observation hooks over repeated instrumentation. Do not create another telemetry backend, general-purpose tracing framework, operator playbook, or parallel event pipeline when the existing path can carry the evidence.

Full diagnostic coverage means every core operation and attempt during a bounded development rehearsal. It does not mean emitting every function call or duplicating large content in every event. Preserve operational telemetry outside diagnostic mode. Expose missing/dropped observations and measure the instrumentation's own overhead.

The user explicitly authorized rich development input/output telemetry, including meeting input, actual model prompts/responses, exact validation errors, and Ask context/answers. The existing Ask-only content switch is insufficient. Extend the versioned content contract and its readers for meeting and search-model evidence. Keep credentials, signing secrets, bearer tokens and invitation/login grants excluded. Use correlated artifacts or explicit chunks if the existing transport cannot carry complete content; never silently truncate or claim complete capture when it was partial. Keep high-cardinality identifiers and content out of metric dimensions and alarm reasons. Existing broader production content/retention defaults are not authorized to change.

Historical content-free staging guidance is narrower than this user's explicit development requirement. Update relevant existing documentation and tests for that scoped evolution; do not invent another approval process or remove existing observability to satisfy an obsolete content allowlist.

Out of scope: parallelizing extraction, moving search outside the worker gate, caching or incremental indexing, changing scheduling/retries, changing answer prompts/retrieval ranking, serving stale search, adding Slack processing UI, installer/account UI changes, or replacing SQLite. Observe those behaviors without changing them. A telemetry-only error-classification improvement may preserve an internal cause while retaining the same external failure behavior.

## Evidence and questions the implementation must answer

The four-meeting rehearsal completed with three Team records and one owner-only record. Owner/employee access checks passed. It was a functional rehearsal, not a capacity qualification.

| Approval | Verify + enqueue | Queue wait | Search preparation | Received to searchable |
|---|---:|---:|---:|---:|
| Revenue | 45 ms | 14 ms | 2.043 s | 2.748 s |
| Data handling | 43 ms | 12 ms | 9.872 s | 10.547 s |
| Implementation | 42 ms | 6.235 s | 33.156 s | 40.200 s |
| Commercial | 41 ms | 31.534 s | 61.212 s | 93.483 s |

- The third/fourth finalizations started 22/21 ms after the previous search completed. The immediate wake works but shares the gate with search. These measured approval waits were not the 30-second periodic timer.
- Search preparation includes AI related-fact projection and local generation work. The current rebuild code reprojects the unchanged Team segment when a new private record advances the head. This run has no separate model-call span to measure that work. Model-only versus local build/storage time is unknown; four samples do not establish a scaling curve.
- Initial delivery took 353.841 seconds: eight extraction attempts took 139.980 seconds, Slack staging took 3.236 seconds, and the remaining 210.625 seconds matched seven 30-second intervals plus overhead. Four failed extraction attempts consumed 74.215 seconds and 13,176 reported tokens. Exact parse/schema/grounding failure detail is missing. Treat the timer attribution as inference until directly instrumented.
- A request during the last build passed authorization and failed retrieval as unavailable. Ask runs as an independent HTTP request, not in the background worker queue. One later employee Ask took 16.247 seconds; there is no percentile or dominant-cost conclusion from that sample.
- The card update attempt precedes its own search preparation. There is no separate successful terminal Slack update timestamp. HTTP 200 acknowledges receipt, not final approval; a successful Slack API response is not the exact moment a person sees a card.

## Issue 07: required coverage

Use monotonic clocks for elapsed time, with UTC timestamps for cross-system correlation. Preserve the distinction between human wait and machine time. Correlate journey, request/action, operation, execution attempt, source revision, record head and search generation using existing opaque or domain-separated identities where sufficient. Shared search work must link the approvals it covers without multiplying its time or token usage.

| Boundary | Required observations |
|---|---|
| Worker scheduling | Enqueue/runnable/start/end, pending depth and oldest age, current operation, gate wait, timer/backoff reason and scheduled versus actual wake, cancellation/recovery. Distinguish queue wait from time executing or awaiting a provider. |
| Source and extraction | Poll/cursor/revision, input size, model attempts, candidate persistence, delivery result, cursor advancement and retry reason. Instrument each actual validation boundary rather than collapsing all failures into unavailable. |
| Every model call | Purpose, provider/model, provider request ID when available, actual request/response evidence, round-trip time, finish reason, input/output sizes, nullable token usage, timeout/cancellation/provider status or throttling, retry/backoff and exact parse/schema/grounding failure. Cover extraction, related-fact projection, Ask planning and answer composition. Missing usage is unknown, not zero. |
| Approval and Slack | Verified receipt, durable enqueue, HTTP acknowledgement, final authorization/terminal decision, approved record commit, terminal update request and `done`/`uncertain`/failed outcome with retries. Separate received, approved, provider-confirmed update and searchable. Do not label a losing repeated click as a failed winning approval. |
| Search preparation | Shared build identity; separate snapshot, enrichment/model calls, local generation/index build, validation/activation and publication spans. Count records/atoms/bytes and visibility groups, changed/unchanged and included/excluded work, actual reuse/recomputation, pending/coalesced/superseded work, captured/current/published head and generation. Do not imply current code caches when it does not. |
| Ask | Server receipt through response, existing planner/auth/retrieval/context/composition/validation/revalidation/audit boundaries, counts and released-evidence references, precise unavailable/insufficient-evidence/invalid-output/provider-failure cause. Include client duration where supported; distinguish it from server time. Preserve the actual stage order. |
| Resource pressure | Correlate process CPU/memory/event-loop delay, active HTTP/model work, SQLite busy/lock time, disk-I/O evidence and provider throttling with operation timelines. Identify unsupported/unavailable resource observations explicitly. Infrastructure-only measurements require later operator verification; do not fake them in local tests. |

Update emitter contracts, version handling, sidecar recovery, transport allowlists, EMF consumers, Explorer queries/display and relevant tests together. Newly emitted detail that the Explorer drops does not satisfy this task. Keep existing historical events readable and visibly distinguish inferred values from newly measured values.

An operator should be able to select one slow journey in the existing Explorer and see its critical path, overlapping work, model calls, validation failures, queue/timer delay and any unaccounted interval. Summing overlapping spans is not elapsed time. Detail can be on demand; a new large dashboard is not inherently required.

## Issue 08: attempts are not automatically retries

A losing repeated action can emit downstream skips before the winning approval's first real append/search execution. Stage reservation then yields `attempt=2` even though search never failed.

This currently affects three layers:

- The terminal coordinator and sidecar reserve attempts for skipped observations.
- `staging-journey-metrics-v1.ts` counts started `attempt > 1` as `StageRetryAttempt`.
- `staging-journey-explorer-handler-v1.cjs` displays `attempt - 1` as retries.

Define and test actual execution, retry, skipped observation and competing action semantics. Fix the producer/aggregate/Explorer interpretation together, preserve history without inventing evidence, and prevent duplicate clicks from changing the winning operation's reported outcome. Include restart/replay and shared search work in the accounting.

## Issue 09: monitoring attribution, not an assumed SNS repair

Received email proves `ALARM -> OK` recovery delivery at `2026-09-08T23:51:02Z` for `echo-authority-observability-v1-authority-alerts`. The earlier empty subscription list concerned the different `echo-authority-staging-observability-v1-authority-alerts` topic. The received alarm monitored `EchoBrain/AuthorityOperations / WorkerFailure`, with no dimensions, Sum over 300 seconds and threshold 3. Email alone does not identify the host/environment. A twice-pasted email is one distinct event, not proof of duplicate delivery.

Offline scope: inspect the existing runtime metrics, templates, queries and runbook; make the source-to-alarm mapping inspectable and test coherent configuration. Determine whether environment/host attribution or shared metric identity needs a compatible template/code correction. Do not blindly change dimensions: emitters, filters, alarms and historical display must agree, and existing alerts must remain effective through any eventual transition.

Live mapping still requires the local operator to verify stack -> host/log group -> metric identity -> alarm -> ALARM/OK topic -> confirmed subscription. Leave this accurately marked pending in the PR. AWS SSO was expired at the last inspection; Cloud implementation must not attempt authentication or access AWS.

An unrelated worktree `restore-observability-email` contains an uncommitted two-file draft that renames the subscription logical ID. It predates the recovery email evidence. Do not copy/cherry-pick/apply that draft or assume duplicate stacks can be removed. No topic/subscription repair or deletion is authorized by this handoff.

## Source map

Paths are relative to the repository. Read only the adjacent modules needed for a change; this is a navigation map, not a requirement to reload the entire repository.

| Concern | Files |
|---|---|
| Event contract and correlation | `services/organization-authority/src/shared/journey-telemetry-v1.ts`; under `services/organization-authority/src/composition/`: `meeting-approval-journey-state-v1.ts`, `meeting-approval-journey-telemetry-v1.ts`, `ask-journey-telemetry-v1.ts` |
| Observability adapters | `services/organization-authority/src/composition/staging/observability/`: `staging-journey-telemetry-transport-v1.ts`, `staging-journey-content-telemetry-v1.ts` (currently Ask-only), `staging-journey-metrics-v1.ts` |
| Worker and source | `services/organization-authority/src/processing/admitted-meeting-processing/`: `serialized-meeting-processing-worker.ts`, `meeting-processing-worker-lifecycle.ts`, `meeting-processing-cycle-v1.ts`, `meeting-approval-journey-telemetry-port-v1.ts`; composition `organization-authority-service-lifecycle.ts`, `organization-authority-runtime.ts` |
| Extraction model | `services/organization-authority/src/processing/adapters/decision-processors/llm/`: `llm-decision-processor.ts` and `openrouter-client.ts` |
| Slack | `services/organization-authority/src/composition/providers/slack/private-approval/`: `private-slack-approval-interaction-handler-v1.ts`, `private-slack-approval-terminal-coordinator-v1.ts`; `services/organization-authority/src/processing/adapters/approval-delivery/slack/private-slack-approval-card-poster-v1.ts`; `services/organization-authority/src/presentation/organization-authority-http-server.ts` |
| Search | Under composition: `readable-search-generation-reconciler.ts`, `readable-search-generation-composition.ts`, `related-atom-projector-v1.ts` |
| Ask | Under composition: `person-answer-route.ts`, `person-record-search-route.ts`; `services/organization-authority/src/answer-composition/retrieval-grounded-answer-composition.ts`; `services/organization-authority/src/adapters/answer-composition/openrouter/openrouter-structured-generation-adapter.ts` |
| Explorer and infrastructure | `deploy/organization-authority/`: `staging-journey-explorer-handler-v1.cjs`, `authority-observability-v1.template.json`, `authority-staging-journey-observability-v1.template.json`, `authority-staging-journey-explorer-v1.template.json` and corresponding guards |

Relevant existing documentation: [original journey contract](2026-09-02-staging-journey-observability-sprint-v1.md), [observability runbook](../operations/RB-OPERATIONS-001-authority-observability.md), and [core evaluation README](../../tools/evals/authority-core/README.md). Read the available AWS observability skill before AWS-specific template/query work and the secret-safety skill before any credential-related task. This is not a request to onboard Application Signals, deploy a collector, or access live services.

## Implementation and verification

Use Node `22.22.1` and npm `10.9.4` from `package.json`. Worktree dependencies are independent; run `npm ci --no-audit --no-fund` if not already installed. Do not symlink another checkout's `node_modules` or share generated build output.

1. Reproduce each missing or misleading observation with focused failing behavioral tests at existing seams. Start with one real search build and one skip-before-execution sequence; then cover the other core paths.
2. Extend observation contracts and real producers with the smallest coherent changes, then wire the existing transport/metrics/Explorer consumers. Keep the canonical business state and runtime scheduling unchanged.
3. Prove failure isolation: throwing observers, sidecar or transport failures, content overflow and dropped observations must not alter authorization, approval, record append, search publication, Ask, startup or shutdown outcomes. Preserve existing single-writer ordering, exact-head/contract checks, visibility isolation, final Person revalidation and audit-before-release.
4. Exercise overlapping approvals, a competing repeated click, an actual failed-and-retried model call, uncertain Slack delivery/recovery, Ask during a stale generation, shared search work and restart/interrupted-stage recovery. Reconcile traces to durable results. Test content and credential exclusion independently of metadata, including failures.
5. Measure observation overhead using the same deterministic workload with observation enabled/disabled. Record wall time, event volume, memory and output sizes; report results instead of inventing an acceptable percentage. Never claim a model/provider latency win from offline fixtures.
6. Update the existing runbook/Explorer usage for reading the new evidence and state remaining live verification explicitly. Open a focused PR after checks pass; leave merging and deployment to the operator session.

Commands (select focused files for the implementation under test):

```sh
npm run build:workspaces
npx vitest run --config vitest.config.ts services/organization-authority/test/observability/journey-telemetry-v1.test.ts services/organization-authority/test/composition/meeting-approval-journey-state-v1.test.ts services/organization-authority/test/composition/meeting-approval-journey-telemetry-v1.test.ts services/organization-authority/test/composition/staging/observability tests/architecture/staging-journey-explorer-handler.test.ts tests/architecture/staging-journey-observability-reconciliation.test.ts
npm run capacity:checkpoint
npm run check
```

Adjacent focused proofs exist under `services/organization-authority/test/`: `organization-authority-service-lifecycle.test.ts`, `readable-search-generation-reconciler.test.ts`, `readable-search-generation-composition.test.ts`, `person-answer-route.test.ts`, `composition/related-atom-projector-v1.test.ts`, `adapters/openrouter-structured-generation-adapter.test.ts`, `processing/adapters/llm-decision-processor.test.ts`, and the corresponding Slack/worker test directories. Template/Explorer tests live under `tests/architecture/authority-observability-stack.test.ts`, `authority-staging-journey-observability-stack.test.ts`, `authority-staging-journey-explorer-stack.test.ts`, and `staging-journey-explorer-handler.test.ts`.

The capacity checkpoint exercises real core authorization, records, publication, retrieval and replay using deterministic external ports. It is **not a load benchmark**: `qualification:false`, no milestone pass. `npm run test:capacity` verifies benchmark components when changed. Do not expand this task into implementing the unfinished capacity qualification system. Increasing-history/concurrency diagnostics may use focused tests without altering the pinned benchmark contract.

Cloud completion means implemented coverage, meaningful offline evidence, required checks passing, and a reviewable PR with remaining local verification identified. Final live acceptance requires the operator's four-meeting candidate rehearsal with complete traces, increasing workload observations, observable Slack/Ask outcomes and actual monitoring attribution. Do not mark that live acceptance complete from unit tests or the old rehearsal.

## Handoff completion record

The preparation session creates only this brief and the sanitized historical measurement file. Source code, deployment state and installed products are unchanged. Subsequent commits should clearly identify implementation and validation results, including any area-1 item that remains pending or only partially addressed.

Preparation baseline: Node `22.22.1` / npm `10.9.4` verified; independent `npm ci --no-audit --no-fund` completed; `npm run build:workspaces` passed; the focused command above passed **83 tests in 8 files** against unchanged application code. Historical extraction counts, durations and token totals reconcile. This baseline does not prove the proposed missing telemetry exists. The full `npm run check` and candidate/live verification remain required for the implementation.
