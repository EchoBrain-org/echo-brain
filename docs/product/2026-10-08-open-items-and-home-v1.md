# Open items and Home v1

Status: designed with the founder on 2026-10-08 and approved by the founder the
same day; rulings 18–23 were added while planning. Implementation plan
executed; see the plan's
[As built](../superpowers/plans/2026-10-08-open-items-and-home.md#as-built)
section. Every section but Rulings describes what was built, including the
rulings made during execution that change behavior.
Decision record: [ADR-0033](../decisions/ADR-0033-shared-open-items.md).
Builds on
[runs store and impact card v1](2026-10-07-runs-store-and-impact-card-v1.md),
[unified meeting approval v1](2026-10-07-unified-meeting-approval-v1.md) and
the [research trigger contract v1](2026-10-06-research-trigger-contract-v1.md).
Design canvas, row 9:
https://claude.ai/code/artifact/ffa8478f-578d-40d0-bc7a-578a66f4adb0.
Implementation plan:
[open items and Home](../superpowers/plans/2026-10-08-open-items-and-home.md).

## Goal

ECHO keeps one shared, company-level state of what a decision still needs:
what is affected, who it waits on, at which stage, and for how long. Nothing
a decision affects may sit invisible because nobody was linked to it. Home
shows each person only what waits on them.

End state: approve a meeting → ECHO checks what it changes → the affected
items appear in the project, unsent → the approver sends them to their owners
→ each owner sees their item on Home and marks it updated → ECHO re-checks
open items and shows which match the decision now.

## Product rules this design follows

- **Coordination, not execution.** ECHO says what is affected and who should
  act. It never edits Jira, Confluence or Slack.
- **One shared state.** Each affected item is one row that everyone involved
  sees. A click by one person is what everyone else sees next.
- **Nothing invisible.** An item exists in the shared state from the moment
  ECHO finds it, always with a named person on it.
- **Status is written only by a person's click.** A check flags what matches
  and what changed; it never closes or opens anything.
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
Home (each person) ◄── rows that wait on them: Send, Update, Review
Sweep (any desktop) ──► re-reads open items ──► last check on each item
Mark updated / No change needed (approver or owner) ──► item closed
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
| Sent, open | the owner (Update, Mark updated) | same, plus the owner | open items: `open` |
| ECHO saw it change, still not matching | the owner (Update) or the approver (Review) | same | open items: `open`, last check `changed` |
| ECHO saw it match the decision, not closed | owner or approver (Close, on Your open items) | same | open items: `open`, last check `landed` |
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
| `expected` | ECHO's short phrase (at most 120 characters): what the decision requires of this item, written from the decision (section 3). Empty when not assessed, and also when the card gave no usable phrase. |
| `owner_membership_id` | The person it waits on. Never empty: the matched owner, or the approver. |
| `owner_match` | `jira_account`, `name`, `picked`, `approver` (no match), `reassigned`. |
| `owner_set_by`, `owner_set_at` | Who last picked or reassigned the owner, and when. |
| `state` | `unsent`, `open`, `done`, `not_relevant`. |
| `state_set_by`, `state_set_at` | Who last clicked, and when. |
| `sent_at`, `send_command_id` | Set by Send. |
| `send_included` | Empty before Send, then immutable: whether Send included the item. Retries return the original counts even after state or owner changes. |
| `checked_verdict` | Latest check: `landed`, `still_open`, `changed`, `unreadable`. |
| `checked_by`, `checked_at`, `checked_run_id` | Who ran the latest check, when, and which sweep. |
| `created_at`, `updated_at` | |

A check keeps only its verdict. ECHO's sentence about what an item says now
summarizes outside text, which no stored row keeps (ADR-0032); a view shows the
item's current details from a live read instead.

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
- Send records whether the item was included, matching its initial state;
  that choice, the command ID and the sent time never change afterward.
- A last check is replaced only by a newer one (`checked_at` increases).

The database keeps structure only. Who may click is the access policy's call
(section 4), so it can change without a new baseline.

### Who is linked to an item

- Every item has the approver and an owner. The owner is never empty.
- If the owner's membership is no longer active, the item counts as the
  approver's. If the approver's is not active either, it shows on the Home of
  the leads of the decision's active projects, who act by reassigning it. A
  decision in no project has no one to fall back to (see "Not in this round").
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
policy(viewer, item, facts) → { see_row, see_decision, see_outside, set_state, assign, waits_on }
decision_policy(facts)      → { see_decision }   (also asked alone: Send rows, stages, a sweep's desk)
send_policy(viewer, run)    → { send }   (its approver, while they can read the decision)

facts: can the viewer read the decision now; can they open the item now;
       the viewer's roles in the decision's projects; whether the approver
       and the owner are still active members; whether the item reached its
       owner; its state
```

Every open-items operation calls them, and nothing else decides access; the
impact card's `view` still checks the decision itself (see "Not in this
round"). A later rule (an organization admin, an org-wide view, delegated
roles, a team lead seeing their reports' items) is a change to these
functions and their inputs, not to the table or the queries. The stored facts
(approver, owner, how the owner was matched, who clicked and checked last, the
decision) are what such rules will need.

One part is not a business choice and stays strict: an outside item's words
are shown only to a viewer who can open it live (ADR-0032, Slack's API terms).

**Rows.** A person sees an item when they can read its decision (the same
exact check the record reader uses), or when it was sent to them as owner.
An item counts as sent to its owner when Send included it, or when it is open
or done after Send (an item Send left out that someone reopened).

**Parts of a row.**

| Part | Shown to |
| --- | --- |
| The decision: its title, first decided line, approval time and projects | viewers who can read the decision (`see_decision`) |
| `expected`, owner, approver, stage, age | everyone who sees the row |
| Last check: verdict, time and who checked | everyone who sees the row |
| Item title, what it says now, its current assignee, status and due date | only viewers who can open the item in its tool right now (live read) |

Each row says how its live read went for this viewer (`reach`): `opened`, or
why there are no live details. `no_access`: the viewer's own access refused
the item; this round, ECHO also refuses every Slack message it is asked to
open, whatever the viewer's Slack access (see "Not in this round").
`unavailable`: the read failed for any other reason (the tool was down or
rate limited, a read timed out, or the request's final access check failed),
which says nothing about access. `not_read`: no read was tried in this
request. A viewer who cannot open the item sees "A Jira ticket you can't
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
they can see it, what the decision needs (`expected`), "Open in Jira" (or the
tool), and "Mark updated", which sets `done`. Once ECHO saw the item change and
still not match, the row opens the item's card first, with "Mark updated" and
"No change needed" (`not_relevant`); the approver, when not the owner, then
gets a Review row for it (section 8). The approver can set `done` or
`not_relevant` on items they do not own.

**Reassign.** Once an item is sent, the approver, the current owner or a lead
of one of the decision's active projects can change the owner to another
active member (`owner_match = reassigned`) through the API and the CLI
(`assign`, `echo-brain person runs`). The new owner gets an Update row. The
desktop has no reassign control in this round (R71); its only person picker
is Send's "Pick a person".

## 6. Sweep

A sweep is a run with `trigger = sweep`: same start, lease, attempts and
storage rules. It acts as the person who asked, with their access.

- **What it covers.** Open items on a Jira ticket, a page, or an ECHO record
  or document. An item on a Slack message is left out, and the `sweep`
  trigger refuses a Slack message citation: no reader in ECHO can open one
  yet, so a sweep could only record it `unreadable` (see "Not in this
  round"). `mine`: those the caller sent or owns. `record` or `project`:
  those there that the caller can see, as `items` shows them. At start, the
  server reads the scope again and takes up to 20 items the caller still
  sees: never checked first, then the oldest last check, then the oldest
  item. The rest wait for the next sweep.
- **Findings.** One per item, in that order. A finding names the item by what
  the impact check found and its kind ("Outdated Jira ticket", "Conflicting
  page", "Affected page" when not assessed). It adds "from <decision title>"
  only when the policy shows the caller the decision (`see_decision`).
  `expected` is the item's own phrase; else, for a caller shown the decision,
  its first decided line cut to 120 characters; else "the approved
  decision". The citations are the item's pointer first, then the decision's
  record citation, again only for a caller shown the decision. So an owner
  sent an item without access to its decision never gets the decision in
  their run. The existing `sweep` trigger definition turns the findings into
  the brief; research reads the items again fresh, and an item that cannot be
  read is reported, not fatal.
- **Where research reads** (R75). A decision's or a project's sweep reads in
  one project only when every item it checks comes from a decision the
  caller is shown that is in exactly that one project, the rule the impact
  run that found the items follows. Otherwise, and for a `mine` sweep, it
  reads everywhere the caller may read, still fenced by the caller's own
  access. A narrower read would refuse an item from a decision's other
  project and store a false shared `unreadable`.
- **A finding's own items.** Its first citation, and every further citation of
  an item in an outside tool (a ticket or a page). A further ECHO record or
  document, such as the decision, is context. Own items are matched by
  identity: the same item and, for a page, the same section; the page's other
  sections stand in only when that section is gone. A new text digest,
  version or link does not matter: edited items are what a sweep checks.
- **Sweep renderer** (new). One verdict and one ECHO line per finding:
  - `unreadable` when research could not read one of the finding's own
    items. No model hears of it. A context citation that could not be read,
    such as the decision, is simply not shown.
  - Otherwise one model call judges the findings. `landed` only when the
    current items show the whole expected change; `changed` when a current
    item changed in a way that differs from it; `still_open` when nothing
    shows the change. A finding where only some of its items moved is not
    `landed`; it is meant to be answered `still_open`.
  - A finding is never judged blind. It goes to the model only together with
    all of its own items. A finding whose own items do not all fit the
    prompt, or that research holds in no form, gets no verdict (null, "Not
    assessed.").
  - A usable reply gives one verdict for each finding shown, each citing at
    least one item the model was shown. A reply that misses or repeats a
    finding, cites nothing, or has a line that fails a screen (instructions
    or suggested edits, ownership claims) is sent back once. In the repaired
    reply, a line that still fails a screen reads "ECHO withheld this line."
    and its verdict stands. With no usable reply, no finding is assessed.
  - The line is never stored or shown in the product: it serves the
    evaluation and the staging endpoint. Unlike the card's stored lines, its
    titles are not replaced. The product stores only the verdict.
- **Finish.** In one transaction with the run's finish, each finding's
  verdict becomes its item's last check when it is newer than the item's
  current one and the caller still sees the item. The policy is asked again
  who still sees each item just before that transaction, in the same
  synchronous step with nothing in between. It cannot be asked inside the
  transaction: the decision check behind it reads the person's project grants
  in a transaction of its own, and transactions do not nest. The check
  carries the time the attempt started, so a check someone else made
  meanwhile stays newer. A null verdict leaves the last check as it is: the
  item stays oldest, and the next sweep takes it first. The run's stored
  result is the counts by verdict, not assessed included, and nothing else:
  no line, title or citation. A sweep never sets `state`. With no item left
  to check at start (all closed, or out of the caller's sight, meanwhile), it
  reads nothing and finishes with zero counts.
- **When it runs.** Home reports `sweep_due` when all of these hold: the
  caller has an open item they sent or own, of a kind a sweep covers (not a
  Slack message), whose last check, by anyone, is older than 24 hours or
  missing; no sweep of theirs is running; and none of their sweeps was
  created in the last hour, whatever its state. So a sweep that keeps
  failing, or leaves items not assessed, is not asked for again on every Home
  load. A sweep left pending for more than an hour does not hold `sweep_due`
  back, so a stuck sweep cannot stop automatic sweeps. When `sweep_due` is
  true, the desktop asks for a `mine` sweep; if the stuck sweep is a `mine`
  sweep, that request returns it. "Check now" on a record or a project asks
  for a sweep of that scope, and the hour does not limit it. A second request
  for the same scope while one is pending or running returns that run.
  Impact runs start before sweeps, enforced by the server: starting a sweep
  answers `busy` while one of the caller's impact runs is pending or
  running.

Because the last check is shared, one person's sweep refreshes the item for
everyone; a person whose items were all checked in the last 24 hours is not
due a sweep.

**What opening ECHO costs.** An impact check runs once per approval; a sweep
at most about once a day per person with stale items, and not at all if a
teammate's desktop checked them that day. A sweep that fails or leaves items
not assessed is asked for again at most once an hour, and so is the next
sweep for a person with more than 20 stale items: a large backlog catches up
20 items an hour. Opening ECHO with nothing waiting makes no model call.
Estimated, not yet measured: a background run is two to five Asks' worth of
model work (a measured Ask is about 6 calls, about $0.003 on DeepSeek V3.2
and $0.023 on Gemini 3.8 Flash), so a 10-person team with 15 approvals a week
runs about 65 runs a week, roughly $1 a week on DeepSeek or $3 to $8 on Gemini
Flash. Jira and Confluence rate limits are the tighter limit: each run makes a
dozen or more reads as one person.

## 7. API

All on `POST /v1/person/runs`, one envelope `{schema_version: 1, operation,
…}`. Existing operations keep their shapes, with these additions for sweeps:

- `list` returns the caller's runs, newest first, at most 100: at most the 20
  newest sweeps, with the newest impact runs filling the rest, so however
  often sweeps run, at least 80 places stay for impact runs and their Try
  again. Each run carries `trigger`: `approved_record` or `sweep`.
- A `running` run whose lease has lapsed (its worker stopped) is reported as
  `pending`, in `list` and in the stages of `items`, because it can be
  started again; the stored state is unchanged.
- `start` claims a sweep as it claims an impact run, except that it answers
  `busy` while one of the caller's impact runs is pending or running.
- `view` of a sweep is `not_found`: a sweep has no card. `retry` of a failed
  sweep is refused (`not_found`): the next sweep replaces it.

| Operation | Input | Result | Allowed |
| --- | --- | --- | --- |
| `view` | `run_id` | card (unchanged shape) | the approver and anyone who can read the decision (was: approver only) |
| `home` | — | Send rows; the open items that wait on the caller and open items the caller sent whose last check is `changed` (the desktop's Update and Review rows, section 8); `landed`, `waiting`, `last_checked_at`, and `sweep_due` (section 6) | the caller's own |
| `items` | `scope: mine \| run \| record \| project`, `id?`, `cursor?`, `summary_only?`, `open_only?` | unsent, open and closed items the caller can see, 50 per page, oldest first; a summary of the whole scope (counts by state, open items by last check, decisions, latest check, and per decision the caller can read its `unsent` and `open` counts and, of the open ones, how many last checked `landed` and `unreadable`); and each decision's impact run stage, with `mine` when the stage's run is the caller's own (they may Send or Try again). With `summary_only: true` (never with `cursor`): the summary and stages only, no items and no live reads. With `open_only: true` (never with `summary_only`): items in state `open` only, paged the same way, with live reads for that page's items only; a `cursor` is sent with the same flag; the summary and stages still cover the whole scope | per section 4 |
| `item` | `item_id` | one item rebuilt for the caller | per section 4 |
| `send` | `run_id`, `command_id`, `items: [{item_id, include, owner_membership_id?}]` | `{sent, not_relevant}`. A `command_id` already sent answers the counts it sent, frozen at Send (`send_included`), even after later state or owner changes and after the caller lost read access to the decision. For a new command, items that changed since the card was drawn answer `conflict` and nothing is written | checked first: the run is the caller's own finished impact run, else `not_found`. A replay is answered right after that check. A new command also needs the caller to read the decision now, and each picked owner to be an active member |
| `set_state` | `item_id`, `state: open \| done \| not_relevant` | `{state}`; a click that changes nothing writes nothing | the approver or the owner, once the item is sent |
| `assign` | `item_id`, `owner_membership_id` | `{owner}`; the item's current owner writes nothing | the approver, the owner, a lead of one of the decision's active projects, once the item is sent; the new owner is an active member |
| `sweep` | `scope: mine \| record \| project`, `id?` (none for `mine`) | `{run_id}`: the caller's pending or running sweep of that scope, else a new pending one. `{state: 'nothing_to_check'}` when the scope holds no open item the caller can see that a sweep covers (section 6; a Slack message is not covered); no run is made | anyone, over items they can see. A scope where they see nothing answers `nothing_to_check`, never `unauthorized`, so a request cannot probe what exists |

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
`summary_only`, so showing a count opens nothing in Jira or Confluence. Your
open items asks for `open_only`, so it spends live reads only on open items.

**The sweep result** (`PersonSweepResultV1`) is what the sweep renderer
returns. The staging research-eval endpoint shows it; the runs API never
does, since a sweep run stores its counts and each item only its verdict. It
holds `findings`, `status` and `citations`:

- One finding per input finding, in input order: `finding_index`, `verdict`
  (`landed`, `still_open`, `changed`, `unreadable`, or null for not
  assessed), `line` and `citation_indexes`. At most 20 findings, 12
  citations each.
- `status` follows from the verdicts, so each state has one encoding:
  `not_assessed` exactly when no finding was judged and at least one is
  null; otherwise `assessed`, even when every finding was unreadable.
- A judged verdict (`landed`, `still_open`, `changed`) cites at least one
  item. An `unreadable` or null finding cites nothing. Every citation is used
  by a finding.
- The renderer's outcome, which the research audit records, is `answered`
  only when every finding was judged, else `partial`.

`meetings.reviews` rows (and `review_open`'s review) gain `first_line` (the
proposal's first decision, else its first action; ECHO text), `action_count`
and `meeting_at` (when the meeting started, when known), so a Home row names
the decision, not only the meeting. Pending rows already carry the suggested
projects in `project_ids`.

## 8. Desktop

The design is the canvas's row 9 (artboards 9.1 to 9.7); copy below is
quoted from it where it gives one, except where the founder's rulings of
2026-10-09 (R63–R70, under Rulings) replace it: they replace the canvas's
Check row, Check card, footer and Did it land? (9.4) copy. "Check" now means
only ECHO's re-read: "ECHO checked 2 h ago", "Check now", "Checking…" (R63).

**Home (9.1, 9.5)** shows only rows that wait on the viewer, under "Needs you
· N". Each row is a verb, a title, one or two lines under it, and on the
right its age and its decision's first project:

| Row | From | Title / lines | Action |
| --- | --- | --- | --- |
| Approve | `meetings.reviews` (pending) | the first decision line / "Decision · 2 actions · Pilot planning meeting, Oct 6" | opens Approve this decision? (9.2) |
| Send | `home` | "<first decided line> — 2 tickets need updating" / "Impact of Pilot planning · owners Mina, Rafael" | opens Tell the owners? (9.3) |
| Update | `home`: an item the viewer owns, and any item not changed since it was sent | "Thermostat PRD · Pilot scope doesn't match the decision yet" / 'Says "starts after freeze" → decision needs: pilot starts next week' / muted "Confluence page · Pilot planning meeting, approved Oct 6", ending " · changed since you got it, still doesn't match" when its last check is `changed` | not changed: inline "Open in <tool>" and "Mark updated", no page; changed: the whole row opens the item card |
| Review | `home`: an item whose last check is `changed` and whose owner is not the viewer | the same three lines; the muted one ends "Mina's to update · changed since you sent it" | opens the item card; nothing on the row closes the item |
| Checking | runs `list` (pending, running impact run) | "Approved · checking what it changes" | none; not counted in the badge |
| Check failed (verb "Retry") | runs `list` (failed impact run) | "Approved · the check did not finish" | opens the reason and Try again |

A sweep never makes a Home row, and a failed sweep shows nothing: a later
Home load may ask for another.

**Update or Review** (R64, R65). An item whose last check is `changed` and
whose owner is not the viewer (the signed-in account's membership) is a
Review row; every other item row is an Update row, and the owner's changed
item is an Update row flagged as changed, not another verb. Changed rows,
Update or Review, sort before the others. An item not changed since it was
sent acts in place (ruling 20); a changed item opens the item card first
(ruling 3). An item is at most one row per person.

**An item row's lines** (R66):

- Title: the item's name, then "doesn't match the decision yet", or "may need
  updating" when the check did not assess it (no `relation`).
- Under it: what the item says now, as its live details ('Says "…"', "Due Oct
  30", or its status), then "→ decision needs: <expected>". A part that is
  missing is left out ("Decision needs: launch next week" for an item the
  viewer cannot open).
- Muted: what the item is ("Jira ticket", "Confluence page"), where it came
  from, and why it is back. Where it came from is "<decision title> meeting,
  approved Oct 6" for a viewer who can read the decision (every decision with
  open items is an approved meeting), else "sent by <approver's first name>".
  Why it is back, when its last check is `changed`: "changed since you got
  it, still doesn't match" for its owner; "<owner's first name>'s to update ·
  changed since you sent it" on its approver's Review row.
- A title that already ends with "meeting" gets no second one ("Approved
  meeting, approved Oct 6"), here, on the item card, on Your open items and
  on the Approve row (R76).

The founder accepted these cases as built (2026-10-09). An item is never
called the viewer's unless the viewer owns it. An item that fell back to its
approver because its owner left still reads "Mina's to update" (nothing says
Mina left); changed, it is a Review row. An item that fell back to a
decision's project lead (approver and owner both left) reads "changed since
it was sent", since the lead did not send it.

A viewer who cannot open the item in its tool sees "A Jira ticket you can't
open" (or page, or Slack message) for its name and no live details. An item
ECHO could not read just now (`unavailable`: an outage or a rate limit) reads
"A Jira ticket ECHO couldn't read just now", and one not read in that request
(`not_read`) "A Jira ticket"; only an item ECHO opened offers "Open in Jira".

Names stay distinct. When two rows, buttons or checkboxes would have the same
accessible name (two items you can't open), each name adds the item's
`expected` phrase. If they still match (no phrase, or the same one), each adds
"· from <decision title>" when the viewer can read the decision and the
matching items come from different decisions, then a position ("(2)"). This
holds for "Mark updated: <item>", "Open in Jira: <item>", "Close: <item>" and
Tell the owners?'s ticks and "Pick a person". A row's title adds only the
position, and only when nothing else on the row tells two rows apart. Tell
the owners?'s remove buttons name the item too: "Remove Rafael from
Thermostat PRD · Pilot scope".

**Item card** (R67; no artboard), opened from a changed item's row:

- Header: the item's name by `reach`, then "<kind> · yours to update" for its
  owner, else "<kind> · Mina's to update", plus " · now <assignee>" when the
  live read shows one; "Open in <tool>" top right when ECHO opened the item.
- The decision, for a viewer who can read it: a small "The decision", its
  first decided line (else its title), and a muted "Pilot planning meeting ·
  approved Oct 6". Otherwise a muted "Sent by <approver>".
- Two boxes side by side: "Now" (the live details, else the item's name,
  which says why they are not shown) and "The decision needs" (`expected`;
  left out when there is none).
- ECHO's last check, naming no one: "ECHO checked 2 h ago: it changed since
  it was sent, but still doesn't match." (`changed`), "…: not updated yet."
  (`still_open`), "…: it matches the decision now." (`landed`), "ECHO
  checked 2 h ago but couldn't read it." (`unreadable`); no line when it was
  never checked.
- "Mark updated" (`done`) and "No change needed" (`not_relevant`) when the
  viewer may set the item's state. Either closes the card, and the row leaves
  Home at once.

**Footer** (R69), under the rows and also on an empty Home (9.5): "1 matches
its decision now · 2 waiting on others · ECHO checked 2 h ago" ("N match
their decision now" for more than one). "Match" counts open items the viewer
sent or owns whose last check is `landed`; "waiting on others" counts open
items the viewer sent that wait on someone else; parts that are zero are left
out. "View" opens Your open items for the viewer's own items whenever either
count is above zero. First-run Home is otherwise unchanged. The
`echo.seenImpact` browser storage goes away: a sent run leaves Home by its
items' state.

Check times read "just now" (under a minute), "N min ago", "N h ago" (under
six hours), then "today", "yesterday", then the date ("Oct 6").

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

**Your open items** (R68; replaces canvas 9.4's "Did it land?") is a status
view of a scope's open items, over the page it was opened from: the viewer's
own (from Home's footer), or a decision's or a project's (after Check now).

- Heading: "Your open items"; for one decision "Open items", with its decided
  line large under it; for a project "Open items · <project name>".
- Under it: "<N> open · ECHO checked 2 h ago", from the scope's summary, shown
  once a read of the items succeeded (a failed first read shows its error,
  not "0 open").
- It lists the scope's open items only (`items` with `open_only`), as one
  list with no checkboxes. Each line: the item's name · what the decision
  needs, its status, and its owner chip.
- Statuses, by last check: "Matches now" (`landed`), with a small "Close"
  that sets `done` when the viewer may; "Not updated yet" (`still_open`);
  "Changed, still doesn't match" (`changed`); "ECHO couldn't read it"
  (`unreadable`); "Not checked yet" (never checked). Where the viewer's own
  access refused the item, its name already says so.
- Order: matches first, then not updated or changed, then couldn't read or
  not checked. The viewer's own items from more than one decision are grouped
  under a small header per decision ("Pilot planning meeting, approved Oct
  6"; "Sent by <approver>" for a decision the viewer cannot read).
- "Close all <N> that match", a quiet link, when two or more can be closed:
  one `set_state` each. Closing keeps the view open without the closed
  lines; an item that could not be closed stays, with a line saying why.
  Back then reads the page below again.
- With nothing open: "No open items". It has no Check now of its own. The
  canvas's "Remind" is not built: an owner already has the item on their
  Home.

**Reader, an approved decision (9.6)**: an Impact line under the title,
"Impact · 1 open · 1 handled · 1 couldn't read · checked just now". The parts
count each sent item once: "open" is open items that neither landed nor were
unreadable at their last check; "handled" is done, not relevant and landed
items; "couldn't read" is unreadable ones; unsent items read "N not sent".
Zero parts are left out. With no items the line gives the check's stage:
"Not checked yet", "Checking…", "Check failed", "Nothing to change". When the
decision's impact run is the viewer's own (the stage's `mine`), the line
offers "Send" while its items wait to be sent and "Try again" after a failed
check. It offers "Check now" once the decision has items. The line reads the
decision's counts only (`items` with `summary_only`) and opens the decision's
items, which are read then. (Its copy is unchanged until the founder reviews
it.)

**Project page (9.7)**: a line above the feed, "4 open items · from 2
decisions · checked today", with "Check now", and "N open" on each decision's
row in the feed. A decision's "open" counts its unsent and open items, less
the open ones that landed or were unreadable at their last check. Unlike the
Impact line, which shows unsent items apart as "N not sent", it includes
them. The project line's total is counted the same way from the project's
whole summary, not by adding the rows (a summary lists at most 100
decisions), so it stays exact in a large project; "from M decisions" counts
the listed decisions with any open. The line stays while any item is unsent
or open, so Check now and the way to the project's items never go (R72):
when that count is zero because everything left matched or could not be
read, the line counts unsent + open items instead ("2 open items"). The line
reads the project's counts only (`summary_only`) and opens the project's open
items grouped by owner, oldest first, each with its stage and age. (Its copy
is unchanged until the founder reviews it.)

**Check now**, on the Impact line and the project line, is a quiet link as
the canvas draws it. It asks for a `sweep` of that decision or project.
`nothing_to_check` makes the line say "Nothing open to check". Otherwise the
line says "Checking…" and the desktop starts the sweep. While the server
answers `busy` because one of the viewer's impact checks waits, the desktop
starts those first, then the sweep, and it follows the run with Part 1's
polling backoff. When the sweep is done, the line's counts are read again,
and Your open items opens for that scope if the line is still in sight. A
failed sweep, or a sweep request that fails, makes the line say "Check
failed · Try again", and Try again asks for a new sweep.

**Runs**: `driveRuns` starts pending impact runs first, then pending sweeps,
one at a time, under Part 1's polling backoff. A pending sweep may be one put
back after a timed-out or rate-limited attempt, one whose attempt stopped
(listed as `pending`, section 7), or one Check now queued; it is started like
an impact run. A start answered `busy` is tried again later and never shown
as an error. When `home` says `sweep_due` and no run is waiting or going, the
desktop asks for one new `mine` sweep and starts it: at most one new sweep
request per Home load, spent only when the request is made. A failed runs
read, or a failed read of what a check found, never skips the start or the
request; its failure only lengthens the wait before the next look. When a
sweep ends, Home is read again to show what it found.

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
   rows, footer, "Did it land?", Check now, sweep evaluation cases. (The
   founder's rulings of 2026-10-09 turned Check rows into Update and Review
   rows and Did it land? into Your open items, section 8.)

As delivered: Part 1 merged on its own as PR #300 after the founder's
walkthrough, with the follow-up PR #301 (Home reads shared items without
Granola; a Send replay answers the counts frozen at Send). Part 2 follows in a
separate pull request. The plan's As built section records the split.

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
  a project lead reassigns; both only once the item is sent. Every operation
  gets these answers from the one access policy (a test table covers each
  role), and the database refuses any move back to `unsent`.
- Send is idempotent per `command_id`; unticked items become `not_relevant`.
  A replay answers the original counts, even after later changes and after
  the approver lost read access to the decision.
- When the owner leaves, the item shows on the approver's Home; when both
  leave, on the Home of the leads of the decision's active projects.
- No stored row or column holds text, a title or a name read from outside ECHO
  (a test seeds distinctive outside text and searches every new row for it).
- A sweep replaces an item's last check only with a newer one, never changes
  `state`, and skips items the sweeper no longer sees as it finishes. Its run
  stores the counts by verdict only.
- An item on a Slack message is not swept and does not make a sweep due; the
  `sweep` trigger refuses a Slack message citation.
- No finding is judged without all of its own items. A finding that was not
  assessed leaves its item's last check as it is. A finding is `unreadable`
  only when one of its own items could not be read.
- A sweep finding names the decision, its first line and its record only to
  a caller who can read the decision.
- `sweep_due` is true only with an open item of the caller's, of a kind a
  sweep covers, whose last check is over 24 hours old or missing, no running
  sweep of theirs, and none of their sweeps created in the last hour; a sweep
  left pending longer than an hour does not block it, and asking again for a
  `mine` sweep returns a stuck `mine` sweep.
- Starting a sweep answers `busy` while the caller has a pending or running
  impact run.
- `sweep` answers `nothing_to_check`, and makes no run, when the scope holds
  no open item the caller can see that a sweep covers.
- Your open items reads open items only. A decision's feed row and the
  project line count "open" as unsent + open − landed − unreadable, the
  project line from the project's whole summary; the Impact line's "open"
  leaves unsent items out. The project line stays while any item is unsent or
  open.
- Desktop: approve in the test Authority → Send row → Send with one picked
  owner → that owner's Update row → Mark updated → the item leaves both Homes
  and shows `done` on the project page.
- Desktop, against the test Authority: Home asks for a sweep by itself when
  one is due and then shows the owner's changed item as an Update row ending
  "changed since you got it, still doesn't match" and the footer "1 matches
  its decision now"; View opens Your open items, and Close closes the
  matching item. An approver sees someone else's changed item as a Review
  row. Check now on a decision sweeps only that decision, and on a project
  only that project. A sweep attempt that went back to the queue is started
  again. A changed item's row opens the item card before anything is closed.
- The research-loop evaluation grades each sweep finding against its key:
  `landed` as landed, `still_open` and `changed` as not landed, `unreadable`
  as no evidence. A null verdict is wrong, and a failed run scores zero.
- Ask goldens unchanged; `npm run check` passes.

## Not in this round

- Slack DMs to owners. Owners learn from Home only.
- Scheduled checks (founder: keep it simple for now). Checks run only from a
  signed-in desktop (Home, or Check now on a decision or project), so
  "latest" means as fresh as the last time someone involved opened ECHO. Two
  later options: a schedule in the desktop's background process (a fixed time
  while the app runs in the menu bar, the same access, a small change), or
  server-side checks for everyone, which need a revocable per-person "check
  while I'm away" grant and a security decision.
- More than one live run per person; sweeps queue behind impact checks.
- An organization-admin view across projects; any count that includes rows
  the viewer cannot see.
- A fallback for a no-project decision whose approver and owner have both
  left: its items stay visible to the decision's readers but wait on no one.
- Showing a pending (unapproved) meeting to anyone but its reviewer.
- History of earlier checks and clicks; only the latest of each is kept.
- Card and sweep quality: unmeasured until the approved-record and sweep
  evaluations run (research loop evaluation, S1 world state).
- Sending for an approver who left. Unsent items of an approver who left
  before Send stay unsent: the decision's project leads see them but cannot
  send or reassign them.
- An open item whose owner left waits on its approver. If the approver is
  still active but can no longer read the decision, the item is on nobody's
  Home. Readers of the decision still see it on its record and project pages.
- A screened line when no repair is possible. When the run has no model call
  or time left for the one repair, a sweep reply whose only problem is a line
  that fails a screen is refused whole, and its findings stay not assessed.
- A partial landing. A finding where only some of its items moved as
  expected has no verdict of its own: it is not `landed`, and is meant to be
  answered `still_open`. Naming it is a later call.
- Verdicts that depend on who checked. A sweep reads as the person who asked,
  so a sweeper who cannot open an item records `unreadable`, and as the
  newest shared check it replaces a reader's `landed`. Home's footer count
  ("match their decision now") and Review rows read the shared check. Whether such a check should replace a
  reader's verdict is a founder call.
- Checking Slack messages. No reader in ECHO can open a Slack message
  citation yet: it names no tool connection, no live Slack reader is
  registered, and ECHO's own desk leaves Slack messages to Slack. A sweep
  could only record such an item `unreadable`, spending a background
  research run on a result known in advance. So an item on a Slack message is
  not swept, does not make a sweep due, and stays "not checked yet" until a
  Slack reader exists. For the same reason a live read of it is refused as
  `no_access`, so a viewer sees "A Slack message you can't open" even when
  their own Slack access would allow it.
- A revocation in the instant a sweep finishes. Who still sees each item is
  asked just before the finishing transaction, not inside it. Nothing in the
  Authority process can run in between, but access revoked by another
  process in that instant is not seen, and that item's check is written.
- Undoing Not relevant on a reopened item. An item Send left out that someone
  reopened reaches its owner. If an owner who cannot read the decision sets
  it not relevant, it leaves their sight, and they cannot reopen it.
- Reassigning from the desktop (R71). The API and the CLI support `assign`;
  the desktop's only person picker is Send's "Pick a person", so reassigning
  an item after Send needs the CLI this round.
- A sweep that keeps going back to the queue (R58 corner). The hour that
  holds `sweep_due` back counts from a sweep's creation, so a sweep released
  after an outage is started again on each Home load until its three
  attempts are spent, and one released because the search index lags is
  claimed again on each Home load. Both are bounded, as before R58.
- The impact card's `view` under the access policy. `view` checks who reads
  the decision itself, not through `decision_policy`: its approver keeps the
  card, decided lines included, after losing read access to the decision,
  and a later decision rule does not reach it until `view` asks the policy.

## Rulings

Rulings made while executing the plan are listed in the plan's
[As built](../superpowers/plans/2026-10-08-open-items-and-home.md#as-built)
section, not here; those that change behavior are folded into the sections
above. The exception is those of 2026-10-09 (R63–R76), which are listed at
the end of this section too.

Made with the founder on 2026-10-08:

1. Owners are matched exactly: Jira account, or a unique exact name on an ECHO
   action. Otherwise the approver picks from active members on the Send card,
   and an unpicked item stays with the approver.
2. Owners learn from their Home only.
3. Check rows open the item first; there is no inline Not relevant. (Since
   2026-10-09: rows for changed items, Update or Review, open the item card,
   whose "No change needed" is Not relevant, R65.)
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
    draws them; Check rows open the item first (ruling 3). (Since 2026-10-09:
    "Mark updated" is Done, and only rows for items not changed since they
    were sent act in place, R65, R67.)
21. "Remind" on Did it land? is not built: an owner already has the item on
    their Home, and ECHO sends nothing else this round. (Did it land? is now
    Your open items, R68; it has no Remind either.)
22. `expected` is a short phrase (at most 120 characters), so a row can read
    "due Oct 30 → next week": live details, then what the decision requires.
23. Approve rows show the proposal's first decision line, action count and
    meeting date, which the meetings API adds to its review rows.

Made on 2026-10-09. R63–R70 are the founder's review of Part 2's screens; they
replace the canvas's Check row, Check card, footer and Did it land? (9.4)
copy. R71–R76 were made while finishing Part 2.

- R63. "Check" is no longer a Home row verb; it means only ECHO's re-read
  ("ECHO checked 2 h ago", "Check now", "Checking…").
- R64. Update is for an item's owner; Review is for an approver looking at
  someone else's item whose last check is `changed`. The owner's changed item
  is an Update row with a flag, not another verb.
- R65. Click behavior is unchanged: items not changed act in place on Update
  rows; changed items, Update or Review, open the item card first.
- R66. Home item rows have three lines: "<item> doesn't match the decision
  yet" (or "may need updating"); "Says … → decision needs: …"; muted kind ·
  "<title> meeting, approved Oct 6" (or "sent by <first name>") · why it is
  back. Every reach fallback stays.
- R67. The item card: whose it is to update, the decision, "Now" and "The
  decision needs", a check line naming no one, "Mark updated" and "No change
  needed" (also on the Update row: "Mark updated: <item>").
- R68. "Did it land?" becomes "Your open items", a status view with no
  checkboxes, one status per item, Close on matches and "Close all N that
  match" when two or more can close; empty, "No open items".
- R69. Home's footer reads "N match their decision now · N waiting on others
  · ECHO checked 2 h ago", with View whenever either count is above zero.
- R70. "landed" and "Did it land?" leave all copy; the Impact line and the
  project line copy stay until the founder reviews them; "Check now" and
  "Checking…" stay.
- R71. No reassign control on the desktop this round; the API and the CLI
  have `assign`.
- R72. The project line stays while any item is unsent or open; when its
  count is zero it counts unsent + open items instead.
- R73. Part 2 finishes with one whole-branch review and one fix round, docs
  accuracy included, then one push and a draft pull request.
- R74. That review is two reviewers (backend and privacy; desktop and docs),
  with one skeptic per critical or important finding.
- R75. A sweep reads in one project only when every item it checks comes
  from a decision in exactly that project; otherwise everywhere the caller
  may read.
- R76. A title that already ends with "meeting" gets no second "meeting".
