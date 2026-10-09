# Open items and Home v1

Status: designed with the founder on 2026-10-08 and approved by the founder the
same day; rulings 18–23 were added while planning. Decision record:
[ADR-0033](../decisions/ADR-0033-shared-open-items.md). Builds on
[runs store and impact card v1](2026-10-07-runs-store-and-impact-card-v1.md),
[unified meeting approval v1](2026-10-07-unified-meeting-approval-v1.md) and
the [research trigger contract v1](2026-10-06-research-trigger-contract-v1.md).
Design canvas, row 9:
https://claude.ai/code/artifact/ffa8478f-578d-40d0-bc7a-578a66f4adb0.
Implementation plan: `docs/superpowers/plans/2026-10-08-open-items-and-home.md`.

## Goal

ECHO keeps one shared, company-level state of what a decision still needs:
what is affected, who it waits on, at which stage, and for how long. Nothing
a decision affects may sit invisible because nobody was linked to it. Home
shows each person only what waits on them.

End state: approve a meeting → ECHO checks what it changes → the affected
items appear in the project, unsent → the approver sends them to their owners
→ each owner sees their item on Home and marks it done → ECHO re-checks open
items and shows what landed.

## Product rules this design follows

- **Coordination, not execution.** ECHO says what is affected and who should
  act. It never edits Jira, Confluence or Slack.
- **One shared state.** Each affected item is one row that everyone involved
  sees. A click by one person is what everyone else sees next.
- **Nothing invisible.** An item exists in the shared state from the moment
  ECHO finds it, always with a named person on it.
- **Status is written only by a person's click.** A check pre-ticks and flags;
  it never closes or opens anything.
- **Never show more than the company's own permissions allow.** Who sees a
  row follows the decision's audience; who sees an outside item's words
  follows that tool's own permissions, checked live.
- **No copies of outside text.** Rows keep pointers and ECHO's own lines;
  titles and text are read again with the viewer's access on every view
  (ADR-0032).

## The shape

```
approval published
   └─ impact run (pending) ── approver's desktop starts it ──► research
        └─ run done: impact card stored + one open item per affected item (unsent)

Send (approver) ──► items open, each with an owner; unticked → not relevant
Home (each person) ◄── rows that wait on them: Send, Update, Check
Sweep (any desktop) ──► re-reads open items ──► last check on each item
Done / Not relevant (approver or owner) ──► item closed
```

## 1. Stages

Every follow-up of a decision is in exactly one stage. The first three stages
live in existing tables; the rest are open items.

| Stage | Waits on | Who can see it | Stored in |
| --- | --- | --- | --- |
| Meeting waiting for approval | the reviewer | the reviewer only | approval proposals (ADR-0030, ADR-0031) |
| Approved, check not run yet | the approver opening ECHO | anyone who can read the decision | runs |
| Check failed | the approver (Try again) | same | runs |
| Found, not sent | the approver (Send) | same | open items: `unsent` |
| Sent, open | the owner (Done) | same, plus the owner | open items: `open` |
| ECHO saw it change, not as decided | owner or approver (Check) | same | open items: `open`, last check `changed` |
| ECHO saw it land, not closed | owner or approver (Mark done) | same | open items: `open`, last check `landed` |
| Closed | nobody | same | open items: `done` or `not_relevant` |

A meeting nobody has approved stays private to its reviewer, as today.

## 2. Storage (Authority baseline V13)

One new table and changes to the runs table, in a new baseline V13. The
Authority has one baseline and no migrations; V13 replaces V12 and staging is
reset (the founder confirmed all current data is disposable).

### Runs (`authority_trigger_runs_v1`, changed)

| Change | Meaning |
| --- | --- |
| `trigger` | `approved_record` or `sweep`. |
| `record_sha256` | Required for `approved_record`, empty for `sweep`. |
| `scope_kind`, `scope_id` | Sweep only: `mine` (no id), `record` (a record hash) or `project` (a project id). |
| `event_ref` | For a sweep, `sweep_<uuid>`. |

Everything else in ADR-0032 stays: start, lease, attempts, failures, one live
run per person, a frozen `done` row, no deletes.

### Open items (`authority_impact_items_v1`, new)

One row per affected item, written when its impact run finishes.

| Column | Meaning |
| --- | --- |
| `item_id` | `itm_<uuid>`. |
| `run_id` | The impact run that found it. |
| `item_key` | Hash of the pointer's kind and primary id (the existing `PRIMARY_ID` rule): the same ticket has the same key. `UNIQUE (run_id, item_key)`. |
| `pointer_json` | How to open the item again: the stored citation pointer, no text. |
| `record_sha256` | The approved record (the decision). |
| `organization_id` | |
| `approver_principal_id`, `approver_membership_id` | The run's actor. |
| `relation` | `conflicts`, `needs_updating`, or empty when the card was not assessed. |
| `expected` | ECHO's short phrase (at most 120 characters): what the decision requires of this item, written from the decision (section 3). Empty when not assessed. |
| `owner_membership_id` | The person it waits on. Never empty: the matched owner, or the approver. |
| `owner_match` | `jira_account`, `name`, `picked`, `approver` (no match), `reassigned`. |
| `owner_set_by`, `owner_set_at` | Who last picked or reassigned the owner, and when. |
| `state` | `unsent`, `open`, `done`, `not_relevant`. |
| `state_set_by`, `state_set_at` | Who last clicked, and when. |
| `sent_at`, `send_command_id` | Set by Send. |
| `checked_verdict` | Latest check: `landed`, `still_open`, `changed`, `unreadable`. |
| `checked_by`, `checked_at`, `checked_run_id` | Who ran the latest check, when, and which sweep. |

A check keeps only its verdict. ECHO's sentence about what an item says now
summarizes outside text, which no stored row keeps (ADR-0032); a view shows the
item's current details from a live read instead.
| `created_at`, `updated_at` | |

Indexes: `(organization_id, owner_membership_id, state)`,
`(organization_id, approver_membership_id, state)`, `(record_sha256)`.

Database rules (triggers):

- A row is inserted only for a `done` `approved_record` run with the same
  record and approver.
- Identity columns (`item_id`, `run_id`, `item_key`, `pointer_json`,
  `record_sha256`, organization, approver, `relation`, `expected`,
  `created_at`) never change; rows are never deleted.
- State moves: `unsent → open | not_relevant` only together with `sent_at`;
  after that, any of `open`, `done`, `not_relevant`; never back to `unsent`.
- A last check is replaced only by a newer one (`checked_at` increases).

The database keeps structure only. Who may click is the access policy's call
(section 4), so it can change without a new baseline.

### Who is linked to an item

- Every item has the approver and an owner. The owner is never empty.
- If the owner's membership is no longer active, the item counts as the
  approver's. If the approver's is not active either, it shows on the Home of
  the leads of the decision's projects, who act by reassigning it. A decision
  in no project has no one to fall back to (see "Not in this round").
- These fallbacks are read at view time; nothing is rewritten when someone
  leaves.

## 3. The impact run, changed

The impact-card renderer also writes, for each `conflicts` or
`needs_updating` item, an `expected` phrase of at most 120 characters: what
the decision requires of the item, in the decision's terms ("launch next
week", "two decimals from DVT"), never what the item says now ("due Oct 30").
Rows show it beside the item's live details ("due Oct 30 → next week"). It
passes the same screens as the card's other lines: no instructions or
suggested edits, no ownership claims, and every outside title replaced by "a
cited item". Because it is written from the decision, anyone who can read the
decision may see it.

When the run finishes, in the same transaction that stores the card:

- One open item per affected row whose relation is `conflicts` or
  `needs_updating`, or that was not assessed. `confirms` rows make no item:
  they already agree.
- **Owner matching**, exact only:
  - A Jira assignee: the run reads the affected tickets' assignee account ids
    in one bulk read with the approver's Jira connection. The owner is the
    one active member whose active Jira connection has that account id on the
    same site. Account ids never reach a model, an item's details or an API
    response; the research desk is unchanged.
  - An owner on an ECHO record's action: the one active member whose display
    name equals it, ignoring case and extra spaces. Two or more such members,
    or none, is no match.
  - No match, or no owner: the approver, with `owner_match = approver`.
- All items start `unsent`.

The card itself is kept as today. Its `view` is open to anyone who can read
the decision (it was approver-only), rebuilt with the viewer's access.

## 4. Who sees what

These are this round's rules, not the final ones: the founder wants a
foundation to build on once the business rules inside an organization are
clearer. So every decision below is made in **one access policy**, pure
functions next to the open-items service:

```
policy(viewer, item, facts) → { see_row, see_decision, see_outside, set_state, assign }
send_policy(viewer, run)    → { send }   (its approver, while they can read the decision)

facts: can the viewer read the decision now; can they open the item now;
       the viewer's roles in the decision's projects; whether the approver
       and the owner are still active members
```

Every operation calls them, and nothing else decides access. A later rule (an
organization admin, an org-wide view, delegated roles, a team lead seeing
their reports' items) is a change to these functions and their inputs, not to
the table or the queries. The stored facts (approver, owner, how the owner was
matched, who clicked and checked last, the decision) are what such rules will
need.

One part is not a business choice and stays strict: an outside item's words
are shown only to a viewer who can open it live (ADR-0032, Slack's API terms).

**Rows.** A person sees an item when they can read its decision (the same
exact check the record reader uses), or when it was sent to them as owner.

**Parts of a row.**

| Part | Shown to |
| --- | --- |
| The decision: its title, first decided line, approval time and projects | viewers who can read the decision (`see_decision`) |
| `expected`, owner, approver, stage, age | everyone who sees the row |
| Last check: verdict and time | everyone who sees the row |
| Item title, what it says now, its current assignee, status and due date | only viewers who can open the item in its tool right now (live read) |

Each row says how its live read went for this viewer (`reach`): `opened`, or
why there are no live details. `no_access`: the viewer's own access refused
the item. `unavailable`: the read failed for any other reason (the tool was
down or rate limited, a read timed out, or the request's final access check
failed), which says nothing about access. `not_read`: no read was tried in
this request. A viewer who cannot open the item sees "A Jira ticket you can't
open" (or page, or Slack message) with the rest of the row; an outage is
never shown as lost access. An owner who cannot read the decision sees their
item, its `expected` line and who sent it, never the decision itself: Send is
the approver's choice to tell them.

There is no organization-wide view and no count that includes rows the viewer
cannot see.

## 5. Send, Update, reassign

**Send** (approver). After the run finishes, the approver's Home shows a Send
row. The Send card lists the run's items, all ticked, each with its owner.
Where `owner_match = approver`, the owner slot is a small "Pick a person"
search over active members (the people directory, ADR-0016); left unpicked,
the item stays with the approver. "Send to <owners>" moves ticked items to
`open` and unticked ones to `not_relevant`, in one transaction, once per
`command_id`. "Not now" closes the card; the row stays.

A finished run that found no items makes no row. A failed run is a row with
its reason and "Try again".

**Update** (owner). Each owner gets one row per item sent to them: the item as
they can see it, the `expected` line, "Open in Jira" (or the tool), and Done.
Done sets `done`. The approver can also set `done` or `not_relevant` on items
they do not own.

**Reassign.** The approver, the current owner or a lead of one of the
decision's projects can change the owner with the same picker
(`owner_match = reassigned`). The new owner gets an Update row.

## 6. Sweep

A sweep is a run with `trigger = sweep`: same start, lease, attempts and
storage rules. It acts as the person who asked, with their access.

- **What it covers.** `mine`: open items the caller sent or owns. `record` or
  `project`: open items there that the caller can see. At start, the server
  takes up to 20 of them, oldest last check first (never checked first); the
  rest wait for the next sweep.
- **Findings.** For each item: what was decided (the record, when the caller
  can read it), the `expected` line, and the item pointer. The existing
  `sweep` trigger definition turns these into the brief; the items are read
  again fresh, and an item that cannot be read is reported, not fatal.
- **Sweep renderer** (new). For each item: `landed`, `still_open`, `changed`
  or `unreadable`, and one ECHO line, under the same screens as the card
  (titles replaced, no instructions, no ownership claims). The line serves
  the evaluation and the staging endpoint; the product stores only the
  verdict.
- **Finish.** In one transaction, each item's last check is replaced if this
  one is newer and the caller can still see the item. The run's stored result
  is the counts by verdict. A sweep never sets `state`.
- **When it runs.** Home reports `sweep_due` when the caller has open items
  they sent or own whose last check, by anyone, is older than 24 hours, and no
  sweep of theirs is pending or running. The desktop then asks for a `mine`
  sweep and starts it after any pending impact runs. "Check now" on a record
  or a project asks for a sweep of that scope. A second request for the same
  scope while one is pending returns the pending run.

Because the last check is shared, one person's sweep refreshes the item for
everyone; another desktop skips items checked in the last 24 hours.

**What opening ECHO costs.** An impact check runs once per approval; a sweep
at most about once a day per person with stale items, and not at all if a
teammate's desktop checked them that day. Opening ECHO with nothing waiting
makes no model call. Estimated, not yet measured: a background run is two to
five Asks' worth of model work (a measured Ask is about 6 calls, about $0.003
on DeepSeek V3.2 and $0.023 on Gemini 3.8 Flash), so a 10-person team with 15
approvals a week runs about 65 runs a week, roughly $1 a week on DeepSeek or
$3 to $8 on Gemini Flash. Jira and Confluence rate limits are the tighter
limit: each run makes a dozen or more reads as one person.

## 7. API

All on `POST /v1/person/runs`, one envelope `{schema_version: 1, operation,
…}`. Existing operations keep their shapes; `list` also returns sweep runs.

| Operation | Input | Result | Allowed |
| --- | --- | --- | --- |
| `view` | `run_id` | card (unchanged shape) | anyone who can read the decision (was: approver only) |
| `home` | — | Send rows; the open items that wait on the caller (Update, or Check once their last check is `changed`) and open items the caller sent whose last check is `changed`; `landed`, `waiting`, `last_checked_at`, `sweep_due` | the caller's own |
| `items` | `scope: mine \| run \| record \| project`, `id?`, `cursor?`, `summary_only?` | unsent, open and closed items the caller can see, 50 per page, oldest first; a summary of the whole scope (counts by state and last check, decisions, latest check, and per decision its open count); and each decision's impact run stage. With `summary_only: true` (never with `cursor`): the summary and stages only, no items and no live reads | per section 4 |
| `item` | `item_id` | one item rebuilt for the caller | per section 4 |
| `send` | `run_id`, `command_id`, `items: [{item_id, include, owner_membership_id?}]` | `{sent, not_relevant}`; a `command_id` already sent answers what it did, before any other check; items that changed since the card was drawn answer `conflict` and nothing is written | the approver, while they can read the decision |
| `set_state` | `item_id`, `state: open \| done \| not_relevant` | `{state}` | the approver or the owner |
| `assign` | `item_id`, `owner_membership_id` | `{owner}`; the item's current owner writes nothing | the approver, the owner, a lead of the decision's projects |
| `sweep` | `scope: mine \| record \| project`, `id?` | `{run_id}` or `{state: 'nothing_to_check'}` | anyone, over items they can see |

Every item read rebuilds outside parts with one live open per item shown, at
most 50 per call. A row's own fields never include a word read from outside
ECHO. Each item carries `reach` (section 4), and `current` exactly when it is
`opened`. A refusal by the viewer's access (`unauthorized`, `not_found` or
`stale_access_state` from the desk, an empty read, or a read of another item)
is `no_access`; every other failure, including a desk that cannot be bound or
a final access check that fails, is `unavailable` and is reported as a
content-free observation (`open_items_live_read` with where it failed and the
error's code, never an id, a title or outside text), as is a stored card whose
first decided line cannot be read. The project and Impact lines ask for
`summary_only`, so showing a count opens nothing in Jira or Confluence.

`meetings.reviews` rows (and `review_open`'s review) gain `first_line` (the
proposal's first decision, else its first action; ECHO text), `action_count`
and `meeting_at` (when the meeting started, when known), so a Home row names
the decision, not only the meeting. Pending rows already carry the suggested
projects in `project_ids`.

## 8. Desktop

The design is the canvas's row 9 (artboards 9.1 to 9.7); copy below is
quoted from it where it gives one.

**Home (9.1, 9.5)** shows only rows that wait on the viewer, under "Needs you
· N". Each row is a verb, a title, a muted line, and on the right its age and
its decision's first project:

| Row | From | Title / muted line | Action |
| --- | --- | --- | --- |
| Approve | `meetings.reviews` (pending) | the first decision line / "Decision · 2 actions · Pilot planning meeting, Oct 6" | opens Approve this decision? (9.2) |
| Send | `home` | "<first decided line> — 2 tickets need updating" / "Impact of Pilot planning · owners Mina, Rafael" | opens Tell the owners? (9.3) |
| Update | `home` | "<item> · due Oct 30 → next week" (live details → `expected`) / "Jira ticket you own · from Pilot planning" | inline: "Open in Jira" and Done, no page |
| Check | `home` (last check `changed`) | "<item> · <live details> — not what was decided" / "Jira ticket · now <assignee> · from Kickoff review" | opens the item: `expected`, live details, Open in tool, Done, Not relevant |
| Checking | runs `list` (pending, running) | "Approved · checking what it changes" | none; not counted in the badge |
| Check failed | runs `list` (failed impact run) | "Approved · the check did not finish" | opens the reason and Try again |

An item is at most one row per person. Its owner sees Update, or Check once
its last check is `changed`; its approver, when not the owner, sees Check only
when it is `changed`. A viewer who cannot open the item in its tool sees "A
Jira ticket you can't open" (or page, or Slack message) for its title and no
live details. An item ECHO could not read just now (`unavailable`: an outage
or a rate limit) reads "A Jira ticket ECHO couldn't read just now", and one
not read in that request (`not_read`) "A Jira ticket"; only an item ECHO
opened offers "Open in Jira". When two rows would name their buttons alike
(two items you can't open), each name adds the item's `expected` phrase. A
viewer who cannot read the decision sees "from Ari" (who sent it) instead of
the meeting.

Footer, under the rows and also on an empty Home (9.5): "2 landed since
yesterday · 1 with others · checked 2 h ago" and "Mark done" when anything
landed. "Landed" counts open items the viewer sent or owns whose last check is
`landed`; "with others" counts open items the viewer sent that wait on
someone else; parts that are zero are left out. "Mark done" opens Did it land?
for the viewer's own items. First-run Home is otherwise unchanged. The
`echo.seenImpact` browser storage goes away: a sent run leaves Home by its
items' state.

**Tell the owners? (9.3)**: "You approved Pilot planning on Oct 6. ECHO found
what it changes.", the first decided line large, a "Must change" list (one
checkbox per item, ticked: the item's title and its live details → `expected`,
and the owner as a chip, or "Pick a person" where there is no match), "Untick
anything that's wrong. Owners get it on their Home.", "Details" (the full
impact card), and "Send to Mina and Rafael" / "Not now". With no one but you to
tell, the button reads "Keep on my Home"; with nothing ticked, "None of these
need changing". When the items changed since the card was drawn (`conflict`),
nothing is sent and the card says "These items changed meanwhile. Open them
again from Home." Details waits while the card is sending.

**Did it land? (9.4)**: "<meeting> · checked just now · 3 items", the decided
line large when the scope is one decision, then "Landed · N" (ticked
checkboxes), "Still open · N" and "Couldn't read · N" ("you don't have
access"), each line with the item, its live details and its owner chip, and
"Mark N done". The canvas's "Remind" is not built: an owner already has the
item on their Home.

**Reader, an approved decision (9.6)**: an Impact line under the title,
"Impact · 1 open · 1 handled · 1 couldn't read · checked just now" (or "Not
checked yet", "Checking…", "Check failed · Try again", "Nothing to change"),
with "Send" when it waits on you and "Check now". The line reads the
decision's counts only (`items` with `summary_only`) and opens the decision's
items, which are read then.

**Project page (9.7)**: a line above the feed, "4 open items · from 2
decisions · checked today", with "Check now", and "N open" on each decision's
row in the feed. The line reads the project's counts only (`summary_only`)
and opens the project's open items grouped by owner, oldest first, each with
its stage and age.

**Runs**: `driveRuns` starts pending impact runs first, then sweeps; it asks
for a `mine` sweep when `home` says `sweep_due`.

## 9. Delivery

One pull request on top of `feat/desktop-home-redesign`, built in two parts
with a stop between them:

1. V13 baseline (all of section 2, sweep columns included), `expected` lines,
   owner matching, items at run finish, `view` for decision readers, `home`,
   `items`, `item`, `send`, `set_state`, `assign`, and the desktop Send and
   Update rows, Send card, reader Impact line and project Open items. **Stop:
   the founder tries Send → Update in the desktop against the test
   Authority.**
2. Sweep: runs dispatch, findings, sweep renderer, `sweep`, auto-sweep, Check
   rows, footer, "Did it land?", Check now, sweep evaluation cases.

## Acceptance

- An impact run's finish writes exactly one item per `conflicts`,
  `needs_updating` or not-assessed row, none for `confirms`, all `unsent`, in
  the card's transaction.
- A Jira assignee whose account a member connected is matched to that member;
  a unique exact name on an ECHO action is matched; anything else falls to the
  approver. Two members with the same name match no one.
- Someone who can read the decision sees its items, unsent included; someone
  who cannot sees none, except items sent to them; an owner never receives the
  decision itself.
- A viewer who cannot open an item in its tool gets no title, text or live
  details for it, but does get its stage, owner, age and verdict.
- No stored row holds a check sentence; a check stores its verdict only.
- Only the approver or the owner changes `state`; only the approver, owner or
  a project lead reassigns; every operation gets these answers from the one
  access policy (a test table covers each role), and the database refuses any
  move back to `unsent`.
- Send is idempotent per `command_id`; unticked items become `not_relevant`.
- When the owner leaves, the item shows on the approver's Home; when both
  leave, on the project leads' Home.
- No stored row or column holds text, a title or a name read from outside ECHO
  (a test seeds distinctive outside text and searches every new row for it).
- A sweep replaces an item's last check only with a newer one, never changes
  `state`, and skips items the sweeper can no longer see.
- `sweep_due` is true only with an open item of the caller's whose last check
  is over 24 hours old and no pending or running sweep.
- Desktop: approve in the test Authority → Send row → Send with one picked
  owner → that owner's Update row → Done → the item leaves both Homes and
  shows `done` on the project page.
- Ask goldens unchanged; `npm run check` passes.

## Not in this round

- Slack DMs to owners. Owners learn from Home only.
- Scheduled checks (founder: keep it simple for now). Checks run only from a
  signed-in desktop showing Home, so "latest" means as fresh as the last time
  someone involved opened ECHO. Two later options: a schedule in the desktop's
  background process (a fixed time while the app runs in the menu bar, the
  same access, a small change), or server-side checks for everyone, which
  need a revocable per-person "check while I'm away" grant and a security
  decision.
- More than one live run per person; sweeps queue behind impact checks.
- An organization-admin view across projects; any count that includes rows
  the viewer cannot see.
- A fallback for a no-project decision whose approver and owner have both
  left: its items stay visible to the decision's readers but wait on no one.
- Showing a pending (unapproved) meeting to anyone but its reviewer.
- History of earlier checks and clicks; only the latest of each is kept.
- Card and sweep quality: unmeasured until the approved-record and sweep
  evaluations run (research loop evaluation, S1 world state).

## Rulings

Made with the founder on 2026-10-08:

1. Owners are matched exactly: Jira account, or a unique exact name on an ECHO
   action. Otherwise the approver picks from active members on the Send card,
   and an unpicked item stays with the approver.
2. Owners learn from their Home only.
3. Check rows open the item first; there is no inline Not relevant.
4. First-run Home is unchanged.
5. One API route: everything is an operation on `/v1/person/runs`. Sweep is a
   run with another trigger.
6. One pull request, with a stop after Send and Update.
7. V13 baseline and a staging reset are fine; all data is disposable.
8. Items enter the shared state when the check finishes, not on Send. Before
   Send, everyone who can read the decision sees them in full, marked "not
   reviewed by <approver> yet". (Replaces the handoff's "approver sees the
   impact list privately".)
9. The last check is one shared value per item; the newest wins. (Replaces
   "verdicts are private to whoever swept".)
10. Rows follow the decision's audience plus the owner; outside parts follow
    the tool's access live. A viewer who cannot open an item still sees its
    verdict, never the check line. (Ruling 18 keeps no check sentence at all;
    the item's live details follow the same rule.)
11. The approver, the owner or a project lead can reassign an item at any
    time.

Carried over from the handoff: status is written only by a person's click; the
approver may close items they do not own; a sweep judges against the decision
when the caller can read it, else against `expected`; nothing stores outside
text; ECHO never edits outside tools.

Made while writing:

12. `confirms` rows make no item; not-assessed rows do, with no `expected`
    line.
13. Leaving is handled at read time: owner gone → approver; both gone →
    project leads, who act by reassigning.
14. `expected` is written from the decision, never from the item, so the
    decision's audience may see it.
15. Item reads rebuild at most 50 items per call with live reads; a project
    page with more pages through them.
16. A finished run with no items makes no Home row; a failed run keeps one.
17. Permissions are a foundation, not final (founder, 2026-10-08): one access
    policy function decides every see and act question; the database enforces
    structure only; outside words stay behind a live access check.

Made while planning, after reading the code and folding in the canvas's row 9
(founder, 2026-10-08: "fold the UI design as well"):

18. A check stores only its verdict, not a sentence: ECHO's sentence about
    what an item says now summarizes outside text, as an impact card's
    `says_now` does, and ADR-0032 keeps neither. Rows show live details.
19. Jira owners are matched by a separate bulk assignee read with the
    approver's connection at the end of the run, not by adding the account id
    to item details: those details are part of Ask's evidence and its model
    prompts, which stay unchanged.
20. Update rows act in place on Home ("Open in Jira", Done), as the canvas
    draws them; Check rows open the item first (ruling 3).
21. "Remind" on Did it land? is not built: an owner already has the item on
    their Home, and ECHO sends nothing else this round.
22. `expected` is a short phrase (at most 120 characters), so a row can read
    "due Oct 30 → next week": live details, then what the decision requires.
23. Approve rows show the proposal's first decision line, action count and
    meeting date, which the meetings API adds to its review rows.
