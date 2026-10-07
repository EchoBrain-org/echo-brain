# Research Trigger Contract v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the single agentic request closure into a fixed research loop, a shared model gate, a shared release step and per-trigger renderers, so a trigger is added by writing a definition and a renderer. Ask stays byte-identical; Check becomes the approved-record trigger with an impact card.

**Architecture:** `createAgenticAskCore` in `agentic-ask-v1.ts` today holds session state, the loop, the writer, layout, two copies of the release sequence and the model gate. It becomes four kernel modules wired by a small request runner: `agentic-model-gate-v1.ts` (call, repair, fingerprints, usage), `agentic-research-loop-v1.ts` (brief in, full bundle out), `agentic-release-v1.ts` (fence, audit, fence, hand over) and `renderers/` (Ask writer, impact card). Trigger definitions live in `agentic-trigger-definitions-v1.ts`; the service derives its allowlists from them.

**Tech Stack:** TypeScript (ES modules, `tsc -b`), Vitest, Node 22 `.mjs` tools.

**Spec:** `docs/product/2026-10-06-research-trigger-contract-v1.md`

## Global Constraints

- After every phase: `agentic-ask-golden.test.ts` passes against both `agentic-ask-golden.v1.json` (b108ad3) and `agentic-ask-granola-phase2.v1.json` with no fixture rewrite (`GOLDEN_WRITE` is never set), and `npm run check` passes.
- Ask's system prompts, user prompts, model inputs, call order, desk call order (including every `revalidate`), audit entries and responses do not change. V4 Ask (`createAgenticAskV1`/`V2`) keeps having no post-audit fence; V5/V6 keep it.
- The loop module never imports a renderer, a trigger definition, or a trigger name. Model calls happen only inside the gate.
- Audit roles stay `step` and `answer`. Renderer calls use `answer`, so the audit adapter's role check does not change.
- No loop behaviour changes (spec "Not in this round"). The only prompt text that changes is Check and Sweep task text in phase 4.
- ECHO never writes to Jira or Confluence; the impact card holds no drafted edits.
- Cloud setup before tests: `npm ci`, `npm run build`, `npm run typecheck`.

## Decisions this plan makes that the spec leaves open

1. **Staging API envelope, not per-trigger fields.** `organization-api` cannot import the kernel (the kernel depends on it). To meet "no edits to the API validators", the start request becomes `{ trigger: string (≤64, [a-z_]), input: bounded JSON object, budget? }`. The API checks only the envelope; the service passes `input` to the definition's `parseEvent`, which returns a brief or an invalid-request error. Ask keeps today's `question` field as an accepted alias for one release, so the founder's runner keeps working until phase 6 updates it.
2. **Audit allowlist.** The SQLite audit adapter (service) imports the kernel's `AGENTIC_TRIGGER_NAMES_V1` (every definition except Ask, which writes no `trigger` field) in place of the `"check" | "sweep"` literal. Older rows that say `check` are never re-validated, so the rename needs no migration.
3. **Renderer role and span.** Renderers call the gate with role `answer`. The runtime span name becomes a gate argument: Ask keeps `ask_answer`, the impact card uses `research_render`.
4. **The gate's per-call hook.** Today a step call marks every scratchpad item as read in full before the provider call. The gate exposes `before_call(role)` so the loop can keep doing that without the gate knowing about items. `liveInPrompt` (which suppresses runtime content capture) becomes a gate argument `content_sensitive: () => boolean`.

---

## Phase 1: Model gate and bundles (no behaviour change)

### Task 1.1: Extract the model gate

**Files:**
- Create: `packages/organization-authority-kernel/src/answer-composition/agentic-model-gate-v1.ts`
- Modify: `agentic-ask-v1.ts`
- Test: `packages/organization-authority-kernel/test/answer-composition/agentic-model-gate-v1.test.ts`

**Interfaces:**
- Produces: `createAgenticModelGateV1({ generation, model, desk_revalidate, budget, now, deadline, signal, input_signal, is_deadline_expired, on_span, content_sensitive, before_call })` returning `{ call(role, system, user, schema, timeout, recovery?), withRepair(role, system, user, schema, timeout, parse, on_rejection?), stats(): { calls, repairs, generations, invocation_digests, stopped } }`.
- [ ] Step 1: Failing tests: one revalidation before each call; the call budget is enforced; a permanent provider failure sets `stopped`; repair adds `validation_error` and `rejected_response`; fingerprints equal today's `canonicalSha256({ role, model, system_prompt, user_prompt, schema, max_output_tokens, timeout_ms })`.
- [ ] Step 2: Move `call` and `withRepair` bodies verbatim. The request closure builds the gate and keeps `fallbacks` and `stepRejections`, which `withRepair` reports through `on_rejection`.
- [ ] Step 3: Golden, kernel tests and `npm run check` all pass.

### Task 1.2: Full and trimmed bundles

**Files:**
- Create: `packages/organization-authority-kernel/src/answer-composition/agentic-evidence-bundle-v1.ts`
- Modify: `agentic-research-v1.ts` (`AgenticResearchResultV1` becomes the trimmed bundle; field names unchanged), `agentic-ask-v1.ts`
- Test: `agentic-evidence-bundle-v1.test.ts`

**Interfaces:**
- Produces: `interface AgenticEvidenceBundleV1` (spec section 2, items 1–9). Each item carries `short`, desk `item`, `full`, `opened`, `preloaded`, `touched`, `query?`, `cited_by_plan`. It also holds `unreadable_starting: []` (filled in phase 4), `gathered_for: { scope, checked_at }`, `server: { receipts, notices, invocation_digests, generations }`. Also produces `trimAgenticEvidenceBundleV1(bundle): AgenticResearchResultV1`.
- [ ] Step 1: Failing test: the trimmed bundle of a scripted run deep-equals today's `researchResult()` output. Snapshot it from the current code in this same test before the move.
- [ ] Step 2: Build the bundle at the end of `research()` from the existing `entries`, `rounds`, `readCoverage`, `inventoryView()` and stop state. `researchResult()` becomes `trimAgenticEvidenceBundleV1(bundle)`.
- [ ] Step 3: Golden, tests and check pass. Commit `refactor(research): extract the model gate and evidence bundle`.

## Phase 2: Shared release step

### Task 2.1: Release module

**Files:**
- Create: `packages/organization-authority-kernel/src/answer-composition/agentic-release-v1.ts`
- Modify: `agentic-ask-v1.ts`
- Test: `agentic-release-v1.test.ts`

**Interfaces:**
- Produces: `releaseAgenticResultV1({ desk, audit, gate_stats, trigger?, background, receipts, rounds, fallbacks, outcome, citation_count, digests: { answer_sha256, response_sha256 } | 'from_response', fence_after_audit, signal, assert_live })` and `auditAgenticTerminalV1(kind: 'timed_out' | 'cancelled', …)`.
- [ ] Step 1: Failing tests: the call order is revalidate, append, revalidate (with `fence_after_audit` on) and revalidate, append (with it off). An abort during the append releases nothing. A timeout writes `timed_out` with null digests. The entry is byte-identical to today's `audit()` for an Ask V6 scripted run and a Sweep scripted run.
- [ ] Step 2: Replace both inline sequences (research-only branch and Ask tail) and the `catch` terminal audits. Keep the `report()` revalidation and audit stage events at the same points. Ask passes `fence_after_audit: tickets`; research-only runs pass `true`.
- [ ] Step 3: Golden (including the Granola fixture's audit fingerprints), tests and check pass. Commit `refactor(research): one shared release step`.

## Phase 3: Ask renderer

### Task 3.1: Move the writer and layout out of the loop

**Files:**
- Create: `packages/organization-authority-kernel/src/answer-composition/renderers/ask-renderer-v1.ts`
- Create: `packages/organization-authority-kernel/src/answer-composition/agentic-renderer-v1.ts` (renderer interface)
- Modify: `agentic-ask-v1.ts`
- Test: `renderers/ask-renderer-v1.test.ts`, and an architecture test in `agentic-ask-v1.test.ts`

**Interfaces:**
- Produces: `interface AgenticRendererV1<In, Out> { render(input: { bundle: AgenticEvidenceBundleV1; trigger_input: In; gate: AgenticModelGateV1; remaining: () => number; signal }): Promise<{ result: Out; cited: readonly string[]; outcome; fallbacks: number }> }`, and `createAskRendererV1({ response_version, answer_prompt, answer_budget, source_catalog, scope, context, desk_scope })`.
- [ ] Step 1: Failing test: given a fixed bundle, the renderer produces the same answer user-prompt bytes, `writer_evidence` and V4/V5/V6 response as the current inline code does for three golden scenarios. Capture those through the existing golden harness.
- [ ] Step 2: Move the "final answer" and "layout" blocks unchanged. They read only the bundle (`entries` order, `touched`, `full`, `text`, cited shorts, coverage, stop state, notices). The `retrieval`, `planner`, `context` and `answer` stage reports stay in the runner at the same points.
- [ ] Step 3: Architecture test: no file under `renderers/` imports a desk port or calls `search`, `open`, `list` or `openCitation`. The loop module has no `generate` call outside the gate.
- [ ] Step 4: Golden, tests and check pass. Commit `refactor(ask): Ask writer becomes a renderer`.

## Phase 4: Brief and trigger definitions

### Task 4.1: Brief, shared task rule, unreadable starting items

**Files:**
- Create: `packages/organization-authority-kernel/src/answer-composition/agentic-brief-v1.ts`
- Create: `packages/organization-authority-kernel/src/answer-composition/agentic-research-loop-v1.ts` (the loop module: brief in, full bundle out; the request closure becomes the runner)
- Modify: `agentic-research-v1.ts`, `agentic-ask-v1-model-protocol.ts`, `agentic-ask-v1.ts`
- Test: `agentic-brief-v1.test.ts`, updated `agentic-research-v1.test.ts`

**Interfaces:**
- Produces: `AgenticBriefV1 = { goal: { kind: 'question'; question } | { kind: 'task'; task: string }; starting: readonly { citation; if_unreadable: 'fail' | 'report' }[]; budget; options: { small_scope_preload: boolean } }` (the person and scope are bound by the desk, as today). Also produces `TASK_RULE_PROMPT = "There is no question from a person; the task below replaces it."`, which replaces `CHECK_TASK_PROMPT` and `SWEEP_TASK_PROMPT`.
- [ ] Step 1: Failing tests: a task goal sends `task` (with starting ids filled into the template) and the shared paragraph. A question goal sends today's bytes. `report` starting items that cannot be read land in `bundle.unreadable_starting`, and research continues. `fail` items throw `not_found` before any model call.
- [ ] Step 2: The loop takes a brief; `goalFields()` becomes `{ question }` or `{ task }`. `small_scope_preload` replaces the `!researchOnly` check.
- [ ] Step 3: Golden (Ask unchanged) and tests pass.

### Task 4.2: Trigger definitions and derived allowlists

**Files:**
- Create: `packages/organization-authority-kernel/src/answer-composition/agentic-trigger-definitions-v1.ts`
- Modify: `services/organization-authority/src/adapters/persistence/sqlite/person-agentic-ask-audit-v1.ts`, `packages/organization-api/src/person-research-eval-v1.ts` (envelope, decision 1), `services/organization-authority/src/composition/person-research-eval-v1.ts`
- Test: `agentic-trigger-definitions-v1.test.ts`, the service audit and endpoint tests, the API validator test

**Interfaces:**
- Produces: `interface AgenticTriggerDefinitionV1<Event, In> { name; parseEvent(input: unknown): Event; brief(event, opened_ids): AgenticBriefV1; budget: 'live' | 'background'; renderer?: AgenticRendererV1<In, unknown>; acts_as: 'requester' | 'approver'; recipients: 'actor_only' }`, `AGENTIC_TRIGGER_DEFINITIONS_V1` (ask, check, sweep) and `AGENTIC_TRIGGER_NAMES_V1`.
- [ ] Step 1: Failing tests: the audit adapter accepts every name in `AGENTIC_TRIGGER_NAMES_V1` and rejects others. The API accepts any well-formed envelope and still accepts the legacy `question` field. The service rejects an unknown trigger or bad input through `parseEvent`.
- [ ] Step 2: Write the Check and Sweep task templates as data. Their text carries what the removed paragraphs said (split into parts, record ids and dates, do not judge, never treat a finding as resolved without reading).
- [ ] Step 3: Golden, tests and check pass. Commit `feat(research): briefs and trigger definitions`.

## Phase 5: Approved-record trigger and impact card

### Task 5.1: Trigger definition

**Files:** `agentic-trigger-definitions-v1.ts`, the service endpoint, the audit adapter test
- [ ] Step 1: Failing tests: `approved_record` replaces `check`. It starts from an approved-record citation (fail closed), runs as the approver on the background budget, uses the spec's task text with `E1` filled in, and is scoped to the record's project. A record with no project gets the approver's whole readable scope.
- [ ] Step 2: Implement. The service resolves the scope from the record before building the desk.

### Task 5.2: Impact card renderer and fallback

**Files:**
- Create: `renderers/impact-card-renderer-v1.ts`, `packages/organization-api/src/person-impact-card-v1.ts` (shape and code validator)
- Test: `renderers/impact-card-renderer-v1.test.ts`, `person-impact-card-v1.test.ts`, and new golden scenarios in a separate fixture `agentic-impact-card-golden.v1.json` recorded once from the reviewed implementation

**Interfaces:**
- Produces: `PersonImpactCardV1 = { decided: { text; citation_index }[]; affected: { citation_index; says_now; relation: 'confirms' | 'conflicts' | 'needs_updating'; owner?; date_at_risk?: { date; milestone } }[]; unconfirmed: string[]; people: { name; items: number[] }[]; status: 'assessed' | 'not_assessed'; citations }`.
- [ ] Step 1: Failing tests: one gate call (role `answer`, span `research_render`) returns summaries and relations by item id. Code drops ids not in the bundle, takes owners and the people list only from item `attributes` (assignee, owner, action owner) without repeats, and fills `unconfirmed` from not-found needs and coverage (cut-short lists, unreadable pages). A model failure gives the fallback (cited items with details under "Possibly affected, not yet assessed"). The validator rejects any text field over its limit or any field not in the shape.
- [ ] Step 2: Implement. Release uses `answer_sha256 = canonicalSha256({ decided, affected })` and `response_sha256 = canonicalSha256(card)`.
- [ ] Step 3: Golden (Ask), new impact-card golden scenarios, tests and check pass. Commit `feat(research): approved-record trigger and impact card`.

## Phase 6: Evaluation

**Files:** `tools/evals/research-loop/lib/{requests,dataset,grade,report}.mjs`, `cases/development.json`, `cases/holdout.json`, `README.md`, tests under `tools/evals/research-loop/test/`
- [ ] Step 1: Failing tests: requests use the envelope. Check cases become `approved_record`, and their answer keys gain `relation` and `owner` per affected item. Card grading counts listed items, correct relations, correct owners, invented items or people, and reported gaps. The report prints loop and renderer numbers in separate sections. A saved run for an impact card contains the card and the trimmed bundle only.
- [ ] Step 2: The endpoint returns `{ rendered, research }` for triggers with a renderer and `{ research }` for Sweep.
- [ ] Step 3: README: Ask baselines remain comparable across this change; approved-record and Sweep baselines must be taken after it. `npm run check` passes. Commit `feat(evals): grade renderers separately from research`.

### Task 6.2: Remove phase scaffolding

After Task 6.1 is green. Phases 1-5 recorded frozen baselines to prove each move changed nothing; afterwards they mostly duplicate the Ask golden replays and pin internal detail that later legitimate changes would trip over.

- [ ] Delete the frozen baselines and the tests that only compare against them (`renderers/__snapshots__/ask-renderer-v1.writer.json`, `__snapshots__/agentic-evidence-bundle-v1.research.json`, `__snapshots__/agentic-release-v1.audit.json`, and any later equivalent). Keep both Ask golden fixtures, the impact-card golden, and behaviour tests, rewritten as direct assertions where they lean on a baseline.
- [ ] Share the golden scenario helpers from one test-fixture module instead of copies.
- [ ] Over-engineering pass on the new modules: option fields nothing passes, leftover re-exports, duplicated helpers, `researchBundle()` if nothing needs it.
- [ ] Golden replays unchanged and `npm run check` passes. Commit `chore(research): remove phase scaffolding`.

## Review Focus

- Phase 2: does any Ask path now fence a different number of times? The Granola fixture's desk call trace must not change.
- Phase 3: does the renderer read anything the inline writer did not? Watch `touched` ordering and the `full`/`text` fallback filter.
- Phase 4: `report` mode must not leak an unreadable item's title or citation beyond what the desk returned.
- Phase 5: owners and people come only from item details, never from model text. No relation is ever phrased as an instruction to edit Jira or Confluence.

## As built

Where the shipped interfaces differ from the plan text above:

- Gate: each call names `{ role, span }` (`AgenticModelCallV1`), not a role alone, and the gate reports each pre-call access check through `on_checked`.
- Bundle: source notices stay in `coverage.notices`, not `server`; each item also carries the `source` selector the model saw.
- The loop module `agentic-research-loop-v1.ts` was created by a pure move in phase 4a; no task in the plan created it.
- Phases 4, 5 and 6 each shipped in two parts: 4a (move the loop) and 4b (briefs, definitions, envelope), 5a (approved-record trigger) and 5b (impact card), 6a (evaluation) and 6b (this cleanup).
- Brief: a definition writes `brief(event)`, not `brief(event, opened_ids)`. A task names its starting items with `{{starting:N}}` slots and places the event's own text with `{{data:N}}` slots; the loop fills both in one pass once it has read the starting items, and the runner refuses a slot with nothing to fill it before any read.
- Definitions also declare `scope` (`requested` or `record_project`), and a definition's brief always carries the limits of its `budget` label.
- Endpoint scope comes from the record: an approved-record run reads its record's one readable project, or everything the approver can read when there is none, and its request names no scope.
- Renderer contract: a renderer also takes `prompt_budget(system_prompt)` and an optional `on_context`, and returns `answer_sha256`, its answer's fingerprint. The release step fingerprints the whole result itself (no `'from_response'` mode), and renderer model calls reach the audit through the shared gate's stats under role `answer`.
- `releaseAgenticResultV1` takes `result` and `answer_sha256` and returns the result it hands over.
- `researchBundle()` was removed in 6b; tests read the full bundle through a renderer.
