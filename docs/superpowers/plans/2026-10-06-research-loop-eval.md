# Research Loop Evaluation v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Separate the agentic research loop from Ask without changing Ask, expose its research result through a staging-only endpoint for three triggers (Ask, Check, Sweep), and build the THERM dataset, grader and runner that measure it per stage.

**Architecture:** The kernel's `createAgenticAskCore` becomes a request (shared session state) with a `research(input)` phase and Ask's writer phase. Research input carries the goal, starting citations and budget; research output is a plain result object with an eval view. A staging-only service application starts research runs in the background and holds results in memory for the runner. Tooling in `tools/evals/research-loop/` seeds nothing by itself (seeding and live runs are the founder's), and grades saved results with code checks plus a model judge.

**Tech Stack:** TypeScript (ES modules, `tsc -b`), Vitest, Node 22 `.mjs` tools, OpenRouter structured generation.

**Spec:** `docs/product/2026-10-06-research-loop-eval-v1.md`

## Global Constraints

- Ask behavior must not change: golden `prompt_sha256` and `response_sha256` recorded from `b108ad3` must be reproduced exactly.
- Live budget: 90 s deadline, 10 rounds, 24 model calls, 4 reads per round, 25 s writer reserve. Background budget: 300 s, 20 rounds, 48 model calls, other limits unchanged.
- The research endpoint is off by default, only composed when `research_eval_v1` is set, and refused when the deployment is production.
- Run results live in memory only, at most 15 minutes, one active run per person; never written to disk, logs, telemetry or audits.
- Eval results are written only under a private local directory (`0700`, files `0600`), never the repository.
- Statuses stay `open`, `found`, `not_found`; no prompt or limit changes to the loop in round one except the Check and Sweep task framing.
- Founder-owned steps (Jira/Confluence writes, staging deploy, meeting intake/approval, live runs, judge calibration grades) are documented, not executed.

## Review Focus

- A research-only run whose starting citation is no longer readable must fail closed (not run without it) and report `not_found`, not leak the item.
- A second start while a run is active for the same person must be refused, not queued silently.
- Fetching a run result with another person's token must return `not_found`.
- A run that hits the deadline must still produce a result with `stop.reason = budget` or an explicit `timed_out` error, never hang the registry.
- Grader matching must treat a ticket key and its permalink as the same item, and must not match a page by title when its id differs.

---

## Phase 1: Golden replay and split (kernel)

### Task 1.1: Golden replay fixture

**Files:**
- Create: `packages/organization-authority-kernel/test/answer-composition/agentic-ask-golden.test.ts`
- Create: `packages/organization-authority-kernel/test/answer-composition/agentic-ask-golden.v1.json`

**Interfaces:**
- Consumes: `createAgenticAskV1`, `createAgenticAskV3` as on `b108ad3`.
- Produces: frozen digests per scenario: `{ prompt_sha256, response_sha256, model_inputs_sha256, calls }`.

- [ ] Step 1: Write scenarios with scripted model replies and pinned `now_ms`/`today`: (a) finish after search+open, (b) `not_found` with two searches, (c) repair after invalid JSON, (d) writer fallback to records, (e) `no_progress` stop, (f) V3 desk with a ticket and a page live source including metadata-only list and open. Each records the audit entry and every `StructuredGenerationInput`.
- [ ] Step 2: Run with `GOLDEN_WRITE=1` to write the JSON fixture from unchanged code; rerun without it and confirm PASS.
- [ ] Step 3: Commit `test(ask): record golden replay digests before the research split`.

### Task 1.2: Request session and research phase

**Files:**
- Modify: `packages/organization-authority-kernel/src/answer-composition/agentic-ask-v1.ts`
- Create: `packages/organization-authority-kernel/src/answer-composition/agentic-research-v1.ts` (input, budget, goal and result types; budget presets)

**Interfaces:**
- Produces:
  - `AGENTIC_RESEARCH_LIVE_BUDGET_V1`, `AGENTIC_RESEARCH_BACKGROUND_BUDGET_V1: AgenticResearchBudgetV1 = { deadline_ms, max_rounds, max_model_calls, writer_reserve_ms }`
  - `type AgenticResearchGoalV1 = { kind: 'question'; question: string } | { kind: 'check_record'; record: string } | { kind: 'recheck_findings'; findings: readonly AgenticResearchFindingV1[] }`
  - `interface AgenticResearchFindingV1 { finding: string; expected: string; citations: readonly unknown[] }`
  - `interface AgenticResearchInputV1 { goal; starting_citations?: readonly unknown[]; budget?: AgenticResearchBudgetV1 }`
- [ ] Step 1: Move the research loop body into an internal `research(input)` function inside the request closure; Ask's `answer()` calls it with `{ goal: { kind: 'question', question }, budget: LIVE }` and continues with the unchanged writer.
- [ ] Step 2: Replace the hard-coded `AGENTIC_ASK_MAX_STEPS_V1`, `AGENTIC_ASK_MAX_MODEL_CALLS_V1`, `AGENTIC_ASK_DEADLINE_MS_V1`, `AGENTIC_ASK_ANSWER_RESERVE_MS_V1` uses with the budget fields (exported constants keep their values).
- [ ] Step 3: Run golden + all kernel Ask tests: PASS. Commit `refactor(ask): run research as a phase of the agentic request`.

## Phase 2: Research result and triggers (kernel)

### Task 2.1: Result bookkeeping and eval view

**Files:**
- Modify: `agentic-ask-v1.ts`, `agentic-research-v1.ts`
- Test: `packages/organization-authority-kernel/test/answer-composition/agentic-research-result.test.ts`

**Interfaces:**
- Produces: `interface AgenticResearchResultV1` (goal, budget, plan, items, rounds, coverage, stop, cost) and `agenticResearchEvalViewV1(result): AgenticResearchEvalViewV1` (drops desk ids, refs, receipts).
- [ ] Step 1: Failing test: a scripted run returns rounds with actions and results, item flags (`read_in_full`, `opened`, `preloaded`, `cited_by_plan`), stop reason and cost; the eval view has no `ref`, desk id or receipt.
- [ ] Step 2: Record each round (plan snapshot after merge, normalized actions, tool results reduced to item short ids/notes/errors, rejected replies with validation reasons, elapsed ms). Bookkeeping only; no prompt change.
- [ ] Step 3: Golden + tests PASS. Commit `feat(ask): keep a research result beside the Ask answer`.

### Task 2.2: Research-only entry point for Check and Sweep

**Files:**
- Modify: `agentic-ask-v1.ts`, `agentic-ask-v1-model-protocol.ts` (task paragraphs only)
- Test: `packages/organization-authority-kernel/test/answer-composition/agentic-research-triggers.test.ts`

**Interfaces:**
- Consumes: `EvidenceDeskPortV2.openCitation?(input: { citation; neighbours?; signal? })`.
- Produces: `createAgenticResearchV1(options: CreateAgenticAskV2Options).research(input: AgenticResearchInputV1 & { signal?: AbortSignal }): Promise<AgenticResearchResultV1>`; `CHECK_TASK_PROMPT`, `SWEEP_TASK_PROMPT`.
- [ ] Step 1: Failing tests: Check preloads the record as E1 through `openCitation`, sends `task`/`record_id` instead of `question`, and the system prompt contains the Check paragraph; Sweep sends `findings` and preloads fresh cited items; an unreadable starting citation throws `not_found` before any model call; background budget allows 20 rounds.
- [ ] Step 2: Implement; research-only runs revalidate at the end and append an audit entry with `trigger` set, outcome from need statuses.
- [ ] Step 3: Golden + tests PASS. Commit `feat(ask): research-only Check and Sweep triggers`.

## Phase 3: Open by citation for live sources

### Task 3.1: Reader, audit wrapper and desk routing

**Files:**
- Modify: `packages/organization-authority-kernel/src/shared/person-live-evidence-v1.ts` (optional `openCitation` on readers)
- Modify: `packages/organization-authority-kernel/src/shared/audited-person-live-evidence-v1.ts`
- Modify: `providers/jira/src/jira-person-live-evidence-reader-v1.ts`, `providers/confluence/src/confluence-person-live-evidence-reader-v1.ts`
- Modify: `packages/organization-authority-kernel/src/shared/evidence-desk-v2.ts` (optional `openCitation` on the port)
- Modify: `services/organization-authority/src/composition/person-live-evidence-desk-v2.ts`
- Test: provider reader tests and `services/organization-authority/test/person-live-evidence-desk-v2.test.ts`
- [ ] Step 1: Failing tests: Jira opens a ticket citation by exact read with project pin enforced; Confluence opens a page citation in a mapped space; desk V2 routes record/document citations to the base desk and ticket/page citations to the matching source; foreign tool or scope is refused.
- [ ] Step 2: Implement; releases are audited as `open`.
- [ ] Step 3: Tests PASS. Commit `feat(evidence): open live tickets and pages by citation`.

## Phase 4: Staging research endpoint

### Task 4.1: API contract

**Files:**
- Create: `packages/organization-api/src/person-research-eval-v1.ts`; export from `index.ts`
- Test: `packages/organization-api/test/person-research-eval-v1.test.ts`
- **Interfaces:** `PERSON_RESEARCH_RUN_START_PATH_V1 = '/v1/person/research-eval/start'`, `PERSON_RESEARCH_RUN_READ_PATH_V1 = '/v1/person/research-eval/read'`; `validatePersonResearchRunStartRequestV1`, `validatePersonResearchRunReadRequestV1`, `validatePersonResearchRunStartReceiptV1`, `validatePersonResearchRunReadResponseV1`.
- [ ] Steps: failing validator tests, implement, PASS, commit with Task 4.2.

### Task 4.2: Service application, registry and route

**Files:**
- Create: `services/organization-authority/src/composition/person-research-eval-v1.ts`
- Modify: `organization-authority-runtime.ts`, `organization-authority-api-runtime.ts`, `organization-authority-http-server.ts`
- Test: `services/organization-authority/test/person-research-eval-v1.test.ts`
- [ ] Step 1: Failing tests: start returns a run id; read returns `running` then `completed` with the eval view; another person reading gets `not_found`; second concurrent start is refused; results expire after 15 minutes; route absent when the setting is off; production deployment refuses the setting.
- [ ] Step 2: Implement with the same desk composition as the live answer route.
- [ ] Step 3: `npm run check` PASS. Commit `feat(authority): staging-only research evaluation endpoint`.

### Task 4.3: Person client methods

**Files:** `src/product/person-client/authority-client.ts`, `client.ts`
- [ ] Add `startResearchRun` / `readResearchRun` using the read session; test with a fake transport; commit.

## Phase 5: Evaluation tooling

### Task 5.1: THERM dataset and seed plan

**Files:** `tools/evals/research-loop/world/` (seed plan: meetings, due dates, assignments, S1 edits), `tools/evals/research-loop/cases/development.json`, `cases/holdout.json`
- [ ] Draft from the founder's export; validate with a schema test; commit.

### Task 5.2: Runner, grader, report

**Files:** `tools/evals/research-loop/{run.mjs,grade.mjs,report.mjs,lib/*.mjs,README.md}`, `tools/evals/research-loop/test/*.test.mjs`
- [ ] Failing tests on saved fixture results: item matching by citation, per-stage counts, restricted leak fails the run, report aggregation; implement; judge call isolated behind an injectable function; PASS; add `eval:research-loop` script; commit.

## Phase 6: Founder runbook

- [ ] `tools/evals/research-loop/README.md` lists the founder steps in order: deploy staging with `research_eval_v1`, map the THERM project, seed, approve meetings, run, calibrate, report. Update the spec status. Commit.
