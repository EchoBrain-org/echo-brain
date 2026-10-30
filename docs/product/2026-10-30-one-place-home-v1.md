# One place to look: a clean Home, and Follow-ups and Only me beside it (v1)

Date: 2026-10-30. Status: being built on `feat/one-place-home`; the founder
validates the result on the desktop. Desktop only: no server, contract or
schema change. It follows [Home you can zoom](2026-10-29-home-altitude-v1.md)
(merged as #376) and replaces parts of it, listed under "What changes from
Home altitude v1".

Mockups (throwaway, git-ignored), in
`.superpowers/brainstorm/46988-1793387354/content/`:

- `home-categories-4.html`: Home (variant E), the founder's pick for
  Needs you and Projects.
- `sidebar-closeup.html`: the sidebar rows, real size.
- `follow-ups-both.html`: Follow-ups. K is the founder's pick.
- `pages-home-style-2.html`: Only me (variant I).

## What the founder asked for

Right after Home altitude shipped to staging, the founder hit this: a meeting
landed, the sidebar's Home badge said 1, but Home opened on My projects, which
it had remembered. Nothing on the page said a meeting was waiting. It sat behind
the ⌖ ("Me") button, and only someone who designed the app knows to press it.
The founder: "it is not ideal make users go to a lot of diff tabs. can we keep
it as simple as possible".

What the founder decided, in order:

1. Keep the altitude bar ("the top scroll bar from before"), but move it into
   the title row in place of the "ECHO" title. Drop the ⌖ button: what needs
   you must be on Home with no click.
2. "home page needs to be clean not noisy and contain the most important info
   for users to decide if they want more details".
3. Needs you collapses into categories (Approve, Send, Update). A category with
   two or more opens a list. "if there is only one item in the categories just
   display it as it is like now no need to click into it". The list is a page
   of its own, not an expansion in place, because in place gets noisy.
4. Projects use the rows with a timeline and a completion rate (variant B):
   health mark, a done bar, the oldest wait.
5. "2 waiting on others · Only me" leaves Home for the sidebar: a quiet count
   on Follow-ups, and an Only me row under it.
6. Follow-ups and Only me "follow the same style as home ... less text ish
   visual". Follow-ups must show both what is open and who owns it: one list of
   tasks with each owner beside the task (K).
7. One owner per task, as in Linear and Jira.
8. "take everything we have discussed end to end. i will validate the results".
   This includes the follow-up that came out of "do we support parallel
   checkings": checks keep moving on every page, not only on Home.

## Goals

1. When something lands (a meeting to approve, follow-ups to send, an update),
   Home shows it at the top, by name, with no click. The sidebar badge and the
   page always agree.
2. Home has two things only: what needs you, and how your projects are doing.
   Each line holds just enough to decide whether to open it.
3. Follow-ups, Only me and Home read as one family: the same rows, marks,
   tiles, faces and ages.
4. Every place is one click from the sidebar. No page needs a "‹ Home" link to
   get back.

## Non-goals (v1)

- Any server, contract or schema change. Parallel checks for one person (the
  server allows one live check per person) stay server work for later.
- Several owners on one task. Splitting a shared meeting action into one task
  per person at review is later work.
- "Seen by" and a Company level (deferred in Home altitude v1, still deferred).
- Restyling the project page feed, the decision page, the item page or Ask.
- Changing what a row opens. Every row opens what it opens today.

## Anti-goals (a failure even if it works)

- Anything that needs you sitting behind a click on Home.
- A Home that changes length with how much is waiting.
- Two meanings for orange. It means "needs attention" everywhere: Home's verbs,
  late projects, late follow-ups. Counts of what others owe you are grey.
- Red, amber and green.
- Words where a mark already says it. Hover gives the words.

## What changes from Home altitude v1

- The ⌖ "Me" stop and the Me level are gone. The first stop, "My projects", is
  Home's top level and now shows Needs you above the projects.
- The stop bar sits in the title row on Home. Other pages keep their title
  there.
- Home no longer remembers the last altitude. The sidebar's Home row, a
  relaunch and an account switch all open the top level.
- My projects drops its health chips and its Off track / At risk / On track
  group bars. Order carries the grouping; a dot marks only what is not fine.
- Home's footer ("N waiting on others · Only me · ECHO checked …") is gone.

## Behavior

### The title row

- **On Home**, the title row holds the altitude bar, centred where "ECHO" was:
  ▦ My projects — project — person. It behaves as in Home altitude v1, minus ⌖:
  click a stop to go there; the project and person stops are disabled until
  you have zoomed into one.
- **On every other page**, the title row shows the page's name, as today.
  Follow-ups and Only me are opened from the sidebar, so they have no back
  link. A page reached by drilling in (an item, a decision, a category list)
  keeps its back link.

### Home: Needs you

At the top of Home's top level, under a small "Needs you N" label. N is the
same number as the sidebar badge.

Rows are grouped by what they ask of you, in this order:

| Category | Today's row kinds | Notes |
| --- | --- | --- |
| Approve | `approve` | a meeting's decisions wait for you |
| Retry | `failed` | a check that did not finish |
| Send | `send` | an approved meeting's follow-ups not sent |
| Update | `update`, `review` | a follow-up waits on you, or one you sent changed |
| Checking | `checking` | on its way: faint, never counted, never orange |

- **One row in a category:** that row, exactly as today: same words, same
  marks, same click.
- **Two or more:** one category line: the verb (orange), an orange count, the
  newest row's name, "and N more" in faint text, the newest row's age, and ›.
  Clicking it opens that category's list.
- **Checking with two or more:** one faint line ("Checking", the newest
  meeting, "and N more"). It opens nothing: there is nothing to do yet.
- **Nothing needs you:** one quiet line, "Nothing needs you". The projects
  stay below it.
- **No projects at all:** today's first-run empty state ("New project").

**A category list** is Home zoomed into one kind:

- The title row shows the bar as on Home, with "My projects" lit.
- The page shows "‹ Home" and the category: its verb and count. Below that are
  its rows, exactly as today's Needs you rows, newest first.
- Esc, "‹ Home" or the sidebar's Home row go back to the top.
- When its last row is dealt with, the page goes back to Home's top level by
  itself.
- When its count drops to one, it still shows that one row until you leave.

### Home: Projects

Under a small "Projects" label, one row per active project. Same data and
health rules as Home altitude v1 (`altitude.ts`), drawn as in variant B:

1. **Mark:** a solid orange dot for off track, an orange ring for at risk,
   nothing for on track. A project not read yet, or whose read failed, shows a
   faint ring, as today.
2. **Tile and name.**
3. **One reason, faint, only when not on track:** the oldest follow-up that
   needs attention, as "title · owner's name". For one with no owner, the
   reason is "title · no owner".
4. **A grey bar:** done out of all follow-ups (64 px, no %, hover "3 of 7
   follow-ups done"). A project with no follow-ups has no bar.
5. **The oldest wait:** faint mono days (`9d`), blank when nothing waits.

Order: off track, then at risk, then on track, as today, settled once the
reads land. Clicking a row zooms into that project, as today. Project and
Person levels are unchanged.

### The sidebar

```
⌂ Home            7      ← orange: what needs you (unchanged)
◯ Ask
⊕ Capture       ⌘⇧E
☰ Follow-ups      2      ← grey: what others still owe you
🔒 Only me               ← new row
Projects            +
…
```

- **Follow-ups' count** is the number of your follow-ups waiting on others,
  the same number Home's footer showed ("N waiting on others"). Hover says "N
  waiting on others". It is grey, never orange, and absent at 0.
- **Only me** opens the Only me page, and its row is lit while you are there.
  Home is no longer lit on Only me.

### Follow-ups (K)

One list of your follow-ups. It shows both what is open and who owns each one.

- **The owner line**, at the top: "All", then one face per owner with a count,
  then "No owner" when any has none. The count is what that person holds open
  now. Clicking a face shows only their follow-ups; clicking "All" or the same
  face again shows everything. The filter is kept while you stay on the page
  and reset when you leave.
- **One row per follow-up, active ones first, most urgent first:**
  1. **A state mark:** a dashed ring for not sent, a ring for open, a tick for
     done. Orange by Home's rule (`needsAttention` in `altitude.ts`): a ring
     when it needs attention, solid when it has waited more than 7 days.
  2. **The title.**
  3. **The owner:** face and first name. On a not-sent row the owner is dimmed
     (it is not with them yet). With no owner, an orange "Pick owner", which
     works as today's.
  4. **The project tile.**
  5. **The age:** faint mono days since it was sent, or since it was made.
- **Done** (and **Dismissed**, if any) fold into one quiet line each at the
  end, as today's closed groups do.
- No page heading and no cards. Hover gives the long words: kind, the meeting
  it came from, "Sent to Mina 4 days ago".
- Clicking a row opens the follow-up's page, as today. Everything the list
  could do before (send what is ticked, pick an owner, Check now, Retry, More)
  keeps working, in the new row style.

The same list component serves a project's follow-ups, a meeting's follow-ups
and a notification's "Changed follow-ups". They take the new rows too, so every
follow-up list looks the same. The owner line shows on every list with more
than one owner.

### Only me (I)

One flat list, newest first, of everything only you can read:

1. **A small grey kind mark:** note, meeting or file, told apart by shape. No
   boxed icon.
2. **The title.**
3. **Project tiles**, only when it is filed in a project. Hover names it.
4. **A short age:** a time for today, then `1d`, `2d`, …

"More" at the end loads older items, as today. Rows open what they open today.

### Checks keep moving

Today the desktop starts queued checks only while Home or a meeting's decision
page is showing and ECHO is in front. From v1, while you are signed in and ECHO
is open, it keeps the queue moving on every page and while ECHO is behind
other apps:

- One check at a time, oldest first, impact checks before sweeps. These rules
  are unchanged; the server still allows one live check per person.
- It polls only while something is queued or running, with today's back-off.
- It stops when you sign out or switch account, and nothing runs while ECHO
  is closed (unchanged).
- Home's own reads still happen only when Home shows.

## Calls made in design (the founder checks these on the desktop)

1. The first stop keeps the name "My projects", as in the approved mock, even
   though the top level now also shows Needs you.
2. Retry is its own category, shown only when a check failed. Review rows go
   under Update.
3. Checking with two or more is one faint line that opens nothing.
4. A category list goes back to Home by itself when it empties.
5. "ECHO checked …" (the footer's last-check time) moves to the Follow-ups
   page, faint, under the list.
6. The project reason line names the oldest follow-up that needs attention,
   with its owner.
7. Follow-ups' owner line counts open follow-ups only; not-sent ones show on
   their rows, dimmed.
8. Every follow-up list (project, meeting, notification) takes the new rows,
   not only "your follow-ups".
9. Checks keep moving while ECHO is behind other apps. They don't run while
   it is closed.

## Architecture

Desktop renderer only (`product/echo-desktop/src/renderer/`), plus the test
Authority fixtures. All data is already in the app:

- Needs you: `homeRows` / `needRows` (today's rows), grouped by kind.
- Projects: `altitude.ts` `rollup` per project, from the reads Home altitude
  v1 already makes. The reason line uses the same rows.
- The Follow-ups count: `HomeView.waiting`, from the `home` read the app
  already makes. It is kept fresh by that read's existing triggers.
- Follow-ups and Only me: their existing list reads. The owner line and filter
  work only on rows the page has already read.
- The run driver: split from Home's reads so it can run on any page. It keeps
  `expect()` account isolation and today's start rules.

## Known limits (v1)

- The Follow-ups owner line counts only rows read so far. A long list pages
  in ("More"), and counts grow as pages arrive.
- One check at a time per person (server rule), so a meeting sent to three
  projects still takes up to about 15 minutes to check.
- The Follow-ups count updates when the `home` read runs, which follows
  today's refresh triggers. It is not live to the second.

## Left to the builder

- Component and function names; whether Follow-ups and Only me rows share a
  row component with Home.
- How the category list is routed (a Home state or a route), as long as Esc,
  "‹ Home" and the sidebar behave as above.
- Tooltip wording, kept short in `messages.ts` style.
- Tests:
  - unit tests for category grouping, the reason line, the owner line, and
    the run driver's start rules;
  - Playwright e2e for Home (one row vs category, the category list and back,
    nothing-needs-you), the sidebar count and Only me row, the Follow-ups owner
    filter, Only me rows, and a check starting while another page shows;
  - every existing test that pinned the old Home footer, ⌖, the "ECHO" title
    or the old list layout, updated to the new behavior.
