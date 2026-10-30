# Home Altitude Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Home gets a stop control that zooms between Me (today's "Needs you"), My projects, one project, and one person. Every new altitude uses one Linear-like row style built from follow-up data the desktop already reads.

**Architecture:**
- Pure rules live in a new `renderer/altitude.ts`: needs attention, health, roll-ups and groupings.
- `store.ts` gains an `altitude` slice. It holds the level, the project and person in focus, and per-project reads made through the existing `readItems`/`readOne`, with live parts kept by item id. It also gains `zoomTo`, `zoomOut` and `loadAltitude`, and a freshness `Surface`.
- A new `screens/altitude.tsx` draws the stops and the three new altitudes.
- `screens/home.tsx` renders the stops, then either the current Needs-you body (Me) or an altitude.

**Tech Stack:** Preact 10 renderer in Electron, TypeScript 7, vitest (unit, `test/unit/harness.ts`), Playwright (e2e against `src/host/test-authority.ts`).

**Spec:** `docs/product/2026-10-29-home-altitude-v1.md`.

## Global Constraints

- Desktop only. No change under `src/`, `packages/` or `services/`, and no contract, schema or host IPC change.
- Signal tokens only (`styles.css` `:root`). Orange (`--signal`) only for what needs attention, the done colour (`--done`) for done and on track. No red, amber or green.
- Thresholds: unsent waits more than **1 day**, open waits more than **3 days**. Off track means one waiting more than **7 days**, or **3 or more** needing attention.
- A row has the same columns at every altitude: mark · identity · name · needs · people · progress · date/wait.
- Me is today's Needs-you body, with its markup and test ids unchanged.
- Escape zooms out only from `project` (to `projects`) and `person` (to `project`), after every existing Escape rule. Arrow keys never zoom. Only `ctrlKey` wheel events (pinch) zoom.
- My projects never reads live. Project live-reads its unsent/open first page. Person live-reads at most **20** items, one by one.
- Reads per project for My projects run at most **4** projects at a time.
- `localStorage` key `echo.home.altitude` holds `{ level, project_id, membership_id, name }`. Any failure falls back to `me`.

## Review Focus

1. **Account change or sign-out while zoomed.** The altitude resets to Me and drops its reads. No row from the old account shows. (Task 2 test.)
2. **A project leaves the sidebar** (archived, left, or no longer readable) while it is the focus or remembered. The level falls back to `projects` and no read of it is sent. (Task 2 test.)
3. **A project's read fails.** Its row shows a faint ring and a "Couldn't read just now" tooltip, never on track, and the other projects still show. (Task 2 and Task 3 tests.)
4. **Escape with text in the Ask bar while zoomed** clears the text first and does not zoom. (Task 4 e2e.)
5. **Zero projects, or projects with no follow-ups.** My projects shows the New project empty state, and a project with nothing reads on track at 100% with no wait. (Task 1 and Task 3 tests.)

---

### Task 1: Rules (`altitude.ts`)

**Files:**
- Create: `product/echo-desktop/src/renderer/altitude.ts`
- Test: `product/echo-desktop/test/unit/altitude.test.ts`

**Interfaces:**
- Produces:
  - `UNSENT_DAYS = 1`, `OPEN_DAYS = 3`, `OFF_TRACK_DAYS = 7`, `OFF_TRACK_COUNT = 3`, `PERSON_LIVE_MAX = 20`, `PROJECT_READS_AT_ONCE = 4`
  - `type Health = 'on' | 'risk' | 'off'`
  - `waitingSince(item: OpenItemView): string | null`:
    - `unsent`: `created_at`;
    - `open`: the later of `sent_at` and `state_set_at`, falling back to `created_at`;
    - otherwise null.
  - `waitedDays(item: OpenItemView, now: number): number | null`: whole days, floored.
  - `unowned(item: OpenItemView): boolean`: `owner.match === 'approver' || waits_on === 'leads'`.
  - `needsAttention(item: OpenItemView, now: number): boolean`
  - `interface Face { membership_id: string; name: string; needs: boolean }`
  - `interface Rollup { done: number; total: number; needs: number; health: Health; oldest: number | null; faces: Face[] }`
  - `rollup(rows: readonly OpenItemView[], counts: { unsent: number; open: number; done: number } | null, now: number): Rollup`
  - `interface OwnerGroup { key: string; name: string; rows: OpenItemView[]; done: number; total: number; needs: number }` (`key` is a `membership_id`, or `'none'`)
  - `byOwner(rows: readonly OpenItemView[], now: number): OwnerGroup[]`
  - `interface DecisionLine { record_sha256: string; title: string; approved_at: string; done: number; total: number; needs: number; faces: Face[] }`
  - `byDecision(rows: readonly OpenItemView[], now: number): DecisionLine[]`
  - `byProject(rows: ReadonlyMap<string, readonly OpenItemView[]>, membership_id: string): { project_id: string; rows: OpenItemView[] }[]`

- [ ] **Step 1: Write the failing tests** in `altitude.test.ts`. Build items with a local `item(overrides)` helper (the full `OpenItemView` shape from `home.test.ts`). Use `now = Date.parse('2026-10-30T12:00:00.000Z')`.
  - `needsAttention`:
    - unsent, created 2 d ago → true;
    - unsent, created 12 h ago → false;
    - open, sent 4 d ago → true;
    - open, sent 4 d ago, `state_set_at` 1 d ago → false;
    - done → false;
    - `not_relevant` → false;
    - open, sent today, `owner.match: 'approver'` → true;
    - `waits_on: 'leads'` → true.
  - `rollup`:
    - no rows and null counts → `{ done: 0, total: 0, needs: 0, health: 'on', oldest: null, faces: [] }`;
    - with counts `{ unsent: 1, open: 2, done: 3 }` → `done 3`, `total 6`;
    - one item needing attention → `'risk'`;
    - three → `'off'`;
    - one open sent 8 d ago → `'off'` and `oldest: 8`;
    - faces dedupe by owner, put people needing attention first, and leave out `unowned` items.
  - `byOwner`:
    - groups by `owner.membership_id`;
    - `unowned` items go to `{ key: 'none', name: 'No owner' }`;
    - order is groups with needs first (by needs, descending), then by name.
  - `byDecision`:
    - groups by `decision.record_sha256`, newest `approved_at` first;
    - skips items with no `decision`;
    - counts done and total per decision.
  - `byProject`: keeps only that owner's rows, in map order, and skips empty projects.
- [ ] **Step 2: Run** `cd product/echo-desktop && npx vitest run test/unit/altitude.test.ts`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement** `altitude.ts` per the interfaces.
  - Days: `Math.floor((now - Date.parse(since)) / 86_400_000)`.
  - Needs attention: unsent with days > `UNSENT_DAYS`, or open with days > `OPEN_DAYS`, or `unowned` and not done/dismissed.
  - Health: off when any needing item waited more than `OFF_TRACK_DAYS`, or needs ≥ `OFF_TRACK_COUNT`; risk when needs > 0; on otherwise.
  - Done and total come from `counts` when given (`unsent + open + done`), else from rows that aren't `not_relevant`.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(desktop): rules for Home altitudes (needs attention, health, groupings)`.

### Task 2: Store slice (`store.ts`)

**Files:**
- Modify: `product/echo-desktop/src/renderer/store.ts`. The pieces:
  - `State` gains `altitude`.
  - The initial state at line ~619.
  - The account-reset `set` calls at ~743 and ~843.
  - `goHome` at 1366.
  - A new `SURFACES` entry near 5047.
  - New exported functions near `loadHome`.
- Test: `product/echo-desktop/test/unit/altitude-store.test.ts` (same `rpc` mock and `startStore` pattern as `home.test.ts`)

**Interfaces:**
- Consumes: Task 1's `PERSON_LIVE_MAX`, `PROJECT_READS_AT_ONCE`, plus the existing `readItems`, `readOne`, `LiveParts`, `shownItem`, `expect()`, `freshness`.
- Produces:
  - `type AltLevel = 'me' | 'projects' | 'project' | 'person'`
  - `interface ProjectRead { loading: boolean; failure?: Failure; counts: OpenItemsView['summary'] | null; active: readonly OpenItemView[]; all: readonly OpenItemView[] | null; reading: boolean }`
    - `active` holds unsent and open rows.
    - `all` holds every state except `not_relevant`. It is read only on a project zoom.
    - `reading` means a live read is on its way.
  - `interface AltitudeState { level: AltLevel; project_id: string | null; membership_id: string | null; name: string | null; reads: Readonly<Record<string, ProjectRead>>; live: LiveParts; seq: number }`
  - `State['altitude']: AltitudeState`
  - `zoomTo(level: AltLevel, target?: { project_id?: string; membership_id?: string; name?: string }): void`
    - Sets the level and target and persists them.
    - For `projects`, `project` and `person` it calls `loadAltitude()`.
    - `me` reads nothing new.
  - `zoomOut(): boolean`: person → project, project → projects. Returns false on `me` and `projects`.
  - `loadAltitude(back?: boolean): Promise<void>`
    - For each project in `state.projects.items`, at most 4 at a time: an `items` read with `scope: 'project'`, `id`, `read: 'counts'`, plus `readItems` with `read: 'rows'` and `states: ['unsent', 'open']` over every page.
    - On `project`, it also reads that project's `all` (states `unsent`, `open`, `done`) and then live-reads its unsent/open first page (the same request without `read`).
    - On `person`, it live-reads with `readOne(…, live = true)` up to 20 of that person's not-done rows that have no live part yet.
    - It drops any answer whose `seq` or account has moved on.

- [ ] **Step 1: Write the failing tests**, each with `rpc` answering per request:
  1. `zoomTo('projects')` with two projects. Expect one counts read and one rows read per project (scope `project`), and no read without `read` (no live read). `state.altitude.reads[p].counts` is filled.
  2. On `me` after start, no `items` read with scope `project` is ever sent.
  3. `zoomTo('project', { project_id })` sends a rows read with states `['unsent','open','done']`, then a live read with no `read` field.
  4. `zoomTo('person', { membership_id, name })` with 25 not-done rows of that person sends exactly 20 `item` reads with no `read` field.
  5. `zoomOut()` goes person → project → projects, then returns false.
  6. A project read that fails sets `reads[p].failure`, and the other project still fills (Review Focus 3).
  7. An account change resets `altitude` to the Me initial state with empty reads, and a late answer from the old account is dropped (Review Focus 1).
  8. A remembered `project_id` that is no longer in `state.projects.items` falls back to `projects` on `goHome()` (Review Focus 2).
  9. `localStorage` holding `{ level: 'projects' }` makes the store start at `projects`. A throwing `localStorage.getItem` gives `me`.
- [ ] **Step 2: Run** `npx vitest run test/unit/altitude-store.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement the slice.**
  - Persist through a small `rememberAltitude()` and `recallAltitude()` pair wrapped in try/catch.
  - `goHome` calls `loadAltitude()` when the level is not `me`.
  - Register `{ areas: ['follow_ups'], shows: () => state.route.page === 'home' && state.altitude.level !== 'me', read: back => loadAltitude(back) }` in `SURFACES`.
  - Reset `altitude` in the same `set` calls that reset `home` on an account change.
- [ ] **Step 4: Run** the new test file and `npx vitest run test/unit/home.test.ts`. Expected: PASS, with home tests unchanged.
- [ ] **Step 5: Commit** `feat(desktop): Home altitude state, reads and zoom`.

### Task 3: Screens (`altitude.tsx`, `home.tsx`, icons, styles)

**Files:**
- Create: `product/echo-desktop/src/renderer/screens/altitude.tsx`
- Modify:
  - `screens/home.tsx`: rename today's `Home` body to `NeedsYou`; `Home` renders `<Stops/>` and then the level.
  - `screens/icons.tsx`: add `Grid`, `Locate`, `Ticket`, `Ring`, `HealthDot`.
  - `styles.css`: `.alt-*` rules.
- Test: `product/echo-desktop/test/unit/altitude-screens.test.ts` (render functions via the harness's `render`/`text`/`elements`)

**Interfaces:**
- Consumes: Task 1 rules, Task 2 `State['altitude']`, `zoomTo`, `zoomOut`, `shownItem`, `itemTitle`, `itemKind`, `openFollowUp`, `openFollowUps`, `openProject`.
- Produces these components. They are not exported except where `home.tsx` needs them:
  - `Stops({ state })`, test id `alt-stops`, with buttons `alt-stop` carrying `data-level`, and `alt-me`;
  - `MyProjects({ state })`, test id `alt-projects`, with rows `alt-project` carrying `data-project`;
  - `ProjectLevel({ state })`, test id `alt-project-level`, with groups `alt-group` carrying `data-group="decisions" | <membership_id> | "none"`, and rows `alt-item` / `alt-decision`;
  - `PersonLevel({ state })`, test id `alt-person-level`;
  - `Ring({ fraction, tone, dashed })`, where tone is `'muted' | 'done' | 'signal' | 'faint'`, and `HealthDot({ health })`.
- Accessible names:
  - stops: "My projects", "Project, <name>", "Person, <name>", "Me";
  - a project row: "<name>, <Off track|At risk|On track>".
- The project and person stops are disabled until a project or person has been the focus.
- Groups are `<section>`. Zoomable headers and rows are `<button>`. ↑/↓ move focus between `[data-alt-nav]` elements when focus is already on one.
- Pinch: `onWheel` on the altitude container with `event.ctrlKey`, `deltaY < 0` over a `[data-zoom]` element zooms into it, `deltaY > 0` calls `zoomOut()`, at most once per 400 ms.
- A level change re-keys the container (`key={level + id}`), so the CSS `alt-in` animation (`.18s`, scale .98→1, fade) plays. `prefers-reduced-motion` turns it off.

- [ ] **Step 1: Write the failing render tests:**
  - `Stops` on `me` lights `alt-me` and disables the project and person stops.
  - `MyProjects` with three reads (off, risk, on) shows Health group headers in that order, each row with needs text and wait text (`9d`), and a failed read row with tooltip "Couldn't read just now" and no health dot.
  - `MyProjects` with no projects shows `empty-new-project`.
  - `ProjectLevel` shows the `decisions` group first, then owner groups needs-first, with "No owner" as `data-group="none"` and no zoom button.
  - A follow-up row's identity icon says "Jira ticket" in its `title` for a ticket.
  - `PersonLevel` groups by project, and the header zooms to the project.
  - `Home` on `me` renders today's `needs` test id unchanged.
- [ ] **Step 2: Run** `npx vitest run test/unit/altitude-screens.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the components and styles per the spec's "One row", "The marks" and "Each altitude". Row grid: `16px 22px minmax(0,1fr) 46px 112px 72px 52px`, 40 px rows, hairlines. Also:
  - The `ProjectLevel` header has a "Project page" button that calls `openProject`.
  - A decision row calls `openFollowUps('record', record_sha256, title)`, and a follow-up row calls `openFollowUp(item_id, item)`.
  - My projects keeps sidebar order until every read has settled or 1.5 s has passed, whichever is first. It then sorts by health (off, risk, on) and then by needs.
- [ ] **Step 4: Run** the screens tests, `home.test.ts` and `sidebar.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(desktop): Home altitudes in one row style`.

### Task 4: Escape, fixtures and end-to-end

**Files:**
- Modify:
  - `src/renderer/main.tsx`, `back()`: before `if (state.route.page !== 'home') return goHome();`, add `if (state.route.page === 'home' && zoomOut()) return;`
  - `src/host/test-authority.ts`: a new mode `altitude`.
- Create: `test/e2e/home-altitude.spec.ts`

**Interfaces:**
- Consumes: `zoomOut`.
- Fixture mode `altitude`, with item times relative to `Date.now()` in the host process:
  - **Thermostat redesign** (off track):
    - Mina owns an open ticket sent 9 d ago;
    - an unsent action created 2 d ago has `owner.match: 'approver'` (no owner);
    - Rafael owns a done action.
  - **Supplier review** (at risk):
    - Rafael owns an open page sent 4 d ago;
    - Ari owns an open action sent today.
  - All are readable, with decisions in their projects.
- Tests:
  1. Home opens on Me. `needs` or `home-clear` shows as today, `alt-stops` shows, and `alt-me` has `aria-pressed=true`.
  2. The My projects stop shows two rows, Thermostat first, under "Off track" with needs `2` and wait `9d`. Supplier review is under "At risk".
  3. Clicking Thermostat shows `alt-project-level` with groups `decisions`, Mina's, `none` and Rafael's. Escape (with an empty bar) returns to `alt-projects`.
  4. Clicking Mina's group header shows `alt-person-level` with one Thermostat group.
  5. Typing `x` in the Ask bar then pressing Escape on the Project altitude clears the bar and stays on Project (Review Focus 4).
  6. Opening a project from the sidebar and then Home returns to the last altitude.

- [ ] **Step 1: Write** `home-altitude.spec.ts` with the six tests, using `launch('altitude')`.
- [ ] **Step 2: Run** `npm run build && npx playwright test test/e2e/home-altitude.spec.ts` (sandbox off). Expected: FAIL.
- [ ] **Step 3: Implement** the fixture mode and the `back()` line.
- [ ] **Step 4: Run** the spec. Expected: 6 passed. Then run all e2e: `npx playwright test`. Expected: 221 passed (215 + 6).
- [ ] **Step 5: Commit** `test(desktop): Home altitudes end to end`.

### Task 5: Docs and evidence

**Files:**
- Modify: `product/echo-desktop/README.md`, the Home section (around line 119): one paragraph on altitudes, stops, Escape and pinch.
- Modify: `docs/product/2026-10-29-home-altitude-v1.md`, Status, to "built on feat/home-altitude; the founder validates on the desktop".

- [ ] **Step 1:** Write both edits.
- [ ] **Step 2:** Take light and dark screenshots of each altitude from the e2e fixture (Playwright `page.screenshot` in a throwaway script, not committed) for the PR.
- [ ] **Step 3: Commit** `docs: Home altitudes`.
