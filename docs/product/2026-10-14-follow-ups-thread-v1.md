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
two. "Your follow-ups" is the same list over everything you sent or own.

## What people see

Four things per follow-up, nothing else by default:

- **Status**: Not sent, Open, Done or Dismissed (the stored states `unsent`,
  `open`, `done`, `not_relevant`).
- **Owner**: a person, or "Pick owner" while ECHO found no one. Changeable
  wherever the viewer may change it, before and after sending.
- **Why it's here**: for a meeting action, "Decided in the meeting"; for a
  document, what it says now against what the meeting decided.
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
  to the one active member with exactly that display name, else the approver
  (shown as "Pick owner"). Never read live, never swept: it is closed by hand.
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
  `owner_set_at`, `owner_set_by` and `reached_owner` (the policy's
  `sent_to_owner`). The desktop shows "Done · ECHO 2", and dates a reassigned
  item from its reassignment, not its first send.
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
- F7. **One status vocabulary.** Counts are by status: "1 open · 4 not sent ·
  2 done". Open means unsent plus open everywhere a total is shown; a check
  verdict never removes an item from a count. Replaces R35's open count and
  the Impact line's "handled" and "couldn't read".
- F8. **Notify the owner.** The desktop checks Home quietly
  (`home` with `rows_only: true`, no live reads) every five minutes while
  signed in, and shows a system notification for each follow-up that newly
  waits on you; clicking it opens the item page. The first check after sign-in
  only learns what is there.
- F9. **Projectless work is reachable.** "Your follow-ups" is in the sidebar,
  and Home's footer shows even when you have no projects.

## API changes (`person-runs-v1`)

- `send`: subset semantics (F1); `RUN_ITEMS_MAX` covers affected rows plus
  meeting actions.
- `assign`: allowed on unsent items for the approver (F2).
- Item view: new kind `action`; new keys `state_set_by`, `owner_set_at`,
  `owner_set_by`, `reached_owner` (F3).
- `home`: optional `rows_only: true` (F8): no live reads, and `sweep_due`
  is always false, so the quiet check never starts a sweep.

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
- Notifications outside the desktop (Slack, email).
