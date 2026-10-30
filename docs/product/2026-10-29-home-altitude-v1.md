# Home you can zoom: one list from me to all my projects (v1)

Date: 2026-10-29. Status: design, waiting for the founder's approval. Desktop
only: no server, contract, or schema change. Mockups (throwaway, git-ignored):
`.superpowers/brainstorm/90909-1793339103/content/map-linear.html` is the
direction the founder picked. The earlier `zoom-options.html`,
`zoom-glass.html` and `map-visual.html` were rejected for their look but kept
the mechanism.

## What the founder asked for

On 2026-10-29 the founder compared ECHO to a company's internal dashboard.
Both exist for visibility, alignment and faster decisions. A dashboard is
built for one altitude and one fixed format, though, and someone has to keep
typing its status in. The founder's examples were a PM like Lin, who has 7
active projects and whose job is risk (is everything on track, is everyone
synced?), and an IC, who needs to know which decisions affect them and which
tasks are theirs.

What the founder decided in that conversation:

- There are no versions per role or per level. It is one ECHO, and anyone
  moves freely between altitudes.
- It works like a map. You zoom in and out, and you go to the part of the map
  you care about.
- It lives on **Home**.
- The mechanism stays:
  - altitude stops in the title bar;
  - click a row to zoom in;
  - Esc or scroll down to zoom out;
  - ⌖ jumps to your own work;
  - the keyboard works too.
- The look follows **Linear**:
  - one row style at every altitude;
  - small marks that fill up instead of words;
  - dense but calm.
- Bubbles, donut charts, link graphs and Gantt bars were rejected.
- More visuals, fewer words. Words come on hover.
- v1 is desktop only, built from data the server already sends. Two pieces are
  deferred: "seen by" (who has opened a decision or follow-up) and a Company
  level above your own projects. Both need server work.

## Goals

1. From Home, a person sees all their projects at once. They can tell in one
   glance which projects are off track, at risk or on track, and how far
   along each one is.
2. They can zoom from there into one project, then into one person, and back
   out, without leaving Home and without the page changing its look.
3. The same Home serves the PM (who starts zoomed out) and the IC (who starts
   at their own work).
4. Status is worked out from what happened (follow-ups sent, done, aging,
   unowned). Nobody types a status.

## Non-goals (v1)

- "Seen by" on decisions and "opened" on follow-ups. The server records
  neither. Later, this needs a server change plus a founder call on who may
  see whether someone else has read something.
- A Company level, other teams, or other people's projects you are not a
  member of. `/v2/person/projects` lists only your projects, and
  `/v1/person/directory` searches people, not projects.
- Any change under `src/`, `packages/`, or the Authority schema.
- Jumping to a place by typing it into the Ask bar. The mock did this; v1
  leaves "Search or ask ECHO" exactly as it is.
- Saved views, custom dashboards, filters, charts, or exports.
- Anything that writes to Jira or Confluence (founder rule: ECHO coordinates,
  it does not execute).

## Anti-goals (a failure even if it works)

- A PM mode and an IC mode, or levels that look like different products.
- A different kind of picture per level.
- Red, amber and green. The app's Signal theme has one signal colour (orange)
  for what needs you, and every kind of row is also told apart by shape.
- Rows that need reading. A row is a mark, a tile or face, a name, and
  numbers. Explanations go in the hover tooltip.
- Showing anything the person cannot already read. The app only adds up what
  the server already returned to this person.
- A status that a person sets by hand.

## Behavior

### Altitudes

v1 has four places on the map:

| Altitude | What its rows are | Grouped by |
| --- | --- | --- |
| **My projects** | your projects (the sidebar's list, not archived) | health: Off track, At risk, On track |
| **Project** | that project's decisions, then its follow-ups | a "Decisions" group, then one group per owner |
| **Person** | one person's follow-ups across your projects | project |
| **Me** | today's "Needs you" rows, unchanged | today's grouping (Decisions, To send, Follow-ups, Checking) |

A stop control sits at the top of the Home page, centered and above the rows:
▦ My projects · [project tile] Project · [face] Person, then ⌖ Me at its
right end. The title bar stays as it is today ("ECHO").

- The current stop shows its name; the others show only their mark.
- The project and person stops remember the last project and person you
  zoomed into, and are disabled until you have zoomed into one.
- ⌖ is lit while you are on Me.
- The sidebar's **Home** row opens Home at the altitude you were last on.

Moving between altitudes:

- Click a project row, or a person group header, to zoom in. Rows are buttons,
  so Tab reaches them and ↵ opens them. ↑ and ↓ move between rows while focus
  is on a row.
- Click a stop in the control to go straight to that altitude.
- **Escape** zooms out one level from Project (to My projects) and from Person
  (to Project), but only after today's Escape rules. Those rules come first:
  the caret waits in the Ask bar, so Escape clears the bar's text, then closes
  Ask, a reader, a follow-up view or a sheet. On My projects and on Me,
  Escape does nothing new. The arrow keys never zoom, because the bar owns
  them for its suggestions.
- A trackpad pinch (a wheel event with `ctrlKey`) zooms: spreading over a row
  zooms into it, pinching zooms out one level. Plain scrolling only scrolls.
- The transition is a short scale-and-fade (about 0.2 s). Reduce motion turns
  it off.

The first time someone opens the new Home, it starts at **Me**, so nobody
loses today's "Needs you". After that, Home reopens at the last altitude used
(remembered on this machine).

### One row

Every row at every altitude has the same columns, left to right:

1. **Mark**: the state, drawn as a ring or a dot (below).
2. **Identity**: a project tile, a person's face, or what a follow-up is.
   For a follow-up that is ☑ a meeting action, 🎫 a Jira ticket, 📄 a page,
   a document, or 📅 an ECHO record, the icon comes from `icons.tsx`
   (`Ticks`, a new `Ticket`, `Page`, `Doc`, `Calendar`). Hover gives
   `itemKind`'s words, such as "Jira ticket". The verbs (◆ approve, ↗ send,
   ⟲ update, 👁 review) stay Home's own on Me.
3. **Name**, then an optional short faint suffix.
4. **Needs**: an orange count, only when something needs attention.
5. **People**: up to 4 faces. An owner's face sits on a follow-up row.
6. **Progress**: a fill ring plus a percentage, or an age such as `3d`.
7. **Date / wait**: monospace and faint.

Group headers use the same left edge. A header that can zoom shows a ›.
Rows are about 40 px tall, separated by hairlines, in the Signal tokens.

### The marks

**The fill ring** (14 px, drawn like Linear's status circle) means the same
thing everywhere: it fills as work finishes.

- **Follow-up**: dashed and empty means not sent (`unsent`). An empty ring
  means sent (`open`). A full ring with a ✓, in the done colour, means done.
  Dismissed follow-ups (`not_relevant`) are not shown.
- **Project, decision, or person**: the share of their follow-ups that are
  done, shown as a pie inside the ring.

**Needs attention** draws the ring in orange. A follow-up needs attention
when:

- it is `unsent` and was created more than 1 day ago (the approver hasn't
  sent it); or
- it is `open`, and the later of `sent_at` and `state_set_at` is more than 3
  days ago; or
- it has no owner a person can act on: `waits_on` is `leads`, or ECHO fell
  back to the approver because no owner matched.

These thresholds are the builder's defaults (see the end of this doc).

**Health** is a dot computed per project from its follow-ups:

- off track (solid orange): any follow-up that needs attention is older than
  7 days, or 3 or more need attention;
- at risk (orange ring): 1 or 2 need attention;
- on track (a dot in the done colour): none need attention.

A project with no follow-ups is on track.

**Needs**: the orange number is how many of a project's or person's
follow-ups need attention.

**Hover** shows the words, for example "Off track · 2 open more than 7 days",
"3 of 7 follow-ups done", or "Sent 4 days ago, still open".

### Each altitude

**My projects.** The page header shows the level's name and three chips
(health dot plus a count). Each project row shows:

- its health dot;
- its tile and name;
- the orange needs count;
- up to 4 faces: owners of its open follow-ups, the ones needing attention
  first;
- its progress ring with %;
- how long its oldest waiting follow-up has waited (`9d`, or nothing when none
  waits). The project list carries no dates, and the open-follow-up read only
  dates decisions that still have open work, so "latest decision" would
  mislead. How long the oldest one has waited is the number a PM watching risk
  needs.

Clicking a row zooms into that project.

**Project.** The header shows the project's tile and name, a health chip and a
progress chip, plus a link to the existing project page (the feed, members
and tools). Below it are two kinds of group:

- **Decisions**: each approved decision with follow-ups in this project.
  - The ring shows the share of its follow-ups that are done, orange when any
    of them needs attention.
  - The faces are its follow-ups' owners.
  - The date is when it was approved.
  - Clicking it opens the decision as today's follow-ups list for that record
    does.
- **One group per owner.** A group's header shows the face and name, a ring
  for that person's share done, and ›, which zooms to that person. "No owner"
  is a group with a dashed orange face and cannot be zoomed into. Groups
  needing attention come first. Each follow-up row shows:
  - its fill ring;
  - what it is (the identity icon above);
  - its title;
  - ! when it needs attention;
  - the owner's face;
  - its age.

  Clicking a follow-up row opens today's item page.

**Person.** The header shows the face and name, a needs chip and a "done/total"
chip. Below it is one group per project, opening on the project tile; the
group header zooms to that project. The rows are that person's follow-ups in
that project, in the follow-up row style. This uses only projects and
follow-ups the viewer can already read.

**Me.** This is today's Home, "Needs you", unchanged in v1. It keeps:

- the same rows (approve, send, update, review, retry, checking);
- the same grouping once it is long;
- the same empty states, footer ("Your follow-ups", "Only me") and test ids.

It is already a one-line-per-row list with kind marks and project tiles, so
it reads as the same map. Restyling it into the new row grid is deferred, so
that v1 changes nothing for anyone who never zooms. Your own follow-ups across
projects are one zoom away, under your face at the Person altitude.

### Empty and loading

- **No projects:** My projects shows the current first-run empty state ("New
  project").
- **Loading:** a project row shows its name and tile at once, then fills in
  its marks as that project's counts arrive. Rows never jump order while
  loading: order is settled once all counts are in, or after 1.5 s.
- **A project whose read failed:** it shows a faint ring with a hover "Couldn't
  read just now". It never shows as on track.

## Calls made in design (the founder checks these on the desktop)

1. **Me is today's Home, unchanged.** Nobody who never zooms sees a change,
   and every existing Home test keeps holding.
2. **The stop control sits at the top of the Home page, not in the title bar.**
   The title bar keeps "ECHO".
3. **The sidebar is unchanged.** A sidebar project row still opens the project
   page (feed, members, tools), and file drops onto it still work. The Project
   altitude links to that page. Making the sidebar zoom Home instead is a
   later call.
4. **Escape zooms out only from Project and Person, after Escape's current
   jobs.** The arrow keys stay the Ask bar's. Pinch zooms; plain scrolling
   scrolls.
5. **A follow-up row shows what the follow-up is** (action, ticket, page,
   document, record), not a verb.
6. **My projects shows how long the oldest follow-up has waited, not a
   date.**
7. **Project and Person read tickets and pages live, as today's follow-ups
   list does. My projects never does.**
8. **No refresh timer.** My projects re-reads when the window comes forward or
   Home is shown again.

## Architecture

All of v1 sits in `product/echo-desktop/src/renderer/`:
`screens/home.tsx`, a new screen module for the altitude rows, `store.ts`,
`needs.ts` and `styles.css`. Host IPC stays the same unless an existing
`runs` request needs a new pass-through.

Data, all through the existing `runs` host method:

- **My projects:** one `items` request per project with `scope: 'project'` and
  `read: 'counts'`. A counts read opens nothing and reaches no live Jira or
  Confluence. The summary gives `unsent`, `open`, `done`, `not_relevant` and
  `by_decision`. Needs-attention, health and faces need item ages and owners,
  which counts don't carry, so each project also needs its non-done items as
  `read: 'rows'` with `states: ['unsent', 'open']`, paged. Both reads go out
  in parallel across projects, through the same per-account guard (`expect()`)
  and freshness rules (`freshness.ts`) as today's lists.
- **Project:** the same project's rows (all states except `not_relevant`), so
  done follow-ups count toward rings. Decision titles and dates come from each
  item's `decision` (`title`, `approved_at`), which appears only when the
  viewer can read that decision now.
  - Then, like today's follow-ups list for a project, it does one live read
    (the same `items` request without `read`, `states: ['unsent', 'open']`,
    first page) so tickets and pages get their real titles.
  - Until that read arrives, rows show `itemTitle`'s stored words faintly, as
    the follow-ups list does now (`awaitingLive`).
  - Done follow-ups are never read live.
- **Person:** the rows already read for each of your projects, filtered to
  `owner.membership_id`.
  - Its not-done rows with no live part yet are read live one by one with the
    existing `item` operation, as an ids list does today (`readOne`). At most
    20 are read; the rest keep stored words.
  - Live parts are kept by item id, as today (B1), so one read serves both
    altitudes.
- **My projects never reads live.**
- **Me:** today's `home` read, unchanged.

Refreshing follows the existing desktop refresh design
(`docs/product/2026-10-15-desktop-refresh-and-notifications-v1.md`). Home's
reads reload on the same pushes and window events Home reloads on today: the
window coming forward, waking, and coming back to Home. There is no timer in
v1 (see Known limits).

Altitude, the last project and the last person are kept in renderer state,
and the last altitude in `localStorage`. A failed or blocked read of that
storage falls back to Me.

## Known limits (v1)

- "Needs attention" is a guess from time. A follow-up the owner is quietly
  working on turns orange after 3 days. Seen-by would fix this later.
- Rings count follow-ups only. Decisions with no follow-ups don't show at the
  Project altitude: they stay on the project page.
- A person's view covers only the projects you share with them.
- Projects with many open follow-ups make My projects page through rows for
  each project. A cap per project may be needed (see below).
- My projects can go stale while ECHO stays in front. The refresh check
  watches only follow-ups you are involved in, so someone else closing or
  aging a follow-up in your project shows up when the window next comes
  forward or Home is shown again. Polling every project would multiply reads
  on the Authority, so v1 doesn't.

## Left to the builder

- Component structure and names, and whether altitude rows reuse
  `screens/items.tsx`'s row.
- The exact thresholds (1 day, 3 days, 7 days, 3 items), kept as named
  constants next to the rules (a new `altitude.ts` beside `needs.ts` is
  fine).
- A per-project row cap for the My projects read, and what to show past it.
- The animation curve, and the debounce of pinch-to-zoom.
- Tooltip wording, kept short, following `messages.ts` style.
- Tests:
  - unit tests for the health and needs-attention rules;
  - Playwright e2e for zooming in and out, the stop control, keyboard,
    first-run landing on Me, and every "Needs you" row kind still appearing
    at Me;
  - against the test Authority (`host/test-authority.ts`), extended with
    multi-project fixtures.
