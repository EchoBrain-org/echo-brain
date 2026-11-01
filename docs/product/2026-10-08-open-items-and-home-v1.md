# Open items and Home v1

Superseded in part by [follow-ups thread v1](../archive/2026-10-14-follow-ups-thread-v1.md)
(sending selects, owners before sending, every row opens the item page,
meeting actions are follow-ups); its Rulings and API changes sections name what
changed (`items` takes `states` in place of `open_only`).

Status: designed with the founder on 2026-10-08 and approved by the founder the
same day; rulings 18–23 were added while planning. Shipped in two parts: Part
1 in #300 (a7f8df7) with its follow-up #301 (00a9c1f), and Part 2 in #303
(264757c). Sections 1 to 6 describe what was built, including the rulings
made while building that change behavior; sections 7 and 8 point to what owns
the API and the desktop now. Updated 2026-10-16 for
the research ROI fixes the founder approved that day (R77–R82): sweeps skip
the planner, take only items in tools the caller has connected, never let
`unreadable` replace a judged verdict, ground `landed` and `changed` in the
finding's own items and withhold a screened line without a repair; an
affected row no model assessed makes no open item.
Decision record: [ADR-0033](../decisions/ADR-0033-shared-open-items.md).
Builds on
[runs store and impact card v1](2026-10-07-runs-store-and-impact-card-v1.md),
[unified meeting approval v1](2026-10-07-unified-meeting-approval-v1.md) and
the [research trigger contract v1](../archive/2026-10-06-research-trigger-contract-v1.md).
Design canvas, row 9:
https://claude.ai/code/artifact/ffa8478f-578d-40d0-bc7a-578a66f4adb0.

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
| `relation` | `conflicts` or `needs_updating`. Empty only on an item made before 2026-10-16 from a card that was not assessed (section 3). |
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
cited item". A screened word it quotes from the approved record's own text
("owner approval") is excused; the item's own title and text never excuse
it. Because it is written from the decision, anyone who can read the
decision may see it.

When the run finishes, in the same transaction that stores the card:

- One open item per affected row whose relation is `conflicts` or
  `needs_updating`. `confirms` rows make no item: they already agree. A row
  no model assessed (the card's fallback) is only possibly affected and makes
  no item either. Neither the meeting's own record nor the transcript its
  approver shared is ever an item.
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
  round"). An item on a ticket or a page counts only when the caller has
  connected its tool: one of the live sources a desk binds is for that tool,
  and the caller's link to it is live (a local read of the link, never a
  provider call). Otherwise a sweep could only record it `unreadable`.
  `mine`: those the caller sent or owns. `record` or `project`:
  those there that the caller can see, as `items` shows them. At start, the
  server reads the scope again and takes up to 20 items the caller still
  sees: never checked first, then the oldest last check, then the oldest
  item. An item one of the caller's sweeps that finished in the last day
  could not read goes after all the others: someone else's judged check stays its last
  check, so it would otherwise come first in every sweep and keep the
  caller's other stale items waiting. It is still read when places remain,
  and a day after that sweep it takes its usual place again. The rest wait
  for the next sweep.
- **Findings.** One per item, in that order. A finding names the item by what
  the impact check found and its kind ("Outdated Jira ticket", "Conflicting
  page", "Affected page" when not assessed). It adds "from <decision title>"
  only when the policy shows the caller the decision (`see_decision`).
  `expected` is the item's own phrase; else, for a caller shown the decision,
  its first decided line cut to 120 characters; else "the approved
  decision". When a finding carries that placeholder and research read its
  decision, the renderer shows the judge the decision's current text in its
  place. The citations are the item's pointer first, then the decision's
  record citation, again only for a caller shown the decision. So an owner
  sent an item without access to its decision never gets the decision in
  their run. The existing `sweep` trigger definition turns the findings into
  the brief, with no planner (R77): research re-reads every finding's
  citations in full as its starting evidence and stops. It does not search
  for newer related items. An item that cannot be read is reported, not
  fatal. The renderer's one judge call then decides the verdicts, and a sweep
  whose items are all unreadable makes no model call.
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
    `landed`; it is meant to be answered `still_open`. A change shows in the
    item itself, so `landed` and `changed` cite at least one of the finding's
    own items (R80); `still_open` may cite its decision alone.
  - A finding is never judged blind. It goes to the model only together with
    all of its own items. A finding whose own items do not all fit the
    prompt, or that research holds in no form, gets no verdict (null, "Not
    assessed."). The model is shown each finding's own items, the other
    sections of those pages and the finding's decision, while they fit, and
    nothing else research came across.
  - A usable reply gives one verdict for each finding shown, each citing at
    least one item the model was shown. A reply that misses or repeats a
    finding, cites nothing or an item it was not shown, or gives a `landed`
    or `changed` verdict that cites none of the finding's own items, is sent
    back once. With no usable reply after that, no finding is assessed.
  - A line that fails a screen (instructions or suggested edits, ownership
    claims) costs no repair (R81): it reads "ECHO withheld this line." and its
    verdict stands. The screen excuses words the line quotes from the items it
    cites.
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
  meanwhile stays newer. A judged verdict (`landed`, `still_open`,
  `changed`) outranks `unreadable` (R79): it replaces an older check, and an
  `unreadable` one whenever that was made; an `unreadable` verdict is
  recorded only while the item has no judged check, from anyone. The
  database lets a last check only move forward, so a judged check that
  replaces a later unreadable one is stamped 1 ms after it. A null verdict
  leaves the last check as it is: the item stays oldest, and the next sweep
  takes it first. The run's stored result is the counts by verdict, not
  assessed included, and the ECHO ids of the items it could not read; no
  line, title or citation. A sweep never sets `state`. With no item left
  to check at start (all closed, or out of the caller's sight, meanwhile), it
  reads nothing and finishes with zero counts.
- **When it runs.** Home reports `sweep_due` when all of these hold: the
  caller has an open item they sent or own, of a kind a sweep covers (not a
  Slack message, and a ticket or page only in a tool they have connected),
  whose last check, by anyone, is older than 24 hours or missing, and that
  none of their sweeps that finished in the last day found unreadable (such an
  item waits a day from when that sweep finished, however long before it was
  asked for, as its own unreadable check would, while someone else's judged
  check stays its last check); no sweep of theirs is running; and none
  of their sweeps was created in the last hour, whatever its state. So a sweep
  that keeps failing, or leaves items not assessed, is not asked for again on
  every Home load. A sweep left pending for more than an hour does not hold
  `sweep_due` back, so a stuck sweep cannot stop automatic sweeps. When
  `sweep_due` is true, the desktop asks for a `mine` sweep; if the stuck sweep
  is a `mine` sweep, that request returns it. "Check now" on a record or a
  project asks for a sweep of that scope, and the hour does not limit it. A
  second request for the same scope while one is pending or running returns
  that run. Impact runs start before sweeps, enforced by the server: starting
  a sweep answers `busy` while one of the caller's impact runs is pending or
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

Every operation is on `POST /v1/person/runs` (ruling 5). The contract as built
is [`person-runs-v1.ts`](../../packages/organization-api/src/person-runs-v1.ts),
with the sweep result in
[`person-sweep-result-v1.ts`](../../packages/organization-api/src/person-sweep-result-v1.ts),
and the
[Authority runbook](../../services/organization-authority/README.md#person-reads-and-permissions)
describes each operation. Two later designs changed it:
[follow-ups thread v1](../archive/2026-10-14-follow-ups-thread-v1.md) ("API changes":
`items` takes `states` in place of `open_only`, and one `read` replaces
`summary_only`), and
[desktop refresh and notifications v1](2026-10-15-desktop-refresh-and-notifications-v1.md)
(the `involved` scope and `changed_since`,
[ADR-0036](../decisions/ADR-0036-person-change-check.md)).

## 8. Desktop

The design was the canvas's row 9 (artboards 9.1 to 9.7), with the founder's
rulings of 2026-10-09 (R63–R76, under Rulings) in place of its Check row,
Check card, footer and Did it land? copy. Two later designs replaced most of
it: [follow-ups thread v1](../archive/2026-10-14-follow-ups-thread-v1.md) (every row
opens the item page, follow-ups lists for a meeting and a project, one status
vocabulary) and
[desktop refresh and notifications v1](2026-10-15-desktop-refresh-and-notifications-v1.md)
(the change check, notifications, and Follow-ups as what you sent, own or last
handed on). The [desktop README](../../product/echo-desktop/README.md)
describes Home, the follow-ups lists and the item page as built.

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
Granola; a Send replay answers the counts frozen at Send). Part 2 followed in a
separate pull request, PR #303.

## Acceptance

- An impact run's finish writes exactly one item per `conflicts` or
  `needs_updating` row, none for `confirms` or not-assessed rows, none for the
  meeting's own record or transcript, all `unsent`, in the card's
  transaction.
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
- A sweep replaces an item's last check only with a newer one, never with
  `unreadable` over a judged verdict, never changes `state`, and skips items
  the sweeper no longer sees as it finishes. Its run stores the counts by
  verdict and the ids of the items it could not read.
- An item on a Slack message is not swept and does not make a sweep due; the
  `sweep` trigger refuses a Slack message citation. Nor is a ticket or page
  in a tool the caller has not connected.
- A sweep makes no planner call. No finding is judged without all of its own
  items, and a `landed` or `changed` verdict cites at least one of them. A
  finding that was not assessed leaves its item's last check as it is. A
  finding is `unreadable` only when one of its own items could not be read.
  A line that fails a screen is withheld without a repair.
- A sweep finding names the decision, its first line and its record only to
  a caller who can read the decision.
- `sweep_due` is true only with an open item of the caller's, of a kind a
  sweep covers, whose last check is over 24 hours old or missing and that no
  sweep of theirs of the last day found unreadable, no running sweep of
  theirs, and none of their sweeps created in the last hour; a sweep
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
- A partial landing. A finding where only some of its items moved as
  expected has no verdict of its own: it is not `landed`, and is meant to be
  answered `still_open`. Naming it is a later call.
- Verdicts that depend on who checked. A sweep reads as the person who asked.
  A sweeper who cannot open an item no longer replaces anyone's judged
  verdict (R79), but two readers' judged checks still replace each other by
  time, and Home's footer count ("match their decision now") and Review rows
  read the shared check. A judged check stamped 1 ms after the unreadable
  check it replaced can make a later judged read of the same item lose; a
  column keeping each check's own read time would fix that, a schema
  change.
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

Numbered rulings (1 to 23) were made while designing. R-numbered rulings (R1
to R82) were made while building and since, and code cites them by number.
Those that change behavior are folded into the sections above.

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
    line. (Superseded 2026-10-16 by R82: not-assessed rows make no item.)
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

Made while executing the implementation plan (R1–R62). The plan was retired
once both parts shipped; a task (Task 1 to Task 14, 9b, 12c, 12d) is one of
its steps, and "the spec" is this design. Each line gives the ruling, then
the reason. The plan's ledger numbered two rulings each as R25 and R26 (one
at the Part 1 stop, one at the Part 2 start); both are listed.

- R1: Move `PersonMeetingReviewV2`'s three fields from Task 4 to Task 8 — Task
  8 changes the service and fixture that produce them, so Tasks 4–7 keep
  building.
- R2: Every task leaves the build, root `tsc` and desktop typecheck green;
  Task 4 adds a temporary route `default` and raw desktop result types,
  replaced in Tasks 7 and 9 — the widened unions would otherwise break the
  tree.
- R3: Move the `sweep` operation, `home.sweep_due` and `trigger: 'sweep'` from
  Task 10 to Task 11 — the service implements them there. Reversed by R25
  (Part 2).
- R4: The runs scope CHECK tests `scope_kind IS NOT NULL` first — the plan's
  `IS` form rejected every approved-record row.
- R5: The items CHECK becomes `relation IS NOT NULL OR expected IS NULL` — a
  conflict without a usable phrase must still be stored.
- R6: Task 7 exports the stored-card reader as `readStoredImpactCardV1` — the
  open-items service needs the first decided line.
- R7: Task 5's `renderWith(reply)` returns `{ card, calls }` — the two tests
  used the helper differently.
- R8: Task 11 sorts sweep candidates by `checked_at` in the service —
  `forRecords` orders by `created_at`.
- R9: Task 6 declares a local structural people type — Task 2's DAO was not on
  its base; the DAO satisfies it.
- R10: The check-newer trigger covers all four check columns and needs a
  strictly newer `checked_at` — spec section 2 replaces a check only by a
  newer one, and the plan's trigger let the verdict change without a newer
  time.
- R11: `leadsAny` counts active projects only — archived projects are
  read-only and the approval-audience trigger requires active ones.
- R12: The runs CHECK test asserts the CHECK's own message — it passed only
  because an earlier trigger fired.
- R13: The policy gains `sent_to_owner` — an owner who cannot read the
  decision sees only items sent to them (spec section 4).
- R14: `action_count` has no upper bound — briefs hold more than 40 actions,
  and a clamp would misreport.
- R15: Re-pin the impact-card quality baseline's three fingerprints — the
  mandated prompt and schema change moved them; the Ask goldens are untouched.
- R16: The policy gains `state` — the rules for unsent and closed items stay
  in the one policy.
- R17: Run Task 9 (desktop) in parallel with Task 7 (server) in separate
  worktrees — they share no files, and Task 9 builds against the merged API
  types and the fixture.
- R18: The policy refuses `assign` on unsent items, and `see_row` is checked
  before "Send it first" — only someone who could act learns that the item is
  unsent.
- R19: Unsent items of an approver who left before Send stay unsent; leads see
  them but cannot send or reassign — parked as a known gap, since letting
  leads send is new scope.
- R20: Task 9b adds `summary_only`, `reach`, replay-first Send,
  `see_decision`, Send gating through the policy and a same-owner assign that
  writes nothing — rate limits and honest outage copy matter on real data.
- R21: Task 9's fix round also hides sent runs locally, pins the can't-open
  row in e2e and names item buttons — same class as the review's Important
  finding.
- R22: A stale Send answers `conflict`, shown as "These items changed
  meanwhile. Open them again from Home." — the desktop reads
  `stale_access_state` as a lost account.
- R23: Task 9b takes the Task 9 re-review's store fixes (staleness check
  first, record a send on any page, no Details while sending, distinct names)
  — they are small fixes in code 9b touches.
- R24: Bring main into the Part 1 branch with one `--no-ff` merge after Task
  9b — a merge keeps the reviewed commits intact.
- R25 (Part 1 stop): Codex finishes the Part 1 stop (merge main as R24 says,
  validate once, refresh screenshots, prepare the fixture walkthrough) without
  starting Part 2 or pushing — the founder's request.
- R26 (Part 1 stop): Keep all three Home recovery cases from main's `f108cf4`,
  adapted to the new Home, and add two failed-Home resume cases — main's
  recovery fix must survive the rewritten Home, and no test is removed.
- R27: Accept the Part 1 reviewer's limits: no sweep, deferred minors stay
  deferred, live staging is not proven by fixtures — the limits stay visible
  at the founder's review.
- R28: Ship the accepted Part 1 as a standalone PR (#300) on the validated
  head — Part 2 stays parked; no reset, merge or release is implied.
- R29: Fix PR #300's two inline review reports in a follow-up, PR #301; Home
  reads shared open items and runs without Granola, and only meeting reviews
  depend on it — PR #300 merged while the fixes were being reproduced. That
  rule answers one report; R30 answers the other.
- R30: V13 stores an immutable `send_included` per item, and a Send replay
  returns its original counts — counting current state went wrong after later
  state changes; this supersedes the Task 2 replay rule.
- R25 (Part 2): Part 2 runs in waves: Task 10 with the runs API additions,
  then Tasks 11, 12 and 13 in separate worktrees — the desktop builds against
  a settled API, as Tasks 7 and 9 did.
- R26 (Part 2): Fold Part 1's deferred minors into the Part 2 tasks (a
  record-level policy function, `reach` code tests, `send_included` for
  `sent_to_owner`, a stage's `mine`, distinct names, plan text) — they touch
  the same code.
- R31: Task 10 computes a stage's `mine` for real, while `sweep` and
  `sweep_due` stay placeholders — a placeholder `mine` would be wrong data,
  and it is one comparison.
- R32: `home.sweep_due` also requires no sweep created in the last hour — a
  failing or unassessed sweep would otherwise be asked for on every Home load,
  reading Jira and Confluence each time.
- R33: A sweep finding names the decision only when the caller may see it — an
  owner sent an item without reading its decision must not get the decision in
  their run.
- R34: A sweep claim answers `busy` while the caller has a pending or running
  impact run — "impact runs start before sweeps" must not depend on the
  client.
- R35: The Impact line partitions sent items: open less landed and unreadable,
  handled (done, not relevant, landed), couldn't read — the canvas 9.6 example
  reads 1, 1 and 1.
- R36: Did it land? groups by last check (Landed; Still open with changed and
  unchecked items; Couldn't read), and Mark N done closes the ticked landed
  items the viewer may set — the spec lists only three sections. Its card form
  is superseded by R68.
- R37: Names that still collide after `expected` add the decision title when
  readable, else a position; "Remove <person>" names its item — it closes a
  Part 1 minor.
- R38: The sweep's work lives in a new composition file called from `launch`,
  with one observation and error structure — the runs file is already long.
- R39: Sweep line screens apply per line after the one repair; a line that
  still fails becomes "ECHO withheld this line." and keeps its verdict —
  refusing the whole reply let one line void every verdict, every hour.
- R40: Never judge a finding blind: send it only when all its own items fit,
  else null; a judged verdict cites at least one item; one status per state —
  a stored blind verdict could hide a landed ticket for a day.
- R41: Start Tasks 12 and 13 from `bc2e9a3` while Task 10's fix round runs —
  the fix changes only renderer internals and the validator; the desktop never
  sees them, and the evaluation reads the result only by `finding_index`.
- R42: Match a finding's own items by identity (item key, and section for a
  page) — matching the whole citation failed for every edited item, and edited
  items are what a sweep checks.
- R43: Failed sweep runs score zero, like failed card runs — a sweep the
  endpoint cannot start is a real failure the report must show.
- R44: Fold all five Task 13 minors into one fix round, including the leak
  scan of result-less runs — a hidden leak undercounts runs with leaks, and
  misaligned verdict keys would misgrade silently.
- R45: A finding owns its first citation and every further outside-tool
  citation; ECHO records cited later are context; it is unreadable only when
  an own item is — eval findings cite several tickets, and an unreadable
  decision must not be stored as the item's check.
- R46: Start Task 11 from `41ceec0` alongside Task 10's third fix round — that
  round changes renderer internals only, not the result contract Task 11 uses.
- R47: The controller pauses after Tasks 10–13 are merged and checked, leaving
  Task 14 and the final review to the founder — the founder's instruction at
  the time; superseded by R52.
- R48: The same implementer fixes the round-3 re-review's three minors — they
  are new small findings from a clean re-review, not a stuck loop.
- R49: Accept Task 12's open choices (relative times, the Check card's layout,
  where Check now shows, impact runs first, one sweep request per Home load),
  but R37 also covers the Send card's checkboxes — names must differ there
  too.
- R50: "One sweep start per Home load" limits new sweep requests only; an
  existing pending sweep starts like a pending impact run, after them, with
  backoff — a released sweep must resume, and nothing may poll every 5 s for
  work it will not start.
- R51: Did it land?'s reads of closed items and the feed row's "open" count
  move to Task 12c — both need API and service changes that neither parallel
  branch could make.
- R52: Finish order: merge Tasks 11 and 12, Task 12c, Task 14's docs, a final
  whole-branch review with one fix round, then `npm run check` and the full
  desktop e2e on the exact candidate, one push and a draft PR against main —
  the review's fixes must be inside the validated candidate.
- R53: Write Task 14's docs in a separate worktree while Tasks 11 and 12
  finish, and re-check the in-flight parts after they merge — the docs depend
  only on settled rulings and briefs.
- R54: `sent_to_owner` is true when the item was sent and Send included it, or
  it is `open` or `done` since — an item reopened after Send would otherwise
  wait on an owner who cannot see it.
- R55: Runs `list` answers at most the 20 newest sweeps and fills the rest of
  its 100 with the newest impact runs — sweeps, up to hourly plus Check now,
  must not push failed impact runs and their Try again rows off the list.
- R56: The kernel's sweep trigger accepts Slack message citations, so Slack
  items are swept and count toward `sweep_due` like tickets and pages — the
  live desk already opens them, and leaving them out meant they were never
  checked. Superseded by R62.
- R57: `readStoredImpactCardV1` moves to its own small composition module that
  both services import, and the `sweep_due` API comment states R32's hourly
  limit — no import cycle, and no 700-line file.
- R58: `home.sweep_due` ignores a pending sweep created more than an hour ago
  (stale items, no sweep created in the last hour, none running); asking again
  returns that same pending run — a stuck sweep is resumed by the server's
  rule instead of blocking automatic sweeps for good, without depending on the
  desktop's list.
- R59: Accept Task 12's narrower R37: a decision's title is added only when
  alike items come from different decisions, else a position — a title cannot
  tell apart items of one decision, and R37's aim is distinct names.
- R60: Runs `list` and the stages of `items` report a `running` run whose
  lease has lapsed as `pending` (the stored state is unchanged) — otherwise a
  run whose worker died shows "Checking…" forever and Home polls every 5 s;
  the gap dates from Part 1 and was found by the Task 12 re-review.
- R61: A sweep asks again who sees each item synchronously right before
  `finish`, with no await between, not inside its transaction — the record
  check behind it opens a project-context transaction, which never nests, so
  nesting would break every production sweep; nothing in the Authority process
  can run in between, and a membership another process revokes in that instant
  is not seen.
- R62: Supersede R56 in Task 12c: the kernel's sweep trigger refuses Slack
  message citations again, and the service leaves Slack-message items out of
  sweeps and `sweep_due`, saying why in a comment and in the spec's "Not in
  this round" — no desk in this repository can open a Slack citation (it
  carries no `tool_id`, and no live Slack connector is registered), so a swept
  Slack item is only ever recorded `unreadable`, at the cost of a background
  research run; Slack items stay "not checked yet" until a Slack reader
  exists.

Unnumbered rulings:

- Implementers run on Opus from Task 2 on (Task 1 finished on Sonnet), and
  reviewers on Opus for substantial diffs — the founder asked for more
  capability.
- Keep Task 1's `Co-Authored-By: Claude Sonnet 5.5` trailer — it names the
  model that wrote the commit, and amending rewrites history.
- Tasks 3, 4, 5, 6 and 8 run as one parallel wave, each in its own worktree,
  merged after Task 2's review — the founder opted in.

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

Made with the founder on 2026-10-16, after the LangSmith audit of 42
`echo-staging` research traces (its decisions 3 and 4):

- R77. Sweeps skip the planner: the starting items are re-read in full and
  one judge call decides each verdict.
- R78. A sweep takes only items in tools the caller has connected.
- R79. `unreadable` never replaces a verdict someone else judged.

Made while building the fixes the founder approved that day:

- R80. `landed` and `changed` cite at least one of the finding's own items.
  A reply that breaks this gets the one repair; downgrading it to
  `still_open` would store a verdict the model never gave.
- R81. A sweep line that fails a screen is withheld without a repair: lines
  are never stored, and in the traces a screen repair regenerated and
  flipped every verdict.
- R82. A row no model assessed makes no open item: the fallback card's rows
  are only possibly affected. This replaces the not-assessed half of
  ruling 12.
