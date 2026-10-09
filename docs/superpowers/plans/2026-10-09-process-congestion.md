# Process congestion fixes

**Status:** In progress on `fix/process-congestion` (base `aeff256`).
**Spec:** GitHub issue #308 (investigation and remediation order) plus the
founder decisions below. Map of the system: the "ECHO Traffic Map" artifact.

## Goal

Stop one failure from blocking unrelated work, then let unrelated work run at
the same time. Order: isolate failures → say what is held → shrink the writer
gate → add lanes → quiet the ground.

## Founder decisions (2026-10-09)

- **V14:** a new Authority table is allowed. It means a V14 baseline and a
  staging data reset (`replace-rehearsal`, then redo initial-owner onboarding),
  following the V13 precedent `f3aeaa5`.
- **Sharing:** a held manual import is consumed when parked. Its "Save to"
  project members can read its notes, the same as folder deliveries and the
  existing stage-failure advance.
- **Retry:** stays operator-only, through the existing `retry-extraction`
  grant. One paid attempt per grant. No owner button, no new route.
- **Discarded result:** include the fix for a paid extraction result being
  thrown away when another import lands during extraction, if it stays small.
  If it grows past about 80 production lines, stop and report.
- **Runs:** impact checks and sweeps stay desktop-driven, per earlier ruling 9.
  There is no server-side runner; this plan adds caps only.

## Global constraints (every task)

- **Lean governance:**
  - Make the smallest change that meets the task.
  - No new HTTP route, CLI verb, or response field. The desktop and CLI
    validate exact response keys, so a new field breaks older clients.
  - Report production and test LOC.
  - Keep test LOC at or below about 1.2× production LOC for the task. Reuse
    existing fixtures and fakes; do not build new test harnesses.
- **Invariants to preserve:**
  - deduplication;
  - review-input identity and the attempt ledger key;
  - membership and access checks;
  - cursor compare-and-swap fences, admission fences, and candidate/approval
    fences;
  - approval-core idempotency (one decision per proposal);
  - no paid model call without a reservation, and no repeat attempt without
    an explicit operator grant;
  - unapproved transcript access stays protected;
  - status and diagnostics carry IDs and allowlisted codes only, never meeting
    titles or text.
- **Validation:**
  - Run focused tests for the files you touch:
    `npx vitest run --config vitest.config.ts <files>`.
  - If you changed anything under `packages/` or `providers/`, run
    `npm run build` first; vitest resolves workspace packages from `dist/`.
  - Do not run `npm run check` or the full suite. The controller runs it once
    at the end.
  - Do not push.
- **Commits:** one or more commits per task, each message ending with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Comments:** fix stale comments you touch, for example the lifecycle
  comment claiming "at most one pending card" per turn, and the claim that
  approvals never wait behind a source poll.

## Task 1: Approval and notes isolation

**Problem:**
- The publisher (`services/organization-authority/src/composition/approval-publisher-v1.ts`,
  `publish()` ~:149-168) isolates rows but rethrows the first row failure
  after the pass.
- It is wired to both `recoverV4Appends` and `appendFinalizedApprovalsToV4`
  (also in `person-meeting-runtime-v1.ts` ~:135-138).
- Recovery is the first phase of every cycle
  (`organization-authority-service-lifecycle.ts` ~:122) and runs before the
  API binds (~:191-197). So one permanently unpublishable approval stops
  intake and enrichment for everyone, and stops startup.
- **Search starvation:**
  - When a cycle fails, `onCycleComplete` is skipped
    (`packages/organization-processing/src/admitted-meeting-processing/serialized-meeting-processing-worker.ts`
    ~:113-120).
  - A failed publication wake skips `search.request()` (lifecycle ~:338-343).
  - With one bad row, no other new approval ever becomes searchable.
- **Poison notes item:**
  - In `person-update-processing-v1.ts` ~:36-38, a throw from `validate()` or
    `captureEligibility()` leaves the item in `processing`.
  - So does `enriched()` throwing "changed during enrichment"
    (`adapters/persistence/sqlite/person-update-enrichment-work-v2.ts` ~:119).
  - `processing` rows are reclaimed immediately (~:67), so the cycle fails
    every 30 s.

**Change:**
1. **Publisher:**
   - `publish(signal, rethrowRows)`.
   - `recoverV4Appends` passes `false`; `appendFinalizedApprovalsToV4` passes
     `true`.
   - Failures of the whole pass (signer inspection, page query, abort, core
     creation) still throw from both.
   - Row failures stay visible as a failed `record_append` span. Rows are
     retried on every pass (`receipt_json IS NULL`).
2. **Person runtime:** point `recoverV4Appends` at the non-rethrowing variant.
3. **Worker:** call `onCycleComplete` after every cycle that was not aborted,
   including failed cycles, still after the gate is released. In the
   lifecycle publication wake, request search and presentation when the run
   settles, unless closing.
4. **Notes item:** catch integrity errors from `validate()` and
   `captureEligibility()`, call `defer(v2, false)`, and report the error. A
   stale `enriched()` must not leave the item stuck in `processing`. The
   smallest fix here is acceptable, since Task 6 adds a lease.

**Startup safety:**
- Recovery still runs first and finishes every recoverable row.
- An unpublished row means one of two things:
  - its append never committed, so it is not readable and correctly shows
    `publishing`;
  - or the record committed without a receipt, so search, which derives only
    from the record log, serves it.
- A whole-pass failure still fails startup. Keep lifecycle tests ~:106 and
  ~:459 passing.

**Tests:**
- **Publisher:** with one poisoned row, recover resolves and the other rows
  publish with receipts. Append still rejects, and the next pass retries the
  row. Update the existing test ~:385.
- **Lifecycle:**
  - A recovery row failure still lets startup bind.
  - A cycle whose `record_append` fails still requests search and
    presentation. Update the event sequence ~:305.
  - A failed publication wake still requests search.
- **Notes item:** an item that fails validation is deferred and the next cycle
  completes.

Estimate: ~30 production, ~120 test.

## Task 2: Authority baseline V14 with the held-extraction table

**Change:**
1. **Pure bump:** follow commit `f3aeaa5` (V12→V13) file by file for V13→V14:
   - rename the baseline SQL and its test;
   - `baseline.ts` constants and sha;
   - `verify-authority-state-lineage.ts`;
   - state bootstrap, Dockerfile, package.json `files`, source-boundary;
   - DAO version asserts and test fixtures;
   - READMEs and operator docs that name the version.
   Use `git show f3aeaa5` as the checklist. Grep for `V13`, `v13` and
   `baseline-v13` afterwards so nothing is missed.
2. **Add table** `authority_live_source_held_extractions_v1`:
   - Primary key `(source_key, review_lineage_id)`, so there is one held item
     per meeting per source.
   - Columns:
     - `source_key`: FK to the live source admission/settings table that
       `source_key` already references; follow existing FKs.
     - `external_id TEXT NOT NULL`.
     - `organization_id`, `source_id`, `revision_id`: FK to
       `authority_source_revisions_v1`, matching how that table is keyed.
     - `extraction_admission_sha256`, `review_input_sha256`: with
       `review_lineage_id`, this is the exact attempt-ledger key.
     - `attempt INTEGER NOT NULL`.
     - `failure_stage TEXT NOT NULL CHECK (failure_stage IN (...))`.
     - `held_at`, `updated_at`.
   - Follow the conventions and CHECK style of nearby tables. The precedent
     for quarantine-and-continue is `authority_person_text_source_failures_v1`.
3. **Failure-stage allowlist:**
   - New pure module
     `packages/organization-processing/src/admitted-meeting-processing/extraction-failure-stage-v1.ts`.
   - It exports the allowlist and `classifyExtractionFailureStageV1(error,
     context)`.
   - Allowed values:
     - the grounding stages from `extractionGroundingFailureStage`;
     - `schema_<stage>` values from `extractionSchemaFailureStage`;
     - `output_json`;
     - `output_contract`;
     - the adapter failure codes (`EXTRACTION_ATTEMPT_FAILURE_CODES_V1`);
     - `cancelled`, `interrupted`, `output_not_saved`, `not_recorded`.
   - Derive the exact grounding and schema stage lists from
     `packages/organization-processing/src/llm/llm-decision-processor.ts`.
   - A test pins the TypeScript allowlist to the SQL CHECK list.

**Tests:**
- The renamed baseline test passes.
- The allowlist pin test.
- The classifier maps a real grounding-failure fixture to its stage, and a
  schema failure to `schema_<stage>`.

Estimate: ~60 mechanical, plus ~25 SQL and ~40 classifier production; ~60 test.

## Task 3: Park a failed meeting and move the cursor past it

Read the cycle `packages/organization-processing/src/admitted-meeting-processing/meeting-processing-cycle-v1.ts`
first, especially ~:509-605 and the class doc ~:355-361.

**Change:**
1. **Ports:**
   - `AuthorityMeetingProcessingStateV1` (~:56-75) gains:
     - `holdExtraction(input)`;
     - `listHeldExtractions()`;
     - `readHeldMeeting(row)`, which rebuilds the meeting from custody the
       way `person-imported-meetings-v1.ts` ~:53-61 does, with digests
       verified.
   - `ExtractionAttemptStoreV1` gains a read-only
     `inspect(key) → {attempt, outcome, failure_code, retry_authorized, reserved_at}`,
     reusing `latest` plus the permission lookup in
     `sqlite-extraction-attempt-store-v1.ts` ~:128-141.
2. **State:** `holdExtraction` in `sqlite-authority-meeting-processing-state-v1.ts`.
   - It is one IMMEDIATE transaction that checks the active admission
     (membership) and source identity, and derives `source_id` and
     `revision_id` with `meetingSourceEnvelopeV1`.
   - It upserts the row, keeping the stored `failure_stage` when the key and
     attempt are unchanged.
   - It does not touch the cursor.
   - `stageCandidate` (~:340-403) deletes the held row for
     `(source_key, review_lineage_id)` inside its existing transaction.
3. **Cycle:** parking applies only when `extraction_attempts` is configured;
   otherwise behavior is unchanged.
   - **Model failure:**
     1. classify the stage;
     2. unless aborted, call `holdExtraction`;
     3. complete the ledger as failed;
     4. then advance with the existing `advanceCursor(expected, batch.next_cursor)`;
     5. return a new result kind `{kind: 'held', stage, cursor_advanced}`
        with no throw.
   - **Blocked path (~:564):** replace the throw with `holdExtraction` plus
     the advance. Take the stage from the ledger snapshot:
     - pending → `interrupted`;
     - failed with `cancelled` → `cancelled`;
     - other failed → `not_recorded`, unless a held row already has a stage;
     - succeeded → `output_not_saved`.
     Task 6 later turns a fresh `pending` into `in_flight`; leave a seam.
   - If `holdExtraction` throws, complete the ledger and rethrow, as today.
   - Aborted runs are not parked.
   - Update the class doc: the cursor also advances after a durably parked
     revision.
4. **Providers:** no provider change. Confirm each `next_cursor` consumes the
   meeting:
   - synthetic `manual.slice(1)`;
   - Granola manual `slice(1)`;
   - Granola folder records `revisions[id]`.
   Advancing a manual import runs `promoteConsumedImports`. That is the
   founder's sharing decision; document it in the class doc.
5. **Runtime:** `person-meeting-runtime-v1.ts` treats a `held` result as
   success for scheduling: no 60 s backoff, and the next eligibility is 0 if
   more is queued.

**Tests:**
- Use the real in-memory `SqliteExtractionAttemptStoreV1` where the runtime
  tests allow.
- Update the cycle tests that expect `extraction_on_hold` and zero advances
  (~:426-575). `FakeState` and `RecordingExtractionAttempts` gain the new
  methods.
- Update the runtime test ~:484-497 ("grants nothing when a cycle fails…").
  It now expects the item consumed and the import promoted.
- **New:**
  - A fails, then healthy B in the same source stages on the next poll, using
    the synthetic queue fixture plus one Granola manual or folder fixture.
    Check the cursor, `pending_imports`, and the held row with its stage.
  - After a restart (new runtime, same DB and ledger), A stays held with no
    model call, and ledger history length is 1.
  - A legacy blocked head with no row is parked as `not_recorded` and
    advanced.
  - A newer revision's candidate deletes the held row.
  - An aborted run is not parked.

Estimate: ~230 production, ~260 test.

## Task 4: Authorized retry from custody, and held status

**Change:**
1. **Cycle:** `retryHeldOnce(signal)`, sharing the `runOnce` single-flight
   guard.
   1. Read the admission.
   2. `listHeldExtractions()`; take the first row where `inspect(key).retry_authorized`.
   3. `readHeldMeeting` from custody.
   4. Recompute the key and require it to equal the stored one.
   5. Run the frozen/reuse checks (~:524-541).
   6. Reserve, which consumes the grant.
   7. Extract.
   8. On failure, `holdExtraction` with the new attempt and stage. On
      success, complete the ledger, `stageCandidate` (which deletes the row),
      and `stager.stage`.
   - It never writes the cursor and never pulls from the provider. Without a
     grant, the reserve returns blocked and no model call happens.
2. **Runtime (`person-meeting-runtime-v1.ts`):**
   - Eligibility (~:144) includes sources with a retry-ready held row: one
     held-row query plus `inspect`.
   - For the selected source, branch before `lane()`. The retry branch builds
     state with the lane's membership and settings guard (~:121-126), not
     `source.requireCurrent()`, because the Granola fence is only set by
     `pull`.
   - It uses `provider.source(...)` only for identity, calls
     `assert_admission_commitments`, and runs before intake for that source.
   - The catch early-return (~:178) also checks held-ready.
3. **Held status:** fill the existing `home.sources[].error` from the durable
   held rows plus `inspect`, joined with any `observed` connection error, at
   most 512 characters.
   - Wording, one sentence per held item, first item only if several: "Meeting
     <external_id> is held after extraction attempt <n> failed at <stage>.
     Later meetings continue. An operator can authorize one more attempt."
   - When a retry is authorized: "…A retry is authorized and runs on the
     next check."
   - The generic "Meeting intake needs attention…" text stays for real
     connection and access errors only.
   - No new response field. `product/echo-desktop/src/renderer/screens/meetings.tsx`
     already renders `s.error`; check the desktop shows it, with no desktop
     code change unless it is hidden.
4. **CLI:** the extraction-attempt CLI `status`
   (`services/organization-authority/src/composition/organization-authority-extraction-attempt-cli.ts`)
   prints `held` and `failure_stage` for each key that has a held row. It
   already reads Authority read-only (~:90).
5. **Canary:** if the canary run fails with "not processed", the message
   names the held stage when its own meeting is held
   (`services/organization-authority/src/composition/staging/staging-synthetic-personal-canary-v1.ts`
   ~:66). Keep it to a few lines.

**Tests:**
- A grant for A's exact key re-runs only A: the provider pull counter is
  unchanged, there is exactly one model call, a candidate exists, and the row
  is deleted. B is untouched.
- The next poll makes no call.
- A grant for another key does not trigger A.
- The `home` error contains the external ID, the stage, the attempt and the
  next action, and no meeting title or text. This also holds after a restart.
- A canary queued behind a held fixture stages within its passes.

Estimate: ~120 production, ~160 test.

## Task 5: Keep a paid result when another import lands during extraction

**Problem:**
- `stageCandidate` requires the cursor to equal the one from the start of the
  cycle (`sqlite-authority-meeting-processing-state-v1.ts` ~:251-255).
- An HTTP `import` or `submit` of another meeting rewrites the cursor (person
  meeting intake `enqueue` ~:143) and can land during a long extraction.
- The successful, already-paid extraction is then discarded. The next poll
  sees the ledger as `succeeded` and holds the meeting as `output_not_saved`,
  which needs another paid attempt.
- The final cursor CAS has the same issue: `next_cursor` was computed from the
  old queue and must not drop the newly queued import.

**Change:**
- Allow staging and advancing when the only change since the pull is newly
  appended manual imports.
- Rebase `next_cursor` onto the current checkpoint by removing the consumed
  meeting from the current queue, instead of overwriting the queue with the
  stale one.
- The cursor is opaque to the core. Put the rebase at the provider or intake
  boundary through the smallest port: for example, an optional
  `cursor.rebase(expected, next, current)` on the provider cursor policy, or
  logic in the runtime's state wiring. Keep provider semantics at the adapter
  boundary (INV-ADAPTERS-005).
- Any other change since the pull (cancel, reorder, folder change, access
  change) must still refuse, as today.
- Apply the same rule to the park advance from Task 3.
- If this grows past about 80 production lines, stop and report back
  (DONE_WITH_CONCERNS) with the design.

**Tests:**
- With a slow fake extraction, enqueue B during A's extraction. A's candidate
  is staged, the cursor keeps B queued, there is exactly one model call, and
  B is processed next.
- A cancel during extraction still refuses, as today.

Estimate: ≤80 production, ~80 test.

## Task 6: Shrink the writer gate (meeting work and notes)

Only short durable transitions should hold the gate. Every Authority write is
already a synchronous better-sqlite3 transaction. The record-log appender is
the only transaction held across an await
(`packages/organization-record/src/log/record-log-v4-append.ts` ~:221-306),
and it shares its handle with search. So publisher passes stay inside the
gate; slow provider and model waits move out.

**Change:**
1. **Worker:** the loop calls `runCycle(signal, exclusive)` without wrapping
   it, where `exclusive = op => this.runExclusive(op)`. The single loop still
   serializes cycles.
2. **Lifecycle (`runOrganizationAuthorityProcessingCycleV1`):**
   - Run in order: `exclusive(recovery)`, then notes enrichment and personal
     intake outside the gate, then `exclusive(publication)`.
   - Make the default `exclusive = op => op()` so direct callers and tests
     keep working.
3. **Person runtime:**
   - Move the per-source body into `runSource(setting, signal)`.
   - Add `inFlight: Map<source_key, Promise<void>>`; round-robin skips keys
     that are in flight.
   - Add `pollAndStageSource(key, signal)`: it waits for any in-flight pass
     on that key, then runs one targeted pass that ignores `observed.next`.
   - The in-memory single-flight saves wasted work. The durable fences (below)
     keep it correct across processes and restarts.
4. **Reservation as lease:**
   - Add `reserved_at` to the ledger's `blocked` result; it is already read at
     `sqlite-extraction-attempt-store-v1.ts` ~:141.
   - In the cycle's blocked path, `blocked && outcome === 'pending' && age < 660_000 ms`
     returns a new result kind `in_flight`: no error, no park, no cursor
     move.
   - Older pending reservations follow Task 3 and park as `interrupted`.
   - Parking must never happen on a fresh pending reservation.
5. **Notes enrichment lease, no schema change:**
   - In `person-update-enrichment-work-v2.ts`, the claim sets
     `state='processing', retry_at = now + 120_000 ms`.
   - Reclaim only rows whose `retry_at` has passed.
   - Completion and defer add `AND retry_at = ?` as a fencing token, so a
     stale `enriched()` becomes a no-op instead of throwing.
6. **Shutdown:**
   - The worker abort reaches every lane.
   - An extraction cut off by shutdown is recorded as `failed/cancelled`, as
     today.
   - Close order: abort, then await the worker loop and tail and in-flight
     source passes, then search, then `api.close`, then `clearHandle`.

**Tests:**
- **Latency:** while a fake intake waits on a deferred that never resolves,
  `requestApprovalPublication` appends within one tick, with gate wait about
  0.
- **No double-processing, in process:** periodic intake plus
  `pollAndStageSource` on the same source with a slow extraction give one
  extract call, one candidate, and one cursor advance.
- **No double-processing, durable:** two runtimes on two handles of the same
  DB file. The second gets `in_flight`, with no error, park, or cursor move.
- **Crash mid-extraction:** a fresh `pending` gives `in_flight`. After the
  clock passes 660 s, it parks as `interrupted` with no second extract call.
- **Notes lease:** reclaim is refused during the lease and allowed after it;
  a stale `enriched()` is a no-op.
- **Shutdown:** DB handles close only after all passes settle.

Estimate: ~100 production, ~180 test.

## Task 7: Slack cards and the canary leave the gate

**Change:**
1. **Presentation:**
   - Lifecycle `schedulePresentation` (~:262-307) runs the presenter in a
     tracked single-flight lane on the shutdown signal, not
     `worker.runExclusive`.
   - `close()` and `drain` must await it before `api.close`; today
     `worker.close()` does this implicitly.
   - This is safe because presenter transitions are compare-and-swap guarded
     (`providers/slack/server/src/private-approval/slack-approval-presenter-v1.ts`
     ~:196-226), `beginMarker` is durable before the post, in-flight markers
     are reconciled, and `decide` already races the presenter.
   - Keep single-flight: concurrent turns would double-count backoff.
   - Fix the stale "at most one pending card" comment.
2. **Canary:**
   - Stop using `runtime.runExclusive`
     (`services/organization-authority/src/composition/organization-authority-runtime.ts`
     ~:92).
   - Run it in a tracked lane and call `pollAndStageSource(setting.source_key)`
     up to the existing 5 passes (`staging-synthetic-personal-canary-v1.ts`
     ~:53-57).
   - It no longer suspends search, since it appends no records.
   - The operator `runExclusive` API stays for genuine operator work.

**Tests:**
- While a presenter turn is blocked, publication still appends.
- `close()` waits for the presenter before api-close. Update the lifecycle
  test ~:811.
- The canary completes while another source's extraction is blocked, does not
  suspend search, and touches only its own source.

Estimate: ~40 production, ~90 test.

## Task 8: Meeting lanes

**Change:**
1. **Person runtime:** `pollAndStageAdmittedMeetings` becomes a top-up.
   - Walk eligible sources round-robin from `after`, skip any in `inFlight`,
     and launch up to `MEETING_LANES - inFlight.size` detached
     `runSource` passes.
   - When a lane settles it removes itself and tops up again.
   - `MEETING_LANES = 3` is a code constant with a test-only option.
   - Each lane does one meeting per pass, which stays fair across sources.
   - Detached lanes send non-`Error` throws to the error reporter instead of
     rethrowing.
2. **Settle:**
   - Add optional `settle?(): Promise<void>` to
     `OrganizationAuthorityProcessingCycleV1`.
   - The lifecycle's `drain` and `close` await it after `worker.close()`.
     This is required because the runtime closes the Authority database after
     `runtime.close()`.

**Tests:**
- Two sources run concurrently.
- The same source is never in flight twice.
- The cap is respected.
- One failing lane does not stall the others.
- `close` and `drain` await lanes.

Estimate: ~40 production, ~90 test.

## Task 9: One model-call limiter and a run cap

**Change:**
1. **Limiter:** new `services/organization-authority/src/composition/model-call-limiter-v1.ts`.
   - `run(priority: 'interactive' | 'background', signal, op)`.
   - `max_concurrent = 6`, `max_background = 4`.
   - Interactive waiters are served first and may use every slot.
   - An aborted waiter leaves the queue and is rejected with `signal.reason`.
   - The limiter never retries. A 429 (`diagnostic.http_status === 429` or
     code `rate_limited`) sets a background-only cooldown: 5 s, doubling to a
     60 s maximum, reset on success. Interactive calls are not paused.
   - Plus `limitStructuredGenerationPortV1(port, limit)`.
2. **Wiring:**
   - In `organization-authority-runtime.ts`:
     - background-wrapped ports go to the related-atom projector binding and
       `createPersonUpdateProcessingV1`;
     - the interactive-wrapped port goes to `api.answer_composition_generation`;
     - a new optional `answer_composition_background` is used for trigger and
       sweep research in `organization-authority-api-runtime.ts` (~:369).
   - Extraction gets a provider-neutral option
     `limit?: <T>(signal, op) => Promise<T>` on
     `createOpenRouterDecisionProcessorBundleV1`, which wraps
     `client.generateStructured`. This does not change processor commitments.
   - The composition root creates one limiter and passes it to both. Wrap at
     this level, not at fetch, so queue time does not eat the call's own
     timeout.
3. **Run cap:**
   - `trigger-runs-v1.ts` `claim` gains `admit?: () => boolean`, checked after
     the live-run and done checks. It returns `{kind: 'busy'}` when the cap is
     full.
   - `person-trigger-runs-v1.ts` passes `() => controllers.size < 4`
     (`MAX_RUNNING = 4`, with an option override).
   - The desktop already handles `busy`.
4. **Token rotation:** in `person-trigger-runs-v1.ts`, a run that hits
   `unauthorized` releases uncounted (`release({counted: false})`) instead of
   failing as `no_access`. The desktop's access token is rotated (and the old
   one revoked) every 12 h, and `start` rechecks access. `stale_access_state`
   and `not_found` keep failing as `no_access`.

**Tests:**
- **Limiter:**
  - priority order;
  - background cap and interactive reserve;
  - abort while queued;
  - 429 cooldown and reset;
  - slot released when the call throws;
  - the decision-processor bundle calls `limit`.
- **Runs:**
  - the cap returns `busy`;
  - a duplicate start of a running run still returns `running`;
  - `unauthorized` releases uncounted.

Estimate: ~90 production, ~150 test.

## Task 10: Quiet the server ground

**Change:**
1. **Search warm skip:**
   - Export `isReadableSearchActiveGenerationWarmV1(active)` from
     `packages/organization-retrieval/src/readable-search-engine-v1.ts`; it
     returns true when the in-process handle's key matches.
   - In `readable-search-generation-reconciler.ts`, unchanged-head branch only
     (~:180-203): call `prepare_generation` only if a new optional
     `is_generation_warm?.(generation)` says it is not warm.
   - The build path always validates.
   - In composition, factor the active-generation mapping (~:655-670) into one
     helper used by both callbacks.
   - In the lifecycle, call `clearHandle()` before the startup reconcile, so
     startup always fully validates.
2. **Slack:** acknowledge first. In
   `providers/slack/server/src/private-approval/private-slack-approval-interaction-handler-v1.ts`
   ~:142, do not await the best-effort feedback POST. The decision is already
   durable before the acknowledgement, and the POST is bounded by the
   composition root's 4 s abort.

**Tests:**
- **Search:**
  - Unchanged head and already warm: no validation.
  - After a clear: validation runs.
  - The build path validates.
  - Startup validates even when warm.
- **Slack:** a feedback call that never resolves still lets `accept` resolve
  at once.

Estimate: ~20 production, ~60 test.

## Task 11: Desktop on-ramp

**Change (`product/echo-desktop`):**
1. **Merge Home loads:**
   - `loadHome` (`src/renderer/store.ts` ~:3393) uses a module-level
     in-flight promise plus a "load again" flag.
   - A request that arrives while a load is in flight joins it, or marks one
     more load to run afterwards.
   - An account change resets it; use a token so an old `finally` cannot
     clear the new one.
   - `refreshHome` sets and clears the loading flag it already checks.
2. **Refresh ahead:**
   - In `src/host/host.ts` `gated` (~:149-166), use
     `refreshDue(store, now, TIMEOUT_MS[method] + 60_000)` for both the first
     check and the re-check.
   - A call then never starts with less sign-in time left than its own
     timeout. The refresh wait behind other in-flight calls is bounded by
     normal call timeouts.
   - Do not let a refresh run while other calls hold the old token. The
     server revokes it on rotation.

**Setup:**
- Run `npm ci` in `product/echo-desktop` with the sandbox off.
- If Electron fails to launch:
  `rm -rf node_modules/electron/dist node_modules/electron/path.txt && node node_modules/electron/install.js`
  (sandbox off).
- Run the root `npm run build` first; the desktop needs the root person-client
  build.

**Tests:**
- Home unit tests: two concurrent loads give one set of reads plus at most one
  follow-up.
- An existing session e2e or unit test covers refresh-ahead for a long method.
- Run the focused desktop specs you touched, not the whole e2e suite.

Estimate: ~25 production, ~60 test.

## Task 12: Docs

**Change:**
- `docs/architecture/meeting-processing-core-and-adapters.md`:
  - held meetings are parked and intake continues;
  - authorized retry from custody;
  - the writer gate covers only publication;
  - meeting lanes;
  - the model-call limiter.
- `deploy/organization-authority/README.md` hold text (~:695-706: "The hold
  preserves the source cursor… later source items… can wait") becomes the
  park behavior. Add the V14 reset note where V13 was noted.
- `services/organization-authority/src/composition/README.md`, if it
  describes the lifecycle or gate.
- Release notes, if the repo keeps them: V14 needs fresh state.

**Validation:** run `npm run check:docs`.

Estimate: docs only.
