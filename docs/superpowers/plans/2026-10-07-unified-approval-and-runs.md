# Unified Meeting Approval and Runs Store Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One meeting approval core (one proposal per meeting, first decision wins across the desktop and an optional Slack DM copy, one publisher, a post-record hook), plus a runs store that checks each approved record's impact as the approver and shows the impact card next to the meeting in the desktop app.

**Architecture:** Every meeting enters through a personal source. The processing cycle freezes one proposal per meeting; surfaces call one `decide()` that writes `authority_approval_decisions_v1`; one publisher appends the record with the neutral `echo-approval-decision-ref-v1` proof and runs after-record hooks in the receipt's transaction. Spec 2's hook enqueues an `approved_record` run; the approver's desktop starts it; the server runs the existing research loop and impact-card renderer, stores a pointer-only form, and rebuilds outside text on every view.

**Tech Stack:** TypeScript (ESM, strict), better-sqlite3 (STRICT tables, triggers), vitest, Electron + React desktop (Playwright e2e), Node CLI person client.

**Specs:** `docs/product/2026-10-07-unified-meeting-approval-v1.md` (spec 1) and `docs/product/2026-10-07-runs-store-and-impact-card-v1.md` (spec 2). Decision records: `docs/decisions/ADR-0031-unified-meeting-approval-core.md`, `docs/decisions/ADR-0032-stored-trigger-runs.md`.

**Code maps (read before starting any task):** `.superpowers/sdd/2026-10-07-unified-approval-and-runs/code-map-approval-core.md`, `code-map-slack-and-org-lane.md`, `code-map-desktop-api-runs.md`. They give exact file:line anchors at the starting commit `57b3126`. Line numbers drift as tasks land; search by symbol.

## Global Constraints

- The repository is public: fixtures and test data are fictional. Never read or copy `~/Desktop/ECHO-Atlassian-Export-2026-10-06`.
- ECHO never writes to Jira, Confluence or Slack content (posting and updating ECHO's own approval DM card is the only Slack write).
- Never set `GOLDEN_WRITE`; never edit the Ask golden fixtures. The Ask goldens must reproduce unchanged.
- No AWS, SSM, SSH, staging deploy, reset, seeding or rehearsal by agents. Those are founder-run.
- No force-push or history rewriting. One or more commits per task; commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- `npm run check` must pass at the end of every task (`check:architecture-boundaries`, `check:docs`, lint, build, typecheck, full vitest). Timeouts in `tests/architecture/workspace-boundaries.test.ts` or `organization-authority-deployment-profile.test.ts` caused by other worktrees' parallel load are re-run alone; report them, never skip them.
- After deleting, adding or renaming a source file, update `source-boundary.v1.json` of its package and `tools/workspace-source-boundaries.v1.json` when listed; `npm run check:architecture-boundaries` enforces them.
- Fresh state only: Authority baseline V12, control-plane baseline V4, empty record log. No migration code.
- Audience: Only me (restricted-reviewer policy) or 1 to 20 sorted, unique project ids (project-members-readable policy, audience = association).
- Owners: the approved snapshot never carries an owner; one owner field per grounded proposal (at most 40); a confirmed owner is trimmed text of 1 to 120 characters with no control characters; owners grant nothing.
- Meetings API envelope `schema_version: 2`. Runs API envelope `schema_version: 1` at `POST /v1/person/runs`.
- Runs: one live `running` run per person, 10-minute lease, 3 attempts, desktop poll every 5 seconds while a run is running and the meetings sheet is open.
- Stored runs never contain text, labels or names read from Slack, Jira or Confluence.
- Plain-English UI copy, exactly as written in the specs where given.

## Review Focus

1. **Two clicks at once from two surfaces** (desktop and Slack within milliseconds) — exactly one decision row and one record; the loser sees who decided. Pinned in Task 7 and Task 12.
2. **A person who loses a project or a Slack link between drawing the card and clicking** — the click is refused and nothing is written. Pinned in Task 7 (project) and Task 12 (link).
3. **A crash between the record append and the receipt** — recovery writes one receipt, runs the hook once, and enqueues exactly one run. Pinned in Task 8 and Task 13.
4. **Distinctive outside text (Slack, Jira, Confluence) reaching the runs store** through says-now lines, labels, owners or "could not be read" notes. Pinned in Task 13 and Task 14.
5. **The desktop opened while a run is mid-flight, closed, and reopened after a server restart** — the run is picked up again after its lease expires, never twice at once. Pinned in Task 14.

---

## File Structure

| Area | Files (create **C**, modify **M**, delete **D**) |
| --- | --- |
| Baselines | M `packages/organization-authority-kernel/baselines/authority-baseline-v11.sql` → renamed `authority-baseline-v12.sql`; M `.../src/adapters/persistence/sqlite/baseline.ts`; M `packages/organization-control-plane/baselines/organization-control-plane-baseline-v3.sql` → `-v4.sql`; M `packages/organization-control-plane/src/persistence/baseline.ts`; M `packages/organization-authority-kernel/src/composition/verify-authority-state-lineage.ts`; M `services/organization-authority/src/composition/organization-authority-state-bootstrap.ts` |
| Synthetic personal source | C `providers/synthetic-demo/src/staging-synthetic-personal-meeting-provider-v1.ts`; M `services/organization-authority/src/composition/person-meeting-runtime-v1.ts` (providers list); M Slack staging canary control (socket kept, runner replaced) |
| Org lane removal | D runtime org branch, synthetic-demo admission/bundle/cursor/setup evidence, staging selection, processing/kernel canary code, journey telemetry sidecar; M setup and service CLIs; M `tools/evals/authority-core/*` |
| Slack approval internals | D coordinator, assignment state, terminal authority, fence, reviewer resolvers, record writer, workflow bundle, stager remainder, control-plane approval persistence and policy resolutions |
| Personal sources | M `services/organization-authority/src/adapters/persistence/sqlite/person-meeting-intake-v1.ts`; M `person-meeting-runtime-v1.ts` |
| Approval core | C `services/organization-authority/src/composition/approval-core-v1.ts` (freeze, decide, owner proposals); C `approval-publisher-v1.ts` (publisher + hooks); D `person-meeting-review-v1.ts`; M processing state and approval workflow state port |
| Proof | C `packages/organization-protocol/src/approval-decision-record-input-v1.ts`; C `services/organization-authority/src/composition/approval-decision-projection-v1.ts`; D in-app V1 and Slack V1–V3 codecs and projectors; M owner readers |
| Meetings API + desktop card | M `packages/organization-api/src/person-meetings-v1.ts`; M `product/echo-desktop/src/renderer/screens/meetings.tsx`; C `product/echo-desktop/src/renderer/screens/project-picker.tsx`; M `compose.tsx`, `store.ts`, `host.ts`, `test-authority.ts`, `tools.spec.ts` |
| Slack plug-in | C `providers/slack/server/src/private-approval/slack-approval-presenter-v1.ts`; C `slack-approval-click-v1.ts`; C `slack-approval-card-v4.ts`; M interaction handler, protocol, poster |
| Runs | C `packages/organization-authority-kernel/src/answer-composition/renderers/impact-card-storage-v1.ts`; C `services/organization-authority/src/adapters/persistence/sqlite/trigger-runs-v1.ts`; C `services/organization-authority/src/composition/person-trigger-runs-v1.ts`; C `packages/organization-api/src/person-runs-v1.ts`; C `product/echo-desktop/src/renderer/screens/impact-card.tsx`; M client, commands, host, protocol, views |

---

### Task 1: Authority baseline V12 plumbing

Pure version bump so later tasks can edit the schema freely. No table changes.

**Files:**
- Rename: `packages/organization-authority-kernel/baselines/authority-baseline-v11.sql` → `authority-baseline-v12.sql` (header comment and trailing `PRAGMA user_version = 12;`)
- Modify: `packages/organization-authority-kernel/src/adapters/persistence/sqlite/baseline.ts` (constant `AUTHORITY_BASELINE_SCHEMA_VERSION_V12 = 12`, `authorityBaselineSqlV12()`, `authorityBaselineSha256V12()`, `applyAuthorityBaselineV12()`; remove V11 names)
- Modify: every importer of the V11 names (35 TS files; `grep -rl "BaselineV11\|baseline-v11\|SCHEMA_VERSION_V11" --include='*.ts' --include='*.mjs' .`), `verify-authority-state-lineage.ts`, `organization-authority-state-bootstrap.ts`, `packages/organization-authority-kernel/package.json` `files`, `packages/organization-authority-kernel/source-boundary.v1.json` runtime assets, `deploy/organization-authority/Dockerfile`, `tests/architecture/workspace-boundaries.test.ts` (ships only current baselines), DAO `user_version === 11` asserts (e.g. `project-upload-enrichment-v1.ts`, `person-update-enrichment-work-v2.ts`; `grep -rn "user_version" services packages --include='*.ts'`)
- Modify docs that state "V11 is fresh-state only": `deploy/release/README.md`, `deploy/organization-authority/README.md`, `docs/architecture/component-naming-taxonomy.md`, `docs/operations/PB-OPERATIONS-001-authority-operator-lane.md`
- Rename test: `packages/organization-authority-kernel/test/adapters/persistence/sqlite/authority-baseline-v11.test.ts` → `...-v12.test.ts`
- Modify hash pins: `services/organization-authority/test/current-storage-schema.test.ts`, `approval-delivery-quarantine-schema.test.ts`, `person-read-decision-audit-schema.test.ts`, `admitted-meeting-source-schema.test.ts` and the kernel baseline test

**Interfaces:**
- Produces: `applyAuthorityBaselineV12(db)`, `authorityBaselineSqlV12()`, `authorityBaselineSha256V12()`, `AUTHORITY_BASELINE_SCHEMA_VERSION_V12`. Later tasks edit `authority-baseline-v12.sql` and update the pinned hash in the five pin tests (one helper constant per test file; run the kernel baseline test to print the new value).

- [ ] **Step 1: Write the failing test.** In the renamed kernel baseline test, assert the new version:

```ts
it('stamps user_version 12 on a fresh database', () => {
  const db = new Database(':memory:');
  applyAuthorityBaselineV12(db);
  expect(db.pragma('user_version', { simple: true })).toBe(12);
});
```

- [ ] **Step 2:** Run `npx vitest run --config vitest.config.ts packages/organization-authority-kernel/test/adapters/persistence/sqlite/authority-baseline-v12.test.ts`. Expected: FAIL (`applyAuthorityBaselineV12` not exported).
- [ ] **Step 3:** `git mv` the SQL file, edit its header and `PRAGMA user_version = 12;`, rename the functions and constant in `baseline.ts`, and update every importer, DAO assert, manifest, Dockerfile line, architecture test and doc listed above.
- [ ] **Step 4:** Recompute the baseline SHA (`node -e` over the file, or read the failure message of the pin test) and update the five pin tests.
- [ ] **Step 5:** Run `npm run check`. Expected: PASS. `grep -rn "V11\b\|v11" --include='*.ts' packages services providers src tests | grep -i baseline` returns nothing.
- [ ] **Step 6: Commit** `chore: Authority baseline V12 (fresh state, no schema change yet)`.

---

### Task 2: Staging synthetic personal source; canary and setup on personal sources

Staging rehearsals stop needing the organization source. Do this before deleting the org lane so the canary never breaks.

**Files:**
- Create: `providers/synthetic-demo/src/staging-synthetic-personal-meeting-provider-v1.ts`
- Modify: `services/organization-authority/src/composition/person-meeting-runtime-v1.ts` (accept `providers: readonly PersonMeetingProviderV1[]`; pick the provider for a stored setting by `setting.source_adapter_id`; route `tool_id` by `provider.id`)
- Modify: `services/organization-authority/src/adapters/persistence/sqlite/person-meeting-intake-v1.ts` (`ensure` takes `custodian_assurance`, default `'personal_oauth_email_workspace'`)
- Modify: `services/organization-authority/src/composition/granola-person-live-runtime-v1.ts` and the composition root (pass a providers list; on the staging origin, append the synthetic provider)
- Modify: `providers/slack/server/src/composition/staging/slack-private-approval/staging-synthetic-private-dm-canary-v1.ts` → replace its runner with `runStagingSyntheticPersonalCanaryV1` (move the file to `services/organization-authority/src/composition/staging/staging-synthetic-personal-canary-v1.ts` if it no longer needs Slack; keep the control socket, `/v1/run` and the receipt shape)
- Modify: `services/organization-authority/src/composition/organization-authority-setup-cli.ts` (finalize with `--staging-synthetic-meetings-dir` queues fixture meetings into the owner's synthetic source; status canary evidence reads synthetic-source proposals and records)
- Test: `services/organization-authority/test/staging-synthetic-personal-canary-v1.test.ts` (new), `services/organization-authority/test/person-meeting-runtime-v1.test.ts` (providers list), setup CLI tests for finalize and status

**Interfaces:**
- Consumes: `PersonMeetingProviderV1` (today's interface in `person-meeting-runtime-v1.ts`), `SqlitePersonMeetingIntakeV1.ensure/enqueue`.
- Produces:

```ts
// providers/synthetic-demo/src/staging-synthetic-personal-meeting-provider-v1.ts
export const STAGING_SYNTHETIC_SOURCE_ADAPTER_ID_V1 = 'staging-synthetic-meeting';
export const STAGING_SYNTHETIC_TOOL_ID_V1 = 'synthetic';
export const STAGING_SYNTHETIC_CANARY_MEETING_ID_V1 = 'synthetic-release-canary';
/** Meetings: the fixed canary meeting plus, when given, each fixture in `fixtures_directory`. */
export function createStagingSyntheticPersonalMeetingProviderV1(options: {
  readonly fixtures_directory?: string;
}): PersonMeetingProviderV1;

// services/organization-authority/src/composition/staging/staging-synthetic-personal-canary-v1.ts
export interface StagingSyntheticCanaryOutcomeV1 {
  readonly kind: 'staged' | 'not_actionable' | 'not_staged';
  readonly approval_id: string | null;
}
/** Ensures the owner's synthetic source, queues the canary meeting, runs one processing pass, reports the proposal. */
export function runStagingSyntheticPersonalCanaryV1(input: {
  readonly database: Database.Database;
  readonly runtime: ReturnType<typeof createPersonMeetingRuntimeV1>;
  readonly signal: AbortSignal;
}): Promise<StagingSyntheticCanaryOutcomeV1>;
```

The control socket keeps building `echo-staging-synthetic-private-dm-canary-receipt-v1` with `approval_outcome = outcome.kind` and `approval_id`, so `deploy/organization-authority/update-clean-v1.sh` does not change.

- [ ] **Step 1: Write the failing tests.**

```ts
// staging-synthetic-personal-canary-v1.test.ts
it('stages the canary meeting as a proposal for the single active owner', async () => {
  const world = await syntheticWorld(); // fresh V12 state, one active owner membership, synthetic provider only
  const outcome = await runStagingSyntheticPersonalCanaryV1({ database: world.db, runtime: world.runtime, signal: new AbortController().signal });
  expect(outcome.kind).toBe('staged');
  expect(outcome.approval_id).toMatch(/^apr_/);
  const source = world.db.prepare("SELECT source_adapter_id, source_custodian_assurance FROM authority_live_source_admission_v2").get();
  expect(source).toEqual({ source_adapter_id: 'staging-synthetic-meeting', source_custodian_assurance: 'staging_synthetic' });
  expect(world.db.prepare("SELECT count(*) FROM authority_live_source_admission_v2 WHERE source_key = '1'").pluck().get()).toBe(0);
});
it('reruns without a second proposal for the same canary revision', async () => {
  const world = await syntheticWorld();
  const first = await runStagingSyntheticPersonalCanaryV1({ database: world.db, runtime: world.runtime, signal: new AbortController().signal });
  const second = await runStagingSyntheticPersonalCanaryV1({ database: world.db, runtime: world.runtime, signal: new AbortController().signal });
  expect(second.approval_id).toBe(first.approval_id);
});
```

```ts
// person-meeting-runtime-v1.test.ts (add)
it('routes each stored source to the provider that owns its adapter id', async () => {
  // two fake providers with different source adapter ids; import one meeting through each;
  // pollAndStageAdmittedMeetings twice; each provider's source() was called only for its own setting
});
```

Setup CLI tests: finalize with a fixtures directory of two fictional meetings leaves two pending imports on the owner's synthetic source and no `source_key = '1'` admission; status reports canary evidence once a synthetic proposal has an approved record.

- [ ] **Step 2:** Run the three test files. Expected: FAIL (missing module and option).
- [ ] **Step 3:** Implement the provider: a `MeetingSourceAdapter` that returns `checkpoint.manual[0]` (the canary meeting or a fixture by id) and a `next_cursor` without it, like `providers/granola/src/granola-folder-source-v1.ts:60-100`; its own checkpoint codec and cursor policy (`source_adapter_id: STAGING_SYNTHETIC_SOURCE_ADAPTER_ID_V1`); `connection_http` with no routes; `tool()` reports `personal_status: 'linked'`; `open()` returns an identity `staging-synthetic-<sha256(person)>` and empty folders. Reuse the canary meeting body from `providers/synthetic-demo/src/staging-canary-meeting-source-v1.ts` and the fixture reader from the synthetic-demo meeting source.
- [ ] **Step 4:** Implement the providers list in the runtime and the `custodian_assurance` option; implement the canary runner (resolve the single active owner membership as `synthetic-demo-meeting-source-admission.ts:177-195` does; `intake.ensure` + `intake.enqueue`; drive `processing.pollAndStageAdmittedMeetings` until the canary meeting leaves the cursor's manual list, at most 5 passes; read the proposal row for that meeting); re-point the control socket and setup finalize/status.
- [ ] **Step 5:** Run the three test files, then `npm run check`. Expected: PASS.
- [ ] **Step 6: Commit** `feat: staging synthetic personal meeting source for the canary and fixtures`.

---

### Task 3: Remove the organization source lane

**Files (delete unless noted):**
- `services/organization-authority/src/composition/organization-authority-runtime.ts`: the `sourceIsAdmitted` check and the whole org branch (today `:401-655`), canary hooks, journey telemetry wiring, `active_processing` override if only the org lane used it. The personal-only branch becomes the only branch.
- `services/organization-authority/src/composition/organization-authority-composition-root.ts`: synthetic/canary bundle selection, `run_staging_synthetic_private_dm_canary` (now Task 2's runner), the Slack approval bundle wiring (`:232-246`). Slack approvals are paused from here until Task 11.
- `services/organization-authority/src/composition/staging/staging-synthetic-meeting-source-selection-v1.ts`, `synthetic-demo-organization-authority-cli.ts`, `synthetic-demo-organization-authority-composition-root-v1.ts`, `synthetic-demo-main.ts`, the `echo-synthetic-demo` bin, `synthetic-demo-pre-slack-evaluator-cli-v1.ts` only if nothing else imports it.
- `providers/synthetic-demo/src/synthetic-demo-meeting-source-admission.ts`, `synthetic-demo-meeting-source-bundle-v1.ts`, `synthetic-demo-admitted-meeting-source-cursor-policy-v1.ts`, `synthetic-demo-setup-evidence-v1.ts`, `staging-canary-meeting-source-v1.ts` (after Task 2 moved what it needs).
- `packages/organization-processing/src/admitted-meeting-processing/staging-synthetic-meeting-canary-v1.ts`, `packages/organization-authority-kernel/src/shared/staging-synthetic-meeting-canary-envelope-v1.ts`, and the canary branches in `sqlite-authority-meeting-processing-state-v1.ts` (`stageSyntheticCanaryCandidate`, the canary branch near `:828-860`, its imports).
- The `source_key = '1'` defaults: `SqliteAuthorityMeetingProcessingStateV1` constructor, `readAdmittedMeetingProcessingCommitmentsV1`, `createPersonMeetingReviewV1(..., sourceKey = '1')` — make the source key a required argument.
- `providers/openrouter/src/verify-openrouter-decision-processor-admission-v1.ts` (source-'1' admission guard) and its wiring.
- Meeting-approval journey telemetry sidecar: `services/organization-authority/src/composition/meeting-approval-journey-telemetry-v1.ts`, `meeting-approval-journey-state-v1.ts`, `packages/organization-processing/src/admitted-meeting-processing/meeting-approval-journey-telemetry-port-v1.ts` and every call site (the stager, interaction handler and coordinator call sites go with Task 5's deletions; leave a no-op only if Task 5's files still import the port, and delete it there).
- Service CLI: the org-lane flags; keep the `staging-private-dm-canary` command name and route it to Task 2's runner.
- Setup CLI: org admission paths, `stagingSyntheticCanaryObserved`/`setupCanaryEvidence` on source `'1'` (Task 2 replaced them), the `ordinarySourceFree` special case becomes the only case.
- Tests that exercise only the removed lane: `organization-authority-staging-canary-cli.test.ts`, `composition/providers/synthetic-demo/*runtime.test.ts`, `composition/staging/*selection-v1.test.ts`, `PROC .../staging-synthetic-meeting-canary-v2.test.ts`, `SYN/test` admission and bundle tests, Slack `test/composition/staging/*` (unless re-pointed in Task 2). Rewrite, do not delete, the org-lane parts of `organization-authority-private-approval-runtime.test.ts`, `organization-authority-service-cli.test.ts`, `organization-authority-setup-cli.test.ts`, `organization-authority-api-runtime.test.ts`, and the staging journey fixtures under `tests/fixtures/staging-*` so they use the personal lane.
- Packaging: `package.json` workspaces, `tsconfig.workspaces.json`, `services/organization-authority/package.json`, `deploy/organization-authority/Dockerfile`, `tools/workspace-source-boundaries.v1.json`, both `source-boundary.v1.json` manifests, `tests/architecture/workspace-boundaries.test.ts` entries for removed files.
- Keep: `demo/meetings/*`, `demo/expectations.json`, `demo/evaluate-rehearsal.mjs` and the synthetic-demo source adapter if Task 2's fixture reader uses it.

**Interfaces:**
- Consumes: Task 2's `runStagingSyntheticPersonalCanaryV1`, the providers list.
- Produces: one runtime path. `SqliteAuthorityMeetingProcessingStateV1(db, policy, processorAdapterId, ..., sourceKey: string, ...)` with `sourceKey` required.

- [ ] **Step 1: Write the failing test** (in `organization-authority-api-runtime.test.ts` or a new `organization-authority-runtime-personal-only.test.ts`):

```ts
it('starts with neither Slack nor Granola configured and never admits source 1', async () => {
  const runtime = await startRuntimeForTest({ slack: undefined, granola: undefined });
  expect(runtime.processing).toBe('idle_until_finalize');
  expect(runtime.db.prepare("SELECT count(*) FROM authority_live_source_admission_v2 WHERE source_key = '1'").pluck().get()).toBe(0);
  await runtime.close();
});
```

- [ ] **Step 2:** Run it; confirm the org branch is still reachable today (a test that seeds `source_key = '1'` takes the org path).
- [ ] **Step 3:** Delete and rewire as listed. After each group, run `npm run build` to catch dangling imports.
- [ ] **Step 4:** `grep -rn "source_key = 1\|source_key = '1'\|sourceKey = '1'" --include='*.ts' --include='*.mjs' services packages providers tools tests` returns only Task 4's harness (if not yet done) or nothing.
- [ ] **Step 5:** Run `npm run check`. Expected: PASS.
- [ ] **Step 6: Commit** `refactor: remove the organization meeting source lane`.

---

### Task 4: Authority-core evaluation harness on a personal source

**Files:**
- Modify: `tools/evals/authority-core/core-input.mjs` (create a personal source through `SqlitePersonMeetingIntakeV1.ensure` for a fictional person instead of inserting `source_key = '1'`)
- Modify: `tools/evals/authority-core/core-approval.mjs` (replace the Slack lane — control-plane seeding, deterministic poster, signed receipts — with the in-app review today, and `createApprovalCoreV1().decide('desktop', …)` once Task 7 lands; this task uses the module that exists at its start)
- Modify: `tools/evals/authority-core/core-candidate.mjs`, `tools/evals/authority-core/test/core-input.test.mjs`, `test/core-approval-wake.test.mjs`, `verify-contract.mjs` if it pins the lane

**Interfaces:**
- Consumes: Task 3's required `sourceKey`.
- Produces: `npm run test:capacity` green on the personal lane.

- [ ] **Step 1: Write the failing test** (in `core-input.test.mjs`): the harness's admission row has `source_key` starting with `pms_` and `principal_id` of the fictional person.
- [ ] **Step 2:** `npm run test:capacity`. Expected: FAIL.
- [ ] **Step 3:** Re-point the three modules; keep the harness's measured phases and output shape.
- [ ] **Step 4:** `npm run test:capacity` and `npm run check`. Expected: PASS.
- [ ] **Step 5: Commit** `test: authority-core evaluation harness on a personal source`.

---

### Task 5: Remove the Slack approval internals and their tables

Slack approvals already stopped running in Task 3. Remove what only that lane used; keep the pieces Task 11 reuses.

**Files:**
- Delete (`providers/slack/server/src/private-approval/`): `private-slack-approval-terminal-coordinator-v1.ts`, `sqlite-private-slack-approval-assignment-state-v1.ts`, `sqlite-private-slack-approval-terminal-authority-v1.ts`, `sqlite-stable-private-approval-authority-fence-v1.ts`, `resolve-meeting-owner-private-slack-approval-reviewer-v1.ts`, `resolve-private-slack-approval-reviewer-target-v1.ts`, `private-slack-approval-workflow-bundle-v1.ts`.
- Split `private-slack-dm-approval-stager-v1.ts`: move the card-input builders (`frozenReview`, `ownerProposals`, `withoutProposedOwners`, `buildCardAndSnapshotV2` helpers, today `:112-244` and `:313-365`) into `providers/slack/server/src/private-approval/slack-approval-card-input-v1.ts`; delete the rest.
- Delete `providers/slack/server/src/processing/adapters/approval-resolution/slack/private-slack-block-v4-record-writer-v1.ts`.
- Delete (`providers/slack/server/src/organization-control-plane/`): `persistence/sqlite-slack-dm-approval-persistence-v1.ts`, `application/slack/private-approval-policy-resolution-v1.ts` and `-v2.ts` (move the 7-line `PrivateApprovalSlackIdentityLinkV1` type next to the link lookup first).
- Delete `packages/organization-control-plane/src/application/private-approval-policy-resolution-core-v1.ts` and `-v2.ts` (move `PRIVATE_APPROVAL_COMMENT_MAX_UTF16_CODE_UNITS` only if Task 11's card still needs it; it does not, since the note field goes).
- Interaction handler: keep verification and parsing (`private-slack-approval-interaction-handler-v1.ts:185-248`), remove receipt building and enqueue; until Task 12 the handler answers every approve or reject click with a fixed "This card is no longer active. Open the ECHO desktop app to review it." ephemeral reply and writes nothing. The route stays unmounted until Task 12.
- Control-plane baseline V4: rename `organization-control-plane-baseline-v3.sql` → `-v4.sql`, drop the four `organization_private_approval_*` tables and their triggers, bump constants and `verify-authority-state-lineage.ts`/state bootstrap pins, `packages/organization-control-plane/test/control-plane-baseline.test.ts`; delete `test/private-approval-schema.test.ts`, `test/private-approval-policy-resolution-core-v2.test.ts`; update `docs/architecture/organization-control-plane.md`.
- Authority V12: drop `authority_private_approval_assignments_v3`, `authority_private_approval_terminal_receipts_v3` and their triggers; remove the terminal-receipts clause from `supersedeUnresolvedLineageApprovals` in `sqlite-authority-meeting-processing-state-v1.ts`; update hash pins.
- Delete the meeting-approval journey telemetry port `packages/organization-processing/src/admitted-meeting-processing/meeting-approval-journey-telemetry-port-v1.ts` and its last call sites if Task 3 had to leave it for these files.
- Delete the Slack tests of removed files (`providers/slack/server/test/private-approval/*` for deleted modules, `test/organization-control-plane/*` for deleted modules, the record writer test, `services/organization-authority/test/composition/private-slack-approval-terminal-journey-recovery.test.ts`); move `test/fixtures/signed-slack-approval-v2.ts` users (`person-meeting-world.ts` and its four consumers) onto in-app approvals.

**Interfaces:**
- Produces: `slack-approval-card-input-v1.ts` exporting `frozenReviewV1(brief)`, `ownerProposalsV1(brief)`, `withoutProposedOwnersV1(brief)` (same behavior as today's private functions) for Task 7 and Task 11.

- [ ] **Step 1: Write the failing test** (`packages/organization-control-plane/test/control-plane-baseline.test.ts`):

```ts
it('has no private approval tables in baseline V4', () => {
  const db = new Database(':memory:');
  applyOrganizationControlBaselineV4(db);
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'organization_private_approval_%'").pluck().all();
  expect(names).toEqual([]);
});
```

- [ ] **Step 2:** Run it. Expected: FAIL.
- [ ] **Step 3:** Delete, split and bump as listed; update manifests and boundary lists.
- [ ] **Step 4:** `npm run check`. Expected: PASS.
- [ ] **Step 5: Commit** `refactor: remove Slack approval internals and their tables (Slack approvals paused)`.

---

### Task 6: One personal source per person and tool account; import suggestions

**Files:**
- Modify V12 SQL: replace `authority_person_meeting_sources_v1` with

```sql
CREATE TABLE authority_person_meeting_sources_v2 (
  source_key TEXT PRIMARY KEY REFERENCES authority_live_source_admission_v2(source_key),
  person_key TEXT NOT NULL CHECK (person_key LIKE 'sha256:%'),
  folder_id TEXT CHECK (folder_id IS NULL OR length(folder_id) BETWEEN 1 AND 256),
  folder_project_id TEXT REFERENCES authority_projects_v1(project_id),
  settings_revision INTEGER NOT NULL CHECK (settings_revision >= 0),
  CHECK ((folder_id IS NULL) = (folder_project_id IS NULL))
) STRICT;
CREATE UNIQUE INDEX authority_person_meeting_one_watch_v2 ON authority_person_meeting_sources_v2(person_key) WHERE folder_id IS NOT NULL;
CREATE TRIGGER authority_person_meeting_settings_ordered_v2
BEFORE UPDATE ON authority_person_meeting_sources_v2
WHEN NEW.source_key != OLD.source_key OR NEW.person_key != OLD.person_key
  OR NEW.settings_revision != OLD.settings_revision + 1
BEGIN SELECT RAISE(ABORT, 'personal meeting settings require ordered changes'); END;
CREATE TABLE authority_person_meeting_suggestions_v1 (
  source_key TEXT NOT NULL REFERENCES authority_person_meeting_sources_v2(source_key),
  external_id TEXT NOT NULL CHECK (length(external_id) BETWEEN 1 AND 256),
  project_id TEXT NOT NULL REFERENCES authority_projects_v1(project_id),
  created_at TEXT NOT NULL CHECK (unixepoch(created_at) IS NOT NULL),
  PRIMARY KEY (source_key, external_id, project_id)
) STRICT;
CREATE TRIGGER authority_person_meeting_suggestion_immutable_v1 BEFORE UPDATE ON authority_person_meeting_suggestions_v1
BEGIN SELECT RAISE(ABORT, 'meeting suggestion is immutable'); END;
CREATE TRIGGER authority_person_meeting_suggestion_delete_denied_v1 BEFORE DELETE ON authority_person_meeting_suggestions_v1
BEGIN SELECT RAISE(ABORT, 'meeting suggestion deletion is denied'); END;
```

- Modify: `person-meeting-intake-v1.ts` — `source_key = pms_<sha256({person, identity})>`; `ensure` no longer takes a project; `watch(setting, folder, folder_project_id, current)` checks the person is an active member of `folder_project_id`; `enqueue(setting, meetingId, project_id | null, current)` inserts a suggestion row when `project_id` is set (after the same membership check); `MeetingIntakeSettingV1` loses `project_id`, gains `folder_project_id`; `requireCurrent` checks the person only; `suggestions(source_key, external_id): readonly string[]`.
- Modify: `person-meeting-runtime-v1.ts` — no project suffix on `identity.instance_id`; processor instance id `personal-${canonicalSha256(person).slice(7, 39)}`; lane grant check uses the person only; `home.sources` rows `{source_key, folder_id, folder_project_id, baseline, pending_imports, checked_at, error}`; review row filter by person only. Keep meetings API v1 shapes otherwise (Task 9 moves to v2), mapping `home.sources[].project_id` to `folder_project_id` for now.
- Modify: `providers/granola/src/granola-folder-source-v1.ts` only if its instance-id check (`startsWith(instance + '-')`) must now accept the exact instance id (it already does).
- Test: `services/organization-authority/test/person-meeting-runtime-v1.test.ts`, `person-meeting-intake-v1.test.ts` (create if absent)

**Interfaces:**
- Produces: `SqlitePersonMeetingIntakeV1.suggestions(sourceKey: string, externalId: string): readonly string[]` (sorted project ids), consumed by Task 7's freeze.

- [ ] **Step 1: Write the failing test** ("one meeting, two projects" up to extraction):

```ts
it('imports one note into two projects as one source and one extraction', async () => {
  const world = await meetingWorld(); // fake provider, person in projects A and B
  await world.call({ operation: 'import', meeting_id: 'note-1', project_id: world.projectA, retain: true });
  await world.call({ operation: 'import', meeting_id: 'note-1', project_id: world.projectB, retain: true });
  await world.processUntilIdle();
  expect(world.db.prepare('SELECT count(*) FROM authority_person_meeting_sources_v2').pluck().get()).toBe(1);
  expect(world.extractions()).toBe(1);
  expect(world.db.prepare("SELECT count(*) FROM authority_live_approval_outbox_v2").pluck().get()).toBe(1);
  expect(world.intake.suggestions(world.sourceKey(), 'note-1')).toEqual([world.projectA, world.projectB].sort());
});
it('refuses an import suggestion for a project the person is not in', async () => {
  const world = await meetingWorld();
  await expect(world.call({ operation: 'import', meeting_id: 'note-1', project_id: world.foreignProject, retain: true })).rejects.toThrow();
  expect(world.db.prepare('SELECT count(*) FROM authority_person_meeting_suggestions_v1').pluck().get()).toBe(0);
});
```

- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement the schema, intake and runtime changes; update hash pins.
- [ ] **Step 4:** Run the tests, the Granola runtime tests and `npm run check`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: one personal meeting source per person and tool account, with project suggestions`.

---

### Task 7: Approval core — proposal freeze, decision table, `decide()`

**Files:**
- Create: `services/organization-authority/src/composition/approval-core-v1.ts`
- Delete: `services/organization-authority/src/composition/person-meeting-review-v1.ts` (its text renderer `personMeetingReviewTextV1` moves into `approval-core-v1.ts` as `approvalProposalTextV1`, unchanged except that it prints no owners)
- Modify V12 SQL:
  - Outbox `authority_live_approval_outbox_v2`: states `queued`, `staged`, `superseded`; columns `candidate_id, approval_id, stage_command_id, state, approved_snapshot_json, approved_snapshot_sha256, suggested_projects_json, superseded_by_candidate_id, superseded_at, updated_at`; CHECK: `queued` has no snapshot; `staged` has snapshot, hash and `suggested_projects_json` (a JSON array); `superseded` has `superseded_by_candidate_id` and `superseded_at` and may have a snapshot. Drop `provider_message_ts`, `frozen_card_sha256`, `private_approval_card_v2_json`, `post_started_at`, `control_approval_sha256`, `tombstoned_at`, the `private_card_v2_immutable` trigger and the ordered-transition trigger's posting states.
  - Drop `authority_live_approval_delivery_quarantines_v1` and its triggers.
  - Replace `authority_person_meeting_approval_actions_v1` with:

```sql
CREATE TABLE authority_approval_decisions_v1 (
  sequence INTEGER PRIMARY KEY,
  approval_id TEXT NOT NULL UNIQUE REFERENCES authority_live_approval_outbox_v2(approval_id),
  command_id TEXT NOT NULL UNIQUE CHECK (length(command_id) BETWEEN 1 AND 128),
  surface TEXT NOT NULL CHECK (surface IN ('desktop', 'slack')),
  action TEXT NOT NULL CHECK (action IN ('approve', 'reject')),
  body_json TEXT NOT NULL CHECK (json_valid(body_json) AND json_type(body_json) = 'object'
    AND json_extract(body_json, '$.request.action') = action),
  receipt_json TEXT CHECK (receipt_json IS NULL OR (json_valid(receipt_json) AND json_type(receipt_json) = 'object')),
  CHECK (receipt_json IS NULL OR action = 'approve')
) STRICT;
CREATE TRIGGER authority_approval_decision_immutable_v1
BEFORE UPDATE ON authority_approval_decisions_v1
WHEN NEW.sequence != OLD.sequence OR NEW.approval_id != OLD.approval_id OR NEW.command_id != OLD.command_id
  OR NEW.surface != OLD.surface OR NEW.action != OLD.action OR NEW.body_json != OLD.body_json
  OR OLD.receipt_json IS NOT NULL OR NEW.receipt_json IS NULL
BEGIN SELECT RAISE(ABORT, 'approval decision is immutable'); END;
CREATE TRIGGER authority_approval_decision_delete_denied_v1
BEFORE DELETE ON authority_approval_decisions_v1
BEGIN SELECT RAISE(ABORT, 'approval decision deletion is denied'); END;
```

- Modify: `packages/organization-processing/src/admitted-meeting-processing/approval-workflow-state-v1.ts` — remove `prepareApprovalPost`, `releaseApprovalPostAttempt`, `recordPostedApprovalCard`, `markControlPlaneStaged`, `recordSupersededApprovalCardTombstoned`, `listPendingSupersededApprovalCards`, `readDurableCardStagedAt`, quarantine methods; add `freezeProposal`. Matching edits in `sqlite-authority-meeting-processing-state-v1.ts` (supersession now skips only proposals with a row in `authority_approval_decisions_v1`), `meeting-processing-cycle-v1.ts` (`ApprovalWorkflowStageResultV1` keeps `staged | revoked | state_drift`; remove `delivery_pending` and `quarantined` handling), and `ApprovalWorkflowOutboxV1` fields.
- Modify: `person-meeting-runtime-v1.ts` — one `createApprovalCoreV1` per runtime; the stager comes from the core; the `review` operation calls `core.decide('desktop', …)` mapping today's v1 request (`project_id` → `project_ids: project_id === null ? [] : [project_id]`, `owners: []`) until Task 9; `review_open` uses `approvalProposalTextV1`.
- Keep `appendPending` working by moving it into the core unchanged in behavior except that it reads `authority_approval_decisions_v1` and supports several project ids (the in-app V1 reference already carries arrays). Task 8 replaces it.
- Test: `services/organization-authority/test/approval-core-v1.test.ts` (new; replaces `person-meeting-review-v1.test.ts`), fixture `test/fixtures/person-meeting-review.ts` → `test/fixtures/approval-core.ts`

**Interfaces:**

```ts
// approval-core-v1.ts
export type ApprovalSurfaceV1 = 'desktop' | 'slack';
export interface ApprovalActorV1 { readonly organization_id: string; readonly principal_id: string; readonly membership_id: string }
export interface ApprovalOwnerChoiceV1 { readonly signal_id: string; readonly owner: string }
export interface ApprovalDecisionRequestV1 {
  readonly approval_id: string; readonly command_id: string; readonly snapshot_sha256: Sha256Digest;
  readonly action: 'approve' | 'reject'; readonly project_ids: readonly string[];
  readonly share_transcript: boolean; readonly owners: readonly ApprovalOwnerChoiceV1[];
}
export interface ApprovalAuthorizationV1 {
  readonly actor: ApprovalActorV1;
  /** Digest of the evidence that authorized this decision: the person session, or the verified Slack click and link. */
  readonly evidence: { readonly kind: 'person-session' | 'slack-click'; readonly sha256: Sha256Digest };
}
export type ApprovalStatusV1 = 'pending' | 'publishing' | 'approved' | 'rejected' | 'superseded';
export type ApprovalDecideResultV1 =
  | { readonly kind: 'decided'; readonly status: 'publishing' | 'rejected'; readonly surface: ApprovalSurfaceV1 }
  | { readonly kind: 'replayed'; readonly status: 'publishing' | 'approved' | 'rejected'; readonly surface: ApprovalSurfaceV1 }
  | { readonly kind: 'already_decided'; readonly status: 'publishing' | 'approved' | 'rejected'; readonly surface: ApprovalSurfaceV1 }
  | { readonly kind: 'stale' };
export interface ApprovalOwnerProposalV1 { readonly signal_id: string; readonly action: string; readonly proposed: string }
export interface ApprovalProposalViewV1 {
  readonly approval_id: string; readonly reviewer: ApprovalActorV1; readonly title: string;
  readonly status: ApprovalStatusV1; readonly decided_on: ApprovalSurfaceV1 | null;
  readonly project_ids: readonly string[];          // the decision's, or the suggestions while pending
  readonly snapshot_sha256: Sha256Digest | null; readonly snapshot_json: string | null;
}
export interface ApprovalCoreV1 {
  readonly stager: ApprovalWorkflowStagerV1;        // freeze; reconcileSuperseded is a no-op (presenters redraw)
  readonly processing: ApprovalWorkflowProcessingV1; // publisher (Task 8 replaces the body)
  decide(surface: ApprovalSurfaceV1, request: ApprovalDecisionRequestV1, authorize: () => ApprovalAuthorizationV1): ApprovalDecideResultV1;
  proposal(approvalId: string): ApprovalProposalViewV1 | undefined;
  proposals(reviewer: ApprovalActorV1, limit?: number): readonly ApprovalProposalViewV1[];
  ownerProposals(approvalId: string): readonly ApprovalOwnerProposalV1[];
}
export function createApprovalCoreV1(database: Database.Database, context: ApprovalWorkflowContextV1, options: {
  readonly suggestions: (sourceKey: string, externalId: string, folderProjectId: string | null) => readonly string[];
  readonly projects: (actor: ApprovalActorV1, projectIds: readonly string[]) => void; // throws 'unauthorized' unless every project is active and the actor an active member
}): Promise<ApprovalCoreV1>;
export function approvalProposalTextV1(snapshotJson: string): string;
```

Rules `decide` must implement (spec 1 section 3): authorize inside one `.immediate()` transaction and again right before the insert; actor must equal the proposal's source admission person with an active membership; replay of the same `command_id` and canonical request returns `replayed`; any other existing decision returns `already_decided` (no throw, nothing written); `state !== 'staged'` or a snapshot mismatch returns `stale`; approve validates `project_ids` (≤ 20, sorted, unique, `options.projects` passes) and owners (each `signal_id` names a proposed action once, owner 1–120 chars after trim, no control characters); reject requires empty projects, `share_transcript: false`, no owners (`invalid_request` otherwise). The body is `{request, surface, actor, evidence, decided_at}`. The wake (`context.on_terminal_action_queued`) runs after commit and its failure is swallowed.

Freeze rules: the snapshot is built once (`surface: 'echo-approval-core'`, brief from `compileDecisionBrief` passed through `withoutProposedOwnersV1` from Task 5); `suggested_projects_json` = sorted union of `intake.suggestions(source, external_id)` and the source's `folder_project_id` when it is set, at most 20; `queued → staged` in one statement. Owner proposals come from `ownerProposalsV1` over the candidate's uncleared brief.

- [ ] **Step 1: Write the failing tests** (`approval-core-v1.test.ts`):

```ts
it('freezes a snapshot without proposed owners and offers them as proposals', async () => {
  const f = await approvalCoreFixture({ owners: { 'act-1': 'Rafael Moreno' } });
  const snapshot = JSON.parse(f.core.proposal(f.approvalId)!.snapshot_json!);
  expect(snapshot.approved_payload.brief.actions.every((a: { owner: unknown }) => a.owner === null)).toBe(true);
  expect(f.core.ownerProposals(f.approvalId)).toEqual([{ signal_id: 'act-1', action: expect.any(String), proposed: 'Rafael Moreno' }]);
});
it('lets the first decision win across surfaces and reports where it was made', async () => {
  const f = await approvalCoreFixture();
  const desktop = f.core.decide('desktop', f.approve({ command_id: 'desk-1' }), () => f.session);
  const slack = f.core.decide('slack', f.approve({ command_id: 'slack:abc' }), () => f.click);
  expect(desktop).toMatchObject({ kind: 'decided', status: 'publishing', surface: 'desktop' });
  expect(slack).toMatchObject({ kind: 'already_decided', status: 'publishing', surface: 'desktop' });
  expect(f.db.prepare('SELECT count(*) FROM authority_approval_decisions_v1').pluck().get()).toBe(1);
});
it('replays the same command and refuses a changed one', async () => {
  const f = await approvalCoreFixture();
  f.core.decide('desktop', f.approve({ command_id: 'desk-1' }), () => f.session);
  expect(f.core.decide('desktop', f.approve({ command_id: 'desk-1' }), () => f.session).kind).toBe('replayed');
  expect(f.core.decide('desktop', f.approve({ command_id: 'desk-1', share_transcript: true }), () => f.session).kind).toBe('already_decided');
});
it('refuses a project the approver lost and writes nothing', async () => {
  const f = await approvalCoreFixture({ projects: 2 });
  f.removeProjectMembership(f.projectB);
  expect(() => f.core.decide('desktop', f.approve({ project_ids: [f.projectA, f.projectB].sort() }), () => f.session)).toThrow(/unauthorized|not available/);
  expect(f.db.prepare('SELECT count(*) FROM authority_approval_decisions_v1').pluck().get()).toBe(0);
});
it('refuses someone other than the reviewer', async () => {
  const f = await approvalCoreFixture();
  expect(() => f.core.decide('desktop', f.approve(), () => ({ ...f.session, actor: { ...f.session.actor, membership_id: 'mem_00000000-0000-4000-8000-000000000099' } }))).toThrow('not available');
});
it('validates owners and audience', async () => {
  const f = await approvalCoreFixture({ owners: { 'act-1': 'Rafael Moreno' } });
  for (const bad of [
    { owners: [{ signal_id: 'act-404', owner: 'X' }] },
    { owners: [{ signal_id: 'act-1', owner: 'A' }, { signal_id: 'act-1', owner: 'B' }] },
    { owners: [{ signal_id: 'act-1', owner: ' padded ' }] },
    { owners: [{ signal_id: 'act-1', owner: 'x'.repeat(121) }] },
    { project_ids: Array.from({ length: 21 }, (_, i) => `prj_00000000-0000-4000-8000-${String(i).padStart(12, '0')}`) },
  ]) expect(() => f.core.decide('desktop', f.approve(bad), () => f.session)).toThrow();
  expect(() => f.core.decide('desktop', f.reject({ project_ids: [f.projectA] }), () => f.session)).toThrow();
});
it('supersedes an undecided proposal on a new revision but keeps a decided one', async () => {
  const f = await approvalCoreFixture();
  await f.newRevision();
  expect(f.core.proposal(f.approvalId)!.status).toBe('superseded');
  const g = await approvalCoreFixture();
  g.core.decide('desktop', g.approve(), () => g.session);
  const next = await g.newRevision();
  expect(g.core.proposal(g.approvalId)!.status).toBe('publishing');
  expect(next.approvalId).not.toBe(g.approvalId);
  expect(g.core.proposal(next.approvalId)!.status).toBe('pending');
});
it('freezes the suggested projects the import recorded', async () => {
  const f = await approvalCoreFixture({ suggestions: 2 });
  expect(f.core.proposal(f.approvalId)!.project_ids).toEqual([f.projectA, f.projectB].sort());
});
```

- [ ] **Step 2:** Run. Expected: FAIL (module missing).
- [ ] **Step 3:** Implement the core, the schema, the state port changes and the runtime wiring; delete `person-meeting-review-v1.ts` and its test (its publication tests move to `approval-core-v1.test.ts` and keep passing on the old in-app reference until Task 8). Update hash pins.
- [ ] **Step 4:** Run the new test file, `services/organization-authority/test/person-meeting-runtime-v1.test.ts`, the processing package tests, and `npm run check`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: approval core with one proposal per meeting and a shared decision table`.

---

### Task 8: Neutral proof, one publisher and the after-record hook

**Files:**
- Create: `packages/organization-protocol/src/approval-decision-record-input-v1.ts` (export from `packages/organization-protocol/src/index.ts`)
- Create: `services/organization-authority/src/composition/approval-decision-projection-v1.ts` (policy projector + approver projector)
- Create: `services/organization-authority/src/composition/approval-publisher-v1.ts` (moved out of the core; the core's `processing` delegates to it)
- Delete: `packages/organization-protocol/src/person-meeting-approval-record-input-v1.ts`, `services/organization-authority/src/composition/person-meeting-approval-projection-v1.ts`, Slack codecs `providers/slack/server/src/organization-protocol/private-slack-block-approval-record-input-v1.ts` and `-v2.ts`, Slack projectors under `providers/slack/server/src/organization-record/adapters/record-policy-projection/slack/`, their tests (`providers/slack/server/test/organization-record/private-slack-record-append.test.ts` and others) and exports/manifests
- Modify: `services/organization-authority/src/composition/organization-authority-composition-root.ts` (`RECORD_INPUT_CODECS` = human-act V1 + approval decision V1; projectors = person policy V2 + approval decision; approver projectors = approval decision)
- Modify owner readers: `services/organization-authority/src/composition/person-meeting-items-v1.ts` (`confirmedOwners`), `packages/organization-record/src/retrieve/record-retrieval-source-snapshot-v1.ts` (`confirmedOwners`) — read `action_owners` from the new reference kind
- Modify every remaining reader of the removed kinds (`grep -rn "private-slack-block-approval-resolution-ref\|person-meeting-approval-resolution-ref" --include='*.ts'`)
- Test: `packages/organization-protocol/test/approval-decision-record-input-v1.test.ts`, `services/organization-authority/test/approval-publisher-v1.test.ts`, search snapshot owner test

**Interfaces:**

```ts
// approval-decision-record-input-v1.ts
export const APPROVAL_DECISION_REF_KIND_V1 = 'echo-approval-decision-ref-v1';
export const APPROVAL_DECISION_CONSEQUENCE_KIND_V1 = 'echo-approval-decision-consequence-v1';
export const APPROVAL_DECISION_FIELD_V1 = 'approval_decision_ref_v1';
export interface ApprovalDecisionRefV1 {
  readonly schema_version: 1; readonly kind: typeof APPROVAL_DECISION_REF_KIND_V1;
  readonly authority_id: string; readonly organization_id: string; readonly state_lineage_id: string;
  readonly approval_id: string; readonly command_id: string; readonly action: 'approve'; readonly surface: 'desktop' | 'slack';
  readonly candidate_sha256: Sha256Digest; readonly approved_snapshot_sha256: Sha256Digest;
  readonly final_approver: { readonly principal_id: string; readonly membership_id: string };
  readonly selected_policy_id: MeetingApprovedEventV2['policy_id']; readonly policy_contract_sha256: Sha256Digest; readonly policy_consequence_sha256: Sha256Digest;
  readonly audience_project_ids: readonly string[]; readonly association_project_ids: readonly string[];
  readonly share_transcript: boolean; readonly transcript_source: MeetingApprovedEventV2['policy_consequence']['transcript_source'];
  /** Confirmed owners by approved action signal id, in brief order, each once (the Slack V3 shape). */
  readonly action_owners: readonly { readonly signal_id: string; readonly owner: string }[];
  readonly audit_event_id: string; readonly audit_sequence: number; readonly audit_entry_sha256: Sha256Digest;
  readonly provider_action_kind: 'echo-approval-decision-v1'; readonly provider_action_schema_version: 1;
  readonly provider_action_sha256: Sha256Digest; readonly authorization_proof_sha256: Sha256Digest; readonly approved_at: string;
}
export function validateApprovalDecisionRecordInputV1(value: unknown): { readonly approval_decision_ref_v1: ApprovalDecisionRefV1; readonly event: MeetingApprovedEventV2; readonly semantic_idempotency_key: Sha256Digest };
export const APPROVAL_DECISION_RECORD_INPUT_CODEC_V1: RecordInputCodecV4;
```

The validator follows `person-meeting-approval-record-input-v1.ts` (exact keys, identifier pattern, digests, event cross-checks) and adds: `surface` is `desktop` or `slack`; `action_owners` names approved-snapshot action signal ids in brief order, each at most once, owners 1–120 characters, trimmed, no control characters; the approved snapshot's actions carry no owner.

```ts
// approval-publisher-v1.ts
export interface AfterApprovedRecordEventV1 {
  readonly approval_id: string; readonly record_sha256: Sha256Digest;
  readonly reviewer: ApprovalActorV1; readonly decided_at: string;
}
/** Runs inside the Authority transaction that writes the receipt. May write Authority rows only; must not await. */
export type AfterApprovedRecordHookV1 = (transaction: Database.Database, event: AfterApprovedRecordEventV1) => void;
export function createApprovalPublisherV1(database: Database.Database, context: ApprovalWorkflowContextV1, hooks: readonly AfterApprovedRecordHookV1[]): ApprovalWorkflowProcessingV1;
```

`createApprovalCoreV1` gains `options.after_record?: readonly AfterApprovedRecordHookV1[]` and passes them to the publisher. Publisher order (spec 1 section 4): build event and reference; `record_append.append(...)` (witness `{decision, evidence, audit}`, checked by the new projector); then `database.transaction(() => { UPDATE receipt_json …; for (const hook of hooks) hook(database, event); }).immediate()`; then the existing wake for search and presentation. `record_sha256` comes from the append receipt.

- [ ] **Step 1: Write the failing tests.**

```ts
// approval-publisher-v1.test.ts
it.each([[[]], [['A']], [['A', 'B']]])('publishes the exact audience and owners (projects %j)', async (names) => {
  const f = await approvalCoreFixture({ projects: 2, owners: { 'act-1': 'Rafael Moreno', 'act-2': 'Jules Ortega' } });
  const project_ids = names.map(n => f.project(n)).sort();
  f.core.decide('desktop', f.approve({ project_ids, owners: [{ signal_id: 'act-1', owner: 'Rafael M.' }] }), () => f.session);
  await f.core.processing.appendFinalizedApprovalsToV4(new AbortController().signal);
  const ref = f.lastRecord().body.human_act_resolution_ref;
  expect(ref.kind).toBe('echo-approval-decision-ref-v1');
  expect(ref.surface).toBe('desktop');
  expect(ref.audience_project_ids).toEqual(project_ids);
  expect(ref.association_project_ids).toEqual(project_ids);
  expect(ref.action_owners).toEqual([{ signal_id: 'act-1', owner: 'Rafael M.' }]); // act-2 cleared, so absent
});
it('runs every hook once inside the receipt transaction, even after a crash between append and receipt', async () => {
  const calls: unknown[] = [];
  const f = await approvalCoreFixture({ after_record: [(tx, event) => { expect(tx.inTransaction).toBe(true); calls.push(event); }] });
  f.core.decide('desktop', f.approve(), () => f.session);
  const interrupted = await f.withAppend(async (input, append) => { await append(input); throw new Error('crash after append'); });
  await expect(interrupted.processing.recoverV4Appends(new AbortController().signal)).rejects.toThrow('crash');
  expect(calls).toHaveLength(0);
  await f.core.processing.recoverV4Appends(new AbortController().signal);
  await f.core.processing.recoverV4Appends(new AbortController().signal);
  expect(f.recordCount()).toBe(1);
  expect(calls).toEqual([expect.objectContaining({ approval_id: f.approvalId, record_sha256: expect.stringMatching(/^sha256:/) })]);
});
it('writes no record and runs no hook for a rejection', async () => {
  const calls: unknown[] = [];
  const f = await approvalCoreFixture({ after_record: [(_tx, e) => calls.push(e)] });
  f.core.decide('desktop', f.reject(), () => f.session);
  await f.core.processing.appendFinalizedApprovalsToV4(new AbortController().signal);
  expect(f.recordCount()).toBe(0);
  expect(calls).toEqual([]);
});
```

```ts
// record-retrieval-source-snapshot owner test (add next to the existing confirmed-owner test)
it('indexes confirmed owners from an approval decision reference', () => {
  // build a record with action_owners [{signal_id:'act-1', owner:'Rafael M.'}]; the snapshot text is "<action> Owner: Rafael M."
});
```

Protocol tests: a valid reference round-trips; a reference whose `action_owners` repeats a signal id, names an unknown one, is out of brief order, or whose snapshot carries an owner is refused.

- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement the codec, projectors, publisher and hooks; register in the composition root; delete the old codecs, projectors and tests; update owner readers.
- [ ] **Step 4:** `npm run check`. Expected: PASS. `grep -rn "person-meeting-approval-resolution-ref\|private-slack-block-approval-resolution-ref" --include='*.ts' .` returns nothing.
- [ ] **Step 5: Commit** `feat: neutral approval proof, one publisher and the after-record hook`.

---

### Task 9: Meetings API v2 and server route

**Files:**
- Modify: `packages/organization-api/src/person-meetings-v1.ts` (keep the file and path; `schema_version: 2`; types and validators below)
- Modify: `services/organization-authority/src/composition/person-meeting-runtime-v1.ts` (operations on the core)
- Modify: `src/product/person-client/composition.ts` if it pins the schema version
- Test: `packages/organization-api/test/person-meetings-v1.test.ts` (create), `services/organization-authority/test/person-meeting-runtime-v1.test.ts`

**Interfaces:**

```ts
export type PersonMeetingOperationV2 =
  | { readonly operation: 'home' } | { readonly operation: 'reviews' }
  | { readonly operation: 'browse'; readonly folder_id: string } | { readonly operation: 'open'; readonly meeting_id: string }
  | { readonly operation: 'watch'; readonly folder_id: string | null; readonly project_id: string | null; readonly settings_sha256: string; readonly retain: true }
  | { readonly operation: 'import'; readonly meeting_id: string; readonly project_id: string | null; readonly retain: true }
  | { readonly operation: 'cancel_import'; readonly source_key: string; readonly meeting_id: string }
  | { readonly operation: 'review_open'; readonly approval_id: string }
  | { readonly operation: 'review'; readonly approval_id: string; readonly command_id: string; readonly snapshot_sha256: string;
      readonly action: 'approve' | 'reject'; readonly project_ids: readonly string[]; readonly share_transcript: boolean;
      readonly owners: readonly { readonly signal_id: string; readonly owner: string }[] };
export type PersonMeetingRequestV2 = PersonMeetingOperationV2 & { readonly schema_version: 2; readonly tool_id: string };
export interface PersonMeetingReviewV2 {
  readonly approval_id: string; readonly title: string; readonly project_ids: readonly string[];
  readonly status: 'pending' | 'publishing' | 'approved' | 'rejected' | 'superseded'; readonly decided_on: 'desktop' | 'slack' | null;
}
export interface PersonMeetingResultsV2 {
  home: { readonly connected: boolean; readonly email: string | null; readonly workspace: string | null;
    readonly folders: readonly { readonly id: string; readonly title: string; readonly count: number }[]; readonly settings_sha256: string;
    readonly sources: readonly { readonly source_key: string; readonly folder_id: string | null; readonly folder_project_id: string | null; readonly baseline: boolean;
      readonly pending_imports: readonly string[]; readonly checked_at: string | null; readonly error: string | null }[] };
  browse: { readonly meetings: readonly { readonly id: string; readonly title: string; readonly date: string }[] };
  open: { readonly id: string; readonly title: string; readonly notes: string; readonly summary: string; readonly truncated: boolean };
  watch: { readonly status: 'saved' }; import: { readonly status: 'queued' }; cancel_import: { readonly status: 'cancelled' };
  reviews: { readonly reviews: readonly PersonMeetingReviewV2[] };
  review_open: { readonly review: PersonMeetingReviewV2; readonly snapshot_sha256: string; readonly content: string;
    readonly owners: readonly { readonly signal_id: string; readonly action: string; readonly proposed: string }[];
    readonly suggested_projects: readonly { readonly project_id: string; readonly name: string }[] };
  review: { readonly status: 'publishing' | 'approved' | 'rejected'; readonly decided_on: 'desktop' | 'slack' };
}
export function validatePersonMeetingRequestV2(value: unknown): PersonMeetingRequestV2;
export function validatePersonMeetingResultV2<K extends keyof PersonMeetingResultsV2>(operation: K, value: unknown): PersonMeetingResultsV2[K];
export const personMeetingCommandV2; // replaces personMeetingCommandV1, same timeout and caps
```

Rename the V1 exports to V2 (no V1 left). Validation: `project_ids` ≤ 20, sorted, unique, each `validateProjectIdV1`; `owners` ≤ 40, unique `signal_id` (1–128 chars), owner 1–120 chars trimmed, no control characters; reject requires `project_ids: []`, `share_transcript: false`, `owners: []`; `suggested_projects` ≤ 20; `owners` result ≤ 40, each line ≤ 300. Response cap stays 120 KB. Server: `review` maps `already_decided` to its existing `{status, decided_on}` (HTTP 200) and `stale` to `stale_access_state` "Meeting review has changed"; `suggested_projects` lists only projects the reviewer is an active member of, with names; `reviews` rows use the core's `proposals(reviewer)`.

- [ ] **Step 1: Write the failing tests** (validator table tests for each rule above; route tests):

```ts
it('approves into two projects with a confirmed owner through the route', async () => {
  const world = await meetingWorld({ projects: 2, owners: { 'act-1': 'Rafael Moreno' } });
  const opened = await world.call({ operation: 'review_open', approval_id: world.approvalId });
  expect(opened.owners).toEqual([{ signal_id: 'act-1', action: expect.any(String), proposed: 'Rafael Moreno' }]);
  const result = await world.call({ operation: 'review', approval_id: world.approvalId, command_id: 'c1', snapshot_sha256: opened.snapshot_sha256,
    action: 'approve', project_ids: [world.projectA, world.projectB].sort(), share_transcript: false, owners: [{ signal_id: 'act-1', owner: 'Rafael Moreno' }] });
  expect(result).toEqual({ status: 'publishing', decided_on: 'desktop' });
});
it('returns the earlier decision when Slack decided first', async () => {
  const world = await meetingWorld();
  world.core.decide('slack', world.approveRequest({ command_id: 'slack:k' }), () => world.slackClick);
  const opened = await world.call({ operation: 'review_open', approval_id: world.approvalId });
  expect(opened.review.decided_on).toBe('slack');
  const result = await world.call({ operation: 'review', approval_id: world.approvalId, command_id: 'c2', snapshot_sha256: opened.snapshot_sha256,
    action: 'reject', project_ids: [], share_transcript: false, owners: [] });
  expect(result).toEqual({ status: 'publishing', decided_on: 'slack' });
});
```

- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement the contract and route.
- [ ] **Step 4:** Run `npm run test:protocols`, the runtime tests and `npm run check` (the desktop typecheck will fail until Task 10 only if the desktop imports V1 names; update the desktop's imports and fixture authority to V2 names in this task, keeping its UI unchanged: single-project selection mapped to `project_ids`, `owners: []`).
- [ ] **Step 5: Commit** `feat: meetings API v2 for multi-project audiences, owners and decided_on`.

---

### Task 10: Desktop review card with projects and owners

**Files:**
- Create: `product/echo-desktop/src/renderer/screens/project-picker.tsx` (controlled multi-project list extracted from `compose.tsx` `ProjectList`: search box after 8 projects, checkboxes, "More projects", cap 20)
- Modify: `product/echo-desktop/src/renderer/screens/compose.tsx` (use the picker; behavior unchanged)
- Modify: `product/echo-desktop/src/renderer/screens/meetings.tsx` (card: content, **Who can read it** Only me / Projects with the picker pre-ticked from `suggested_projects`, **Share the transcript** off, owner fields, Approve/Reject; list shows status and "Approved in Slack" / "Approved on the desktop"; on `decided_on` ≠ `desktop` after a click show "Already approved in Slack" or "Already rejected in Slack" and refresh)
- Modify: `product/echo-desktop/src/renderer/store.ts` (`meetingCommand` request types V2; review state holds `project_ids`, `owners`), `src/host/host.ts`, `src/shared/protocol.ts`, `src/host/test-authority.ts` (fixture: `review_open` returns two owners and one suggested project; `review` records the body; mode `granola-decided-in-slack` returns `decided_on: 'slack'`), `src/renderer/styles.css`
- Test: `product/echo-desktop/test/e2e/tools.spec.ts`, `product/echo-desktop/test/unit/*` for the picker if a unit harness exists

**Interfaces:**
- Consumes: Task 9's V2 types.
- Produces: `ProjectPicker` props `{ projects: readonly ProjectSummary[]; ticked: readonly string[]; onTick(id: string): void; onMore(): void; more: boolean; max: number }`.

- [ ] **Step 1: Write the failing e2e tests** (extend `tools.spec.ts`):

```ts
test('approves a meeting into two projects with an edited owner', async () => {
  const app = await launch('granola');
  // open the Granola sheet, open the pending review
  await app.page.getByRole('radio', { name: 'Projects' }).check();
  await expect(app.page.getByRole('checkbox', { name: 'Thermostat redesign' })).toBeChecked(); // suggested
  await app.page.getByRole('checkbox', { name: 'Supplier review' }).check();
  await app.page.getByLabel('Owner for: Send the revised quote').fill('Rafael M.');
  await app.page.getByLabel('Owner for: Confirm the trace').fill('');
  await app.page.getByRole('button', { name: 'Approve' }).click();
  const body = (await app.calls()).find(c => c.request?.operation === 'review')!.request;
  expect(body).toMatchObject({ action: 'approve', share_transcript: false, owners: [{ signal_id: 'act-1', owner: 'Rafael M.' }] });
  expect(body.project_ids).toHaveLength(2);
});
test('shows that the meeting was already approved in Slack', async () => {
  const app = await launch('granola-decided-in-slack');
  // approve → "Already approved in Slack" is visible and the list shows the Slack status
});
```

Update the existing review test (`tools.spec.ts:129-153`) to assert `{action:'approve', share_transcript:false, project_ids:[], owners:[...]}`.

- [ ] **Step 2:** `npm run -w product/echo-desktop test:e2e -- tools.spec.ts` (or the workspace's e2e script; see `product/echo-desktop/package.json`). Expected: FAIL.
- [ ] **Step 3:** Implement the picker, card and fixture changes. Keep copy exactly as in spec 1 section 5.
- [ ] **Step 4:** Run desktop unit + e2e and `npm run check`. Expected: PASS. If Playwright cannot launch Electron, apply the known fix (remove `node_modules/electron/dist` and run `node node_modules/electron/install.js` outside the sandbox) and report it.
- [ ] **Step 5: Commit** `feat: desktop meeting card with project audience and confirmed owners`.

---

### Task 11: Slack plug-in — shown-on table, card V4 and presenter

**Files:**
- Modify V12 SQL:

```sql
CREATE TABLE authority_approval_presentations_v1 (
  approval_id TEXT NOT NULL REFERENCES authority_live_approval_outbox_v2(approval_id),
  surface TEXT NOT NULL CHECK (surface = 'slack'),
  target_json TEXT NOT NULL CHECK (json_valid(target_json) AND json_type(target_json) = 'object'),
  delivery TEXT NOT NULL CHECK (delivery IN ('posting', 'posted', 'unrepresentable', 'failed')),
  message_ts TEXT CHECK (message_ts IS NULL OR length(message_ts) BETWEEN 1 AND 64),
  card_sha256 TEXT CHECK (card_sha256 IS NULL OR card_sha256 LIKE 'sha256:%'),
  shows TEXT NOT NULL CHECK (shows IN ('open', 'approved', 'rejected', 'superseded')),
  attempts INTEGER NOT NULL CHECK (attempts >= 0),
  retry_at TEXT CHECK (retry_at IS NULL OR unixepoch(retry_at) IS NOT NULL),
  created_at TEXT NOT NULL CHECK (unixepoch(created_at) IS NOT NULL),
  updated_at TEXT NOT NULL CHECK (unixepoch(updated_at) IS NOT NULL),
  PRIMARY KEY (approval_id, surface),
  CHECK ((delivery = 'posted') = (message_ts IS NOT NULL)),
  CHECK (delivery = 'posted' OR shows = 'open')
) STRICT;
CREATE TRIGGER authority_approval_presentation_target_immutable_v1
BEFORE UPDATE ON authority_approval_presentations_v1
WHEN NEW.approval_id != OLD.approval_id OR NEW.surface != OLD.surface OR NEW.target_json != OLD.target_json
  OR (OLD.message_ts IS NOT NULL AND NEW.message_ts IS NOT OLD.message_ts)
BEGIN SELECT RAISE(ABORT, 'approval presentation target is immutable'); END;
CREATE TRIGGER authority_approval_presentation_delete_denied_v1
BEFORE DELETE ON authority_approval_presentations_v1
BEGIN SELECT RAISE(ABORT, 'approval presentation deletion is denied'); END;
```

- Create: `providers/slack/server/src/private-approval/slack-approval-card-v4.ts` (builds on the V1 review blocks; audience select Only me / Projects; project multi-select ≤ 100 options, ≤ 20 selected, `initial_options` = suggested projects the reviewer can read; transcript checkbox; owner input per proposal (from `ownerProposalsV1`); Approve/Reject buttons with value `{"schema_version":2,"approval_id":…,"snapshot_sha256":…}`; closed-card builder `buildClosedApprovalCardV4({title, outcome: 'approved'|'rejected'|'superseded', surface, audience_label})` with texts "Approved in the ECHO desktop", "Approved in Slack", "Rejected in the ECHO desktop", "Rejected in Slack", "Replaced by a newer version of this meeting")
- Create: `providers/slack/server/src/private-approval/slack-approval-presenter-v1.ts`
- Modify: poster (`providers/slack/server/src/processing/adapters/approval-delivery/slack/private-slack-approval-card-poster-v1.ts`) only as needed to post/update V4 blocks; keep its marker, retry and auth-failure rules
- Modify: lifecycle and runtime so `reconcileApprovalPresentations` of the personal processing runs (today only `dependencies.processing` gets it: `organization-authority-service-lifecycle.ts:278, 297`); the composition root passes the Slack presenter to the personal runtime when Slack is configured (`composeSlackV1` token source, health, link lookup)
- Delete: `private-slack-approval-block-kit-card-v1.ts` V1 controls and `-card-v2.ts` V2/V3 builders once nothing imports them (keep the review-section renderer)
- Test: `providers/slack/server/test/private-approval/slack-approval-presenter-v1.test.ts`, `slack-approval-card-v4.test.ts`

**Interfaces:**

```ts
export interface ApprovalPresenterV1 {
  /** Bounded: posts new cards and redraws decided or superseded ones. Never needed for a decision or record to be durable. */
  reconcile(signal: AbortSignal): Promise<'rendered' | 'idle' | 'uncertain'>;
}
export function createSlackApprovalPresenterV1(options: {
  readonly database: Database.Database;                  // authority.sqlite
  readonly core: Pick<ApprovalCoreV1, 'proposal' | 'ownerProposals'>;
  readonly target: (reviewer: ApprovalActorV1) => SlackApprovalTargetV1 | null; // active link on the active connection, else null
  readonly poster: SlackApprovalPosterV1;                // open DM, post, update (today's poster)
  readonly projects: (reviewer: ApprovalActorV1) => readonly { readonly project_id: string; readonly name: string }[];
  readonly now?: () => Date;
}): ApprovalPresenterV1;
export interface SlackApprovalTargetV1 {
  readonly connection_id: string; readonly external_identity_link_id: string; readonly external_identity_link_contract_sha256: string;
  readonly slack_workspace_id: string; readonly slack_subject_id: string; readonly api_app_id: string;
}
```

The `ApprovalCoreV1` interface gains `presenters?: readonly ApprovalPresenterV1[]` in its options and `processing.reconcileApprovalPresentations` runs each presenter in turn.

Presenter rules (spec 1 section 5): post for staged, undecided proposals with no Slack row and a non-null target (insert `posting` first, then post, then `posted` with `message_ts`; a crash while `posting` uses the poster's marker reconcile, never a blind repost); unrepresentable cards (block limits) are marked and never retried; redraw posted rows whose proposal is decided or superseded and whose `shows` differs; failures back off (`attempts`, `retry_at`, at most 5 attempts → `failed`); a reviewer without a link gets no row; a reviewer who links later gets open proposals on the next pass.

- [ ] **Step 1: Write the failing tests** (fake poster records calls):

```ts
it('posts one DM card to a linked reviewer and none to an unlinked one', async () => {
  const f = await presenterFixture({ linked: ['alice'], proposals: ['alice', 'bob'] });
  await f.presenter.reconcile(signal());
  expect(f.poster.posts.map(p => p.subject)).toEqual(['U_ALICE']);
  expect(f.rows()).toEqual([expect.objectContaining({ delivery: 'posted', shows: 'open' })]);
  await f.presenter.reconcile(signal());
  expect(f.poster.posts).toHaveLength(1);
});
it('redraws a posted card after a desktop decision and after supersession', async () => {
  const f = await presenterFixture({ linked: ['alice'], proposals: ['alice'] });
  await f.presenter.reconcile(signal());
  f.core.decide('desktop', f.approve(), () => f.session);
  await f.presenter.reconcile(signal());
  expect(f.poster.updates.at(-1)!.text).toContain('Approved in the ECHO desktop');
  expect(f.rows()[0].shows).toBe('approved');
});
it('posts open proposals once the reviewer links Slack later', async () => { /* link after first reconcile → posted on the second */ });
it('marks an oversized card unrepresentable and never retries it', async () => { /* 60 decisions → unrepresentable, no poster call on the next pass */ });
it('resumes a card left posting by a crash through the marker, without a second post', async () => { /* poster.postMarker seen, crash, reconcile → reconcileMarker */ });
```

- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement schema, card, presenter and wiring; update hash pins.
- [ ] **Step 4:** `npm run check`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: Slack DM copy of meeting proposals as a presenter on the approval core`.

---

### Task 12: Slack click → `decide`

**Files:**
- Create: `providers/slack/server/src/private-approval/slack-approval-click-v1.ts`
- Modify: `private-slack-approval-interaction-protocol-v1.ts` (button value `{schema_version: 2, approval_id, snapshot_sha256}`; parse V4 state: audience, project ids, transcript, owner fields keyed by signal id; drop V1 branches, the Team policy and the note), `private-slack-approval-interaction-handler-v1.ts` (verified, parsed click → `slack-approval-click-v1`), `private-slack-approval-http-adapter-v1.ts` (mounted through the personal runtime's `applications` when Slack is configured; signing secret lookup from the old bundle's `:150-165`)
- Test: `providers/slack/server/test/private-approval/slack-approval-click-v1.test.ts`, protocol tests

**Interfaces:**

```ts
export function createSlackApprovalClickV1(options: {
  readonly database: Database.Database;
  readonly core: Pick<ApprovalCoreV1, 'decide' | 'proposal'>;
  /** Re-reads the active link for this Slack user on the active connection; null when there is none. */
  readonly link: (click: { readonly workspace_id: string; readonly subject_id: string }) => (ApprovalActorV1 & { readonly external_identity_link_id: string; readonly contract_sha256: string }) | null;
  readonly redraw: (approvalId: string) => void; // asks the presenter to run
}): (click: VerifiedSlackApprovalClickV1) => { readonly outcome: 'decided' | 'already_decided' | 'stale' | 'refused' };
```

Rules: the click's workspace, channel, message timestamp, user and app must equal the posted presentation row's target and `message_ts` (else `refused`, nothing written); `command_id = 'slack:' + provider_action_key_sha256.slice(7)` (≤ 128 chars); the authorizer passed to `decide` re-reads the link on every call and throws `unauthorized` when the link is gone or maps to another membership; evidence `{kind: 'slack-click', sha256: canonicalSha256({provider_action_key_sha256, workspace, subject, channel, message_ts, link_id, link_contract_sha256})}`; `already_decided` and `stale` call `redraw`; the HTTP handler returns 200 only after `decide` returned or refused.

- [ ] **Step 1: Write the failing tests:**

```ts
it('approves from Slack with the chosen projects and owners', async () => {
  const f = await clickFixture({ projects: 2, owners: { 'act-1': 'Rafael Moreno' } });
  expect(f.click({ audience: 'projects', projects: [f.projectA], owners: { 'act-1': 'Rafael Moreno' } }).outcome).toBe('decided');
  expect(f.decisionRow()).toMatchObject({ surface: 'slack', action: 'approve' });
});
it('lets a desktop decision and a Slack click race to exactly one decision and one record', async () => {
  const f = await clickFixture();
  const results = await Promise.all([
    Promise.resolve().then(() => f.core.decide('desktop', f.approve({ command_id: 'desk-1' }), () => f.session)),
    Promise.resolve().then(() => f.click({ audience: 'only_me' })),
  ]);
  expect(f.db.prepare('SELECT count(*) FROM authority_approval_decisions_v1').pluck().get()).toBe(1);
  await f.publish();
  expect(f.recordCount()).toBe(1);
  expect(results.map(r => 'kind' in r ? r.kind : r.outcome).sort()).toEqual(['already_decided', 'decided']);
});
it('refuses a click after the Slack link was removed and writes nothing', async () => {
  const f = await clickFixture();
  f.removeLink();
  expect(f.click({ audience: 'only_me' }).outcome).toBe('refused');
  expect(f.db.prepare('SELECT count(*) FROM authority_approval_decisions_v1').pluck().get()).toBe(0);
});
it('refuses a click from another message, channel or user', async () => { /* each mismatch → refused */ });
```

Protocol tests: the V4 parser accepts only V4 action ids for the approval, refuses a button value without `snapshot_sha256`, caps projects at 20, and keeps HMAC, freshness and size checks unchanged.

- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement; mount the route; delete the Task 5 placeholder reply.
- [ ] **Step 4:** `npm run check`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: Slack clicks decide through the approval core`.

---

### Task 13: Runs store, the approval hook and the storable impact card

**Files:**
- Modify V12 SQL:

```sql
CREATE TABLE authority_trigger_runs_v1 (
  run_id TEXT PRIMARY KEY CHECK (run_id GLOB 'run_*' AND length(run_id) BETWEEN 8 AND 64),
  trigger TEXT NOT NULL CHECK (trigger IN ('approved_record')),
  event_ref TEXT NOT NULL CHECK (length(event_ref) BETWEEN 1 AND 128),
  organization_id TEXT NOT NULL, principal_id TEXT NOT NULL, membership_id TEXT NOT NULL,
  record_sha256 TEXT NOT NULL CHECK (record_sha256 LIKE 'sha256:%'),
  state TEXT NOT NULL CHECK (state IN ('pending', 'running', 'done', 'failed')),
  attempts INTEGER NOT NULL CHECK (attempts BETWEEN 0 AND 3),
  lease_token TEXT, lease_expires_at TEXT CHECK (lease_expires_at IS NULL OR unixepoch(lease_expires_at) IS NOT NULL),
  result_json TEXT CHECK (result_json IS NULL OR (json_valid(result_json) AND json_type(result_json) = 'object')),
  result_sha256 TEXT CHECK (result_sha256 IS NULL OR result_sha256 LIKE 'sha256:%'),
  error_code TEXT CHECK (error_code IS NULL OR error_code IN ('no_access', 'unavailable', 'timed_out', 'research_failed')),
  created_at TEXT NOT NULL CHECK (unixepoch(created_at) IS NOT NULL),
  updated_at TEXT NOT NULL CHECK (unixepoch(updated_at) IS NOT NULL),
  UNIQUE (trigger, event_ref),
  CHECK ((state = 'running') = (lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)),
  CHECK ((state = 'done') = (result_json IS NOT NULL AND result_sha256 IS NOT NULL)),
  CHECK ((state = 'failed') = (error_code IS NOT NULL))
) STRICT;
CREATE INDEX authority_trigger_runs_by_actor_v1 ON authority_trigger_runs_v1 (organization_id, principal_id, membership_id, created_at);
CREATE TRIGGER authority_trigger_run_approved_record_v1
BEFORE INSERT ON authority_trigger_runs_v1
WHEN NEW.trigger = 'approved_record' AND NOT EXISTS (
  SELECT 1 FROM authority_approval_decisions_v1 d
  WHERE d.approval_id = NEW.event_ref AND d.action = 'approve' AND d.receipt_json IS NOT NULL
    AND json_extract(d.body_json, '$.actor.organization_id') = NEW.organization_id
    AND json_extract(d.body_json, '$.actor.principal_id') = NEW.principal_id
    AND json_extract(d.body_json, '$.actor.membership_id') = NEW.membership_id
    AND json_extract(d.receipt_json, '$.record_sha256') = NEW.record_sha256)
BEGIN SELECT RAISE(ABORT, 'approved-record run needs its published approval'); END;
CREATE TRIGGER authority_trigger_run_identity_immutable_v1
BEFORE UPDATE ON authority_trigger_runs_v1
WHEN NEW.run_id != OLD.run_id OR NEW.trigger != OLD.trigger OR NEW.event_ref != OLD.event_ref
  OR NEW.organization_id != OLD.organization_id OR NEW.principal_id != OLD.principal_id OR NEW.membership_id != OLD.membership_id
  OR NEW.record_sha256 != OLD.record_sha256 OR NEW.created_at != OLD.created_at
BEGIN SELECT RAISE(ABORT, 'trigger run identity is immutable'); END;
CREATE TRIGGER authority_trigger_run_transition_v1
BEFORE UPDATE OF state ON authority_trigger_runs_v1
WHEN NOT ((OLD.state = 'pending' AND NEW.state = 'running') OR (OLD.state = 'running' AND NEW.state IN ('pending', 'running', 'done', 'failed'))
  OR (OLD.state = 'failed' AND NEW.state = 'pending'))
BEGIN SELECT RAISE(ABORT, 'trigger run transition is not allowed'); END;
CREATE TRIGGER authority_trigger_run_done_frozen_v1
BEFORE UPDATE ON authority_trigger_runs_v1 WHEN OLD.state = 'done'
BEGIN SELECT RAISE(ABORT, 'a finished trigger run is frozen'); END;
CREATE TRIGGER authority_trigger_run_delete_denied_v1
BEFORE DELETE ON authority_trigger_runs_v1
BEGIN SELECT RAISE(ABORT, 'trigger run deletion is denied'); END;
```

(Confirm the receipt's JSON path for the record hash in Task 8's receipt shape and use that exact path; `running → running` covers taking over an expired lease.)

- Create: `services/organization-authority/src/adapters/persistence/sqlite/trigger-runs-v1.ts` (DAO)
- Create: `packages/organization-authority-kernel/src/answer-composition/renderers/impact-card-storage-v1.ts` (pure functions)
- Modify: `impact-card-renderer-v1.ts` to export `ownerOfImpactItemV1`, `statesImpactDateV1` and `detailsOfImpactItemV1` (today's private `ownerOf`, `statesDate`, `detailsOf`) without behavior change
- Modify: the runtime composition to register the hook `enqueueApprovedRecordRunV1` on the approval core
- Test: `services/organization-authority/test/trigger-runs-v1.test.ts`, `packages/organization-authority-kernel/test/answer-composition/renderers/impact-card-storage-v1.test.ts`

**Interfaces:**

```ts
// trigger-runs-v1.ts
export type TriggerRunStateV1 = 'pending' | 'running' | 'done' | 'failed';
export type TriggerRunErrorV1 = 'no_access' | 'unavailable' | 'timed_out' | 'research_failed';
export interface TriggerRunRowV1 {
  readonly run_id: string; readonly trigger: 'approved_record'; readonly event_ref: string;
  readonly actor: ApprovalActorV1; readonly record_sha256: Sha256Digest; readonly state: TriggerRunStateV1;
  readonly attempts: number; readonly lease_token: string | null; readonly lease_expires_at: string | null;
  readonly result_json: string | null; readonly error_code: TriggerRunErrorV1 | null; readonly created_at: string; readonly updated_at: string;
}
export class SqliteTriggerRunsV1 {
  constructor(database: Database.Database, now?: () => Date);
  /** For the after-record hook: inside the caller's transaction, idempotent on (trigger, event_ref). */
  enqueueApprovedRecord(transaction: Database.Database, event: AfterApprovedRecordEventV1): void;
  list(actor: ApprovalActorV1, limit: number): readonly TriggerRunRowV1[];
  read(actor: ApprovalActorV1, runId: string): TriggerRunRowV1 | undefined;            // undefined unless the actor owns it
  claim(actor: ApprovalActorV1, runId: string, leaseMs: number): { readonly kind: 'claimed'; readonly lease_token: string } | { readonly kind: 'running' | 'busy' | 'done' | 'failed' | 'not_found' };
  /** running → pending. A counted attempt that reaches 3 becomes failed with `exhausted`. */
  release(runId: string, leaseToken: string, attempt: { readonly counted: false } | { readonly counted: true; readonly exhausted: 'timed_out' | 'unavailable' }): void;
  finish(runId: string, leaseToken: string, result: { readonly json: string; readonly sha256: Sha256Digest }): boolean; // false if the lease was lost
  fail(runId: string, leaseToken: string, error: TriggerRunErrorV1): boolean;
  retry(actor: ApprovalActorV1, runId: string): boolean;                                // failed → pending, attempts 0
}
export const enqueueApprovedRecordRunV1: (runs: SqliteTriggerRunsV1) => AfterApprovedRecordHookV1;

// impact-card-storage-v1.ts
export interface StoredImpactCardV1 {
  readonly schema_version: 1;
  readonly status: PersonImpactCardV1['status'];
  readonly decided: PersonImpactCardV1['decided'];
  readonly affected: readonly { readonly citation_index: number; readonly relation?: PersonImpactRelationV1;
    readonly date_at_risk?: { readonly date: string; readonly milestone: string }; readonly says_now?: string /* ECHO-local only */ }[];
  readonly unconfirmed: readonly string[];
  readonly citations: readonly unknown[];   // citation pointers only (PersonAnswerCitationV6['citation'])
}
/** Removes every word read from outside ECHO. `outsideLabels` are the bundle's labels of non-ECHO items. */
export function storableImpactCardV1(card: PersonImpactCardV1, outsideLabels: readonly string[]): StoredImpactCardV1;
export interface FreshImpactItemV1 {
  readonly citation: PersonAnswerCitationV6;      // as released to this viewer now
  readonly text?: string; readonly label: string;
  readonly attributes?: { readonly owner?: string; readonly due_at?: string; readonly status?: string };
  readonly local: boolean;                        // approved_record or source_revision
}
/** Rebuilds the viewer's card from the stored form and fresh reads (null = could not open). */
export function refreshImpactCardV1(stored: StoredImpactCardV1, fresh: readonly (FreshImpactItemV1 | null)[]): { readonly card: PersonImpactCardV1; readonly hidden: number };
```

Storable rules (spec 2 section 4): external `says_now` dropped; owners and people dropped; citations kept as pointers; an `unconfirmed` note containing any outside label is replaced by one count note ("1 item could not be read." / "N items could not be read."). Refresh rules: a `null` fresh item hides its decided line or affected row (and drops it from `citations`, re-indexing); outside `says_now` = first 300 characters of the current text on one line, else `detailsOfImpactItemV1`; owner = `ownerOfImpactItemV1(fresh)`; people rebuilt from owners; a date the fresh item no longer states (`statesImpactDateV1`) is dropped; output passes `validatePersonImpactCardV1`.

- [ ] **Step 1: Write the failing tests.**

```ts
// trigger-runs-v1.test.ts
it('enqueues exactly one pending run per approved record through the publisher hook', async () => {
  const f = await approvalCoreFixture({ runs: true });
  f.core.decide('desktop', f.approve(), () => f.session);
  await f.core.processing.appendFinalizedApprovalsToV4(signal());
  await f.core.processing.recoverV4Appends(signal());
  expect(f.db.prepare("SELECT trigger, event_ref, state FROM authority_trigger_runs_v1").all()).toEqual([{ trigger: 'approved_record', event_ref: f.approvalId, state: 'pending' }]);
});
it('refuses a run for an approval that has no receipt', () => {
  const f = runsFixture();
  expect(() => f.insertRaw({ event_ref: 'apr_unpublished' })).toThrow('needs its published approval');
});
it('claims once, refuses other people and a second live run, and takes over an expired lease', () => {
  const f = runsFixture({ runs: 2, now: '2026-10-07T10:00:00.000Z' });
  expect(f.runs.claim(f.stranger, f.run1, 600_000).kind).toBe('not_found');
  expect(f.runs.claim(f.owner, f.run1, 600_000).kind).toBe('claimed');
  expect(f.runs.claim(f.owner, f.run1, 600_000).kind).toBe('running');
  expect(f.runs.claim(f.owner, f.run2, 600_000).kind).toBe('busy');
  f.advance(600_001);
  expect(f.runs.claim(f.owner, f.run1, 600_000).kind).toBe('claimed');
});
it('fails after three counted attempts and retries with attempts reset', () => { /* release ×3 counted → failed; retry → pending, attempts 0 */ });
it('never lets a lost lease finish a run', () => { /* claim, expire, re-claim, old token finish → false */ });
```

```ts
// impact-card-storage-v1.test.ts
const OUTSIDE = 'Kestrel cooling fan drift 0xC0FFEE'; // distinctive fictional outside text
it('stores no outside text, label or owner', () => {
  const card = cardWith({ affected: [{ local: false, says_now: OUTSIDE, owner: 'Rafael Moreno', label: OUTSIDE }], unconfirmed: [`${OUTSIDE} could not be read.`] });
  const stored = JSON.stringify(storableImpactCardV1(card, [OUTSIDE]));
  expect(stored).not.toContain('0xC0FFEE');
  expect(stored).not.toContain('Rafael Moreno');
  expect(JSON.parse(stored).unconfirmed).toContain('1 item could not be read.');
});
it('keeps ECHO-local text and the model relation and date', () => { /* local row says_now kept; relation and date kept */ });
it('hides what the viewer can no longer open and re-indexes citations', () => { /* fresh [record, null, item] → 1 hidden, indexes valid */ });
it('rebuilds outside text and owners from the fresh item and drops a date it no longer states', () => { /* fresh text without the date → no date_at_risk */ });
```

- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement schema, DAO, hook registration, pure functions and renderer exports; update hash pins.
- [ ] **Step 4:** Run the two test files, `packages/organization-authority-kernel/test/answer-composition` (goldens unchanged) and `npm run check`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: runs store with the approved-record hook and a pointer-only impact card`.

---

### Task 14: Runs service and API

**Files:**
- Create: `packages/organization-api/src/person-runs-v1.ts` (+ export)
- Create: `services/organization-authority/src/composition/person-trigger-runs-v1.ts`
- Create: `services/organization-authority/src/presentation/person-trigger-runs-http-application.ts` (port: `{list, start, retry, view, close}` like `person-research-eval-http-application.ts`)
- Modify: `services/organization-authority/src/composition/person-record-search-route.ts` — add `recordAnchor({access_token, record_sha256})` returning the first atom citation of that record from the active readable search generation for this reader (uses `readReadableSearchGenerationAtomsV1` with `record_sha256s: [sha]`), throwing `PersonRecordSearchIndexLagV1` when the generation does not include the record yet and `not_found` when the reader cannot see it
- Modify: `services/organization-authority/src/composition/organization-authority-api-runtime.ts` (compose when `answerOptions` exists; pass `close()` to shutdown), `services/organization-authority/src/presentation/organization-authority-http-server.ts` (`personCancellablePost` entry; add `PERSON_RUNS_PATH_V1` to `ORGANIZATION_AUTHORITY_HTTP_ROUTES`)
- Modify: `src/product/person-client/authority-client.ts`, `client.ts`, `commands.ts` (verb `runs --request <json>`: OPTIONS, RULES, HELP, action, switch case, pre-network validation; prints `{ok:true,result}`)
- Test: `packages/organization-api/test/person-runs-v1.test.ts`, `services/organization-authority/test/person-trigger-runs-v1.test.ts`, `services/organization-authority/test/person-runs-http.test.ts`, `tests/person-client/person-runs.test.ts`

**Interfaces:**

```ts
// person-runs-v1.ts
export const PERSON_RUNS_PATH_V1 = '/v1/person/runs';
export type PersonRunsRequestV1 =
  | { readonly schema_version: 1; readonly operation: 'list' }
  | { readonly schema_version: 1; readonly operation: 'start' | 'retry' | 'view'; readonly run_id: string };
export interface PersonRunV1 {
  readonly run_id: string; readonly trigger: 'approved_record'; readonly event_ref: string;
  readonly state: 'pending' | 'running' | 'done' | 'failed'; readonly error_code: 'no_access' | 'unavailable' | 'timed_out' | 'research_failed' | null;
  readonly created_at: string; readonly updated_at: string;
}
export interface PersonRunsResultsV1 {
  list: { readonly runs: readonly PersonRunV1[] };
  start: { readonly state: 'pending' | 'running' | 'busy' | 'done' | 'failed' };
  retry: { readonly state: 'pending' };
  view: { readonly card: PersonImpactCardV1; readonly checked_at: string; readonly hidden: number };
}
export function validatePersonRunsRequestV1(value: unknown): PersonRunsRequestV1;
export function validatePersonRunsResultV1<K extends keyof PersonRunsResultsV1>(operation: K, value: unknown): PersonRunsResultsV1[K];
```

```ts
// person-trigger-runs-v1.ts
export function createPersonTriggerRunsV1(options: {
  readonly runs: SqliteTriggerRunsV1;
  readonly sessions: Pick<PersonIdentitySessionApplication, 'authenticateAccess'>;
  readonly records: Pick<PersonRecordSearchRoute, 'recordAnchor' | 'recordProjects'>;
  /** The same desk binding the staging research evaluation uses (`person-research-eval-v1.ts`). */
  readonly bindDesk: typeof bindPersonLiveEvidenceDeskV1;
  /** Builds the research runner for a bound desk, as the staging evaluation does with `createAgenticResearchV1` and `answerOptions`' model and generation. */
  readonly research: (input: { readonly desk: Awaited<ReturnType<typeof bindPersonLiveEvidenceDeskV1>>; readonly context: Parameters<typeof bindPersonLiveEvidenceDeskV1>[3] }) => ReturnType<typeof createAgenticResearchV1>;
  readonly audit: PersonAgenticAskAuditV1;
  readonly lease_ms?: number;     // default 600_000
}): PersonTriggerRunsHttpApplicationV1;
```

Behavior (spec 2 section 3 and 4): `start` authenticates, claims, and returns at once; the detached work finds the anchor (index lag → `release(run, token, { counted: false })`, seen by the next `list` as `pending`), scopes by `recordProjects` (one project → project, otherwise global), runs `renderWithResearch` for the `approved_record` definition with `IMPACT_CARD_RENDERER_V1` and the background budget, validates with `validatePersonImpactCardV1`, stores `storableImpactCardV1(card, outsideLabels)` via `finish`. Error mapping: `AuthorityOperationError` `unauthorized`/`stale_access_state` → `fail('no_access')`; abort/timeout → `release(run, token, { counted: true, exhausted: 'timed_out' })`; model or provider unavailable → `release(run, token, { counted: true, exhausted: 'unavailable' })`; anything else → `fail('research_failed')`. `view` authenticates, requires the actor, binds a fresh desk with the same scope rule, opens each stored citation (`desk.openCitation`), maps results to `FreshImpactItemV1 | null`, calls `refreshImpactCardV1`, then `desk.revalidate`, and returns `{card, checked_at: updated_at, hidden}`. `close()` aborts in-flight work (runs stay `running` until their lease expires).

- [ ] **Step 1: Write the failing tests** (fake desk and research like `services/organization-authority/test/person-research-eval-v1.test.ts:44-85`):

```ts
it('runs as the approver and stores the pointer-only card', async () => {
  const f = await runsServiceFixture({ outsideText: 'Kestrel cooling fan drift 0xC0FFEE' });
  expect(await f.app.start(f.approverToken, f.runId)).toEqual({ state: 'running' });
  await f.settled();
  const row = f.db.prepare('SELECT state, result_json FROM authority_trigger_runs_v1').get() as { state: string; result_json: string };
  expect(row.state).toBe('done');
  expect(row.result_json).not.toContain('0xC0FFEE');
  expect(f.research.lastBinding.access_token).toBe(f.approverToken);
});
it('hides the run from anyone but the approver', async () => {
  const f = await runsServiceFixture();
  for (const op of ['start', 'retry', 'view'] as const) await expect(f.app[op](f.otherToken, f.runId)).rejects.toThrow('not_found');
  expect((await f.app.list(f.otherToken)).runs).toEqual([]);
});
it('sends an unindexed record back to pending without counting an attempt', async () => { /* recordAnchor throws index lag → state pending, attempts 0 */ });
it('maps failures to retry or failed', async () => { /* unauthorized → failed no_access; 3 timeouts → failed timed_out */ });
it('view hides a lost item and refreshes outside text from the current read', async () => { /* desk.openCitation returns null for one, new text for another */ });
it('picks a run left running back up after its lease expires, never twice at once', async () => {
  const f = await runsServiceFixture({ leaseMs: 1_000 });
  await f.app.start(f.approverToken, f.runId);
  await f.app.close();                                         // server stops mid-run
  const g = await f.restart();                                 // same database, new service
  expect(await g.app.start(f.approverToken, f.runId)).toEqual({ state: 'running' }); // live lease: no second worker
  f.advance(1_001);
  expect(await g.app.start(f.approverToken, f.runId)).toEqual({ state: 'running' }); // taken over
  await g.settled();
  expect(g.research.calls).toBe(1);
});
```

API validator tests for every operation and result; HTTP test: the path is reserved, needs a bearer token, and a request without a model configured answers `unavailable`. Client test: `runs --request '{"schema_version":1,"operation":"list"}'` prints `{ok:true,result:{runs:[…]}}`.

- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement contract, service, anchor lookup, route, client verb.
- [ ] **Step 4:** Run `npm run test:protocols`, `npm run test:authority`, `npm run test:person`, then `npm run check`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: runs API that checks an approved record's impact as the approver`.

---

### Task 15: Desktop Impact section

**Files:**
- Create: `product/echo-desktop/src/renderer/screens/impact-card.tsx`
- Modify: `product/echo-desktop/src/shared/protocol.ts` (`'runs': { params: { expect: Expect; request: PersonRunsRequestV1 }; result: PersonRunsResultsV1[keyof PersonRunsResultsV1] }`; add to `HOST_METHODS`; add to `WRITE_METHODS` since `start` and `retry` write), `src/host/host.ts` (timeout 45 s; handler runs `runs --request=<json>` through `forAccount` and validates with `validatePersonRunsResultV1`), `src/main.ts` broker allow-list, `src/host/views.ts` (export `v4Source`; add `impactCardView(result)` converting each citation for display), `src/renderer/store.ts` (runs state: list on meetings refresh; start the oldest `pending`; poll `list` every 5 s while a run is `running` and the Granola sheet is open; `view` when an approved review with a `done` run is opened; `retry`), `src/renderer/screens/meetings.tsx` (Impact section on approved reviews), `src/host/test-authority.ts` (fixture route for `/v1/person/runs`: after the first approve, one pending run; `start` → running; two `list` polls later → done; `view` returns a card with one decided line, two affected items — one Jira, one ECHO record — one unconfirmed note, one person, `hidden: 1`), `src/renderer/styles.css`
- Test: `product/echo-desktop/test/e2e/tools.spec.ts` (or a new `impact.spec.ts`), `product/echo-desktop/test/unit/views.test.ts`

**Interfaces:**
- Consumes: Task 14's API.
- Produces: `ImpactSection` props `{ run: PersonRunV1 | null; view: PersonRunsResultsV1['view'] | null; onRetry(): void; onOpen(source): void }`.

Copy (spec 2 section 5): "Impact check queued.", "Checking what this changes. This can take a few minutes.", section titles "What was decided", "Affected items", "Couldn't confirm", "People to tell", "Checked <time>", "<N> items you can no longer open are hidden.", failed reasons — `no_access`: "You no longer have access to what this check needs.", `unavailable`: "The impact check is unavailable right now.", `timed_out`: "The impact check took too long.", `research_failed`: "The impact check failed." — and the button "Try again". Relations display as "Confirms", "Conflicts", "Needs updating". Outside items get "Open in Jira", "Open in Confluence" or "Open in Slack" through the existing external-source handlers (`main.ts` `source.openExternal`/`openTicket`/`openPage`/`openSlack`).

- [ ] **Step 1: Write the failing e2e test:**

```ts
test('approving a meeting shows its impact card once the check finishes', async () => {
  const app = await launch('granola');
  // open the Granola sheet, open the pending review, Approve
  await expect(app.page.getByText('Impact check queued.').or(app.page.getByText('Checking what this changes. This can take a few minutes.'))).toBeVisible();
  await expect(app.page.getByRole('heading', { name: 'Affected items' })).toBeVisible({ timeout: 20_000 });
  await expect(app.page.getByText('Conflicts')).toBeVisible();
  await expect(app.page.getByRole('button', { name: 'Open in Jira' })).toBeVisible();
  await expect(app.page.getByText('1 item you can no longer open is hidden.')).toBeVisible();
  const ops = (await app.calls()).filter(c => c.path === '/v1/person/runs').map(c => c.request.operation);
  expect(ops).toEqual(expect.arrayContaining(['list', 'start', 'view']));
});
test('a failed check offers Try again', async () => { /* fixture mode granola-run-failed → reason text and Try again → retry call */ });
```

Use the singular form "1 item you can no longer open is hidden." when `hidden === 1`, and the spec's plural form otherwise.

- [ ] **Step 2:** Run the desktop e2e. Expected: FAIL.
- [ ] **Step 3:** Implement host method, views, store, component and fixture.
- [ ] **Step 4:** Desktop unit + e2e and `npm run check`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: desktop impact card on approved meetings`.

---

### Task 16: Documentation sweep and final consistency

**Files:**
- Modify: `docs/operations/PB-OPERATIONS-001-authority-operator-lane.md` (canary approved on the desktop or in Slack via the synthetic personal source; reset to V12/V4; no org source), `deploy/release/README.md`, `deploy/organization-authority/README.md`, `services/organization-authority/README.md`, `services/organization-authority/src/composition/README.md`, `docs/architecture/meeting-processing-core-and-adapters.md`, `docs/architecture/connector-contracts.md`, `docs/architecture/organization-control-plane.md`, `docs/architecture/component-naming-taxonomy.md`, `docs/invariants/INV-ADAPTERS-005-provider-semantics-at-boundary.md`, `docs/product/2026-10-05-personal-granola-sprint-v1.md` (implementation note: synthetic approval qualification now runs on the synthetic personal source), `docs/product/2026-10-06-research-trigger-contract-v1.md` (implementation note: the approved-record trigger now fires from real approvals and results are stored per ADR-0032), `docs/rfcs/RFC-0003-multi-source-agentic-ask.md` (note under Retention: background trigger runs store pointers only, ADR-0032), `docs/invariants/INV-PERMISSIONS-015-layer-3-person-release-boundary.md` (stored runs re-release through a fresh desk on every view)
- Modify both specs' status lines with "Implementation plan executed; see the plan's As built section" and add an **As built** section to this plan listing any interface that differs from the plan text.

- [ ] **Step 1:** `grep -rln "source_key = '1'\|organization source\|private_approval_terminal\|private-slack-block-v4-record-writer\|baseline-v11\|control-plane-baseline-v3" docs deploy services providers packages tools tests` and fix every hit that describes current behavior (historical ADR text stays).
- [ ] **Step 2:** `npm run check:docs` and `npm run check`. Expected: PASS.
- [ ] **Step 3: Commit** `docs: unified approval and runs store as built`.

---

## Test helpers

Test snippets call helpers such as `syntheticWorld()`, `meetingWorld()`, `approvalCoreFixture()`, `presenterFixture()`, `clickFixture()`, `runsFixture()` and `runsServiceFixture()`. Each task creates the helpers its tests use, in that task's test file or under the package's `test/fixtures/`, building on the existing fixtures named in the code maps (`services/organization-authority/test/fixtures/person-meeting-review.ts`, `person-meeting-world.ts`, the fake provider in `person-meeting-runtime-v1.test.ts:27-52`, the research-eval harness in `person-research-eval-v1.test.ts:44-85`). A helper's options are the ones its snippets pass.

## Order

Tasks run in order; each depends on the one before it. Slack approvals are unavailable from Task 3 until Task 12.

## Self-review notes

- Spec 1 coverage: sources (Tasks 2, 6), proposal (7), decide (7, 12), publisher and hook (8), desktop (9, 10), Slack (11, 12), data (1, 5, 6, 7, 11, 13), removals (3, 5, 8), build order (Tasks 1–12 then the founder rehearsal), acceptance tests (race: 7, 12; two projects: 6, 7; edits: 7, 11; crash: 8, 13; owners: 7, 8; refusals: 7, 12; desktop only: 3, 10; goldens: every task).
- Spec 2 coverage: store (13), trigger (13), running (14), storage and view (13, 14), API and desktop (14, 15), acceptance (13, 14, 15).
- Type names used across tasks: `ApprovalCoreV1`, `ApprovalActorV1`, `ApprovalDecisionRequestV1`, `ApprovalAuthorizationV1`, `AfterApprovedRecordHookV1`, `AfterApprovedRecordEventV1`, `SqliteTriggerRunsV1`, `StoredImpactCardV1`, `FreshImpactItemV1`, `PersonRunsRequestV1`, `PersonRunsResultsV1`, `PersonMeetingRequestV2`, `PersonMeetingResultsV2`.
