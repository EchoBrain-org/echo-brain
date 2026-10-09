# Open Items and Home Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One shared row per item a decision affects, seen by everyone who can read the decision; the approver sends items to their owners and owners close them from Home; then Sweep re-checks open items and Home shows what landed and what drifted, as canvas row 9 draws it.

**Architecture:** Authority baseline V13 adds `authority_impact_items_v1` and lets `authority_trigger_runs_v1` hold sweep runs. An impact run's finishing transaction writes its items (`unsent`) with exact owner matches. New operations on `POST /v1/person/runs` read and change items, and every access question goes through one pure policy function. Outside words are read live with the viewer's access and never stored. Sweep is a second run trigger whose renderer judges each open item; only verdicts are stored. The desktop's Home, Tell the owners?, Did it land?, the reader's Impact line and the project line follow the canvas.

**Tech Stack:** TypeScript (ESM, strict), better-sqlite3 (STRICT tables, triggers), vitest, Electron + Preact desktop (Playwright e2e), Node CLI person client.

**Spec:** `docs/product/2026-10-08-open-items-and-home-v1.md` (rulings 1–23). Decision record: `docs/decisions/ADR-0033-shared-open-items.md`. Design: canvas row 9, artboards H1–H7 (9.1 Home, 9.2 Approve this decision?, 9.3 Tell the owners?, 9.4 Did it land?, 9.5 Home empty, 9.6 decision Impact line, 9.7 project line), https://claude.ai/code/artifact/ffa8478f-578d-40d0-bc7a-578a66f4adb0. Builds on ADR-0031/0032 and the plan `docs/superpowers/plans/2026-10-07-unified-approval-and-runs.md` (its Tasks 13–15 built the runs store, service and desktop impact card this plan extends).

**Branch:** `feat/home-needs-you` in `.worktrees/home-needs-you`, on top of `feat/desktop-home-redesign` (PR #299 at `814470f`). When PR #299 changes (the founder is fixing its Codex P2), rebase onto it before the Part 1 stop.

## Global Constraints

- The repository is public: fixtures and test data are fictional (Ari, Mina Patel, Rafael Moreno, S. Okafor, ECHO-12). Never read or copy `~/Desktop/ECHO-Atlassian-Export-2026-10-06`.
- ECHO never writes to Jira, Confluence or Slack.
- Never set `GOLDEN_WRITE`; never edit the Ask golden fixtures. The Ask goldens must reproduce unchanged.
- No AWS, SSM, SSH, staging deploy, reset, seeding or rehearsal by agents. Those are founder-run.
- No force-push or history rewriting. One or more commits per task; commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Validation cadence (`AGENTS.md`): focused tests while working; one `npm run check` on the finished Part 1 candidate (at the stop) and one on the finished Part 2 candidate; push once, at the end. Never use pushes as the debugging loop. `tests/architecture/*` can time out under other worktrees' load: rerun alone and report, never skip.
- After adding or renaming a source file, update its package's `source-boundary.v1.json` and `tools/workspace-source-boundaries.v1.json` when listed; `npm run check:architecture-boundaries` enforces them.
- Fresh state only: Authority baseline V13. No migration code.
- Every task leaves `npm run build`, the root `tsc --noEmit -p tsconfig.json` and the desktop `npm run typecheck` passing, so the next task starts from a building tree. A task that widens an API union adds a temporary branch where a consumer cannot compile yet (named in the task) and the later task replaces it.
- No stored row holds text, a title or a name read from Slack, Jira or Confluence. Item rows hold pointers, ECHO's `expected` phrase, ECHO member ids and verdicts. A check stores its verdict only (ruling 18).
- Every see and act decision comes from `openItemAccessV1` (Task 3). Database triggers enforce structure only.
- Runs API envelope stays `schema_version: 1` at `POST /v1/person/runs`; new operations are additive.
- Limits: items page 50; Home at most 20 Send rows and 20 item rows; at most 50 live opens per call, each item opened at most once per call; sweep findings at most 20 (`MAX_FINDINGS`); `expected` 1–120 characters; one live run per person; impact runs start before sweeps.
- Owner matching is exact only (ruling 1): a Jira assignee by connected account on the same site; an ECHO action owner by a full name exactly one active member holds. Everything else is the approver's until picked.
- Copy: exactly as spec section 8 gives it (canvas row 9).

## Review Focus

1. **A decision reader who cannot open the Jira item.** The row reads "A Jira ticket you can't open"; no title, text, assignee, permalink or citation for it appears anywhere in the response. Pinned in Task 7 (service) and Task 9 (desktop).
2. **Send clicked twice, retried after a timeout, or sent from a card drawn before the item list changed.** Exactly one send; a stale list is refused and nothing is written. Pinned in Task 2 (DAO) and Task 7 (service).
3. **The owner's or approver's membership revoked after Send.** The item moves to the approver's, then the project leads', Home; it never disappears. Pinned in Task 3 and Task 7.
4. **A Home read that fails once, and an Authority with no model (runs answer `unavailable` forever).** The first keeps the previous rows and recovers; the second never polls every 5 seconds. Same class as PR #299's Codex P2. Pinned in Task 9.
5. **A sweep that finishes after a newer check, or after the sweeper lost access to an item.** It never overwrites the newer check, never changes `state`, and skips items the sweeper can no longer see. Pinned in Task 11.

---

## File Structure

| Area | Files (create **C**, modify **M**) |
| --- | --- |
| Baseline | M `packages/organization-authority-kernel/baselines/authority-baseline-v12.sql` → renamed `authority-baseline-v13.sql`; M `.../src/adapters/persistence/sqlite/baseline.ts` and every importer (Task 1 list) |
| Stores | M `services/organization-authority/src/adapters/persistence/sqlite/trigger-runs-v1.ts`; C `.../sqlite/impact-items-v1.ts`; C `.../sqlite/open-item-people-v1.ts` |
| Policy | C `services/organization-authority/src/composition/open-items-policy-v1.ts` |
| API | M `packages/organization-api/src/person-runs-v1.ts`, `person-impact-card-v1.ts`, `person-meetings-v1.ts`, `person-research-eval-v1.ts`, `index.ts`; C `packages/organization-api/src/person-sweep-result-v1.ts` (Part 2) |
| Kernel | M `packages/organization-authority-kernel/src/answer-composition/renderers/impact-card-renderer-v1.ts`, `impact-card-storage-v1.ts`, `agentic-trigger-definitions-v1.ts` (Part 2); C `.../renderers/sweep-renderer-v1.ts` (Part 2) |
| Owners | M `providers/shared/src/person-connection-store-v1.ts`; M `services/organization-authority/src/composition/jira-person-live-runtime-v1.ts`; C `services/organization-authority/src/application/ports/jira-owner-accounts-v1.ts`; C `services/organization-authority/src/composition/impact-owner-matching-v1.ts` |
| Service | M `services/organization-authority/src/composition/person-trigger-runs-v1.ts`; C `.../composition/person-open-items-v1.ts`; M `.../composition/person-record-search-route.ts`, `organization-authority-api-runtime.ts`, `person-meeting-runtime-v1.ts`, `approval-core-v1.ts`, `person-research-eval-v1.ts` (Part 2); M `.../presentation/person-trigger-runs-http-application.ts`, `organization-authority-http-server.ts` |
| Client | M `src/product/person-client/commands.ts` (help text) |
| Desktop | M `product/echo-desktop/src/shared/protocol.ts`, `src/host/host.ts`, `src/host/views.ts`, `src/host/test-authority.ts`, `src/renderer/store.ts`, `src/renderer/main.tsx`, `src/renderer/styles.css`, `src/renderer/screens/{home,decision,reader,project,items,impact-card}.tsx`; C `src/renderer/screens/{send,open-items,did-it-land}.tsx` |
| Eval | M `tools/evals/research-loop/lib/{checks,report,judge}.mjs`, `tools/evals/research-loop/test/research-loop.test.mjs` (Part 2) |

---

### Task 0: Worktree and dependencies

The worktree is fresh: no `node_modules`, no builds.

- [ ] **Step 1:** Confirm the base:

```bash
cd "$(git rev-parse --show-toplevel)"    # the worktree root: .worktrees/home-needs-you
git log --oneline -4    # docs commits on top of 814470f feat(desktop): move meeting decisions and impact checks to Home
```

- [ ] **Step 2:** Install and build from the repository root, then the person client and the desktop:

```bash
npm ci
npm run build
node tools/build.mjs --person-client
cd product/echo-desktop && npm ci && npm run build && npx vitest run
```

- [ ] **Step 3:** Prove the starting point is green on the code this plan changes:

```bash
cd "$(git rev-parse --show-toplevel)"    # the worktree root: .worktrees/home-needs-you
npx vitest run --config vitest.config.ts services/organization-authority/test/trigger-runs-v1.test.ts services/organization-authority/test/person-trigger-runs-v1.test.ts
cd product/echo-desktop && npx playwright test test/e2e/impact.spec.ts
```

Expected: PASS. If Electron fails to launch, the sandboxed install broke Electron's `dist` symlinks: `rm -rf node_modules/electron/dist && node node_modules/electron/install.js` with the sandbox off, then rerun. The known slow-runner failures `ask.spec.ts:127` and `pages.spec.ts:54` (ask-cancel) are pre-existing; do not chase them.

No commit.

---

## Part 1 — Send and Update

### Task 1: Authority baseline V13 plumbing

A pure version bump, so later tasks edit V13 freely. No table changes.

**Files:**
- Rename: `packages/organization-authority-kernel/baselines/authority-baseline-v12.sql` → `authority-baseline-v13.sql` (header comment and trailing `PRAGMA user_version = 13;` if present)
- Modify: `packages/organization-authority-kernel/src/adapters/persistence/sqlite/baseline.ts` (`AUTHORITY_BASELINE_SCHEMA_VERSION_V13 = 13`, `authorityBaselineSqlV13()`, `authorityBaselineSha256V13()`, `applyAuthorityBaselineV13()`; no V12 names left)
- Modify: every importer and assert. List them with:

```bash
grep -rln "BaselineV12\|BASELINE_SCHEMA_VERSION_V12\|baseline-v12" --include='*.ts' --include='*.mjs' --include='*.json' --include='*.sh' --include='Dockerfile' . | grep -v node_modules | grep -v /dist/
grep -rn "user_version" --include='*.ts' services packages providers | grep -v /dist/ | grep "12"
```

  (45 files at the start, including `SqliteTriggerRunsV1`'s constructor check, the project-context, document, original-items, enrichment and upload DAOs, `verify-authority-state-lineage.ts`, `organization-authority-state-bootstrap.ts`, `packages/organization-authority-kernel/package.json` `files`, `packages/organization-authority-kernel/source-boundary.v1.json`, `deploy/organization-authority/staging-journey-explorer-handler-v1.mjs`, `product/echo-desktop/src/host/test-authority.ts`, `tests/architecture/workspace-boundaries.test.ts` and the test fixtures.)
- Rename test: `packages/organization-authority-kernel/test/adapters/persistence/sqlite/authority-baseline-v12.test.ts` → `...-v13.test.ts`
- Modify docs that state the current baseline (not ADR history): `grep -rln "V12" docs deploy services/organization-authority/README.md | xargs grep -ln "baseline\|fresh"`

**Interfaces:**
- Produces: `applyAuthorityBaselineV13(db)`, `authorityBaselineSqlV13()`, `authorityBaselineSha256V13()`, `AUTHORITY_BASELINE_SCHEMA_VERSION_V13`. Later tasks edit `authority-baseline-v13.sql` and update the pinned baseline hash (find the pins with `grep -rln "authorityBaselineSha256V1[23]\|baseline.*sha256" services/organization-authority/test packages/organization-authority-kernel/test`).

- [ ] **Step 1: Write the failing test** in the renamed kernel baseline test:

```ts
it('stamps user_version 13 on a fresh database', () => {
  const db = new Database(':memory:');
  applyAuthorityBaselineV13(db);
  expect(db.pragma('user_version', { simple: true })).toBe(13);
});
```

- [ ] **Step 2:** `npx vitest run --config vitest.config.ts packages/organization-authority-kernel/test/adapters/persistence/sqlite/authority-baseline-v13.test.ts` → FAIL (`applyAuthorityBaselineV13` is not exported).
- [ ] **Step 3:** `git mv` the SQL and the test, rename the functions and constant, update every importer, DAO assert, manifest, deploy file, architecture test and doc from the lists above.
- [ ] **Step 4:** Update the pinned baseline hashes (the pin tests print the new value on failure).
- [ ] **Step 5:** Run the kernel baseline test, `npm run test:authority` and `npm run test:architecture`. Expected: PASS. `grep -rn "V12\b\|v12" --include='*.ts' packages services providers src tests product | grep -i baseline` prints nothing.
- [ ] **Step 6: Commit** `chore: Authority baseline V13 (fresh state, no schema change yet)`.

---

### Task 2: V13 schema, runs changes and the items store

**Files:**
- Modify: `packages/organization-authority-kernel/baselines/authority-baseline-v13.sql` (runs table, items table, triggers, indexes below)
- Modify: `services/organization-authority/src/adapters/persistence/sqlite/trigger-runs-v1.ts`
- Create: `services/organization-authority/src/adapters/persistence/sqlite/impact-items-v1.ts`
- Create: `services/organization-authority/src/adapters/persistence/sqlite/open-item-people-v1.ts`
- Modify: `services/organization-authority/source-boundary.v1.json` (new files)
- Test: `services/organization-authority/test/trigger-runs-v1.test.ts` (extend), `services/organization-authority/test/impact-items-v1.test.ts` (new), `services/organization-authority/test/open-item-people-v1.test.ts` (new)

**Schema.** Replace the runs table and its identity trigger, keep its other triggers, and add the items table:

```sql
CREATE TABLE authority_trigger_runs_v1 (
  run_id TEXT PRIMARY KEY CHECK (run_id GLOB 'run_*' AND length(run_id) BETWEEN 8 AND 64),
  trigger TEXT NOT NULL CHECK (trigger IN ('approved_record', 'sweep')),
  event_ref TEXT NOT NULL CHECK (length(event_ref) BETWEEN 1 AND 128),
  organization_id TEXT NOT NULL, principal_id TEXT NOT NULL, membership_id TEXT NOT NULL,
  record_sha256 TEXT CHECK (record_sha256 IS NULL OR record_sha256 LIKE 'sha256:%'),
  scope_kind TEXT CHECK (scope_kind IS NULL OR scope_kind IN ('mine', 'record', 'project')),
  scope_id TEXT CHECK (scope_id IS NULL OR length(scope_id) BETWEEN 1 AND 128),
  state TEXT NOT NULL CHECK (state IN ('pending', 'running', 'done', 'failed')),
  attempts INTEGER NOT NULL CHECK (attempts BETWEEN 0 AND 3),
  lease_token TEXT, lease_expires_at TEXT CHECK (lease_expires_at IS NULL OR unixepoch(lease_expires_at) IS NOT NULL),
  result_json TEXT CHECK (result_json IS NULL OR (json_valid(result_json) AND json_type(result_json) = 'object')),
  result_sha256 TEXT CHECK (result_sha256 IS NULL OR result_sha256 LIKE 'sha256:%'),
  error_code TEXT CHECK (error_code IS NULL OR error_code IN ('no_access', 'unavailable', 'timed_out', 'research_failed')),
  created_at TEXT NOT NULL CHECK (unixepoch(created_at) IS NOT NULL),
  updated_at TEXT NOT NULL CHECK (unixepoch(updated_at) IS NOT NULL),
  UNIQUE (trigger, event_ref),
  CHECK ((trigger = 'approved_record') = (record_sha256 IS NOT NULL)),
  CHECK ((trigger = 'sweep') = (scope_kind IS NOT NULL)),
  CHECK ((scope_kind IS NOT NULL AND scope_kind IN ('record', 'project')) = (scope_id IS NOT NULL)),
  CHECK ((lease_token IS NULL) = (lease_expires_at IS NULL)),
  CHECK ((state = 'running') = (lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)),
  CHECK ((result_json IS NULL) = (result_sha256 IS NULL)),
  CHECK ((state = 'done') = (result_json IS NOT NULL)),
  CHECK ((state = 'failed') = (error_code IS NOT NULL))
) STRICT;
CREATE INDEX authority_trigger_runs_by_actor_v1 ON authority_trigger_runs_v1 (organization_id, principal_id, membership_id, created_at);
CREATE INDEX authority_trigger_runs_by_record_v1 ON authority_trigger_runs_v1 (record_sha256) WHERE record_sha256 IS NOT NULL;
-- One live sweep per person and scope.
CREATE UNIQUE INDEX authority_trigger_runs_one_live_sweep_v1 ON authority_trigger_runs_v1
  (organization_id, principal_id, membership_id, scope_kind, ifnull(scope_id, ''))
  WHERE trigger = 'sweep' AND state IN ('pending', 'running');
CREATE TRIGGER authority_trigger_run_identity_immutable_v1
BEFORE UPDATE ON authority_trigger_runs_v1
WHEN NEW.run_id != OLD.run_id OR NEW.trigger != OLD.trigger OR NEW.event_ref != OLD.event_ref
  OR NEW.organization_id != OLD.organization_id OR NEW.principal_id != OLD.principal_id OR NEW.membership_id != OLD.membership_id
  OR NEW.record_sha256 IS NOT OLD.record_sha256 OR NEW.scope_kind IS NOT OLD.scope_kind OR NEW.scope_id IS NOT OLD.scope_id
  OR NEW.created_at != OLD.created_at
BEGIN SELECT RAISE(ABORT, 'trigger run identity is immutable'); END;

CREATE TABLE authority_impact_items_v1 (
  item_id TEXT PRIMARY KEY CHECK (item_id GLOB 'itm_*' AND length(item_id) BETWEEN 8 AND 64),
  run_id TEXT NOT NULL REFERENCES authority_trigger_runs_v1(run_id),
  item_key TEXT NOT NULL CHECK (item_key LIKE 'sha256:%'),
  pointer_json TEXT NOT NULL CHECK (json_valid(pointer_json) AND json_type(pointer_json) = 'object'),
  record_sha256 TEXT NOT NULL CHECK (record_sha256 LIKE 'sha256:%'),
  organization_id TEXT NOT NULL,
  approver_principal_id TEXT NOT NULL,
  approver_membership_id TEXT NOT NULL REFERENCES authority_memberships(membership_id),
  relation TEXT CHECK (relation IS NULL OR relation IN ('conflicts', 'needs_updating')),
  expected TEXT CHECK (expected IS NULL OR length(expected) BETWEEN 1 AND 120),
  owner_membership_id TEXT NOT NULL REFERENCES authority_memberships(membership_id),
  owner_match TEXT NOT NULL CHECK (owner_match IN ('jira_account', 'name', 'picked', 'approver', 'reassigned')),
  owner_set_by TEXT REFERENCES authority_memberships(membership_id),
  owner_set_at TEXT CHECK (owner_set_at IS NULL OR unixepoch(owner_set_at) IS NOT NULL),
  state TEXT NOT NULL CHECK (state IN ('unsent', 'open', 'done', 'not_relevant')),
  state_set_by TEXT REFERENCES authority_memberships(membership_id),
  state_set_at TEXT CHECK (state_set_at IS NULL OR unixepoch(state_set_at) IS NOT NULL),
  sent_at TEXT CHECK (sent_at IS NULL OR unixepoch(sent_at) IS NOT NULL),
  send_command_id TEXT CHECK (send_command_id IS NULL OR length(send_command_id) BETWEEN 1 AND 128),
  checked_verdict TEXT CHECK (checked_verdict IS NULL OR checked_verdict IN ('landed', 'still_open', 'changed', 'unreadable')),
  checked_by TEXT REFERENCES authority_memberships(membership_id),
  checked_at TEXT CHECK (checked_at IS NULL OR unixepoch(checked_at) IS NOT NULL),
  checked_run_id TEXT REFERENCES authority_trigger_runs_v1(run_id),
  created_at TEXT NOT NULL CHECK (unixepoch(created_at) IS NOT NULL),
  updated_at TEXT NOT NULL CHECK (unixepoch(updated_at) IS NOT NULL),
  UNIQUE (run_id, item_key),
  CHECK (relation IS NOT NULL OR expected IS NULL),
  CHECK ((state = 'unsent') = (sent_at IS NULL)),
  CHECK ((sent_at IS NULL) = (send_command_id IS NULL)),
  CHECK ((state_set_by IS NULL) = (state_set_at IS NULL)),
  CHECK ((owner_set_by IS NULL) = (owner_set_at IS NULL)),
  CHECK ((checked_verdict IS NULL) = (checked_at IS NULL) AND (checked_at IS NULL) = (checked_by IS NULL) AND (checked_by IS NULL) = (checked_run_id IS NULL))
) STRICT;
CREATE INDEX authority_impact_items_by_owner_v1 ON authority_impact_items_v1 (organization_id, owner_membership_id, state);
CREATE INDEX authority_impact_items_by_approver_v1 ON authority_impact_items_v1 (organization_id, approver_membership_id, state);
CREATE INDEX authority_impact_items_by_record_v1 ON authority_impact_items_v1 (record_sha256, state);
CREATE TRIGGER authority_impact_item_insert_v1
BEFORE INSERT ON authority_impact_items_v1
WHEN NEW.state != 'unsent' OR NEW.state_set_by IS NOT NULL OR NEW.owner_set_by IS NOT NULL OR NEW.checked_at IS NOT NULL
  OR NEW.owner_match NOT IN ('jira_account', 'name', 'approver')
  OR NOT EXISTS (SELECT 1 FROM authority_trigger_runs_v1 r WHERE r.run_id = NEW.run_id AND r.trigger = 'approved_record' AND r.state = 'done'
    AND r.record_sha256 = NEW.record_sha256 AND r.organization_id = NEW.organization_id
    AND r.principal_id = NEW.approver_principal_id AND r.membership_id = NEW.approver_membership_id)
BEGIN SELECT RAISE(ABORT, 'an open item starts unsent from its finished impact run'); END;
CREATE TRIGGER authority_impact_item_identity_immutable_v1
BEFORE UPDATE ON authority_impact_items_v1
WHEN NEW.item_id != OLD.item_id OR NEW.run_id != OLD.run_id OR NEW.item_key != OLD.item_key OR NEW.pointer_json != OLD.pointer_json
  OR NEW.record_sha256 != OLD.record_sha256 OR NEW.organization_id != OLD.organization_id
  OR NEW.approver_principal_id != OLD.approver_principal_id OR NEW.approver_membership_id != OLD.approver_membership_id
  OR NEW.relation IS NOT OLD.relation OR NEW.expected IS NOT OLD.expected OR NEW.created_at != OLD.created_at
BEGIN SELECT RAISE(ABORT, 'open item identity is immutable'); END;
CREATE TRIGGER authority_impact_item_send_v1
BEFORE UPDATE OF state, sent_at, send_command_id ON authority_impact_items_v1
WHEN (OLD.state = 'unsent' AND NEW.state NOT IN ('unsent', 'open', 'not_relevant'))
  OR (OLD.state != 'unsent' AND (NEW.state = 'unsent' OR NEW.sent_at IS NOT OLD.sent_at OR NEW.send_command_id IS NOT OLD.send_command_id))
BEGIN SELECT RAISE(ABORT, 'open item state move is not allowed'); END;
CREATE TRIGGER authority_impact_item_check_newer_v1
BEFORE UPDATE OF checked_at ON authority_impact_items_v1
WHEN OLD.checked_at IS NOT NULL AND (NEW.checked_at IS NULL OR NEW.checked_at <= OLD.checked_at)
BEGIN SELECT RAISE(ABORT, 'a last check is replaced only by a newer one'); END;
CREATE TRIGGER authority_impact_item_delete_denied_v1
BEFORE DELETE ON authority_impact_items_v1
BEGIN SELECT RAISE(ABORT, 'open item deletion is denied'); END;
```

Timestamps are written with `Date.toISOString()` everywhere, so string order is time order (the runs DAO already relies on this). The scope CHECK tests `scope_kind IS NOT NULL` first, so an approved-record row (no scope) passes; an `expected` phrase needs a relation, but a relation may come without one (the model gave no usable phrase).

**Interfaces:**

```ts
// trigger-runs-v1.ts (changed)
export type TriggerRunScopeV1 =
  | { readonly kind: 'mine' }
  | { readonly kind: 'record'; readonly record_sha256: Sha256Digest }
  | { readonly kind: 'project'; readonly project_id: string };
export interface TriggerRunRowV1 {
  readonly run_id: string; readonly trigger: 'approved_record' | 'sweep'; readonly event_ref: string;
  readonly actor: ApprovalActorV1; readonly record_sha256: Sha256Digest | null; readonly scope: TriggerRunScopeV1 | null;
  readonly state: TriggerRunStateV1; readonly attempts: number; readonly lease_token: string | null; readonly lease_expires_at: string | null;
  readonly result_json: string | null; readonly error_code: TriggerRunErrorV1 | null; readonly created_at: string; readonly updated_at: string;
}
export class SqliteTriggerRunsV1 {
  constructor(database: Database.Database, now?: () => Date);                       // requires user_version 13 and foreign keys
  enqueueApprovedRecord(transaction: Database.Database, event: AfterApprovedRecordEventV1): void;   // unchanged
  /** One immediate transaction: the actor's pending or running sweep of the same scope, else a new pending one (`event_ref` = `sweep_<uuid>`). */
  enqueueSweep(actor: ApprovalActorV1, scope: TriggerRunScopeV1): { readonly run_id: string; readonly created: boolean };
  /** The actor's pending or running sweep of any scope. */
  liveSweep(actor: ApprovalActorV1): TriggerRunRowV1 | undefined;
  list(actor: ApprovalActorV1, limit: number): readonly TriggerRunRowV1[];           // unchanged; now includes sweeps
  read(actor: ApprovalActorV1, runId: string): TriggerRunRowV1 | undefined;          // unchanged, actor-fenced
  /** Not fenced: callers must apply the open-items access policy before returning anything from it. */
  readUnfenced(runId: string): TriggerRunRowV1 | undefined;
  /** The approved-record runs of these records. Not fenced, as above. */
  impactRunsFor(recordSha256s: readonly Sha256Digest[]): readonly TriggerRunRowV1[];
  claim(...): unchanged;  release(...): unchanged;  fail(...): unchanged;
  /** `then` runs inside the same immediate transaction, only when this call moved the run to done. */
  finish(runId: string, leaseToken: string, result: { readonly json: string; readonly sha256: Sha256Digest }, then?: (transaction: Database.Database) => void): boolean;
  /** failed → pending for approved-record runs only; a failed sweep stays failed and the next sweep replaces it. */
  retry(actor: ApprovalActorV1, runId: string): boolean;
}
```

```ts
// impact-items-v1.ts (new)
export type ImpactItemStateV1 = 'unsent' | 'open' | 'done' | 'not_relevant';
export type ImpactItemVerdictV1 = 'landed' | 'still_open' | 'changed' | 'unreadable';
export type ImpactOwnerMatchV1 = 'jira_account' | 'name' | 'picked' | 'approver' | 'reassigned';
export interface ImpactItemDraftV1 {
  readonly item_key: Sha256Digest;
  readonly pointer: Readonly<Record<string, unknown>>;            // a stored citation pointer, no text
  readonly relation: 'conflicts' | 'needs_updating' | null;
  readonly expected: string | null;
  readonly owner_membership_id: string;
  readonly owner_match: 'jira_account' | 'name' | 'approver';
}
export interface ImpactItemRowV1 {
  readonly item_id: string; readonly run_id: string; readonly item_key: Sha256Digest; readonly pointer: Readonly<Record<string, unknown>>;
  readonly record_sha256: Sha256Digest; readonly organization_id: string;
  readonly approver: { readonly principal_id: string; readonly membership_id: string };
  readonly relation: 'conflicts' | 'needs_updating' | null; readonly expected: string | null;
  readonly owner_membership_id: string; readonly owner_match: ImpactOwnerMatchV1;
  readonly state: ImpactItemStateV1; readonly state_set_by: string | null; readonly state_set_at: string | null;
  readonly sent_at: string | null; readonly send_command_id: string | null;
  readonly check: { readonly verdict: ImpactItemVerdictV1; readonly by: string; readonly at: string; readonly run_id: string } | null;
  readonly created_at: string; readonly updated_at: string;
}
export interface ImpactSendChoiceV1 { readonly item_id: string; readonly include: boolean; readonly owner_membership_id?: string }
export class SqliteImpactItemsV1 {
  constructor(database: Database.Database, now?: () => Date);                       // requires user_version 13 and foreign keys
  /** Inside the impact run's finishing transaction (`SqliteTriggerRunsV1.finish`'s `then`). `itm_<uuid>` ids. */
  insertForRun(transaction: Database.Database, run: TriggerRunRowV1, drafts: readonly ImpactItemDraftV1[]): void;
  read(itemId: string): ImpactItemRowV1 | undefined;                                  // not fenced
  forRun(runId: string): readonly ImpactItemRowV1[];
  /** Oldest first by created_at, then item_id; `after` is the last row of the previous page. */
  forRecords(recordSha256s: readonly Sha256Digest[], options: { readonly states: readonly ImpactItemStateV1[]; readonly limit: number; readonly after?: { readonly created_at: string; readonly item_id: string } }): readonly ImpactItemRowV1[];
  /** Items this member approved or owns. */
  involving(organizationId: string, membershipId: string, options: { readonly states: readonly ImpactItemStateV1[]; readonly limit: number }): readonly ImpactItemRowV1[];
  /** Unsent or open items whose approver and owner memberships are both inactive. */
  orphaned(organizationId: string, options: { readonly limit: number }): readonly ImpactItemRowV1[];
  /**
   * One immediate transaction. Replayed when any item of the run carries `command_id`.
   * Stale when the run has no unsent item or `choices` is not exactly its unsent items.
   * Included → open (with the picked owner, `owner_match = picked`, when one is given and differs);
   * excluded → not_relevant. Sets sent_at, send_command_id, state_set_by/at = `by`.
   */
  send(input: { readonly run_id: string; readonly by: string; readonly command_id: string; readonly choices: readonly ImpactSendChoiceV1[] }):
    { readonly kind: 'sent' | 'replayed'; readonly sent: number; readonly not_relevant: number } | { readonly kind: 'stale' };
  /** undefined when the item is missing or still unsent. */
  setState(itemId: string, state: 'open' | 'done' | 'not_relevant', by: string): ImpactItemRowV1 | undefined;
  assign(itemId: string, ownerMembershipId: string, by: string): ImpactItemRowV1 | undefined;   // owner_match = reassigned
  /** In the sweep's finishing transaction. False when the item holds an equal or newer check. */
  recordCheck(transaction: Database.Database, input: { readonly item_id: string; readonly verdict: ImpactItemVerdictV1; readonly by: string; readonly at: string; readonly run_id: string }): boolean;
}
```

```ts
// open-item-people-v1.ts (new): ECHO's own directory facts, read from authority_memberships, authority_principals and authority_project_memberships_v1.
export class SqliteOpenItemPeopleV1 {
  constructor(database: Database.Database);
  /** Display names and whether each membership is active, for these memberships of the organization. */
  people(organizationId: string, membershipIds: readonly string[]): ReadonlyMap<string, { readonly name: string; readonly active: boolean }>;
  /** Active memberships whose display name equals `name` ignoring case and runs of whitespace (NFC). */
  activeByName(organizationId: string, name: string): readonly string[];
  isActiveMember(organizationId: string, membershipId: string): boolean;
  /** The member is an active lead of at least one of these projects (active grant, active membership). */
  leadsAny(membershipId: string, projectIds: readonly string[]): boolean;
}
```

- [ ] **Step 1: Write the failing tests.**

```ts
// trigger-runs-v1.test.ts (add)
it('queues one live sweep per person and scope, and a new one once it is done', async () => {
  const f = await approvedRunFixture();
  const first = f.runs.enqueueSweep(f.owner, { kind: 'mine' });
  expect(first.created).toBe(true);
  expect(f.runs.enqueueSweep(f.owner, { kind: 'mine' })).toEqual({ run_id: first.run_id, created: false });
  expect(f.runs.enqueueSweep(f.owner, { kind: 'record', record_sha256: f.recordSha256 }).created).toBe(true);
  expect(f.runs.read(f.owner, first.run_id)).toMatchObject({ trigger: 'sweep', record_sha256: null, scope: { kind: 'mine' }, state: 'pending' });
  const claimed = f.runs.claim(f.owner, first.run_id, 600_000);
  if (claimed.kind !== 'claimed') throw new Error('expected lease');
  expect(f.runs.finish(first.run_id, claimed.lease_token, { json: '{"schema_version":1}', sha256: canonicalSha256({ schema_version: 1 }) })).toBe(true);
  expect(f.runs.enqueueSweep(f.owner, { kind: 'mine' }).created).toBe(true);
});
it('refuses a sweep row with a record and an approved-record row without one', async () => {
  const f = await approvedRunFixture();
  expect(() => f.db.prepare(`INSERT INTO authority_trigger_runs_v1 (run_id, trigger, event_ref, organization_id, principal_id, membership_id, record_sha256, scope_kind, state, attempts, created_at, updated_at)
    VALUES ('run_badsweep', 'sweep', 'sweep_x', ?, ?, ?, ?, 'mine', 'pending', 0, ?, ?)`).run(f.person.organization_id, f.person.principal_id, f.person.membership_id, f.recordSha256, NOW, NOW)).toThrow();
});
it('runs the finishing callback in the same transaction and never after a lost lease', async () => {
  const f = await approvedRunFixture();
  const run = f.runs.list(f.owner, 1)[0]!;
  const lease = f.runs.claim(f.owner, run.run_id, 600_000);
  if (lease.kind !== 'claimed') throw new Error('expected lease');
  f.advance(600_001);
  const then = vi.fn();
  expect(f.runs.finish(run.run_id, lease.lease_token, card(), then)).toBe(false);
  expect(then).not.toHaveBeenCalled();
});
```

```ts
// impact-items-v1.test.ts (new; helper `doneRunFixture()` = approvedRunFixture + claim + finish with a stored card)
it('inserts unsent items only for a done approved-record run of the same record and approver', async () => {
  const f = await doneRunFixture();
  f.db.transaction(() => f.items.insertForRun(f.db, f.run, [draft('46'), draft('47')]))();
  expect(f.items.forRun(f.run.run_id).map(row => row.state)).toEqual(['unsent', 'unsent']);
  const pending = await approvedRunFixture();
  expect(() => pending.db.transaction(() => f.items.insertForRun(pending.db, pending.runs.list(pending.owner, 1)[0]!, [draft('46')]))()).toThrow('starts unsent');
});
it('sends once per command, refuses a stale list, and marks unticked items not relevant', async () => {
  const f = await doneRunWithItems(['46', '47']);
  const [a, b] = f.items.forRun(f.run.run_id);
  expect(f.items.send({ run_id: f.run.run_id, by: f.owner.membership_id, command_id: 'cmd-1', choices: [{ item_id: a!.item_id, include: true }] })).toEqual({ kind: 'stale' });
  const choices = [{ item_id: a!.item_id, include: true, owner_membership_id: f.mina }, { item_id: b!.item_id, include: false }];
  expect(f.items.send({ run_id: f.run.run_id, by: f.owner.membership_id, command_id: 'cmd-1', choices })).toEqual({ kind: 'sent', sent: 1, not_relevant: 1 });
  expect(f.items.send({ run_id: f.run.run_id, by: f.owner.membership_id, command_id: 'cmd-1', choices })).toEqual({ kind: 'replayed', sent: 1, not_relevant: 1 });
  expect(f.items.send({ run_id: f.run.run_id, by: f.owner.membership_id, command_id: 'cmd-2', choices })).toEqual({ kind: 'stale' });
  expect(f.items.read(a!.item_id)).toMatchObject({ state: 'open', owner_membership_id: f.mina, owner_match: 'picked' });
  expect(f.items.read(b!.item_id)).toMatchObject({ state: 'not_relevant' });
});
it('never moves an item back to unsent, keeps identity frozen, and keeps only a newer check', async () => {
  const f = await sentItemFixture();
  expect(() => f.db.prepare("UPDATE authority_impact_items_v1 SET state='unsent', sent_at=NULL, send_command_id=NULL WHERE item_id=?").run(f.itemId)).toThrow();
  expect(() => f.db.prepare("UPDATE authority_impact_items_v1 SET expected='something else' WHERE item_id=?").run(f.itemId)).toThrow('immutable');
  expect(() => f.db.prepare('DELETE FROM authority_impact_items_v1 WHERE item_id=?').run(f.itemId)).toThrow('denied');
  expect(f.db.transaction(() => f.items.recordCheck(f.db, { item_id: f.itemId, verdict: 'landed', by: f.owner.membership_id, at: '2026-10-08T10:00:00.000Z', run_id: f.sweepRunId }))()).toBe(true);
  expect(f.db.transaction(() => f.items.recordCheck(f.db, { item_id: f.itemId, verdict: 'changed', by: f.owner.membership_id, at: '2026-10-08T09:00:00.000Z', run_id: f.sweepRunId }))()).toBe(false);
  expect(f.items.read(f.itemId)!.check).toMatchObject({ verdict: 'landed' });
});
it('finds items by person, record, and both-inactive orphans', async () => { /* involving(owner) and involving(approver) return the item; forRecords pages oldest first; orphaned() lists it after both memberships are revoked */ });
```

```ts
// open-item-people-v1.test.ts (new)
it('matches an exact name held by exactly one active member', () => {
  const f = peopleFixture([['mem_a', 'Rafael Moreno', 'active'], ['mem_b', 'Mina Patel', 'active'], ['mem_c', 'Mina  patel', 'active'], ['mem_d', 'Ari Lee', 'revoked']]);
  expect(f.people.activeByName(f.org, 'rafael moreno')).toEqual(['mem_a']);
  expect(f.people.activeByName(f.org, 'Mina Patel')).toEqual(['mem_b', 'mem_c']);   // two holders: the caller treats it as no match
  expect(f.people.activeByName(f.org, 'Ari Lee')).toEqual([]);
  expect(f.people.leadsAny('mem_a', [PROJECT_A])).toBe(false);
});
```

- [ ] **Step 2:** `npx vitest run --config vitest.config.ts services/organization-authority/test/trigger-runs-v1.test.ts services/organization-authority/test/impact-items-v1.test.ts services/organization-authority/test/open-item-people-v1.test.ts` → FAIL.
- [ ] **Step 3:** Implement the SQL, both DAOs and the runs changes. Keep `SqliteTriggerRunsV1`'s existing behavior for approved-record runs byte for byte; `publicRow` maps `scope_kind`/`scope_id` into `scope`. Update the baseline hash pins.
- [ ] **Step 4:** Rerun the three files plus `services/organization-authority/test/person-trigger-runs-v1.test.ts` (unchanged behavior). Expected: PASS.
- [ ] **Step 5: Commit** `feat: open items table and sweep runs in Authority V13`.

---

### Task 3: The open-items access policy

**Files:**
- Create: `services/organization-authority/src/composition/open-items-policy-v1.ts`
- Test: `services/organization-authority/test/open-items-policy-v1.test.ts`

**Interfaces:**
- Produces: `openItemAccessV1(facts: OpenItemFactsV1): OpenItemAccessV1`, used by every open-items operation (Tasks 7 and 11).

```ts
/**
 * Who may see and act on an open item (open items and Home v1, section 4;
 * ADR-0033). Every open-items operation asks this function; nothing else
 * decides access. These rules are a foundation (founder, 2026-10-08): a later
 * organization rule, such as an admin or an org-wide view, changes this
 * function and its facts, not the table or the queries. An outside item's
 * words stay behind `opens_item` whatever the rules become (ADR-0032).
 */
export interface OpenItemFactsV1 {
  readonly viewer: string;                     // membership ids throughout
  readonly approver: string;
  readonly owner: string;
  readonly approver_active: boolean;
  readonly owner_active: boolean;
  /** The viewer passes the exact record check for the item's decision now. */
  readonly reads_decision: boolean;
  /** The viewer is an active lead of one of the decision's projects. */
  readonly leads_decision_project: boolean;
  /** The viewer opened the item in its tool in this request; absent when no open was tried. */
  readonly opens_item?: boolean;
}
export interface OpenItemAccessV1 {
  readonly see_row: boolean;
  readonly see_outside: boolean;
  readonly set_state: boolean;
  readonly assign: boolean;
  /** Who the item waits on now: the owner, else the approver, else the decision's project leads. */
  readonly waits_on: 'owner' | 'approver' | 'leads';
  readonly waits_on_viewer: boolean;
}
export function openItemAccessV1(facts: OpenItemFactsV1): OpenItemAccessV1 {
  const owner = facts.viewer === facts.owner;
  const approver = facts.viewer === facts.approver;
  const see_row = facts.reads_decision || owner;
  const waits_on = facts.owner_active ? 'owner' as const : facts.approver_active ? 'approver' as const : 'leads' as const;
  return Object.freeze({
    see_row,
    see_outside: see_row && facts.opens_item === true,
    set_state: see_row && (approver || owner),
    assign: see_row && (approver || owner || facts.leads_decision_project),
    waits_on,
    waits_on_viewer: see_row && (waits_on === 'owner' ? owner : waits_on === 'approver' ? approver : facts.leads_decision_project),
  });
}
```

- [ ] **Step 1: Write the failing test** as a table:

```ts
const base = { viewer: 'mem_x', approver: 'mem_ari', owner: 'mem_mina', approver_active: true, owner_active: true, reads_decision: false, leads_decision_project: false };
it.each([
  ['approver reading the decision', { viewer: 'mem_ari', reads_decision: true }, { see_row: true, set_state: true, assign: true, waits_on: 'owner', waits_on_viewer: false }],
  ['owner who cannot read the decision', { viewer: 'mem_mina' }, { see_row: true, set_state: true, assign: true, waits_on: 'owner', waits_on_viewer: true }],
  ['project member reading the decision', { reads_decision: true }, { see_row: true, set_state: false, assign: false, waits_on_viewer: false }],
  ['project lead reading the decision', { reads_decision: true, leads_decision_project: true }, { see_row: true, set_state: false, assign: true }],
  ['stranger', {}, { see_row: false, see_outside: false, set_state: false, assign: false, waits_on_viewer: false }],
  ['approver after the owner left', { viewer: 'mem_ari', reads_decision: true, owner_active: false }, { waits_on: 'approver', waits_on_viewer: true }],
  ['lead after both left', { reads_decision: true, leads_decision_project: true, owner_active: false, approver_active: false }, { waits_on: 'leads', waits_on_viewer: true }],
  ['reader who cannot open the item', { reads_decision: true, opens_item: false }, { see_row: true, see_outside: false }],
  ['reader who opened the item', { reads_decision: true, opens_item: true }, { see_outside: true }],
] as const)('%s', (_name, facts, expected) => {
  expect(openItemAccessV1({ ...base, ...facts })).toMatchObject(expected);
});
```

- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `feat: one access policy for open items`.

---

### Task 4: API contract for open items

**Files:**
- Modify: `packages/organization-api/src/person-runs-v1.ts` (requests, results, validators)
- Modify: `packages/organization-api/src/index.ts` (exports)
- Modify (temporary, keeps the tree building until Task 7 and Task 9): `services/organization-authority/src/presentation/organization-authority-http-server.ts` — the runs route's `switch` gains a `default` that throws `AuthorityOperationError('unavailable', 'This operation is not available yet')`; `product/echo-desktop/src/shared/protocol.ts` — `RunsResults` gains the new operations' raw API result types (`home: PersonRunsResultsV1['home']`, and so on), which Task 9 replaces with views.
- Test: `packages/organization-api/test/person-runs-v1.test.ts`

**Interfaces** (all exported):

```ts
// person-runs-v1.ts additions (Part 1). `sweep` and `PersonRunV1.trigger: 'sweep'` come in Task 10.
export type PersonOpenItemStateV1 = 'unsent' | 'open' | 'done' | 'not_relevant';
export type PersonOpenItemVerdictV1 = 'landed' | 'still_open' | 'changed' | 'unreadable';
export type PersonOpenItemKindV1 = 'ticket' | 'page' | 'slack_message' | 'record' | 'document';
export type PersonOpenItemOwnerMatchV1 = 'jira_account' | 'name' | 'picked' | 'approver' | 'reassigned';
export interface PersonOpenItemPersonV1 { readonly membership_id: string; readonly name: string; readonly active: boolean }
/** Only for a viewer who can read the decision now. ECHO data. */
export interface PersonOpenItemDecisionV1 {
  readonly approval_id: string; readonly record_sha256: string; readonly title: string;
  /** The impact card's first decided line, when it has one. */
  readonly first_line: string | null;
  readonly approved_at: string; readonly project_ids: readonly string[];
}
/** Only for a viewer who opened the item in its tool in this request. Read live, never stored. */
export interface PersonOpenItemCurrentV1 {
  readonly citation: PersonAnswerCitationV6;
  /** The first 300 characters of its text on one line, else its title and details. */
  readonly says_now: string;
  readonly assignee?: string; readonly status?: string; readonly due_at?: string;
}
export interface PersonOpenItemV1 {
  readonly item_id: string; readonly run_id: string; readonly kind: PersonOpenItemKindV1;
  readonly decision?: PersonOpenItemDecisionV1;
  readonly current?: PersonOpenItemCurrentV1;
  readonly relation: 'conflicts' | 'needs_updating' | null;
  readonly expected: string | null;
  readonly approver: PersonOpenItemPersonV1;
  readonly owner: PersonOpenItemPersonV1 & { readonly match: PersonOpenItemOwnerMatchV1 };
  readonly waits_on: 'owner' | 'approver' | 'leads';
  readonly state: PersonOpenItemStateV1;
  readonly created_at: string; readonly sent_at: string | null; readonly state_set_at: string | null;
  readonly check: { readonly verdict: PersonOpenItemVerdictV1; readonly checked_at: string; readonly checked_by: string } | null;
  readonly can: { readonly set_state: boolean; readonly assign: boolean };
}
export interface PersonHomeSendV1 {
  readonly run_id: string; readonly decision: PersonOpenItemDecisionV1;
  readonly items: number; readonly kinds: readonly PersonOpenItemKindV1[];
  /** Owner names other than the approver, each once. */
  readonly owners: readonly string[];
  readonly finished_at: string;
}
export interface PersonOpenItemsSummaryV1 {
  readonly unsent: number; readonly open: number; readonly done: number; readonly not_relevant: number;
  readonly landed: number; readonly changed: number; readonly unreadable: number;
  readonly decisions: number; readonly last_checked_at: string | null;
  readonly by_decision: readonly { readonly record_sha256: string; readonly unsent: number; readonly open: number }[];
}
export interface PersonImpactStageV1 {
  readonly record_sha256: string; readonly run_id: string;
  readonly state: PersonRunStateV1; readonly error_code: PersonRunErrorCodeV1 | null;
}
export type PersonRunsRequestV1 =
  | { readonly schema_version: 1; readonly operation: 'list' | 'home' }
  | { readonly schema_version: 1; readonly operation: 'start' | 'retry' | 'view'; readonly run_id: string }
  | { readonly schema_version: 1; readonly operation: 'items'; readonly scope: 'mine' | 'run' | 'record' | 'project'; readonly id?: string; readonly cursor?: string }
  | { readonly schema_version: 1; readonly operation: 'item'; readonly item_id: string }
  | { readonly schema_version: 1; readonly operation: 'send'; readonly run_id: string; readonly command_id: string;
      readonly items: readonly { readonly item_id: string; readonly include: boolean; readonly owner_membership_id?: string }[] }
  | { readonly schema_version: 1; readonly operation: 'set_state'; readonly item_id: string; readonly state: 'open' | 'done' | 'not_relevant' }
  | { readonly schema_version: 1; readonly operation: 'assign'; readonly item_id: string; readonly owner_membership_id: string };
export interface PersonRunsResultsV1 {
  list: ...; start: ...; retry: ...; view: ...;          // unchanged
  home: { readonly send: readonly PersonHomeSendV1[]; readonly items: readonly PersonOpenItemV1[];
          readonly landed: number; readonly waiting: number; readonly last_checked_at: string | null };
  items: { readonly items: readonly PersonOpenItemV1[]; readonly next_cursor: string | null;
           readonly summary: PersonOpenItemsSummaryV1; readonly stages: readonly PersonImpactStageV1[] };
  item: { readonly item: PersonOpenItemV1 };
  send: { readonly sent: number; readonly not_relevant: number };
  set_state: { readonly state: 'open' | 'done' | 'not_relevant' };
  assign: { readonly owner: PersonOpenItemPersonV1 };
}
export const PERSON_OPEN_ITEMS_PAGE_V1 = 50;
export const PERSON_HOME_ROWS_V1 = 20;
```

**Validation rules** (follow the file's existing style: `assertExactKeys`, frozen output, `fail` on anything else):
- Ids: `run_id` as today; `item_id` `/^itm_[A-Za-z0-9-]{4,60}$/`; membership ids with the existing membership id check used by `project-context-v1.ts`; project ids with `validateProjectIdV1`-style check; record ids `/^sha256:[0-9a-f]{64}$/`; `command_id` `/^[A-Za-z0-9_-]{1,128}$/`; `cursor` `/^[A-Za-z0-9_-]{1,256}$/`.
- `items`: `id` is required for `run`, `record` and `project` and absent for `mine`.
- `send.items`: 1 to 20 entries, unique `item_id`s, `include` boolean, `owner_membership_id` only with `include: true`.
- Results: `items` at most 50 per page, `home.send` and `home.items` at most 20 each, `by_decision` and `stages` at most 100; counts are safe non-negative integers; names 1–200 characters on one line; `expected` and `first_line` validated like the impact card's lines (`expected` at most 120, `first_line` at most 300); `says_now` at most 300; `current.citation` with `validatePersonAnswerCitationV6`; `decision` and `current` optional keys; `check.verdict` one of four; `waits_on` one of three; the existing 1 MiB response cap.

- [ ] **Step 1: Write the failing tests:**

```ts
it('accepts each new runs request and refuses a scope without its id', () => {
  expect(validatePersonRunsRequestV1({ schema_version: 1, operation: 'home' })).toEqual({ schema_version: 1, operation: 'home' });
  expect(validatePersonRunsRequestV1({ schema_version: 1, operation: 'items', scope: 'record', id: RECORD })).toMatchObject({ scope: 'record', id: RECORD });
  expect(() => validatePersonRunsRequestV1({ schema_version: 1, operation: 'items', scope: 'project' })).toThrow();
  expect(() => validatePersonRunsRequestV1({ schema_version: 1, operation: 'items', scope: 'mine', id: RECORD })).toThrow();
  expect(() => validatePersonRunsRequestV1({ schema_version: 1, operation: 'send', run_id: RUN, command_id: 'c1', items: [{ item_id: ITEM, include: false, owner_membership_id: MINA }] })).toThrow();
  expect(() => validatePersonRunsRequestV1({ schema_version: 1, operation: 'set_state', item_id: ITEM, state: 'unsent' })).toThrow();
});
it('validates an open item with and without the parts a viewer may not see', () => {
  const seen = openItem({ decision: DECISION, current: CURRENT });
  expect(validatePersonRunsResultV1('item', { item: seen }).item.current?.says_now).toBe(CURRENT.says_now);
  expect(validatePersonRunsResultV1('item', { item: openItem({}) }).item).not.toHaveProperty('current');
  expect(() => validatePersonRunsResultV1('item', { item: { ...seen, pointer: {} } })).toThrow();      // no extra key ever
  expect(() => validatePersonRunsResultV1('home', { send: [], items: Array.from({ length: 21 }, () => seen), landed: 0, waiting: 0, last_checked_at: null })).toThrow();
});
```

- [ ] **Step 2:** `npm run test:protocols` → FAIL.
- [ ] **Step 3:** Implement types and validators; export from `index.ts`.
- [ ] **Step 4:** `npm run test:protocols` → PASS; `npm run build`, root `tsc --noEmit -p tsconfig.json` and `cd product/echo-desktop && npm run typecheck` → PASS.
- [ ] **Step 5: Commit** `feat: runs API operations for open items`.

---

### Task 5: The impact card's `expected` phrase and item keys

**Files:**
- Modify: `packages/organization-authority-kernel/src/answer-composition/renderers/impact-card-renderer-v1.ts`
- Modify: `packages/organization-authority-kernel/src/answer-composition/renderers/impact-card-storage-v1.ts`
- Modify: `packages/organization-api/src/person-impact-card-v1.ts` (`expected` on affected rows; limit `expected_chars: 120`)
- Modify: `services/organization-authority/src/composition/person-trigger-runs-v1.ts` (`stored()` accepts `expected`)
- Test: `packages/organization-authority-kernel/test/answer-composition/renderers/impact-card-renderer-v1.test.ts`, `.../impact-card-storage-v1.test.ts`, `packages/organization-api/test/person-impact-card-v1.test.ts`

**Interfaces:**
- `PersonImpactAffectedV1` gains `readonly expected?: string` — present only when the card is assessed and the relation is `conflicts` or `needs_updating`; 1–120 characters on one line.
- `StoredImpactCardV1.affected[]` gains `readonly expected?: string` (screened like every stored line).
- Produces: `export function impactItemKeyV1(pointer: unknown): Sha256Digest | undefined` (in the storage module): `canonicalSha256` of the existing private `itemOf(pointer)` value; undefined for a pointer that names no item. Two pointers to the same ticket with different `text_sha256` give the same key.
- Produces: `export function currentImpactLineV1(item: FreshImpactItemV1): string` (the storage module's existing `currentLine`, exported for Task 7's `says_now`).

**Renderer changes:**
- `IMPACT_CARD_PROMPT`, in the `affected` field list, after `relation`:

```text
  - expected: for "conflicts" and "needs_updating", a short phrase (under 15 words) of what the record requires of this item, in the record's own terms ("launch next week", "two decimals from DVT"). Never a date, name, number or fact that only the item states. "" for "confirms".
```

  and the reply example gains `"expected":"<short phrase>"`.
- `IMPACT_CARD_SCHEMA`: each affected entry requires `expected` (`{ type: 'string', maxLength: 120 }`).
- `parseCard`: keep `expected` (cleaned with `line(…, 120)`) only for `conflicts`/`needs_updating` and only when non-empty; add it to the screened `lines` so `SUGGESTED_EDIT` and `OWNERSHIP_CLAIM` apply to it.
- Layout: carry `expected` onto the affected row.
- The no-model fallback writes no `expected`.

- [ ] **Step 1: Write the failing tests** (`renderWith(reply)` runs the renderer with a fake gate that answers `reply` and returns `{ card, calls }`):

```ts
it('keeps the expected phrase for a conflict and drops it for a confirmation', async () => {
  const { card } = await renderWith({ affected: [
    { id: 'E2', says_now: 'THERM-46 asks for one decimal', relation: 'conflicts', date_at_risk: '', milestone: '', expected: 'two decimals from DVT' },
    { id: 'E3', says_now: 'The PRD already says two decimals', relation: 'confirms', date_at_risk: '', milestone: '', expected: 'two decimals' },
  ] });
  expect(card.affected.find(row => row.relation === 'conflicts')!.expected).toBe('two decimals from DVT');
  expect(card.affected.find(row => row.relation === 'confirms')).not.toHaveProperty('expected');
});
it('sends an instruction in expected back for one repair', async () => {
  const { calls } = await renderWith({ affected: [{ id: 'E2', says_now: 'x', relation: 'needs_updating', date_at_risk: '', milestone: '', expected: 'update the ticket to two decimals' }] });
  expect(calls).toBe(2);
});
```

```ts
// storage
it('stores expected with outside titles replaced', () => {
  const card = cardWith({ affected: [{ local: false, label: OUTSIDE, relation: 'conflicts', expected: `${OUTSIDE} shows two decimals` }] });
  const stored = storableImpactCardV1(card, [OUTSIDE]);
  expect(stored.affected[0]!.expected).toBe('a cited item shows two decimals');
});
it('gives one key per item whatever its text hash', () => {
  expect(impactItemKeyV1({ ...TICKET_46, text_sha256: H1 })).toBe(impactItemKeyV1({ ...TICKET_46, text_sha256: H2 }));
  expect(impactItemKeyV1(TICKET_46)).not.toBe(impactItemKeyV1(TICKET_47));
  expect(impactItemKeyV1({ kind: 'ticket' })).toBeUndefined();
});
```

```ts
// API
it('allows expected only on assessed conflicts and needs-updating rows', () => {
  expect(() => validatePersonImpactCardV1(assessedCard({ relation: 'confirms', expected: 'x' }))).toThrow();
  expect(() => validatePersonImpactCardV1(notAssessedCard({ expected: 'x' }))).toThrow();
  expect(validatePersonImpactCardV1(assessedCard({ relation: 'conflicts', expected: 'two decimals' })).affected[0]!.expected).toBe('two decimals');
});
```

- [ ] **Step 2:** Run the three test files → FAIL.
- [ ] **Step 3:** Implement. Update any renderer test that pins the schema or prompt text.
- [ ] **Step 4:** Run them, `packages/organization-authority-kernel/test/answer-composition` (Ask goldens unchanged) and `services/organization-authority/test/person-trigger-runs-v1.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: impact cards say what each affected item should become`.

---

### Task 6: Exact owner matching

**Files:**
- Modify: `providers/shared/src/person-connection-store-v1.ts` (`peopleForSubject`)
- Create: `services/organization-authority/src/application/ports/jira-owner-accounts-v1.ts`
- Modify: `services/organization-authority/src/composition/jira-person-live-runtime-v1.ts` (`owners` on the opened runtime)
- Create: `services/organization-authority/src/composition/impact-owner-matching-v1.ts`
- Test: `providers/shared/test/person-connection-store-v1.test.ts` (extend or create), `services/organization-authority/test/jira-owner-accounts-v1.test.ts`, `services/organization-authority/test/impact-owner-matching-v1.test.ts`

**Interfaces:**

```ts
// person-connection-store-v1.ts
/** The people whose active binding is this external account on this site. */
peopleForSubject(externalScopeId: string, externalSubjectId: string): readonly ConnectedPersonV1[];
```

```ts
// application/ports/jira-owner-accounts-v1.ts
/** Jira assignees as account ids, for matching an impact card's owners to ECHO members. Server only: an account id never reaches a model, a stored row or an API response. */
export interface JiraOwnerAccountsV1 {
  /** The Jira site (cloud id) this runtime reads. */
  readonly cloud_id: string;
  /** Assignee account ids by ticket id, read live with this person's Jira connection in bulk. A ticket it cannot read, or with no assignee, is left out; a failed read returns an empty map. */
  assignees(input: { readonly access_token: string; readonly ticket_ids: readonly string[]; readonly signal?: AbortSignal }): Promise<ReadonlyMap<string, string>>;
  /** The people whose active Jira connection is this account on this site. */
  people(accountId: string): readonly { readonly organization_id: string; readonly principal_id: string; readonly membership_id: string }[];
}
```

  The runtime implements `assignees` with `application.captureConnection({ access_token, signal })` and its transport: `POST /ex/jira/${cloud_id}/rest/api/3/issue/bulkfetch` with body `{ issueIdsOrKeys: <up to 100 ids per batch>, fields: ['assignee'] }` (the transport already allows this path), reading `issues[].id` and `issues[].fields.assignee.accountId` (`/^[A-Za-z0-9:_-]{1,128}$/`), ignoring `issueErrors`. `people` calls `new JiraConnectionStoreV1(database).peopleForSubject(cloud_id, accountId)`.

```ts
// impact-owner-matching-v1.ts
export interface ImpactOwnerCandidateV1 {
  /** The stored citation pointer of the affected item. */
  readonly pointer: Readonly<Record<string, unknown>>;
  /** The owner name the impact card took from the item's details, if any. */
  readonly owner_name?: string;
}
export interface ImpactOwnerMatchResultV1 { readonly owner_membership_id: string; readonly owner_match: 'jira_account' | 'name' | 'approver' }
/**
 * Exact matches only (open items and Home v1, ruling 1). A Jira ticket on the
 * runtime's site: the one active member whose Jira connection is the ticket's
 * assignee account. An ECHO record or document action: the one active member
 * whose display name equals its owner. Anything else, and any failure: the
 * approver. Never throws.
 */
export async function matchImpactOwnersV1(input: {
  readonly candidates: readonly ImpactOwnerCandidateV1[];
  readonly approver: { readonly organization_id: string; readonly membership_id: string };
  readonly access_token: string;
  readonly people: Pick<SqliteOpenItemPeopleV1, 'activeByName' | 'isActiveMember'>;
  readonly jira?: JiraOwnerAccountsV1;
  readonly signal?: AbortSignal;
}): Promise<readonly ImpactOwnerMatchResultV1[]>;
```

- [ ] **Step 1: Write the failing tests:**

```ts
// impact-owner-matching-v1.test.ts
it('matches a Jira assignee by connected account and an ECHO action owner by unique name', async () => {
  const jira = fakeJira({ assignees: new Map([['10046', 'acct-mina']]), people: { 'acct-mina': [MINA] } });
  const result = await matchImpactOwnersV1({ candidates: [
    { pointer: ticket('10046'), owner_name: 'Mina Patel' },
    { pointer: record(), owner_name: 'Rafael Moreno' },
    { pointer: page(), owner_name: 'Someone' },
    { pointer: ticket('10047') },
  ], approver: ARI, access_token: 'tok', people: people({ 'Rafael Moreno': ['mem_rafael'] }), jira });
  expect(result).toEqual([
    { owner_membership_id: MINA.membership_id, owner_match: 'jira_account' },
    { owner_membership_id: 'mem_rafael', owner_match: 'name' },
    { owner_membership_id: ARI.membership_id, owner_match: 'approver' },
    { owner_membership_id: ARI.membership_id, owner_match: 'approver' },
  ]);
});
it('falls back to the approver for a shared name, another organization, an inactive member, another site and a failed read', async () => { /* each case → approver */ });
it('never matches a Jira ticket by display name', async () => {
  const result = await matchImpactOwnersV1({ candidates: [{ pointer: ticket('10046'), owner_name: 'Rafael Moreno' }], approver: ARI, access_token: 'tok',
    people: people({ 'Rafael Moreno': ['mem_rafael'] }), jira: fakeJira({ assignees: new Map(), people: {} }) });
  expect(result[0]!.owner_match).toBe('approver');
});
```

```ts
// jira-owner-accounts-v1.test.ts: the runtime's `owners` over a fake fetch
it('reads assignees in one bulk call with the person connection and maps accounts to people', async () => {
  const f = await jiraRuntimeFixture({ bulk: { issues: [{ id: '10046', fields: { assignee: { accountId: 'acct-mina', displayName: 'Mina Patel' } } }, { id: '10047', fields: { assignee: null } }] } });
  expect(await f.runtime.owners.assignees({ access_token: f.token, ticket_ids: ['10046', '10047'] })).toEqual(new Map([['10046', 'acct-mina']]));
  expect(f.requests.filter(r => r.path.endsWith('/issue/bulkfetch'))).toHaveLength(1);
  f.connect(MINA, 'acct-mina');
  expect(f.runtime.owners.people('acct-mina')).toEqual([MINA]);
});
```

- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run, plus `npm run test:context-e2e` (Jira reader unchanged). Expected: PASS.
- [ ] **Step 5: Commit** `feat: match impact owners to members exactly`.

---

### Task 7: Runs service: items at finish and the open-items operations

**Files:**
- Modify: `services/organization-authority/src/composition/person-trigger-runs-v1.ts` (items at finish; `view` for decision readers)
- Create: `services/organization-authority/src/composition/person-open-items-v1.ts`
- Modify: `services/organization-authority/src/composition/person-record-search-route.ts` (`readableDecisions`, `projectRecords`)
- Modify: `services/organization-authority/src/presentation/person-trigger-runs-http-application.ts`, `organization-authority-http-server.ts` (route cases)
- Modify: `services/organization-authority/src/composition/organization-authority-api-runtime.ts` (compose; model-less stub answers `unavailable` for the new operations after authenticating)
- Modify: `src/product/person-client/commands.ts` (help text lists the operations)
- Test: `services/organization-authority/test/person-trigger-runs-v1.test.ts` (extend), `services/organization-authority/test/person-open-items-v1.test.ts` (new), `services/organization-authority/test/person-runs-http.test.ts` (extend), `services/organization-authority/test/person-record-search-route.test.ts` (extend), `tests/person-client/person-runs.test.ts` (extend)

**Interfaces:**

```ts
// person-record-search-route.ts
export interface PersonReadableDecisionV1 {
  readonly approval_id: string; readonly record_sha256: Sha256Digest; readonly title: string;
  readonly approved_at: string; readonly project_ids: readonly ProjectIdV1[];
}
export interface PersonReadableDecisionsV1 {
  /** The records among these that this person can read now (the exact Layer 1 check `admittedRecord`), with what a list row shows of each. A lookup, not a release: nothing is audited. */
  readableDecisions(input: { readonly access_token: string; readonly record_sha256s: readonly Sha256Digest[] }): ReadonlyMap<Sha256Digest, PersonReadableDecisionV1>;
  /** The records this person can read in one project now, newest first, at most `limit` (at most 500). */
  projectRecords(input: { readonly access_token: string; readonly project_id: string; readonly limit: number }): readonly Sha256Digest[];
}
```

  `title` and `approved_at` come from the same envelope helpers the person list uses for a meeting row; `project_ids` from `recordAssociations` filtered to the reader's projects, as `recordProjects` does.

```ts
// person-trigger-runs-http-application.ts: the port gains
home(input: { readonly access_token: string; readonly signal?: AbortSignal }): Promise<PersonRunsResultsV1['home']>;
items(input: { readonly access_token: string; readonly request: Extract<PersonRunsRequestV1, { operation: 'items' }>; readonly signal?: AbortSignal }): Promise<PersonRunsResultsV1['items']>;
item(...): Promise<PersonRunsResultsV1['item']>;   send(...): Promise<...['send']>;   set_state(...): Promise<...['set_state']>;   assign(...): Promise<...['assign']>;
```

```ts
// person-open-items-v1.ts
export function createPersonOpenItemsV1(options: {
  readonly sessions: { authenticateAccess(input: { readonly access_token: string }): PersonAccessAuthorization };
  readonly runs: SqliteTriggerRunsV1;
  readonly items: SqliteImpactItemsV1;
  readonly people: SqliteOpenItemPeopleV1;
  readonly records: PersonReadableDecisionsV1;
  readonly bindDesk: typeof bindPersonLiveEvidenceDeskV1;
  readonly bind_options: CreatePersonLiveAnswerRouteOptionsV1;
  readonly live_sources?: CreatePersonLiveAnswerRouteOptionsV1['live_sources'];
}): Pick<PersonTriggerRunsHttpApplicationV1, 'home' | 'items' | 'item' | 'send' | 'set_state' | 'assign'>;
```

**Behavior:**

*At the end of an impact run* (`launch` in `person-trigger-runs-v1.ts`, after `storableImpactCardV1`):
1. Candidates: each validated card affected row with relation `conflicts` or `needs_updating`, or with no relation (not assessed); never `confirms`. Pointer = `card.citations[row.citation_index].citation`; skip a pointer whose `impactItemKeyV1` is undefined; one candidate per item key.
2. `matchImpactOwnersV1` with the run's token, the approver, `options.people` and `options.jira_owners` (new optional option).
3. `runs.finish(run_id, lease, stored, tx => items.insertForRun(tx, row, drafts))` with `relation`, the stored `expected` (null when absent) and the match.

*`view`*: `runs.readUnfenced(run_id)` must be a `done` `approved_record` run whose actor is the caller or whose record `readableDecisions` admits for the caller; otherwise `not_found`. Everything after is unchanged (fresh desk as the caller).

*Presenting items* (one helper used by `home`, `items` and `item`):
1. Distinct records → `records.readableDecisions`; people → `people.people` for approvers, owners and checkers; `leadsAny` for each record's projects.
2. `openItemAccessV1` per row without `opens_item`; drop rows without `see_row`.
3. One desk for the request (global scope, the caller's token); `desk.openCitation({ citation: pointer })` for each kept row, at most 50, once per item key; a throw or an empty result means "cannot open". Then `desk.revalidate`.
4. `current` only when the open succeeded: `citation` as released now, `says_now = currentImpactLineV1(opened)`, `assignee`/`status`/`due_at` from the opened item's attributes.
5. `decision` only when `reads_decision`: `readableDecisions`' entry plus `first_line` = the run's stored card's first decided line (parse `result_json` with the existing private `stored()` reader in `person-trigger-runs-v1.ts`, exported as `readStoredImpactCardV1`; null when it has none).
6. `kind` from the pointer kind (`approved_record` → `record`, `source_revision` → `document`); `can` from the policy.

*`home`*:
- `send`: the caller's own `done` approved-record runs with at least one unsent item and a decision the caller can read; `owners` = owner names other than the caller's, each once; at most 20, newest first.
- `items`: open items where the policy says `waits_on_viewer`, plus open items the caller approved whose last check is `changed`; from `items.involving` and, for leads, `items.orphaned`; `changed` first, then oldest `sent_at`; at most 20.
- `landed`, `waiting`, `last_checked_at`: counted over open items the caller approved or owns, with no live reads.

*`items`*: `mine` → `involving`; `run` → `forRun`; `record` → `forRecords([id])`; `project` → `forRecords(projectRecords(...))`. Each row passes the policy. Pages of 50, oldest first, cursor = base64url of `created_at|item_id`. `summary` counts the whole visible scope (no live reads). `stages` = `runs.impactRunsFor` for the scope's decisions the caller can read.

*`send`*: the run must be the caller's own `done` approved-record run (`runs.read(actor, run_id)`) with a decision the caller can read, else `not_found`. Each picked owner must be an active member of the organization, else `invalid_request`. `items.send`: `stale` → `AuthorityOperationError('stale_access_state', 'The items changed. Open them again.')`.

*`set_state`*: the item must pass `see_row`, else `not_found`; `set_state` false → `not_found`; an unsent item → `invalid_request` ("Send it first").

*`assign`*: as `set_state` with the policy's `assign`; the new owner must be an active member.

- [ ] **Step 1: Write the failing tests** (build `openItemsFixture()` on `approvalCoreFixture` and the runs-service fixture in `person-trigger-runs-v1.test.ts`: Ari approves into project A, whose members are Ari (lead), Mina and Rafael; S. Okafor is in the organization but not in project A. The fake desk opens a Jira ticket and an ECHO record, and refuses a third item for Rafael):

```ts
it('writes one unsent item per conflict or needs-updating row at finish, with exact owners, and no outside text', async () => {
  const f = await openItemsFixture({ outsideText: 'Kestrel cooling fan drift 0xC0FFEE' });
  await f.finishImpactRun();
  const rows = f.db.prepare('SELECT * FROM authority_impact_items_v1').all();
  expect(rows).toHaveLength(2);                                        // the confirms row made none
  expect(rows.map(row => (row as { owner_match: string }).owner_match).sort()).toEqual(['approver', 'jira_account']);
  expect(JSON.stringify(rows)).not.toContain('0xC0FFEE');
  expect(JSON.stringify(rows)).not.toContain('acct-mina');
});
it('shows unsent items to decision readers, the decision only to readers, and live parts only to those who can open them', async () => {
  const f = await openItemsFixture(); await f.finishImpactRun();
  const mina = await f.app.items({ access_token: 'mina', request: { schema_version: 1, operation: 'items', scope: 'record', id: f.record } });
  expect(mina.items).toHaveLength(2);
  expect(mina.items.every(item => item.state === 'unsent' && item.decision?.title === 'Pilot planning')).toBe(true);
  const rafael = await f.app.items({ access_token: 'rafael', request: { schema_version: 1, operation: 'items', scope: 'record', id: f.record } });
  expect(rafael.items.find(item => item.kind === 'ticket')).not.toHaveProperty('current');   // the desk refuses Rafael this ticket
  expect(JSON.stringify(rafael)).not.toContain('ECHO-12');                                   // no title, permalink or citation leaks
  const okafor = await f.app.items({ access_token: 'okafor', request: { schema_version: 1, operation: 'items', scope: 'record', id: f.record } });
  expect(okafor.items).toEqual([]);
});
it('sends once, refuses a stale card, and gives the owner an Update row they can close', async () => {
  const f = await openItemsFixture(); await f.finishImpactRun();
  const unsent = (await f.app.items({ access_token: 'ari', request: { schema_version: 1, operation: 'items', scope: 'run', id: f.runId } })).items;
  const send = { schema_version: 1 as const, operation: 'send' as const, run_id: f.runId, command_id: 'c1',
    items: unsent.map(item => ({ item_id: item.item_id, include: true, ...(item.owner.match === 'approver' ? { owner_membership_id: f.okaforMembership } : {}) })) };
  await expect(f.app.send({ access_token: 'ari', request: send })).resolves.toEqual({ sent: 2, not_relevant: 0 });
  await expect(f.app.send({ access_token: 'ari', request: send })).resolves.toEqual({ sent: 2, not_relevant: 0 });
  await expect(f.app.send({ access_token: 'ari', request: { ...send, command_id: 'c2' } })).rejects.toMatchObject({ code: 'stale_access_state' });
  const okaforHome = await f.app.home({ access_token: 'okafor' });
  expect(okaforHome.items).toHaveLength(1);
  expect(okaforHome.items[0]).not.toHaveProperty('decision');       // Okafor cannot read the decision; only Send told them
  await f.app.set_state({ access_token: 'okafor', request: { schema_version: 1, operation: 'set_state', item_id: okaforHome.items[0]!.item_id, state: 'done' } });
  expect((await f.app.home({ access_token: 'okafor' })).items).toEqual([]);
});
it('lets only the approver or the owner change state, and a project lead reassign', async () => { /* Rafael (reader, not owner): set_state → not_found; Ari as lead: assign → ok; Rafael: assign → not_found */ });
it('moves an item to the approver when the owner leaves, and to the project leads when both leave', async () => {
  const f = await sentFixture({ owner: 'mina' });
  f.revoke('mina');
  expect((await f.app.home({ access_token: 'ari' })).items.map(item => item.waits_on)).toEqual(['approver']);
  f.revoke('ari'); f.makeLead('rafael');
  expect((await f.app.home({ access_token: 'rafael' })).items.map(item => item.waits_on)).toEqual(['leads']);
});
it('opens a finished card to any decision reader and to nobody else', async () => { /* view as Mina → card; as Okafor → not_found */ });
it('lists Send rows only to the approver and counts what waits on others', async () => { /* home(ari).send has one row with owners ['Mina Patel']; waiting counts after send */ });
```

  HTTP test: each new operation reaches its method; a model-less runtime answers `unavailable` after authenticating. Client test: `runs --request '{"schema_version":1,"operation":"home"}'` prints `{ok:true,result:{send:[],items:[],landed:0,waiting:0,last_checked_at:null}}`.

- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement the record lookups, the finish hook, the open-items service, the route cases, the composition (`items`, `people` and `jira_owners` from the Jira live connector's runtime when it is configured) and the help text.
- [ ] **Step 4:** `npm run test:authority`, `npm run test:person`, `npm run test:protocols`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: open items on the runs API, written when an impact check finishes`.

---

### Task 8: Review rows: first decision line, action count, meeting time

**Files:**
- Modify: `packages/organization-api/src/person-meetings-v1.ts` (`PersonMeetingReviewV2` gains three fields; validator) and its test `packages/organization-api/test/person-meetings-v1.test.ts`
- Modify: `services/organization-authority/src/composition/approval-core-v1.ts` (export `approvalProposalSummaryV1`)
- Modify: `services/organization-authority/src/composition/person-meeting-runtime-v1.ts` (`reviewView`)
- Modify: `product/echo-desktop/src/host/test-authority.ts` (the fixture's review object carries the three fields, or the host's validator refuses it)
- Test: `services/organization-authority/test/approval-core-v1.test.ts` (or the file that tests `approvalProposalTextV1`), `services/organization-authority/test/person-meeting-runtime-v1.test.ts`

**Interfaces:**

```ts
// person-meetings-v1.ts
export interface PersonMeetingReviewV2 {
  readonly approval_id: string; readonly title: string; readonly project_ids: readonly string[];
  readonly status: 'pending' | 'publishing' | 'approved' | 'rejected' | 'superseded'; readonly decided_on: 'desktop' | 'slack' | null;
  /** The proposal's first decision, else its first action: one line of ECHO text, or null. */
  readonly first_line: string | null;
  readonly action_count: number;
  /** When the meeting started, when the meeting tool says. */
  readonly meeting_at: string | null;
}
```

  Validation: `first_line` null or a line of 1–300 characters; `action_count` an integer 0–40; `meeting_at` null or a timestamp; exact keys, as the file does today. `review_open.review` uses the same row validator.

```ts
/** What a Home row shows of a proposal: its first decision (else first action) on one line, how many actions it has, and when the meeting started. */
export function approvalProposalSummaryV1(snapshotJson: string): { readonly first_line: string | null; readonly action_count: number; readonly meeting_at: string | null };
```

  `first_line` = `brief.decisions[0]?.text ?? brief.actions[0]?.text`, whitespace collapsed, at most 300 characters, null when neither exists. `meeting_at` = `brief.meeting.time?.actual_start_at ?? brief.meeting.time?.scheduled_start_at ?? null`, normalized with `new Date(x).toISOString()`, null when unparseable. `action_count` = `brief.actions.length`.

- [ ] **Step 1: Write the failing test:**

```ts
it('summarizes a proposal for its Home row', () => {
  expect(approvalProposalSummaryV1(snapshot({ decisions: ['Launch the pilot next week.'], actions: ['Send the revised quote', 'Confirm the trace'], started: '2026-10-06T16:00:00Z' })))
    .toEqual({ first_line: 'Launch the pilot next week.', action_count: 2, meeting_at: '2026-10-06T16:00:00.000Z' });
  expect(approvalProposalSummaryV1(snapshot({ decisions: [], actions: ['Book the lab'] })).first_line).toBe('Book the lab');
});
```

  and in the meetings runtime test: `reviews` rows carry the three fields; and in the API test:

```ts
it('requires the three new review fields', () => {
  expect(() => validatePersonMeetingResultV2('reviews', { reviews: [{ approval_id: APR, title: 'Pilot planning', project_ids: [], status: 'pending', decided_on: null }] })).toThrow();
  expect(validatePersonMeetingResultV2('reviews', { reviews: [{ approval_id: APR, title: 'Pilot planning', project_ids: [], status: 'pending', decided_on: null,
    first_line: 'Launch the pilot next week.', action_count: 2, meeting_at: '2026-10-06T16:00:00.000Z' }] }).reviews[0]!.action_count).toBe(2);
});
```
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement; update the desktop fixture's review object (`first_line: 'Launch the pilot next week.'`, `action_count: 2`, `meeting_at: '2026-10-06T16:00:00.000Z'`).
- [ ] **Step 4:** `npm run test:protocols`, `npm run test:authority`; desktop `npm run typecheck`, `npx vitest run` and `npx playwright test test/e2e/impact.spec.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: review rows name their first decision`.

---

### Task 9: Desktop: Home rows, Tell the owners?, Update in place, Impact lines

Follow canvas row 9 and spec section 8 exactly. The canvas sources are the artboards H1, H3, H5, H6 and H7; the copy below is final.

**Files:**
- Modify: `product/echo-desktop/src/shared/protocol.ts` — `RunsResults` gains `home: HomeView`, `items: OpenItemsView`, `item: OpenItemView`, `send`, `set_state`, `assign`, where each view replaces `current.citation` with `current.source: AnswerSource` (for "Open in …").
- Modify: `src/host/views.ts` — `openItemView`, `homeView`, `openItemsView` (each `current.citation` through `v4Source`, like `impactCardView`).
- Modify: `src/host/host.ts` — the `runs` handler returns the view for each operation.
- Modify: `src/renderer/store.ts` — the Home section (below), the Send card, Update in place, the reader and project lines; remove `SEEN_IMPACT`, `seenImpact`, `markImpactSeen`, `dismissImpact`.
- Create: `src/renderer/screens/send.tsx` (Tell the owners?), `src/renderer/screens/open-items.tsx` (a decision's or a project's items, grouped by owner, oldest first, read-only in Part 1).
- Modify: `src/renderer/screens/home.tsx` (rows and footer), `decision.tsx` (the approved view keeps the impact card as Details; "Got it" goes away; the pending card shows `first_line` large as 9.2 does), `reader.tsx` (Impact line, 9.6), `project.tsx` and `items.tsx` (project line and per-row "N open", 9.7), `main.tsx` (routes `send` and `open-items`), `sidebar.tsx` (badge counts rows that wait on you), `styles.css`.
- Modify: `src/host/test-authority.ts` — open-items fixture (below).
- Test: create `test/e2e/open-items.spec.ts`; modify `test/e2e/impact.spec.ts` (no "Got it"); modify `test/unit/home.test.ts`.

**Store (Home section), the shape to implement:**

```ts
export type NeedKind = 'approve' | 'send' | 'update' | 'check' | 'checking' | 'failed';
export type NeedRow =
  | { kind: 'approve'; review: PersonMeetingReviewV2 }
  | { kind: 'checking'; review: PersonMeetingReviewV2; run?: PersonRunV1 }
  | { kind: 'failed'; review: PersonMeetingReviewV2; run: PersonRunV1 }
  | { kind: 'send'; send: HomeView['send'][number] }
  | { kind: 'update' | 'check'; item: OpenItemView };
export interface HomeState {
  seq: number; loading: boolean; failure?: Failure; meetings: boolean;
  /** Each part keeps its last good value when a later read of it fails. */
  reviews: readonly PersonMeetingReviewV2[]; runs: readonly PersonRunV1[]; open: HomeView | null;
  rows: NeedRow[];
}

/** Rows that wait on you first; what is on its way last. Check rows sort before Update rows. */
export function needRows(reviews: readonly PersonMeetingReviewV2[], runs: readonly PersonRunV1[], open: HomeView | null): NeedRow[] { /* approve, send, check, update, failed, checking */ }

export async function loadHome(): Promise<void> {
  // …account and route guards as today…
  const [reviews, runs, open] = await Promise.allSettled([
    meetingCommand({ operation: 'reviews' }),
    runsCommand({ schema_version: 1, operation: 'list' }),
    runsCommand({ schema_version: 1, operation: 'home' }),
  ]);
  const previous = state.home!;
  const next = {
    reviews: reviews.status === 'fulfilled' ? reviews.value.reviews : previous.reviews,
    runs: runs.status === 'fulfilled' ? runs.value.runs : previous.runs,
    open: open.status === 'fulfilled' ? open.value : previous.open,
  };
  const failed = [reviews, runs, open].find(part => part.status === 'rejected');
  set({ home: { ...previous, ...next, loading: false, meetings: true, rows: needRows(next.reviews, next.runs, next.open),
    failure: failed && reviews.status === 'rejected' ? { code: 'unavailable', retryable: true } : undefined } });
  void driveRuns(next.runs, next.reviews.some(review => review.status === 'publishing'));
}
```

  Polling: `driveRuns` polls every 5 seconds only while a run is `pending` or `running` or a review is `publishing`, and a failed poll retries with backoff (5 s, 10 s, 20 s, at most 60 s). A runs read that fails with `unavailable` and no run in flight does not poll (a model-less Authority). The runs and home parts fail silently; only a failed `reviews` read shows the error line, as today. Put the decision in one pure, exported function so it is unit-tested:

```ts
/** Milliseconds until the next runs read, or null for none. `failures` counts consecutive failed reads. */
export function runPollDelay(input: { readonly runs: readonly PersonRunV1[]; readonly publishing: boolean; readonly failures: number; readonly lastFailure?: Failure }): number | null;
```

```ts
/** Tell the owners?: the run's unsent items, ticked, with owner picks. */
export interface SendState {
  run_id: string; seq: number; loading: boolean; failure?: string;
  items: readonly OpenItemView[]; ticks: Record<string, boolean>; picks: Record<string, Member>;
  command: string; busy: boolean;
  picker: { item_id: string; query: string; results: readonly Member[]; loading: boolean } | null;
}
export async function openSend(run_id: string): Promise<void>;       // items {scope: 'run'}; route { page: 'send', run_id }
export function tickSend(item_id: string): void;
export async function searchOwner(item_id: string, query: string): Promise<void>;   // people.directory
export function pickOwner(item_id: string, member: Member): void;
export async function sendToOwners(): Promise<void>;                  // send; toast "Sent"; goHome()
export async function markDone(item: OpenItemView): Promise<void>;    // set_state done; the row leaves at once, comes back with an error line if it fails
export async function openItemInTool(item: OpenItemView): Promise<boolean>;   // openImpactSource(item.current.source)
```

**Copy** (spec section 8):
- Home head: "Needs you · N" (N = rows that are not Checking).
- Approve row: title `review.first_line ?? review.title`; line "Decision · N actions · <title> meeting, <Oct 6>" ("1 action", no actions part when 0, no date when `meeting_at` is null).
- Send row: title "<decision.first_line ?? decision.title> — N tickets need updating" (all tickets → "tickets", all pages → "pages", otherwise "items"; "1 ticket needs updating"); line "Impact of <decision.title> · owners Mina, Rafael" ("owners" part left out when empty).
- Update row: title "<current title or 'A Jira ticket you can't open'> · <live details> → <expected>" (live details: "due Oct 30" from `due_at`, else `status`; parts that are missing are left out); line "Jira ticket you own · from <decision.title>" ("from Ari" when the decision is not shown); inline buttons "Open in Jira" (only with `current`) and "Done".
- Checking row line: "Approved · checking what it changes"; Failed row line: "Approved · the check did not finish".
- Footer (Part 1): "N with others" when N > 0. (Landed and "checked X ago" come in Task 12.)
- Tell the owners?: "Tell the owners?", "You approved <title> on <Oct 6>. ECHO found what it changes.", the decided line large, "Must change", per item a checkbox, the item title in bold and "· <live details> → <expected>" muted, the owner chip or "Pick a person"; "Untick anything that's wrong. Owners get it on their Home."; "Details" (opens the decision page's impact card); buttons "Send to Mina and Rafael" ("Send to Mina", "Send to Mina, Rafael and S. Okafor"), "Keep on my Home" when every ticked item is yours, "None of these need changing" when nothing is ticked; "Not now".
- Reader Impact line (approved meetings): "Impact · 2 open · 1 not sent", "Not checked yet", "Checking…", "Check failed · Try again" (Try again only for the approver), "Nothing to change"; "Send" when it waits on you; the line opens the decision's items.
- Project line: "4 open items · from 2 decisions" (parts that are zero are left out; no line when there are none); each decision row in the feed shows "1 open".

**Test Authority fixture** (`granola*` modes, after the existing run reaches `done`):
- The run has two unsent items: ECHO-12 (Jira, `owner_match: 'jira_account'`, owner Mina Patel, `current` with due 2026-10-30, `expected: 'launch next week'`) and "Thermostat PRD · Pilot scope" (Confluence page, `owner_match: 'approver'`, owner Ari, `current` says "starts after freeze", `expected: 'pilot starts next week'`).
- `home` returns a Send row for the run until `send`; `items` scopes `run`, `record` (`sha('record:Pilot planning')`) and `project` (the Thermostat redesign project) return them; `send` validates the item ids and records the choices; `set_state` records the state.
- New mode `granola-owner`: Ari is the owner of ECHO-12, sent by Mina; `home.items` holds it (Update row) until `set_state` done.
- New mode `granola-home-fails-once`: the second `home` read answers 503 once.
- `people.directory` already returns organization members (reuse for the picker; include "Rafael Moreno").

- [ ] **Step 1: Write the failing e2e tests** (`test/e2e/open-items.spec.ts`):

```ts
test('the approver sends the impact to its owners from Home', async () => {
  const app = await launch('granola');
  await approveFromHome(app);                                                  // helper: Approve row → Approve
  const send = app.page.getByTestId('need-row').filter({ hasText: 'need updating' });
  await expect(send).toBeVisible({ timeout: 20_000 });
  await expect(send).toContainText('owners Mina');
  await send.click();
  await expect(app.page.getByRole('heading', { name: 'Tell the owners?' })).toBeVisible();
  await expect(app.page.getByText('Untick anything that\'s wrong. Owners get it on their Home.')).toBeVisible();
  await app.page.getByRole('button', { name: 'Pick a person' }).click();
  await app.page.getByRole('searchbox', { name: 'Find a person' }).fill('Raf');
  await app.page.getByRole('option', { name: 'Rafael Moreno' }).click();
  await app.page.getByRole('button', { name: 'Send to Mina and Rafael' }).click();
  await expect(app.page.getByTestId('need-row').filter({ hasText: 'need updating' })).toHaveCount(0);
  const sent = (await app.calls()).find(call => call.path === '/v1/person/runs' && call.request.operation === 'send')!;
  expect(sent.request.items).toEqual(expect.arrayContaining([expect.objectContaining({ include: true, owner_membership_id: expect.any(String) })]));
});
test('an owner closes an item from Home', async () => {
  const app = await launch('granola-owner');
  const row = app.page.getByTestId('need-row').filter({ hasText: 'ECHO-12' });
  await expect(row).toContainText('due Oct 30 → launch next week');
  await expect(row.getByRole('button', { name: 'Open in Jira' })).toBeVisible();
  // The fixture's second item has no `current`: Ari cannot open it in Jira.
  const hidden = app.page.getByTestId('need-row').filter({ hasText: 'A Jira ticket you can\'t open' });
  await expect(hidden).toBeVisible();
  await expect(hidden.getByRole('button', { name: 'Open in Jira' })).toHaveCount(0);
  await row.getByRole('button', { name: 'Done' }).click();
  await expect(row).toHaveCount(0);
  expect((await app.calls()).some(call => call.request?.operation === 'set_state' && call.request.state === 'done')).toBe(true);
});
test('a Home read that fails once keeps the rows it had', async () => { /* granola-home-fails-once: rows stay after a window refresh; they update on the next read */ });
test('an approved decision shows its Impact line and the project shows its open items', async () => { /* reader: "Impact · 2 not sent"; project: "2 open items · from 1 decision", feed row "2 open" */ });
```

  Unit (`test/unit/home.test.ts`): `needRows` orders approve, send, check, update, failed, checking; a `null` home part leaves only review and run rows; `runPollDelay` is 5000 with a running run, null with nothing in flight, null after an `unavailable` failure with nothing in flight, and 10000 then 20000 then 60000 (capped) for consecutive failures while a run is in flight.

  Fixture addition for `granola-owner`: a second item sent to Ari with no `current` (Ari cannot open it).
- [ ] **Step 2:** `cd product/echo-desktop && npm run build && npx playwright test test/e2e/open-items.spec.ts` → FAIL.
- [ ] **Step 3:** Implement protocol, views, host, store, screens, fixture and styles.
- [ ] **Step 4:** `npm run typecheck`, `npx vitest run`, then the full desktop e2e `npx playwright test`. Expected: PASS except the two known ask-cancel timing tests (report them).
- [ ] **Step 5: Commit** `feat(desktop): send the impact to owners and close items from Home`.

---

### STOP — Part 1 validation (founder)

- [ ] Rebase onto the current `feat/desktop-home-redesign` if PR #299 moved; rerun the focused desktop tests.
- [ ] Run `npm run check` once on the Part 1 candidate. Record the commit, the command and the result.
- [ ] Take screenshots with Playwright of: Home with Approve, Send and Update rows; Tell the owners? with a picked owner; Home after Send; an owner's Update row; the reader's Impact line; the project line. Send them to the founder.
- [ ] Tell the founder how to click through it themselves: `cd product/echo-desktop && npm start -- granola` (approver) and `npm start -- granola-owner` (owner); the fixture Authority runs in a throwaway home and never touches a real session.
- [ ] Wait for the founder's go. Do not start Part 2 before it. Changes the founder asks for are done here, re-validated, and recorded under As built.

---

## Part 2 — Sweep, Check, Landed

### Task 10: Sweep result contract and the sweep renderer

**Files:**
- Create: `packages/organization-api/src/person-sweep-result-v1.ts` (+ export)
- Modify: `packages/organization-api/src/person-research-eval-v1.ts` (`rendered` is an impact card or a sweep result)
- Create: `packages/organization-authority-kernel/src/answer-composition/renderers/sweep-renderer-v1.ts`
- Modify: `packages/organization-authority-kernel/src/answer-composition/agentic-trigger-definitions-v1.ts` (`sweep.renderer = SWEEP_RENDERER_V1`)
- Modify: `services/organization-authority/src/composition/person-research-eval-v1.ts` (validate `rendered` by trigger)
- Test: `packages/organization-api/test/person-sweep-result-v1.test.ts`, `packages/organization-authority-kernel/test/answer-composition/renderers/sweep-renderer-v1.test.ts`, `services/organization-authority/test/person-research-eval-v1.test.ts`

**Interfaces:**

```ts
// person-sweep-result-v1.ts
export type PersonSweepVerdictV1 = 'landed' | 'still_open' | 'changed' | 'unreadable';
export interface PersonSweepFindingResultV1 {
  /** The finding's position in the sweep's input. */
  readonly finding_index: number;
  /** null: not assessed (the model gave no usable reply); the item's last check stays as it is. */
  readonly verdict: PersonSweepVerdictV1 | null;
  /** ECHO's one line: what the current item shows against what was expected. For evaluation and the staging endpoint; never stored. */
  readonly line: string;
  readonly citation_indexes: readonly number[];
}
export interface PersonSweepResultV1 {
  readonly findings: readonly PersonSweepFindingResultV1[];   // one per input finding, in input order
  readonly status: 'assessed' | 'not_assessed';
  readonly citations: readonly PersonAnswerCitationV6[];
}
export function validatePersonSweepResultV1(value: unknown, findingCount?: number): PersonSweepResultV1;
```

**Renderer** (`SWEEP_RENDERER_V1: AgenticRendererV1<SweepEventV1, PersonSweepResultV1>`):
- A finding whose starting citations include one in `bundle.unreadable_starting` (by canonical JSON) is `unreadable` with the line "ECHO could not read this item." and no model call for it.
- The other findings go to one model call through `callRendererModelV1` (role `answer`, span `research_render`) with the findings (index, finding, expected) and the bundle items it gathered (`describeAgenticEvidenceItemV1` plus text), fitting `prompt_budget` like the impact card does. The reply is one entry per finding: `{ index, verdict: 'landed' | 'still_open' | 'changed', line, cites: [ids] }`.
- Prompt rules: judge only from the current items' text and details; "landed" only when a current item shows the expected change; "changed" when a current item changed in a way that differs from the expected change; "still_open" when nothing shows the change; never treat an unread item as changed; describe, never instruct (the impact card's `SUGGESTED_EDIT` and `OWNERSHIP_CLAIM` screens apply to the line).
- No usable reply: `status: 'not_assessed'`, verdict null for the readable findings, line "Not assessed.".
- `outcome`: `answered` when assessed with no unreadable finding, else `partial`.

- [ ] **Step 1: Write the failing tests:**

```ts
it('reports an unreadable starting item without asking the model about it', async () => {
  const result = await renderSweep({ findings: [finding(TICKET_46), finding(TICKET_47)], unreadable: [TICKET_47], reply: [{ index: 0, verdict: 'landed', line: 'THERM-46 now says two decimals.', cites: ['E1'] }] });
  expect(result.findings.map(f => f.verdict)).toEqual(['landed', 'unreadable']);
  expect(result.findings[1]!.line).toBe('ECHO could not read this item.');
});
it('leaves verdicts empty when the model gives no usable reply', async () => {
  const result = await renderSweep({ findings: [finding(TICKET_46)], reply: 'garbage' });
  expect(result).toMatchObject({ status: 'not_assessed', findings: [{ verdict: null }] });
});
it('sends an instruction back for one repair', async () => { /* line "Update THERM-46 to two decimals" → 2 calls */ });
```

  Eval endpoint test: a sweep start returns `rendered` that passes `validatePersonSweepResultV1`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run, plus `packages/organization-authority-kernel/test/answer-composition` (Ask goldens unchanged) and `npm run test:protocols`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: a sweep renderer that judges each open item against its decision`.

---

### Task 11: Sweep runs in the service

**Files:**
- Modify: `packages/organization-api/src/person-runs-v1.ts` (`PersonRunV1.trigger: 'approved_record' | 'sweep'`, the `sweep` operation, `home.sweep_due`) and its test; the desktop `RunsResults` gains the raw `sweep` result type (Task 12 replaces it)
- Modify: `services/organization-authority/src/composition/person-trigger-runs-v1.ts` (`launch` dispatches on `row.trigger`; the sweep path)
- Modify: `services/organization-authority/src/composition/person-open-items-v1.ts` (`sweep` operation; `home.sweep_due`)
- Modify: the route and the port (`sweep`)
- Test: `services/organization-authority/test/person-sweep-runs-v1.test.ts` (new), `services/organization-authority/test/person-runs-http.test.ts`

**API additions:**

```ts
// person-runs-v1.ts (Part 2 additions)
| { readonly schema_version: 1; readonly operation: 'sweep'; readonly scope: 'mine' | 'record' | 'project'; readonly id?: string }
sweep: { readonly run_id: string } | { readonly state: 'nothing_to_check' };
home: { …; readonly sweep_due: boolean };
PersonRunV1: { …; readonly trigger: 'approved_record' | 'sweep' }
```

**Behavior:**
- `sweep {scope, id?}`: the caller's open items in scope that pass `see_row` (`mine`: items they sent or own; `record`/`project`: as `items` does). None → `{ state: 'nothing_to_check' }`. Else `runs.enqueueSweep(actor, scope)` → `{ run_id }`.
- `start` on a sweep run claims it as today; `launch` dispatches on `row.trigger`.
- Sweep work: at start, read the scope's open items again and sort them in the service (never-checked first, then oldest `checked_at`; `forRecords` orders by `created_at`), keep up to 20 that the caller still sees; findings = `{ finding: "<relation as words> <kind> from <decision title>", expected: item.expected ?? decision first line ?? "the approved decision", citations: [pointer, record citation when the caller can read the decision] }`; bind the desk with the caller's token (scope: the project for a project sweep, the record's project for a record sweep, else global); `renderWithResearch` with the `sweep` definition and `SWEEP_RENDERER_V1`; validate with `validatePersonSweepResultV1(result, findings.length)`.
- Finish: `runs.finish(run_id, lease, counts, tx => …)` where `counts = { schema_version: 1, landed, still_open, changed, unreadable, not_assessed }` and the callback calls `items.recordCheck(tx, { item_id, verdict, by: caller, at: now, run_id })` for each finding with a verdict whose item the caller still sees (`see_row` checked again just before finishing). A sweep never calls `setState`.
- No items left at start (all closed meanwhile): finish with zero counts.
- Errors map as for impact runs.
- `home.sweep_due` = the caller has an open item they sent or own whose `checked_at` is null or older than 24 hours, and `runs.liveSweep(actor)` is undefined.

- [ ] **Step 1: Write the failing tests:**

```ts
it('records verdicts on the items the sweep checked, never their state', async () => {
  const f = await sweepFixture({ verdicts: ['landed', 'changed'] });
  const { run_id } = await f.app.sweep({ access_token: 'ari', request: { schema_version: 1, operation: 'sweep', scope: 'mine' } }) as { run_id: string };
  await f.app.start({ access_token: 'ari', request: { schema_version: 1, operation: 'start', run_id } }); await f.settled(run_id);
  const rows = f.db.prepare('SELECT state, checked_verdict FROM authority_impact_items_v1 ORDER BY created_at').all();
  expect(rows).toEqual([{ state: 'open', checked_verdict: 'landed' }, { state: 'open', checked_verdict: 'changed' }]);
  expect(JSON.stringify(f.db.prepare('SELECT * FROM authority_trigger_runs_v1 WHERE run_id=?').get(run_id))).not.toContain('0xC0FFEE');
});
it('keeps a newer check and skips an item the sweeper lost', async () => {
  const f = await sweepFixture({ verdicts: ['changed', 'landed'] });
  const { run_id } = await f.queueAndStart('ari');
  f.recordNewerCheck(0, 'landed');               // another person's sweep finished first
  f.removeFromProject('ari');                    // Ari can no longer read the decision of item 1 (and does not own it)
  await f.settled(run_id);
  expect(f.verdicts()).toEqual(['landed', null]);
});
it('queues one sweep per scope and says when one is due', async () => { /* sweep twice → same run_id; home.sweep_due true before, false while queued, false after a fresh check */ });
it('answers nothing_to_check without queuing a run', async () => { /* all items done */ });
it('runs impact checks before sweeps on one person\'s single live run', async () => { /* claim(sweep) while an impact run is live → busy */ });
```

- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** `npm run test:authority`, `npm run test:person`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: sweep runs record a shared last check on open items`.

---

### Task 12: Desktop: Check rows, Did it land?, Check now, auto-sweep

**Files:**
- Modify: `product/echo-desktop/src/shared/protocol.ts`, `src/host/host.ts`, `src/host/views.ts` (the `sweep` operation; `home.sweep_due`)
- Modify: `src/renderer/store.ts` (Check card, Did it land?, Check now, auto-sweep in `driveRuns`)
- Create: `src/renderer/screens/did-it-land.tsx`; modify `home.tsx` (Check rows and the full footer), `open-items.tsx` (a Check card for one item), `reader.tsx` and `project.tsx` (Check now), `styles.css`
- Modify: `src/host/test-authority.ts` (sweep fixture)
- Test: `test/e2e/open-items.spec.ts` (extend), `test/unit/home.test.ts`

**Behavior and copy** (spec section 8, canvas 9.1, 9.4, 9.5, 9.6, 9.7):
- Check row: title "<current title or 'A Jira ticket you can't open'> · <live details> — not what was decided"; line "Jira ticket · now <current.assignee> · from <decision.title>" (the assignee part only with `current.assignee`); it opens the item: `expected`, the live details, the verdict and its time ("Checked 2 h ago by Mina Patel"), "Open in Jira", "Done", "Not relevant".
- Footer: "2 landed since yesterday · 1 with others · checked 2 h ago" and "Mark done" when landed > 0 (the "since yesterday" words are fixed copy, as the canvas has it); on an empty Home (9.5) the same footer under "Nothing needs you".
- Did it land?: "Did it land?", "<decision title> · checked <just now / 2 h ago> · N items" (from Home: "Your items · checked …"), the decided line large for one decision, "Landed · N" (checkbox lines, ticked), "Still open · N", "Couldn't read · N" (line "you don't have access" when the viewer cannot open it, else "ECHO could not read it"), each line: the title, its live details, the owner chip; "Mark N done" sets `done` on the ticked items (one `set_state` each).
- Check now on the reader's Impact line and the project line: `sweep` with that scope; `nothing_to_check` → the line says "Nothing open to check"; else the line shows "Checking…" until the run finishes, then opens Did it land? for that scope.
- Auto-sweep: after `loadHome`, when `home.sweep_due` is true and no impact run is pending or running, `sweep {scope: 'mine'}` and start it; never more than one sweep start per Home load.
- Impact lines gain "· 1 handled · 1 couldn't read · checked just now" parts from the summary.

**Fixture:** a mode `granola-checked`: Ari's sent items carry last checks (ECHO-12 `landed`, the PRD page `changed`), `home.sweep_due` false; a mode `granola-sweep`: `sweep_due` true, `sweep` → a pending sweep run that `start` runs, the second `list` finds `done`, after which `home` shows one landed and one changed item.

- [ ] **Step 1: Write the failing e2e tests:**

```ts
test('Home sweeps by itself and shows what landed and what drifted', async () => {
  const app = await launch('granola-sweep');
  await expect(app.page.getByTestId('need-row').filter({ hasText: 'not what was decided' })).toBeVisible({ timeout: 20_000 });
  await expect(app.page.getByText(/1 landed since yesterday/)).toBeVisible();
  const ops = (await app.calls()).filter(call => call.path === '/v1/person/runs').map(call => call.request.operation);
  expect(ops.indexOf('sweep')).toBeGreaterThan(-1);
  await app.page.getByRole('button', { name: 'Mark done' }).click();
  await expect(app.page.getByRole('heading', { name: 'Did it land?' })).toBeVisible();
  await app.page.getByRole('button', { name: 'Mark 1 done' }).click();
  await expect(app.page.getByText(/landed since yesterday/)).toHaveCount(0);
});
test('Check now on a decision checks only that decision', async () => { /* reader → Check now → sweep {scope:'record'} → Did it land? */ });
test('a Check row opens the item before anything is closed', async () => { /* granola-checked: Check row → item card with Done and Not relevant → Not relevant → set_state not_relevant */ });
```

- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** typecheck, desktop unit, full desktop e2e. Expected: PASS except the two known ask-cancel tests.
- [ ] **Step 5: Commit** `feat(desktop): sweep open items and show what landed`.

---

### Task 13: Sweep in the research-loop evaluation

**Files:**
- Modify: `tools/evals/research-loop/lib/checks.mjs` (sweep runs must return `rendered`; grade it), `lib/report.mjs` (a sweep table), `lib/judge.mjs` (the judge prompt mentions the sweep result)
- Test: `tools/evals/research-loop/test/research-loop.test.mjs`

**Behavior:** for a `sweep` case, the rendered result's verdict per finding is compared with the key's `verdicts[i].expected`, mapping `landed` → `landed`, `still_open` and `changed` → `not_landed`, `unreadable` → `no_evidence`; a null verdict counts as wrong. Report per case: verdicts right / findings, and the not-assessed count. Research-loop numbers stay separate from renderer numbers, as for the impact card.

- [ ] **Step 1: Write the failing test:**

```js
test('grades a sweep result against the key with the verdict mapping', () => {
  const graded = gradeSweep({ verdicts: [{ expected: 'landed' }, { expected: 'not_landed' }, { expected: 'no_evidence' }] },
    { findings: [{ finding_index: 0, verdict: 'landed' }, { finding_index: 1, verdict: 'changed' }, { finding_index: 2, verdict: null }] });
  assert.deepEqual(graded, { right: 2, total: 3, not_assessed: 1 });
});
```

- [ ] **Step 2:** `npm run test:research-loop-eval` → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `feat: grade sweep verdicts in the research-loop evaluation`.

---

### Task 14: Documentation, As built, final check, PR

**Files:**
- Modify: `docs/product/2026-10-08-open-items-and-home-v1.md` (status line: "Implementation plan executed; see the plan's As built section"), `docs/product/2026-10-07-runs-store-and-impact-card-v1.md` (note: open items and Sweep are specified in the open-items spec; `view` is open to decision readers per ADR-0033), `docs/product/2026-10-06-research-trigger-contract-v1.md` (implementation note: Sweep has a renderer; sweep results are stored as verdicts on open items; results reach owners via Send per ADR-0033), `product/echo-desktop/README.md` (Home: Send, Update, Check, Did it land?; remove "status and sweep actions are not included"), `services/organization-authority/README.md` if it lists the runs operations, `docs/operations/PB-OPERATIONS-001-authority-operator-lane.md` (reset to V13)
- Modify: this plan — an **As built** section listing every interface that differs from the text above and every ruling made during execution.

- [ ] **Step 1:** `grep -rln "V12\|seenImpact\|Got it\|status and sweep actions" docs deploy services providers packages product tools tests --include='*.md' --include='*.ts' --include='*.tsx'` and fix every hit that describes current behavior (historical ADR text stays).
- [ ] **Step 2:** `npm run check:docs`, then `npm run check` once on the final candidate; the full desktop e2e. Record the commit, commands and results.
- [ ] **Step 3: Commit** `docs: open items and Home as built`.
- [ ] **Step 4:** Push `feat/home-needs-you` and open a draft PR against `feat/desktop-home-redesign` (or `main` if PR #299 has merged), using the repository template, with the validated commit and evidence; bind it with the ccd_pr tools and read its CI. The Authority needs a V13 reset on staging before the founder's live test; say so in the PR. Do not merge.

---

## Test helpers

Test snippets call helpers such as `approvedRunFixture()`, `doneRunFixture()`, `doneRunWithItems()`, `sentItemFixture()`, `peopleFixture()`, `fakeJira()`, `jiraRuntimeFixture()`, `openItemsFixture()`, `sentFixture()`, `sweepFixture()`, `renderWith()`, `renderSweep()`, `cardWith()` and `approveFromHome()`. Each task creates the helpers its tests use, in that test file or under the package's `test/fixtures/`, building on the existing fixtures: `services/organization-authority/test/fixtures/approval-core.ts`, the runs fixtures at the top of `trigger-runs-v1.test.ts` and `person-trigger-runs-v1.test.ts`, `services/organization-authority/test/fixtures/project-context-sqlite.ts` (`addMembership`), `services/organization-authority/test/fixtures/fake-jira-v1.ts`, the impact card fixtures in the kernel's renderer and storage tests, and `product/echo-desktop/test/e2e/launch.ts`. A helper's options are the ones its snippets pass.

## Order

Tasks run in order; each depends on the one before it. Task 8 and Task 9 both touch the desktop fixture's review object; Task 8 adds the fields, Task 9 builds on them. Part 2 starts only after the founder's go at the stop.

## Self-review notes

### Part 1 follow-up to PR #300

Part 1 was accepted in the fixture walkthrough and merged separately; Part 2
remains paused. Two review fixes extend the Part 1 implementation:

- Home reads shared open items and runs even when Granola is absent or
  unavailable. Only meeting reviews depend on Granola availability.
- V13 stores an immutable `send_included` flag per item, written atomically
  with Send and constrained to match its initial state. `sentBy` replays the
  original choice counts, independent of later state or owner changes. This
  supersedes the earlier current-state replay ruling and re-pins the fresh
  V13 baseline; no migration is added.

- Spec coverage: stages (Tasks 2, 7, 9); storage (1, 2); the impact run (5, 6, 7); who sees what (3, 7, 9); Send, Update, reassign (2, 7, 9); Sweep (10, 11, 12, 13); API (4, 7, 10, 11); desktop (8, 9, 12); delivery and the stop (STOP); acceptance — items at finish (7), exact owners (6, 7), visibility (3, 7), no live parts without access (7, 9), policy-only writers (3, 7), idempotent Send (2, 7), fallbacks (3, 7), no outside text (2, 7, 11), sweep rules (2, 11), `sweep_due` (11), desktop path (9, 12), goldens (5, 10).
- Rulings 18–23 are reflected: verdict-only checks (2, 11), Jira bulk assignee read (6), Update in place (9), no Remind (12), short `expected` (2, 4, 5), review summaries (4, 8).
- Type names used across tasks: `TriggerRunRowV1`, `TriggerRunScopeV1`, `SqliteTriggerRunsV1`, `ImpactItemDraftV1`, `ImpactItemRowV1`, `SqliteImpactItemsV1`, `SqliteOpenItemPeopleV1`, `OpenItemFactsV1`, `OpenItemAccessV1`, `openItemAccessV1`, `JiraOwnerAccountsV1`, `matchImpactOwnersV1`, `PersonReadableDecisionsV1`, `PersonOpenItemV1`, `PersonHomeSendV1`, `PersonOpenItemsSummaryV1`, `PersonImpactStageV1`, `PersonSweepResultV1`, `SWEEP_RENDERER_V1`, `impactItemKeyV1`, `currentImpactLineV1`, `approvalProposalSummaryV1`.

## As built

Parts 1 and 2 were executed with subagent-driven development: one implementer per task, a task review, and fix rounds until the review was clean. The controller kept an execution ledger outside the repository; its rulings are listed below as R1–R62. "Spec ruling N" means a ruling in the spec. Only what differs from the task text above is listed.

### Delivery

- The plan's branch `feat/home-needs-you` sat on PR #299. PR #299 merged into main (`f1c16de`) during Part 1, and main was merged into the branch at the Part 1 stop (`78be005`, R24).
- Part 1 shipped alone as PR #300 (merged as `a7f8df7`), then a follow-up, PR #301 (`5a008d0`, merged as `00a9c1f`).
- Part 2 ran on `feat/open-items-part-2`, started from `5a008d0`. Main was merged in once PR #301 landed (`c4c2310`). Its pull request targets main.
- Two controller follow-ups are not in the plan: Task 9b after Task 9 (R20) and Task 12c after Tasks 11 and 12 (R51). Task 12c also carries R62.

### Interfaces that differ, by task

#### Task 1: baseline V13

- No interface change. Two files on the plan's list held no V12 reference. The SQL's `PRAGMA user_version = 13;` stamp sits mid-file, not at the end.

#### Task 2: V13 schema and stores

- The SQL block in Task 2 shows the old check trigger, which fired only on `UPDATE OF checked_at`. As built (R10), any change to the four check columns needs a strictly newer `checked_at`; the first check comes from NULL:

```sql
CREATE TRIGGER authority_impact_item_check_newer_v1
BEFORE UPDATE OF checked_verdict, checked_by, checked_at, checked_run_id ON authority_impact_items_v1
WHEN (NEW.checked_verdict IS NOT OLD.checked_verdict OR NEW.checked_by IS NOT OLD.checked_by
    OR NEW.checked_at IS NOT OLD.checked_at OR NEW.checked_run_id IS NOT OLD.checked_run_id)
  AND (NEW.checked_at IS NULL OR (OLD.checked_at IS NOT NULL AND NEW.checked_at <= OLD.checked_at))
BEGIN SELECT RAISE(ABORT, 'a last check is replaced only by a newer one'); END;
```

- PR #301 (R30) adds `send_included INTEGER CHECK (send_included IS NULL OR send_included IN (0, 1))` to the items table, with `CHECK ((sent_at IS NULL) = (send_included IS NULL))`. Send writes it with the state move, and it never changes afterwards:

```sql
CREATE TRIGGER authority_impact_item_send_v1
BEFORE UPDATE OF state, sent_at, send_command_id, send_included ON authority_impact_items_v1
WHEN (OLD.state = 'unsent' AND NEW.state NOT IN ('unsent', 'open', 'not_relevant'))
  OR (OLD.state = 'unsent' AND NEW.state != 'unsent' AND NEW.send_included IS NOT (NEW.state = 'open'))
  OR (OLD.state != 'unsent' AND (NEW.state = 'unsent' OR NEW.sent_at IS NOT OLD.sent_at
    OR NEW.send_command_id IS NOT OLD.send_command_id OR NEW.send_included IS NOT OLD.send_included))
BEGIN SELECT RAISE(ABORT, 'open item state move is not allowed'); END;
```

- The scope CHECK and the `relation`/`expected` CHECK in the block are the pre-flight corrections R4 and R5 (`8bf5bed`), made before execution.
- `impact-items-v1.ts`:
  - `insertForRun` and `recordCheck` run only on the caller's open transaction handle. `recordCheck` accepts `at` only in exact `toISOString()` form.
  - `sentBy(runId, commandId): { sent, not_relevant } | undefined` is new (Task 9b): what a send under that command did. `send` replays through it. Since PR #301 it counts `send_included`, so a replay returns the original counts whatever changed since.
  - `ImpactItemRowV1` gains `send_included: boolean | null` (Task 11).
- `trigger-runs-v1.ts` (Task 11):
  - The plan's `liveSweep(actor)` (a pending or running sweep of any scope) was built in Task 2 and is gone. Task 11 replaced it with two reads, which `home.sweep_due` uses (R32, R58; see Task 11):
    - `runningSweep(actor)`: the actor's sweep, of any scope, that is running now (its attempt's lease still holds);
    - `newestSweep(actor)`: the actor's most recently created sweep, in any state.
  - `claim` answers `busy` for a sweep while the actor has a pending or running approved-record run (R34).
  - `list` takes an optional `trigger` filter (R55); it always returned runs of every trigger.
  - `triggerRunStateAtV1(row, at)` is new (R60): a `running` run whose lease has lapsed reads `pending`. The store's own reads return the stored state; the service applies the function to `list` and to the stages of `items`.
- `open-item-people-v1.ts`: `leadsAny` counts active projects only (R11).

#### Task 3: the access policy

`services/organization-authority/src/composition/open-items-policy-v1.ts` as built:

```ts
export interface OpenItemFactsV1 {
  // The plan's facts, plus:
  /** The item reached its owner: it was sent, and Send included it, or it is `open` or `done` since. */
  readonly sent_to_owner: boolean;                                    // Task 3 fix, R13; R54
  readonly state: 'unsent' | 'open' | 'done' | 'not_relevant';        // Task 7, R16
}
export interface OpenItemAccessV1 {
  // The plan's outputs, plus:
  /** The viewer may see the decision part (title, first line, approval time, projects). */
  readonly see_decision: boolean;                                     // Task 9b, R20
}
/** Who may send a run's items: its approver, while they can read the decision. */
export function openItemSendAccessV1(facts: { readonly viewer: string; readonly approver: string; readonly reads_decision: boolean }): { readonly send: boolean };
/** Who sees a decision: on a row, in a summary, in a stage and in a sweep's findings. */
export function openItemDecisionAccessV1(facts: { readonly reads_decision: boolean }): { readonly see_decision: boolean };   // Task 11, R26 (Part 2)
```

- `see_row = reads_decision || (owner && sent_to_owner)`. An owner who cannot read the decision sees only items that reached them: Send included them, or they were reopened or closed as done after Send. An item Send left unticked that nobody reopened never reaches its owner.
- An unsent item waits on its approver, or on the decision's project leads when the approver has left. Nobody sets its state or reassigns it before Send.
- A closed item (`done`, `not_relevant`) waits on no one: `waits_on_viewer` is false.
- `see_decision` comes from `openItemDecisionAccessV1`.
- Task 7 computed `sent_to_owner` from timestamps (R13). Task 11 reads `send_included` instead, widened by R54: `sent_at` is set, and `send_included` is true or the state is `open` or `done`.

#### Task 4: runs API

`packages/organization-api/src/person-runs-v1.ts` as built, with the later additions marked:

```ts
export type PersonRunsRequestV1 =
  | { readonly schema_version: 1; readonly operation: 'list' }
  | { readonly schema_version: 1; readonly operation: 'home' }
  | { readonly schema_version: 1; readonly operation: 'start'; readonly run_id: string; readonly capture_id?: PersonDiagnosticCaptureIdV1 }
  | { readonly schema_version: 1; readonly operation: 'retry'; readonly run_id: string }
  | { readonly schema_version: 1; readonly operation: 'view'; readonly run_id: string }
  | { readonly schema_version: 1; readonly operation: 'items'; readonly scope: 'mine' | 'run' | 'record' | 'project'; readonly id?: string; readonly cursor?: string;
      readonly summary_only?: true;                                   // Task 9b
      readonly open_only?: true }                                     // Task 12c
  // item, send, set_state and assign as planned
  | { readonly schema_version: 1; readonly operation: 'sweep'; readonly scope: 'mine' | 'record' | 'project'; readonly id?: string };   // Task 10
```

- `list` and `home` are two variants. With the grouped `'list' | 'home'` form, `Extract<PersonRunsRequestV1, { operation: 'list' }>` was `never` in the person client.
- `start` takes an optional `capture_id` (main's PR #298 diagnostics).
- `items`:
  - `summary_only` is accepted only as `true` and never with `cursor`. It answers `items: []`, `next_cursor: null` and the full `summary` and `stages`, with no live read.
  - `open_only` is accepted only as `true`, never with `summary_only`, and with `cursor`. It pages the visible `open` items; the summary and stages still cover the whole scope.
- `PersonOpenItemV1.reach: 'opened' | 'no_access' | 'unavailable' | 'not_read'` is required, and `current` comes exactly with `opened` (Task 9b).
- `PersonRunV1.trigger` is `'approved_record' | 'sweep'`, `home.sweep_due` is a boolean, `PersonImpactStageV1.mine` says the stage's run is the caller's own, and `sweep` answers `{ run_id }` or `{ state: 'nothing_to_check' }`. The trigger, `sweep_due` and the `sweep` operation moved from Task 11's text into Task 10 (R25 for Part 2), so the service and the desktop could be built at once; before execution, R3 had moved them the other way. The stage's `mine` is new (R26 for Part 2), and Task 10 computes it for real (R31).
- `summary.by_decision` entries gain `landed` and `unreadable`, with `landed + unreadable <= open` (Task 12c).
- Value rules the plan left open: `decision.approval_id` at most 128 characters; names 1–200 characters; `current.status` and `current.due_at` at most 128; `decision.project_ids` at most 20 valid ids; Send-row `kinds` distinct and `owners` unique, at most 20; a stage's `error_code` exactly when it failed.
- Task 7 replaced the temporary pre-authentication `default` in the runs route. One `default` stays for operations the API knows and the server does not serve; it is unreachable now.

#### Task 5: `expected` and item keys

- The stored `expected` is cut to 120 characters after outside titles are replaced, so a short title that grows into "a cited item" cannot break the 120-character CHECK.
- `refreshImpactCardV1` does not show `expected` on a viewed card. People see it on item rows.
- The impact card's quality baseline fingerprints moved (R15).
- The same modules export more later: `impactCardLineV1(value, maximum)`, the card's one-line cleaner (Task 7), and the `SUGGESTED_EDIT` and `OWNERSHIP_CLAIM` screens (Task 10, reused by the sweep renderer).

#### Task 6: exact owner matching

- `matchImpactOwnersV1` takes `people: ImpactOwnerPeopleV1`, a structural type with `activeByName` and `isActiveMember` declared in `impact-owner-matching-v1.ts` (R9).
- `assignees` sends only numeric Jira ids, each once. A malformed page, a failed batch or an abort returns an empty map.
- `OpenedPersonLiveConnectorV1` gains `owners?: JiraOwnerAccountsV1` (Task 7), so the runtime hands the Jira runtime's owners to the run finish.

#### Task 7: runs service and open-items operations

- `createPersonTriggerRunsV1` gains `items: Pick<SqliteImpactItemsV1, 'insertForRun'>`, `people: ImpactOwnerPeopleV1` and an optional `jira_owners`; its `records` also provide `readableDecisions`. The stored-card reader is exported as `readStoredImpactCardV1` (R6); Task 11 moved it to its own module, `person-stored-impact-card-v1.ts` (R57), and widened these options (see Task 11). After owner matching the run checks its signal, so a cancelled run never stores approver fallbacks.
- `createPersonOpenItemsV1` also takes `on_live_failure?` (Task 9b) and an optional `now` clock (Task 11), and serves `sweep` (Task 10).
- `unavailablePersonTriggerRunsV1(sessions)` in `organization-authority-api-runtime.ts` is the model-less application. It authenticates, then answers `unavailable` for every operation.
- `projectRecords` returns `[]` for a project the reader does not hold. Neither record lookup writes an audit row. A blank decision title reads "Approved meeting"; a missing member name reads "Unknown member".
- `set_state` and `assign` check `see_row` first (`not_found`). An unsent item then answers `invalid_request` "Send it first", but only to someone who could act once it is sent (R18). Then the policy's right decides. A `set_state` to the current state writes nothing.
- `send`, in Task 9b's order: the caller's own finished approved-record run, else `not_found`; a replayed `command_id` answers its counts from `sentBy` before any other check; then `openItemSendAccessV1`, active-member picks and the store. A stale card answers `conflict` "The items changed. Open them again." (R22), not `stale_access_state`.
- `assign` to the current owner writes nothing (Task 9b).
- Live reads set `reach` (Task 9b). A desk refusal (`unauthorized`, `not_found`, `stale_access_state`, an empty open, or another item released) is `no_access`. Any other failure, a failed bind or fence, or a read the API cannot carry is `unavailable`. An item past the 50-open cap is `not_read`. Failures send a content-free event `{ kind: 'open_items_live_read', reason, code }`: one per item that fails to open (`open`; also an opened item the API cannot carry, with code `invalid_output`), one per request for a failed bind or fence (`bind`, `fence`), and one for a stored impact card that cannot be read for its first line (`first_line`).
- `home` opens only the rows it returns. Read bounds: `involving` and `orphaned` 1,000 rows, an `items` scope 5,000 rows, a project 500 records.
- Summary: `landed`, `changed` and `unreadable` count visible open items; `decisions` counts decisions with a visible row; `by_decision` names only decisions the viewer may see, newest activity first, at most 100.
- Stages: the latest run per record. A `record` scope includes its record even with no items. A stage's `mine` is true when the run's actor is the caller (Task 10, R31). Task 11 decides stages with `openItemDecisionAccessV1`, and a stage whose run is `running` with a lapsed lease reads `pending` (R60).
- An item the API refuses is retried without `current`, then without `decision`, before the response fails.
- Home reads open items and runs even when Granola is absent or unavailable; only meeting reviews depend on it (PR #301, R29).

#### Task 8: review rows

- `action_count` is `brief.actions.length`, any safe non-negative integer (R14). The plan's "0–40" bound was dropped.
- `first_line` turns control characters into spaces and never cuts a surrogate pair.

#### Task 9: desktop Home, Tell the owners?, Update in place

- `HomeState` gains `closing` and `closeFailures` for Update in place, and `sent`: a sent run's Send row stays hidden until a later Home read (R21). `meetings` says meeting review is available; Home's open items do not depend on it (PR #301).
- A poll reads `home` only after a check ends or after a failed `home` read (`resultOwed`, `openUnread`), because every `home` read opens items live. `homeNeedsPolling()`, carried from main's `f108cf4` (R26 for Part 1), recovers Home after a failed read.
- `runPollDelay`: 5 s with work in flight; after failures `min(60 s, 5 s × 2^failures)`; null after `unavailable` with nothing in flight. Any other failure with nothing in flight keeps backing off, at most 60 s.
- `runsCommand` and `meetingCommand` throw `CommandFailed`, which carries the failure code.
- Copy helpers live in `src/renderer/needs.ts`, including `itemTitle` (by `reach`) and `itemNames`.
- Open items is a layer over the reader or the project, not a route. Send is a route.
- Fixture modes beyond the plan: `granola-all` (Approve, Send and Update rows on one Home) and `granola-owner-outage` (Task 9b).
- Copy beyond section 8 of the spec:
  - toasts "Sent", "Kept on your Home" and "Nothing to change";
  - the failed row's verb "Retry";
  - live details fall back to `says "<says_now>"`;
  - "A page you can't open", and the Impact line's "N handled";
  - "A Jira ticket ECHO couldn't read just now" (`unavailable`) and "A Jira ticket" (`not_read`), from Task 9b;
  - a Send conflict reads "These items changed meanwhile. Open them again from Home." (R22), and Details is disabled while sending (R23).
- Pick a person lists everyone but you. A picked owner shows "Remove <name>".

#### Task 9b: counts-only reads and honest live-read failures

A follow-up the plan does not have (R20, R22, R23; `a087346`). Its interfaces are listed under Tasks 2, 3, 4, 7 and 9.

#### Task 10: sweep result contract and renderer

- `person-sweep-result-v1.ts`:
  - `PERSON_SWEEP_RESULT_LIMITS_V1 = { findings: 20, finding_citations: 12, line_chars: 300 }`.
  - `personSweepResultStatusV1(findings)` is `not_assessed` exactly when no finding was judged and at least one is null. The validator requires the result's status to equal it, so an assessed result may hold nulls (R40).
  - A judged verdict cites at least one item; a null or `unreadable` verdict cites nothing; every citation is used; `finding_index` equals the finding's position.
  - A null verdict means not assessed: no usable reply, no model call possible, or the finding's own items were not shown.
- The research-eval API's `rendered` is `PersonImpactCardV1 | PersonSweepResultV1`, chosen by the run's trigger. The service picks the validator by renderer object, never by name.
- `sweep-renderer-v1.ts`:
  - The trigger input is `SweepTriggerInputV1` (the definitions file calls it `SweepEventV1`). `MAX_FINDINGS` reads the contract's limit.
  - A finding's own items are its first citation plus every further ticket, page or Slack message it cites (R45). They match by identity: the same item key and, for a page, the same section; text digest, version and permalink are ignored. Another section of a page stands in only when the cited section is gone (R42). An ECHO record or document cited after the first is context.
  - A finding is `unreadable`, with no model call, only when one of its own citations is in `bundle.unreadable_starting`.
  - A finding is sent only with all of its own items. If one is missing from the bundle, if they do not fit, or if it has no own citation, it comes back null with "Not assessed." (R40, R48). Own items fill the prompt first, then other sections of the same pages, then the impact card's order.
  - Each prompt finding carries `about`: the ids of its own items. The prompt says "landed" only when the current items show the whole expected change, and never to say who owns anything.
  - The reply schema uses only the impact card's schema keywords (`maxItems`, `maxLength`, `enum`); `index` has no `minimum` or `maximum`.
  - The screens apply per line after the one repair: a line of the second reply that still fails becomes "ECHO withheld this line.", and its verdict and cites stay (R39).
  - The outcome is `answered` only when every finding was judged, else `partial`.
- The runs API additions moved here (see Task 4). Until Task 11, `sweep` authenticated and answered `unavailable`, and `home.sweep_due` was false.

#### Task 11: sweep runs in the service

- `sweep` takes the caller's visible open items in scope (`see_row`). None, or a record or project where the caller sees nothing, answers `nothing_to_check`, never `unauthorized`. Otherwise it calls `enqueueSweep`, which answers the caller's pending or running sweep of that scope, else a new pending one.
- `home.sweep_due` is not the plan's "`runs.liveSweep(actor)` is undefined". As built (R32, R58), it needs all three:
  - an open item the caller approved or owns, and sees, was last checked more than 24 hours ago or never;
  - `newestSweep(actor)` is absent, or was created an hour ago or more (R32);
  - `runningSweep(actor)` is absent.

  A sweep left pending for more than an hour no longer holds `sweep_due` back; only one that is running now does. Asking again for its scope returns that same pending run, so a stuck sweep is resumed (R58). Check now is not limited. The `sweep_due` API comment states the hourly limit and R58's resume.
- `list`, and the stages of `items`, report a `running` run whose lease has lapsed as `pending` through `triggerRunStateAtV1`; the stored state is unchanged, and `claim` already re-claims such a run (R60).
- A sweep claim answers `busy` while the caller has a pending or running impact run (R34).
- The sweep's own work is `sweepOpenItemsV1` in a new `services/organization-authority/src/composition/person-sweep-runs-v1.ts`, called from `launch` with the impact run's observation and error structure (R38). `person-open-items-v1.ts` exports what it shares: `sweepScopeOpenItemsV1`, `assessOpenItemsV1`, `openItemDecisionPartsV1`, `openItemKindV1` and `openItemViewerV1`.
- Both triggers answer `{ result, writes? }` to `launch`. `writes` is asked right before `finish`, with no await between, and answers the callback that `finish` runs in its transaction.
- A finding names the decision (its title, its first line as the `expected` fallback, its record citation) only when `openItemDecisionAccessV1` lets the caller see it (R33):
  - The finding reads "<Conflicting, Outdated or Affected> <kind>", plus "from <decision title>" for a decision reader.
  - Its `expected` is the item's own phrase, else, for a decision reader, the first decided line cut to 120 characters, else "the approved decision".
  - The item pointer is always the first citation, and it is the only one for a caller not shown the decision.
- A sweep takes up to 20 items: never checked first, then oldest `checked_at` (R8), then oldest item.
- The desk's scope:
  - a project sweep reads in its project;
  - a record sweep reads in the record's project when the caller may see the decision and it has exactly one project;
  - any other sweep reads globally.
- Slack-message items, as Task 11 first built them, stayed out of sweeps and `sweep_due`, because the kernel's sweep trigger refused Slack citations. R56 reversed that in the fix round (`7024358`):
  - the trigger took Slack citations, checked with the organization API's own Slack citation check;
  - the research-eval endpoint, which parses sweep findings with the same trigger, took them too;
  - Slack items were swept and counted toward `sweep_due`.

  The re-review found that no desk in this repository can open a Slack citation. So R62 supersedes R56, and Task 12c restores the refusal and the exclusion, with the reason in a comment.
- The stored result is the counts object `{ schema_version: 1, landed, still_open, changed, unreadable, not_assessed }`.
- The finish records each non-null verdict with `recordCheck`, only on items the caller still sees. Who sees what is asked again synchronously, right before `finish`, not inside its transaction (R61): the record check behind it opens a project-context transaction, which never nests. The service tests' fixture now refuses that nesting, as production does.
- Checks carry the attempt's start time, not the finish time, so a check someone made meanwhile stays newer.
- An attempt with no item left reads nothing, binds no desk, and finishes with zero counts. A diagnostic capture of it checks the caller's session alone, so it no longer reads `failed`.
- A sweeper who loses access mid-run ends `no_access`, with nothing recorded.
- `list` answers at most the 20 newest sweeps and fills the rest of its 100 with the newest impact runs, newest first (R55). `view` of a sweep is `not_found`; `retry` of a sweep is refused with `not_found`, and the next sweep replaces it. The service dropped Task 2's temporary sweep guards; the store's `list` never had one.
- `createPersonTriggerRunsV1`'s options widen:
  - `items` also provides `involving`, `forRecords`, `read` and `recordCheck`;
  - `people` also provides `people` and `leadsAny`;
  - `records` is the full `PersonReadableDecisionsV1`;
  - an optional `now` clock stamps a sweep's checks and tells a lapsed lease.
- `readStoredImpactCardV1` moved to its own module, `services/organization-authority/src/composition/person-stored-impact-card-v1.ts`, imported by both services (R57).
- From R26 (Part 2): `openItemDecisionAccessV1`, a table test of the `reach` refusal codes, and `sent_to_owner` from `send_included`, widened by R54 to items reopened or closed as done after Send.
- The person client's `runs` help lists `sweep`, and `list` as "your own impact runs and sweeps".

#### Task 12: desktop Check rows, Did it land?, Check now, auto-sweep

- A Check row is one button that opens a Check card (spec ruling 3); Part 1's inline Open and Done are gone. The card shows the live details → `expected`, "Not what was decided · Checked 2 h ago by Mina Patel", Done and Not relevant (with `can.set_state`) and "Open in …" (only when opened). `markDone` became `closeItem(item, 'done' | 'not_relevant')`.
- The footer reads "2 landed since yesterday · 1 with others · checked 2 h ago", with "Mark done" when anything landed, also under "Nothing needs you".
- Did it land? (`src/renderer/screens/did-it-land.tsx`) is a layer over the page it opened from, grouped as R36 says. Task 12 read every item in scope and kept the open ones; since Task 12c it reads `items` with `open_only: true` and keeps that check as a guard.
- Check now sits on the reader's Impact line (once the decision has items) and on the project line:
  - `nothing_to_check` shows "Nothing open to check".
  - Otherwise the line shows "Checking…" until the sweep ends. Then it reads the line's counts again, and opens Did it land? for that scope if the line is still in sight.
  - A failure shows "Check failed · Try again".
  - Its sweep is started at once. While a start answers `busy`, each runs list says what starts next (`runToStart`), so queued impact runs go first. The list is read at `runPollDelay`'s pace.
- Auto-sweep:
  - `runToStart` picks the oldest queued impact run, else the oldest queued sweep.
  - A Home load asks for at most one new `mine` sweep, and only when `sweep_due` is true and no run is pending or running.
  - A sweep that already exists and is pending is started like a pending impact run, after them, under `runPollDelay`'s backoff (R50).
  - `busy` is never shown. Like a start that fails, it only lengthens the next wait, for impact starts too.
  - A sweep never makes a Home row. When the sweep Home asked for ends, Home reads what waits on you again.
- The Impact line adds up as R35 says. It learns Send and Try again from the stage's `mine`, no longer from runs `list`. The project line adds "checked …". After Task 12c, a feed row and the project line count open items as `unsent + open − landed − unreadable`, and the project line sums its decisions' counts (`by_decision`); "from M decisions" counts those above zero.
- Names stay distinct (R37) on rows, buttons and the Send card's checkboxes (R49). A decision's title is added only where it tells alike items apart, so alike items of one decision get a position: "(1)", "(2)" (R59). The remove button names its item: "Remove Rafael from Thermostat PRD · Pilot scope".
- Relative times read "just now", "N min ago", "N h ago" under 6 hours, then "today", "yesterday", "Oct 6" (R49).
- Fixture modes `granola-checked`, `granola-sweep`, `granola-sweep-requeued` (the sweep's first attempt goes back to the queue, R50) and `granola-alike` (look-alike unsent items, for R37's names on the Send checkboxes). The fixture's `sweep` now queues a real sweep run; it used to answer `nothing_to_check`.

#### Task 12c: open-only pages and per-decision verdict counts

A follow-up the plan does not have (R51), as its brief specifies:

- The API gains `open_only` and the per-decision `landed` and `unreadable` counts (see Task 4).
- The service pages open items only, oldest first, 50 a page, opening only that page's items live, and counts verdicts per decision.
- The fixture honors `open_only` and answers the new counts. The desktop uses them as Task 12 describes.
- R62 (it supersedes R56) rides along, in the same files:
  - the kernel's sweep trigger refuses Slack message citations again;
  - the service leaves Slack-message items out of sweeps and `sweep_due` again, with a comment saying why: no desk can read a Slack citation yet.

#### Task 13: sweep in the research-loop evaluation

- `gradeSweep(key, result)` returns `{ right, total, not_assessed }` and grades by `finding_index`. A missing or repeated finding is wrong. A null verdict is wrong and not assessed.
- A completed sweep run without `rendered` fails with `no_rendered_result`. A failed sweep run scores zero: all its findings count as wrong (R43).
- The leak scan covers the whole `rendered` result, and also runs on a completed run that lacks its result (R44).
- The dataset check requires each Sweep verdict to name its own finding, in the findings' order (R44).
- The report sums sweep verdicts per case and in total, under Renderers only. A caption separates them from the research measure "Sweep verdicts correct".
- The judge sees a sweep as `answer.sweep` (per finding: verdict, line, cites), never as a card. Sweep gaps are still judged on the plan.
- Impact-card checks run only on approved-record runs. Before, `grade` crashed on any sweep result.

### Rulings made during execution

Each line gives the ruling, then the reason. The ledger numbered two rulings each as R25 and R26 (one at the Part 1 stop, one at the Part 2 start); both are listed.

- R1: Move `PersonMeetingReviewV2`'s three fields from Task 4 to Task 8 — Task 8 changes the service and fixture that produce them, so Tasks 4–7 keep building.
- R2: Every task leaves the build, root `tsc` and desktop typecheck green; Task 4 adds a temporary route `default` and raw desktop result types, replaced in Tasks 7 and 9 — the widened unions would otherwise break the tree.
- R3: Move the `sweep` operation, `home.sweep_due` and `trigger: 'sweep'` from Task 10 to Task 11 — the service implements them there. Reversed by R25 (Part 2).
- R4: The runs scope CHECK tests `scope_kind IS NOT NULL` first — the plan's `IS` form rejected every approved-record row.
- R5: The items CHECK becomes `relation IS NOT NULL OR expected IS NULL` — a conflict without a usable phrase must still be stored.
- R6: Task 7 exports the stored-card reader as `readStoredImpactCardV1` — the open-items service needs the first decided line.
- R7: Task 5's `renderWith(reply)` returns `{ card, calls }` — the two tests used the helper differently.
- R8: Task 11 sorts sweep candidates by `checked_at` in the service — `forRecords` orders by `created_at`.
- R9: Task 6 declares a local structural people type — Task 2's DAO was not on its base; the DAO satisfies it.
- R10: The check-newer trigger covers all four check columns and needs a strictly newer `checked_at` — spec section 2 replaces a check only by a newer one, and the plan's trigger let the verdict change without a newer time.
- R11: `leadsAny` counts active projects only — archived projects are read-only and the approval-audience trigger requires active ones.
- R12: The runs CHECK test asserts the CHECK's own message — it passed only because an earlier trigger fired.
- R13: The policy gains `sent_to_owner` — an owner who cannot read the decision sees only items sent to them (spec section 4).
- R14: `action_count` has no upper bound — briefs hold more than 40 actions, and a clamp would misreport.
- R15: Re-pin the impact-card quality baseline's three fingerprints — the mandated prompt and schema change moved them; the Ask goldens are untouched.
- R16: The policy gains `state` — the rules for unsent and closed items stay in the one policy.
- R17: Run Task 9 (desktop) in parallel with Task 7 (server) in separate worktrees — they share no files, and Task 9 builds against the merged API types and the fixture.
- R18: The policy refuses `assign` on unsent items, and `see_row` is checked before "Send it first" — only someone who could act learns that the item is unsent.
- R19: Unsent items of an approver who left before Send stay unsent; leads see them but cannot send or reassign — parked as a known gap, since letting leads send is new scope.
- R20: Task 9b adds `summary_only`, `reach`, replay-first Send, `see_decision`, Send gating through the policy and a same-owner assign that writes nothing — rate limits and honest outage copy matter on real data.
- R21: Task 9's fix round also hides sent runs locally, pins the can't-open row in e2e and names item buttons — same class as the review's Important finding.
- R22: A stale Send answers `conflict`, shown as "These items changed meanwhile. Open them again from Home." — the desktop reads `stale_access_state` as a lost account.
- R23: Task 9b takes the Task 9 re-review's store fixes (staleness check first, record a send on any page, no Details while sending, distinct names) — they are small fixes in code 9b touches.
- R24: Bring main into the Part 1 branch with one `--no-ff` merge after Task 9b — a merge keeps the reviewed commits intact.
- R25 (Part 1 stop): Codex finishes the Part 1 stop (merge main as R24 says, validate once, refresh screenshots, prepare the fixture walkthrough) without starting Part 2 or pushing — the founder's request.
- R26 (Part 1 stop): Keep all three Home recovery cases from main's `f108cf4`, adapted to the new Home, and add two failed-Home resume cases — main's recovery fix must survive the rewritten Home, and no test is removed.
- R27: Accept the Part 1 reviewer's limits: no sweep, deferred minors stay deferred, live staging is not proven by fixtures — the limits stay visible at the founder's review.
- R28: Ship the accepted Part 1 as a standalone PR (#300) on the validated head — Part 2 stays parked; no reset, merge or release is implied.
- R29: Fix PR #300's two inline review reports in a follow-up, PR #301; Home reads shared open items and runs without Granola, and only meeting reviews depend on it — PR #300 merged while the fixes were being reproduced. That rule answers one report; R30 answers the other.
- R30: V13 stores an immutable `send_included` per item, and a Send replay returns its original counts — counting current state went wrong after later state changes; this supersedes the Task 2 replay rule.
- R25 (Part 2): Part 2 runs in waves: Task 10 with the runs API additions, then Tasks 11, 12 and 13 in separate worktrees — the desktop builds against a settled API, as Tasks 7 and 9 did.
- R26 (Part 2): Fold Part 1's deferred minors into the Part 2 tasks (a record-level policy function, `reach` code tests, `send_included` for `sent_to_owner`, a stage's `mine`, distinct names, plan text) — they touch the same code.
- R31: Task 10 computes a stage's `mine` for real, while `sweep` and `sweep_due` stay placeholders — a placeholder `mine` would be wrong data, and it is one comparison.
- R32: `home.sweep_due` also requires no sweep created in the last hour — a failing or unassessed sweep would otherwise be asked for on every Home load, reading Jira and Confluence each time.
- R33: A sweep finding names the decision only when the caller may see it — an owner sent an item without reading its decision must not get the decision in their run.
- R34: A sweep claim answers `busy` while the caller has a pending or running impact run — "impact runs start before sweeps" must not depend on the client.
- R35: The Impact line partitions sent items: open less landed and unreadable, handled (done, not relevant, landed), couldn't read — the canvas 9.6 example reads 1, 1 and 1.
- R36: Did it land? groups by last check (Landed; Still open with changed and unchecked items; Couldn't read), and Mark N done closes the ticked landed items the viewer may set — the spec lists only three sections.
- R37: Names that still collide after `expected` add the decision title when readable, else a position; "Remove <person>" names its item — it closes a Part 1 minor.
- R38: The sweep's work lives in a new composition file called from `launch`, with one observation and error structure — the runs file is already long.
- R39: Sweep line screens apply per line after the one repair; a line that still fails becomes "ECHO withheld this line." and keeps its verdict — refusing the whole reply let one line void every verdict, every hour.
- R40: Never judge a finding blind: send it only when all its own items fit, else null; a judged verdict cites at least one item; one status per state — a stored blind verdict could hide a landed ticket for a day.
- R41: Start Tasks 12 and 13 from `bc2e9a3` while Task 10's fix round runs — the fix changes only renderer internals and the validator; the desktop never sees them, and the evaluation reads the result only by `finding_index`.
- R42: Match a finding's own items by identity (item key, and section for a page) — matching the whole citation failed for every edited item, and edited items are what a sweep checks.
- R43: Failed sweep runs score zero, like failed card runs — a sweep the endpoint cannot start is a real failure the report must show.
- R44: Fold all five Task 13 minors into one fix round, including the leak scan of result-less runs — a hidden leak undercounts runs with leaks, and misaligned verdict keys would misgrade silently.
- R45: A finding owns its first citation and every further outside-tool citation; ECHO records cited later are context; it is unreadable only when an own item is — eval findings cite several tickets, and an unreadable decision must not be stored as the item's check.
- R46: Start Task 11 from `41ceec0` alongside Task 10's third fix round — that round changes renderer internals only, not the result contract Task 11 uses.
- R47: The controller pauses after Tasks 10–13 are merged and checked, leaving Task 14 and the final review to the founder — the founder's instruction at the time; superseded by R52.
- R48: The same implementer fixes the round-3 re-review's three minors — they are new small findings from a clean re-review, not a stuck loop.
- R49: Accept Task 12's open choices (relative times, the Check card's layout, where Check now shows, impact runs first, one sweep request per Home load), but R37 also covers the Send card's checkboxes — names must differ there too.
- R50: "One sweep start per Home load" limits new sweep requests only; an existing pending sweep starts like a pending impact run, after them, with backoff — a released sweep must resume, and nothing may poll every 5 s for work it will not start.
- R51: Did it land?'s reads of closed items and the feed row's "open" count move to Task 12c — both need API and service changes that neither parallel branch could make.
- R52: Finish order: merge Tasks 11 and 12, Task 12c, Task 14's docs, a final whole-branch review with one fix round, then `npm run check` and the full desktop e2e on the exact candidate, one push and a draft PR against main — the review's fixes must be inside the validated candidate.
- R53: Write Task 14's docs in a separate worktree while Tasks 11 and 12 finish, and re-check the in-flight parts after they merge — the docs depend only on settled rulings and briefs.
- R54: `sent_to_owner` is true when the item was sent and Send included it, or it is `open` or `done` since — an item reopened after Send would otherwise wait on an owner who cannot see it.
- R55: Runs `list` answers at most the 20 newest sweeps and fills the rest of its 100 with the newest impact runs — sweeps, up to hourly plus Check now, must not push failed impact runs and their Try again rows off the list.
- R56: The kernel's sweep trigger accepts Slack message citations, so Slack items are swept and count toward `sweep_due` like tickets and pages — the live desk already opens them, and leaving them out meant they were never checked. Superseded by R62.
- R57: `readStoredImpactCardV1` moves to its own small composition module that both services import, and the `sweep_due` API comment states R32's hourly limit — no import cycle, and no 700-line file.
- R58: `home.sweep_due` ignores a pending sweep created more than an hour ago (stale items, no sweep created in the last hour, none running); asking again returns that same pending run — a stuck sweep is resumed by the server's rule instead of blocking automatic sweeps for good, without depending on the desktop's list.
- R59: Accept Task 12's narrower R37: a decision's title is added only when alike items come from different decisions, else a position — a title cannot tell apart items of one decision, and R37's aim is distinct names.
- R60: Runs `list` and the stages of `items` report a `running` run whose lease has lapsed as `pending` (the stored state is unchanged) — otherwise a run whose worker died shows "Checking…" forever and Home polls every 5 s; the gap dates from Part 1 and was found by the Task 12 re-review.
- R61: A sweep asks again who sees each item synchronously right before `finish`, with no await between, not inside its transaction — the record check behind it opens a project-context transaction, which never nests, so nesting would break every production sweep; nothing in the Authority process can run in between, and a membership another process revokes in that instant is not seen.
- R62: Supersede R56 in Task 12c: the kernel's sweep trigger refuses Slack message citations again, and the service leaves Slack-message items out of sweeps and `sweep_due`, saying why in a comment and in the spec's "Not in this round" — no desk in this repository can open a Slack citation (it carries no `tool_id`, and no live Slack connector is registered), so a swept Slack item is only ever recorded `unreadable`, at the cost of a background research run; Slack items stay "not checked yet" until a Slack reader exists.

Unnumbered rulings:

- Implementers run on Opus from Task 2 on (Task 1 finished on Sonnet), and reviewers on Opus for substantial diffs — the founder asked for more capability.
- Keep Task 1's `Co-Authored-By: Claude Sonnet 5.5` trailer — it names the model that wrote the commit, and amending rewrites history.
- Tasks 3, 4, 5, 6 and 8 run as one parallel wave, each in its own worktree, merged after Task 2's review — the founder opted in.

### Execution record

#### Part 1

1. Pre-flight scan of the plan's tasks against each other; corrections committed as `8bf5bed` (R1–R8). Task 0 set up and proved the base green.
2. Task 1 (`f3aeaa5`), then Task 2 (`923edf2`, fix `12a13f6`).
3. Wave A, from `f3aeaa5`: Tasks 3, 4, 5, 6 and 8 in parallel, each reviewed. Tasks 3, 5 and 8 took one fix round; Tasks 4 and 6 were approved on first review. They merged after Task 2's review (`a5424e1`, `0d8c417`, `f2dbde1`, `2a958b3`, `153e584`), then one integrated check.
4. Task 7 (server: `274e3c3`, `dc0ef09`, `f6b6f90`) in parallel with Task 9 (desktop: `87aba52`, `8476046`, `c8d6a13`, fix `9289dde`, merged `786ea1a`) (R17).
5. Task 9b (`a087346`).
6. The stop: Codex merged main (`78be005`), validated once and prepared screenshots and the fixture walkthrough (R24–R26). The founder accepted Part 1 after clicking through the fixture. PR #300 opened on `78be005` (R28) and merged as `a7f8df7`. Two inline review reports were fixed in PR #301 (`5a008d0`; R29, R30), merged as `00a9c1f`.

#### Part 2

1. The founder gave the go once PR #301 was open. `feat/open-items-part-2` started from `5a008d0`.
2. Wave 1: Task 10 with the runs API additions (`b1593e5`, `bc2e9a3`), then four fix rounds (`25aacdf`, `1cacc13`, `41ceec0`, `c16add0`, `650f844`).
3. Wave 2, in separate worktrees: Task 12 (desktop, against the fixture Authority) and Task 13 (evaluation) from `bc2e9a3` (R41); Task 11 (service) from `41ceec0` (R46). Task 13 (`0ba71df`, fix `fef1c79`) merged as `ce76f0b`. Main, with PR #301, merged at `c4c2310`. Tasks 11 and 12 merged after their reviews: Task 12 (`43bbe12`, fix `cc5fb08`) as `dbf29fa`, then Task 11 (`05f75d3`, `b5b82a6`, fixes `7024358` and `34c5a87`) as `c31a46f`. Task 11 merged once its review approved it, ahead of the scoped re-review of its two fix rounds; that re-review found nothing critical or important.
4. Task 12c on the merged branch (R51): `<to be filled at the final check>`.
5. Task 14: docs written in their own worktree in parallel with Wave 2 (R53; draft `0ab233a`), checked again against the code once Tasks 11 and 12 had merged, then the final whole-branch review with one fix round, the final check, one push and a draft PR against main (R52): `<to be filled at the final check>`.

#### Models

- Implementers: Claude Opus 5.5 for Tasks 2–14, 9b and 12c. Task 1 ran on Claude Sonnet 5.5.
- Reviewers: Claude Opus 5.5 for the task reviews and re-reviews, and for the final whole-branch review.
- Codex ran the Part 1 stop (the main merge, an independent review, validation, screenshots and PR #300) and PR #301.

#### Validation evidence

- Wave A, integrated at `153e584`: `npm run check` exit 0 (322 files; 4,642 passed, 2 expected failures, 1 skipped); desktop build, typecheck, 83 unit tests, and the impact and tools e2e (16) passed.
- Part 1 stop, at `78be005`: `npm run check` exit 0 (331 files; 4,780 passed, 2 expected failures, 1 skipped); desktop build and typecheck passed; 116 of 116 unit tests; full Playwright 179 of 179. PR #300's CI passed all six jobs on the first run.
- PR #301, at `5a008d0`: `npm run check` passed (331 files; 4,784 passed, 2 expected failures, 1 skipped); desktop build and typecheck passed; 119 of 119 unit tests.
- Part 2 with main merged, at `c4c2310`: the build, the person client, root `tsc`, the desktop build, typecheck and unit tests, and the search, open-items and impact e2e passed. `search.spec.ts:65` failed at the Part 2 base and passes once PR #301's `a0c2f79` is in.
- Task 12 merged, at `dbf29fa`: the build, the person client, root `tsc`, the desktop build and typecheck, 145 of 145 unit tests and full Playwright 185 of 185 passed.
- Task 11 merged, at `c31a46f`: `npm run check` exit 0 (334 files; 4,884 passed, 2 expected failures, 1 skipped); desktop build and typecheck passed; 145 of 145 unit tests; full Playwright 185 of 185.
- Final candidate commit: `<to be filled at the final check>`.
- Final `npm run check`: `<to be filled at the final check>`.
- Final desktop build, typecheck and unit tests: `<to be filled at the final check>`.
- Final full desktop e2e (`npx playwright test`): `<to be filled at the final check>`.

#### Left open for the founder

- R19: unsent items of an approver who left before Send stay unsent.
- When the owner has left and the approver is active but can no longer read the decision, an open item waits on the approver, who has no row for it. It is on nobody's Home, though readers still see it on record and project pages.
- A partial landing, where some of a finding's items moved as expected, has no verdict of its own. The prompt's `still_open` rule leads the model to answer `still_open` (Task 10).
- R39's corner: when no repair call can follow the first reply (under 3 seconds left, or no call left), a reply whose only problem is a screened line is still refused whole, and every readable finding is not assessed (Task 10).
- A sweeper who cannot open an item records `unreadable`, and as the newest shared check it replaces a reader's `landed`; Home's landed count and Check rows read the shared check (Task 11 review, founder call).
- No desk in this repository opens a Slack citation, so Slack-message items stay "not checked yet" (R62). The same gap means a Slack item on an open-items row reads as one the viewer cannot open (`no_access`), and a viewed impact card hides the rows that cite a Slack message (counted in `hidden`).
- R61's gap: a membership that another process revokes between a sweep's visibility re-check and its finish is not seen.
- R58 counts the hour from a sweep's creation, not from its last attempt (Task 11 re-review). A sweep that waited over an hour and is then released after an outage is restarted on each Home load until its three attempts are spent. One released for index lag is re-claimed on every Home load.
- An R54 asymmetry (Task 11 re-review): an owner who cannot read the decision may set a reopened item, which Send left unticked, to `not_relevant`. It then leaves their sight at once, and they cannot undo it.
- Service minors (Task 11):
  - out-of-order finishes are tested with a fixture helper, not two real sweeps;
  - R60's re-claim is tested for an impact run only;
  - `person-open-items-v1.ts` is large, and its shared reads could move out;
  - a `mine` sweep reads the 1,000 oldest open items before ordering by check age;
  - `view` reads a run's decision directly, not through `openItemDecisionAccessV1`.
- Desktop minor (Task 12): on a project page, the project line's Check now and a decision's Impact-line Check now can both read the runs list until one ends.
- Evaluation minors (Task 13):
  - `report.json`'s per-case `leaks` mean leaves out runs that failed for a missing result, though `runs_with_leaks` counts them.
  - Two card fixtures still use the placeholder digest `sha256:0`.
  - No suite check keeps the evaluation's sweep fixtures contract-valid.
  - The dataset check throws on a null verdict or finding entry, as it did before Part 2.
