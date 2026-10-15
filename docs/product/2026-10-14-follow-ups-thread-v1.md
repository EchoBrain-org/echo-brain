# Follow-ups thread v1

Status: approved by the founder on 2026-10-14 (the fix order and the target
map). Replaces the parts of
[open items and Home v1](2026-10-08-open-items-and-home-v1.md) named under
Rulings below; everything else there still holds.
Visual map: https://claude.ai/artifact/PAUmZ7J8c8xuhU9sgmwQdj.

## Goal

One follow-up can be followed from the meeting to done without losing your
place. Today a follow-up shows through six partial views (the decision page's
impact card, Tell the owners?, Home's Update row, the item card, Your open
items, a decision's Open items), only one of which opens it, and each action
takes you somewhere else.

Target: two places.

- **Meeting follow-ups.** Every follow-up of one meeting, grouped by status.
  Sending, dismissing and changing owners happen here and the result shows
  here.
- **Item page.** One follow-up: why it is there, its owner, its status, what
  happened to it, and the one next action. Every row anywhere opens it.

Home stays the inbox of what waits on you; each of its rows opens one of the
two. "Follow-ups" (in the sidebar) is the same list over everything you sent
or own.

## What people see

Four things per follow-up, nothing else by default:

- **Status**: Not sent, Open, Done or Dismissed (the stored states `unsent`,
  `open`, `done`, `not_relevant`).
- **Owner**: a person, or "Pick owner" while ECHO found no one. Changeable
  wherever the viewer may change it, before and after sending.
- **Why it's here**: for a meeting action, its line ("Meeting action · from
  Pilot planning, Oct 6") says it, with nothing repeated under it; for a
  document, what it says now (with its tool's status, due date and assignee
  in one faint line) against what the meeting decided.
- **One next action**: Send, Mark done or Reopen.

Kept underneath: the last check's verdict (one faint line on the item page,
and a faint "matches now" on a list row), how ECHO matched the owner, access
rules, check runs and sweeps, and rolled-up counts such as "handled".

## What a follow-up is

A follow-up is either an action the approved meeting decided, or an existing
document ECHO's impact check found the meeting affects. Both are open items in
`authority_impact_items_v1`, made when the impact run finishes, and share the
statuses, the list and the item page.

- **Meeting action** (kind `action`): one per action in the approved brief.
  Pointer `{ kind: 'meeting_action', record_sha256, signal_id }`; `relation`
  `needs_updating`; `expected` is the action's text as one line of at most 120
  characters. Its owner is the name the approver confirmed on Approve, matched
  to the one active member with the same display name, ignoring case and
  spacing, else the approver (shown as "Pick owner"). Never read live, never
  swept: it is closed by hand.
- **Document** (kinds `ticket`, `page`, `slack_message`, `record`,
  `document`): as before, except that the meeting's own record is never a
  follow-up of itself.

## Rulings

- F1. **Sending is selecting.** `send` takes any non-empty subset of a run's
  unsent items. Listed with `include: true` they go to their owners (`open`);
  listed with `include: false` they are dismissed (`not_relevant`); unlisted
  items stay Not sent. A listed item that is not unsent makes the send stale.
  Replaces "unticked → not relevant" (v1 §5, ruling 13's stamp still holds for
  a dismissed item). A desktop that lists every unsent item behaves as before.
- F2. **Owners before sending.** The approver may `assign` an unsent item they
  may send; the owner is stored at once (`owner_match = picked`). After Send,
  `assign` works as before (`reassigned`). Send's per-item pick still works.
  Picking the approver for an item that fell back to them is stored too, so
  it no longer shows "Pick owner"; any other pick of the current owner
  changes nothing.
- F3. **Who and when.** Every item view carries `state_set_by`,
  `owner_set_at`, `owner_set_by` and `send_included` (the stored column: null
  while unsent, true when Send included it, false when Send dismissed it).
  The desktop shows "Done · ECHO 2", and dates a reassigned item from its
  reassignment, not its first send.
- F4. **History without a schema change.** The item page lists the latest
  event of each kind (found, sent or dismissed, owner set, state set) from the
  item's own columns. A full event log needs a new table and waits for the
  next baseline.
- F5. **Every row opens the item page.** Home's Update and Review rows, list
  rows and notifications all open it; no row closes an item in place. Replaces
  rulings 3 and 20 and R67's "changed only".
- F6. **Results stay in place.** Send, Dismiss, owner changes, Mark done and
  Reopen keep the page you are on and say what happened there ("Sent to ECHO
  2", "Done · Undo"). Undo after Mark done or a Dismiss of an open item
  reopens it. A Send cannot be undone and a dismissal before sending cannot
  return to Not sent (the V14 triggers forbid both); a dismissed-before-sending
  item offers "Send to <owner>" instead, which reopens it to its owner.
- F7. **One status vocabulary.** Counts are by status: a meeting's line and a
  project's line both read "Follow-ups · 1 open · 4 not sent · 2 done". "Open"
  is one status only, never Not sent and Open together: their total, as a
  project's feed row shows it, is "4 follow-ups". A check verdict never
  removes an item from a count. Replaces R35's open count and the Impact
  line's "handled" and "couldn't read".
- F8. **Notify the owner.** Every five minutes while signed in, the desktop
  pages through `items` in `mine` scope with `states: ['open']` and
  `read: 'rows'`. It performs no live reads or sweeps. The first complete
  scan learns existing assignments; later scans notify new handoffs, including
  reopens. Home acknowledges only the rows it actually showed. Per-item
  handoff times prevent Home's display limit from hiding notifications.
  A failed page leaves the previous baseline intact for the next scan.
  Large batches are split into bounded notifications; a click opens the item
  page or Follow-ups for a batch.
- F9. **Projectless work is reachable.** "Follow-ups" is in the sidebar, and
  Home's footer (its link says "Follow-ups" too) shows even when you have no
  projects.

## API changes (`person-runs-v1`)

- `send`: subset semantics (F1); `RUN_ITEMS_MAX` covers affected rows plus
  meeting actions.
- `assign`: allowed on unsent items for the approver (F2).
- Item view: new kind `action`; new keys `state_set_by`, `owner_set_at`,
  `owner_set_by`, `send_included` (F3; null exactly while unsent).
- `home`: optional `read: 'rows'` (F8): no live reads, and `sweep_due`
  is always false, so a rows-only read never starts a sweep. It answers the
  same rows as a full `home`. Home's items come newest first by when each started waiting on the
  caller (the latest of `sent_at`, `owner_set_at` and `state_set_at`); changed
  items break ties. Notifications use the paginated items read independently
  of Home's 20-row display limit.
- `items`: optional `states`, a non-empty subset of `unsent`, `open`, `done`
  and `not_relevant`, replaces `open_only`. The page and its cursor go over
  those states only; the summary and stages still cover the whole scope.
  Yours and a project's list read current work (`unsent`, `open`) first, and
  each closed status only once its group opens, each with its own More, so
  current work is never behind closed items. A meeting's list reads every
  status in one read: its one check makes at most 40 items
  (`RUN_ITEMS_MAX`), and a page holds 50, so they all come in its first
  page.
- `items`, `home` and `item`: one optional `read` replaces `summary_only`.
  `read: 'rows'` answers the same page, cursor, summary and stages (or the
  same item) with no live read, every reach `not_read`; `read: 'counts'`
  (`items` only, never beside a cursor or `states`) answers the summary and
  stages alone. A list shows its rows from a rows read at once and reads live
  only the rows it shows; after a change to one item it reads that item as
  rows and the counts again, and keeps what it last read live of each row.

The response validators check exact keys, so a desktop older than this change
cannot read item views from an Authority that has it. Deploy the Authority and
publish the desktop update together.

## Not in this version

- A full per-item event log (F4).
- Undoing a Send, and returning a dismissed item to Not sent (F6).
- Action due dates on the item page: the stored line carries the action text
  only.
- Action items for meetings approved before this change: items are made when
  an impact run finishes.
- Follow-ups from a failed or timed-out impact check: it makes none, the
  meeting's actions included, until Try again succeeds (the V14 insert
  trigger accepts items only for a finished run).
- Notifications outside the desktop (Slack, email).
