# One place to look (v1) Implementation Plan

> **For agentic workers:** this plan runs as four parallel tracks, each in its
> own git worktree and branch, then merged in order D → C → B → A by the
> controller. Each track works test-first (superpowers:test-driven-development).

**Goal:** Build [One place to look v1](../../product/2026-10-30-one-place-home-v1.md).
It covers:
- a clean Home, with the altitude bar in the title row, Needs you by category and the new project rows;
- the Follow-ups count and an Only me row in the sidebar;
- Follow-ups as one task list with owners;
- a quiet Only me;
- checks that keep moving on every page.

**Architecture:** Desktop renderer only (`product/echo-desktop/src/renderer`),
plus test Authority fixtures and tests. No server, contract or schema change.
The base commit exports `Tile`, `FaceMark`, `NoOwner` and `KIND_ICON` from
`screens/altitude.tsx`, so tracks B and C reuse them without editing that file.

**Tech stack:** Electron 44, Preact 10, TypeScript 7, Vitest, Playwright
(fixture Authority in `src/host/test-authority.ts`).

**Spec:** `docs/product/2026-10-30-one-place-home-v1.md`. Read it first. It is
the binding authority, and this plan argues from it.

**Code map:** `/Users/zhenye/Desktop/echo-brain/.worktrees/home-altitude/.superpowers/sdd/2026-10-30-one-place-home/map-<area>.json`
(`home`, `sidebar`, `followups`, `onlyme`, `runs`). Each map gives every code
site with file:line, what it does today and what it needs, and every test that
breaks. Read your track's maps before you write code.

## Global constraints

- Desktop only. Do not edit `packages/`, `services/`, `src/` (repo root) or
  any server contract.
- Orange (`--signal`, `--signal-text`) means "needs attention" only. Counts of
  what others owe you are grey (`--faint`). No red, amber or green.
- Every row opens what it opens today. Every action that exists today keeps
  working: send what is ticked, Dismiss, pick an owner, Check now, Retry, More,
  Approve, Try again.
- Reuse what exists: `altitude.ts` (`needsAttention`, `waitedDays`, `unowned`,
  `rollup`), `needs.ts`, `format.ts`, and the exports from
  `screens/altitude.tsx`. Match the surrounding code's naming, comment density
  and idiom.
- New CSS goes beside its area's existing rules: `.alt-*` and `.needs-*` for
  A, the follow-up list rules for B, `.only-me` / `.item-row` for C. Never
  append it at the end of `styles.css`, and never reuse the global `.row`,
  `.name`, `.meta`, `.mark` or `.more`.
- New fixture modes in `test-authority.ts` go next to related modes, never at
  the end of the file.
- Light and dark themes both work, using tokens only.
- Commit messages: `type(desktop): …`, ending with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Commands, from `product/echo-desktop`:
  - typecheck: `npm run typecheck`;
  - one unit file: `npx vitest run test/unit/<file>`;
  - e2e: `npm run build && npx playwright test test/e2e/<spec>`;
  - the whole desktop suite: `npm test`.
  Before you report, the whole desktop suite must be green on your branch.

## Rulings (the controller's answers to the map's open questions)

### Home

- **H1. The category list is Home state, not a route.** Add
  `altitude.category: 'approve' | 'retry' | 'send' | 'update' | null`; the
  level stays `projects`. The title row's left back slot shows "Home", and the
  centre shows the bar with My projects lit. Esc, ‹ Home and the sidebar's
  Home row clear the category.
- **H2. The sidebar's Home row opens the top level:** level `projects`,
  `category: null`, reads kept. Back from a decision or item page, and
  Approve, still return to Home as it was left, so they land on an open list.
- **H3. When a category empties while its list is open, the list closes by
  itself.** When one row remains, the list stays.
- **H4. "Newest" and age per category:**
  - Approve: the server's order; the first row is the newest. Its age comes
    from `meeting_at` when present, otherwise none.
  - Send: `finished_at`.
  - Update and Review: the latest of `sent_at`, `owner_set_at`,
    `state_set_at` and `created_at`.
  - Retry: the run's time.
  - Ages use Home's short form (`2h`, `3d`).
- **H5. Remembered altitude goes.** Delete the `echo.home.altitude` read and
  write, and remove the old key once, best effort. Relaunch and an account
  switch open the top level.
- **H6. Need rows and category lines join ↑/↓ with the project rows**
  (`data-alt-nav`).
- **H7. Escape on Follow-ups and Only me works as today** (it goes Home as
  Home was left). Only their back link goes.

### Sidebar

- **S1. Follow-ups' count is `state.home.open.waiting`**, grey, hidden at 0.
  Its accessible name is "Follow-ups, N waiting on others", with the same
  hover. Off Home it shows the last value read, the same limit Home's badge
  has today.
- **S2. Only me row:** the `Lock` icon, under Follow-ups. A drop on it goes
  nowhere (`noDrop`). It is lit on `only-me`, and Home is no longer lit there.
- **S3. Only Follow-ups and Only me lose the "Home" back link.** Tools,
  People and project pages keep theirs.
- **S4. "ECHO checked …" moves to the Follow-ups page (track B).** Track B
  reads it from `homeFooter(state.home?.open ?? null).checked`. Track A must
  not delete `homeFooter` or `checkedAgo` from `needs.ts`.

### Follow-ups

- **F1. Every follow-up list takes the new rows:** your follow-ups, a
  project's, a meeting's and a notification's. The owner line shows when the
  list has rows for two or more owners (No owner counts as one).
- **F2. Order:**
  - Active rows (unsent and open) first: those that need attention, oldest
    wait first, then the rest, oldest wait first.
  - Then the closed folds, Done and Dismissed, each its own fold as today.
- **F3. Owner line counts and filter:**
  - A face's count is that owner's open rows among the rows read.
  - "You" is the viewer's face, labelled "You".
  - "No owner" covers rows today's list marks as unmatched (`ownerUnmatched`,
    and the Pick owner affordance).
  - Order: owners with something needing attention first, then by name; No
    owner last.
  - A filter shows all of that owner's rows, active and closed.
  - The filter lives in `FollowUpList`, so it survives opening an item and
    coming back, and is reset when the list is opened afresh.
- **F4. Ticking and filters:** changing the filter unticks rows it hides, so
  Send and Dismiss act only on what you can see. The checkbox stays on
  sendable rows, just before the state mark.
- **F5. Row:**
  - state mark: dashed ring unsent, ring open, tick done, dimmed dismissed;
    orange ring when `needsAttention`, solid orange when it waited over 7
    days;
  - the title, as `itemTitle` gives it today, live parts included;
  - the owner's face and first name, dimmed while unsent; Pick owner when
    unmatched;
  - the project tile, when the row has a decision with projects;
  - the age, as days from `waitedDays`, or from `created_at` for closed
    rows.
  Kind, source meeting and history go in the row's hover. No page heading,
  no cards.

### Only me

- **O1. Only me gets its own row component.** `ItemRow` and the project
  feed / Granola list stay unchanged.
- **O2. Age:** today it is the time (`10:12`). Under 7 days it is `Nd`. Older
  it is `Sep 18` (`monthDay`).
- **O3. Project tiles:** look up each filed name in `altitudeProjects(state)`
  by exact name. A unique match takes `identity(project_id)`. An unknown or
  duplicate name gets a neutral tile. Show at most 3 tiles, then `+N`. Hover
  names them all, and the aria-label says them.
- **O4. Kind mark:** note, meeting or file (shape) in grey. The tooltip has
  the kind and, for a document, its type and size.

### Checks keep moving

- **R1. Checks keep moving while signed in and ECHO is running**: window in
  front, covered, or closed to the tray. Nothing runs once ECHO quits.
  - This replaces the spec's "covered" wording.
  - Doc call 9 is updated: "keep moving while ECHO is running, even with the
    window closed to the tray."
- **R2. Pace:** today's 5 s while something is queued or running, with
  today's back-off. `resultOwed` counts as in flight only while Home shows.
- **R3. The off-Home driver does not write Home state.** It keeps its own
  runs snapshot, and Home reads its own as today.
  - Home's own runs reads and the driver never double-start. One in-flight
    start at a time.
  - It is fenced by `expect()` and an account token, as today.
- **R4. Kick triggers:** sign-in, coming back, an approval (the reviews area
  moving), a start finishing, and Try again or Check now.
  - It does not run on every change check.
  - It honours Home's failed-tools hold: "starts no run until Try again".

## Review focus

The five failure modes most likely to bite, which every track's tests must
cover where they own the code:

1. **A meeting lands while you are on Home:** it shows at once by name.
   - Track A: a fixture with one approve shows the row itself.
   - With two, it shows one line with "and 1 more". The badge equals Needs
     you N.
2. **A category list empties while it is open**, and a relaunch while a list
   or zoom was open. Track A: it goes back to the top, and relaunch opens the
   top.
3. **The owner filter with ticked rows, paging and an item round trip**
   (Track B). Send never acts on hidden rows. The filter survives opening an
   item and pressing Back.
4. **Checks start while another page shows or the window is covered**
   (Track D).
   - An approved meeting's queued check starts on Follow-ups.
   - No double start when Home is opened mid-run.
   - An account switch stops the driver.
5. **Only me with an item in two projects, and with an unknown project name**
   (Track C): tiles plus a hover naming both; a neutral tile.

---

## Track A: Home, title row, sidebar

**Worktree:** `/Users/zhenye/Desktop/echo-brain/.worktrees/oph-home`, branch
`feat/oph-home`.
**Maps:** `map-home.json`, `map-sidebar.json`.

**Owns:**
- `screens/home.tsx`, `screens/altitude.tsx` (Stops, MyProjects; leave
  ProjectLevel and PersonLevel as they are), `screens/sidebar.tsx`,
  `main.tsx`;
- the altitude, home and goHome parts of `store.ts`, and `applyStatus`'s
  recall line;
- `forgetAccount`'s altitude lines; the `.alt-*`, `.needs-*`, `.home` and
  sidebar CSS;
- `test/unit/altitude*.test.ts`, the Home and sidebar parts of other unit
  tests, `test/e2e/home-altitude.spec.ts`, and every e2e assertion on Home's
  footer, ⌖ / `alt-me`, the "ECHO" title, `needs-group` / `needs-more`, the
  sidebar rows, and remembered altitude.

**Builds:**
1. The `'me'` level goes (`AltLevel` = `projects | project | person`). The ⌖
   button goes. `Stops` renders in `main.tsx`'s title row on Home in place of
   "ECHO". Other pages keep their title.
2. Home's top level: Needs you by category, then Projects in variant B rows,
   with no footer. Spec "Home: Needs you" and "Home: Projects", rulings
   H1–H6. Category helpers (`categoryOf`, `homeCategories`) sit beside
   `needRows` in `store.ts`. `homeGroups` and the GROUPS grouping are
   replaced by categories.
3. The category list as Home state (H1–H3), with auto-close.
4. Remembered altitude removed (H5). The sidebar's Home row opens the top
   (H2).
5. Sidebar: the Follow-ups count (S1), the Only me row (S2), Home lit only on
   `home` and `decision`. `main.tsx`: no back link on Follow-ups or Only me
   (S3).

**Tests (write the failing test first for each):**
- **unit:**
  - `categoryOf` and `homeCategories`: the order, newest and age per H4;
    Checking never counted;
  - auto-close when the list empties, but not while one row remains;
  - the project reason line, the bar and the oldest wait;
  - the top-level default with no localStorage;
  - the sidebar count hidden at 0, grey, and its label.
- **e2e (`home-altitude.spec.ts` plus updates):**
  - one Approve row shows as a row; two show as one line, which opens the
    list; Esc and ‹ Home come back;
  - the list auto-closes after the last row is dealt with;
  - the bar is in the title row, there is no ⌖, and there is no "ECHO" title
    on Home;
  - Nothing needs you shows the projects below;
  - the sidebar count, the Only me row lit on Only me, and no back link there;
  - relaunch opens the top.

## Track B: Follow-ups

**Worktree:** `/Users/zhenye/Desktop/echo-brain/.worktrees/oph-followups`,
branch `feat/oph-followups`.
**Map:** `map-followups.json`.

**Owns:**
- `screens/follow-ups.tsx`, and the follow-up list parts of `store.ts`
  (`FollowUpList`, list reads, ticking, the owner filter);
- new pure helpers in `needs.ts` (do not change `homeFooter`);
- the follow-up list CSS;
- `test/unit` follow-up list tests, and e2e assertions on the list's
  structure (`open-items.spec.ts` list parts, `impact.spec.ts` list parts, and
  any other spec that checks list headings, groups, cards or chips).

**Builds:**
- spec "Follow-ups (K)", rulings F1–F5 and S4;
- the owner line with a filter;
- the new row with state mark, owner and tile;
- the folds;
- "ECHO checked …" faint under the list on your follow-ups page.

**Tests:**
- **unit:** ordering (F2); owner counts and the No owner rule (F3); unticking
  on filter (F4); the state mark and its orange rule (F5).
- **e2e:**
  - the owner line filters and shows counts; the filter survives an item round
    trip;
  - Send after filtering sends only the visible ticked rows;
  - the folds open; a meeting's list keeps send ticking; Pick owner still
    works;
  - "ECHO checked" shows on Follow-ups.

## Track C: Only me

**Worktree:** `/Users/zhenye/Desktop/echo-brain/.worktrees/oph-onlyme`, branch
`feat/oph-onlyme`.
**Map:** `map-onlyme.json`.

**Owns:**
- `screens/only-me.tsx`, plus a new row component, either in that file or in
  a new `screens/only-me-row.tsx`;
- the Only me CSS;
- `test/e2e/only-me.spec.ts` assertions on the page's rows, and the
  `only-me` fixture;
- not the sidebar assertions (Track A).

**Builds:** spec "Only me (I)", rulings O1–O4.

**Tests:**
- **unit:** the age (O2) and the tile lookup (O3: unique, unknown, duplicate,
  more than 3).
- **e2e:**
  - the rows show a kind mark, the title, tiles and the age, with no boxed
    icon;
  - a filed row's tile hover names its project; an item in two projects shows
    two tiles;
  - More still works; rows still open the reader.

## Track D: Checks keep moving

**Worktree:** `/Users/zhenye/Desktop/echo-brain/.worktrees/oph-runs`, branch
`feat/oph-runs`.
**Map:** `map-runs.json`.

**Owns:**
- the run driver in `store.ts` (`runToStart`, `pollRuns`, `driveRuns`,
  `stopRunPolling`, and the kicks);
- `applyStatus`'s run kick, and `forgetAccount`'s run lines;
- run tests (`impact.spec.ts` run parts, unit run tests).

**Builds:** spec "Checks keep moving", rulings R1–R4. Also update the spec's
call 9 wording per R1, in
`docs/product/2026-10-30-one-place-home-v1.md`.

**Tests:**
- **unit:** the start rules (one at a time, impact before sweep, the failed
  hold); `resultOwed` only on Home; the account switch stops it.
- **e2e:**
  - after approving, open Follow-ups at once: the queued check still starts
    and finishes;
  - concealed (window covered or closed to the tray): it still starts;
  - opening Home mid-run makes no second start.

## Merge (controller)

1. Merge D, C, B, then A into `feat/one-place-home` with merge commits, and
   resolve conflicts.
2. `npm test` in `product/echo-desktop`, then `npm run check` at the repo root.
3. Adversarial review workflow, then fix rounds until no Important findings
   are left.
4. Screenshots, then a draft PR. Then the cleanup pass as a stacked PR.
