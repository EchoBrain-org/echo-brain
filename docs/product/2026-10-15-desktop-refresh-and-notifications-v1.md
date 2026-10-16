# Desktop refresh and notifications v1

Date: 2026-10-15. Status: approved by the founder for build (Tier 1 + Tier 2);
the founder validates the finished result. Decision record:
[ADR-0036](../decisions/ADR-0036-person-change-check.md). Replaces F8 of
[follow-ups thread v1](2026-10-14-follow-ups-thread-v1.md) and its definition
of Follow-ups.

## Why

On 2026-10-15 the founder's Mac added ECHO 2 to a project (23:03:50Z) and sent
it a follow-up (23:04:13Z). The Linux ECHO 2 window kept focus, so it never
recorded a departure. A Home click at 23:04:18Z showed the follow-up but not
the project. The sidebar caught up at 23:06:15Z, on the first "came back"
refresh.

The desktop has no way to learn of another person's change except by window
lifecycle:

- A came-back refresh runs only after a recorded departure. That departure is
  macOS app activation, or on Linux a window blur with no ECHO window focused
  150 ms later.
- A window-shown refresh (tray, shortcut, notification) refreshes a different
  set of surfaces from a came-back refresh.
- Navigation never refreshes the sidebar.
- The follow-ups list and item page, the open project and Mine are not re-read
  on return.
- Home never re-reads handoffs while it stays open.
- The five-minute quiet check reads every open follow-up but only notifies the
  owner. The person who sent a follow-up is never told what happened to it.

## Goals

1. **Pull, matching the CLI.** What you look at is read from the server when
   you look: when you open a page, when the window comes forward, and when you
   come back. This includes the frame around it: the sidebar and your role.
   It behaves the same on macOS and Linux, never depends on focus, and needs
   no Refresh button.
2. **Push for what involves you, quietly.** A change someone else makes to a
   follow-up you are involved in reaches you within about a minute, as a
   system notification plus an updated screen. So does being added to a
   project. Nothing else notifies.

## Not in v1 (and what would bring each back)

- **Seconds-level delivery** (a long-poll or stream on the change check).
  Revisit when ECHO gains chat-like features or a pilot needs sub-minute
  handoffs.
- **A server-side participant list and notification inbox.** This would cover
  a full hand-on chain, notifications for changes made while ECHO was closed,
  several devices per person, and a Slack copy. It needs new tables, which
  means a staging data reset. Revisit on a missed handoff in a pilot, or with
  the next planned reset.
- **"Who added you" in a project-add notification.** Project memberships do
  not record who granted them, so this needs a schema change.
- **An index on `owner_set_by`.** It comes with the next planned reset.
- **An `account` area** (organization role or deactivation). A deactivation
  already fails the next call. A role change still shows on sign-in.

## 1. Server: the change check (Tier 2)

### 1.1 Route and CLI

- **Route.** `GET /v1/person/changes`, authenticated like every Person route.
  The answer is `echo-person-changes-v1`
  ([`packages/organization-api/src/person-changes-v1.ts`](../../packages/organization-api/src/person-changes-v1.ts)):

  ```json
  { "kind": "echo-person-changes-v1",
    "areas": { "projects": "sha256:…", "follow_ups": "sha256:…", "reviews": "sha256:…" },
    "check_again_after_seconds": 60 }
  ```

- **CLI.** The person client gains `changes`, a read with no flags, which prints
  that object as its last JSON line. An Authority without the route answers 404.
  The client reports that as failure code `not_supported`, distinct from
  `not_found`.
- **Desktop host.** It calls it as `changes.read`. That wiring is in the
  contract commit.

### 1.2 Areas

Each area is the SHA-256 of a canonical JSON array of sorted tuples, built only
from rows the caller may read under the same policy as the matching read:

| Area | Tuples | Moves when |
|---|---|---|
| `projects` | `[project_id, name, status, role]` for every project the caller is an active member of, active and archived | Added or removed, a rename, an archive, a role change |
| `follow_ups` | `[item_id, state, owner_membership_id, owner_set_at, state_set_at, sent_at]` for every item the caller is **involved** in and may read | A send, a handoff, a reassignment, a done, not-relevant or reopen |
| `reviews` | `[approval_id, status]` for the meetings waiting for the caller's review, as `tools.meetings` `reviews` lists them | A meeting is ready for you, or a review is decided |

- **Involved** means the item's approver (the person who sent it), its owner,
  or its `owner_set_by` (the last person to hand it on). The item must also be
  visible to the caller by the same rows-only policy pass that `runs items`
  uses.
- **Checks are left out** (`checked_*`). A sweep must not wake every desktop.

### 1.3 Privacy (ADR-0012)

- A fingerprint is a digest of rows the caller can read. It never moves with
  activity they cannot see.
- There is no global position or counter, and no substitute for one.
- A test proves it: another person's change to an item or project the caller
  cannot read leaves every one of the caller's fingerprints unchanged.

### 1.4 Cost, audit and pace

- **Database only, no live reads.** Each check runs in one Authority read
  transaction with no `BEGIN IMMEDIATE`, and makes no Jira, Confluence or
  Granola call. The record check reads the record log on its own connection,
  as every record read does.
- **No audit row.** The check returns no content. The project list reads it
  triggers (when `projects` moved, and at the first check after sign-in or
  start, until one full read succeeds) are still audited as today.
- **The server sets the pace.** `check_again_after_seconds`: the Authority
  answers 60 today; the field lets a later Authority ask for longer; clients
  honour 15..3600.
- **Known scan.** The `owner_set_by` part of involvement has no index, so it
  scans the organization's items. That is acceptable at pilot size.

### 1.5 The `involved` scope

- `runs` `items` gains the scope `involved`. Like `mine`, it takes no id.
- It lists what `mine` lists (approver or owner) plus items whose
  `owner_set_by` is the caller, filtered by the same visibility pass. It pages
  and orders exactly as `mine` does: oldest first by creation, 50 a page. A
  change to an old item does not move it up, so a reader that looks for
  changes reads every page.
- `read: 'rows'` and `states` behave as for `mine`. Sweep scopes are unchanged.
- `changed_since` (a UTC millisecond time; `mine` and `involved` only, never
  with `counts`) lists only items whose latest send, handoff or state change
  is at or after it, chosen before the scope's bound; it narrows the page and
  its cursor like `states`, never the summary.
- The validator change is in the contract commit; the server implements the
  query.

### 1.6 Compatibility

- **Exact-key validators.** The desktop and the person client validate exact
  keys, so the Authority is deployed with or before the desktop release.
- **Older Authority.** A desktop talking to an older Authority gets
  `not_supported` from `changes.read`. That one answer also stands for
  `involved` and `changed_since`, which ship with the change check: the
  desktop then runs the fallback in R8 and never asks for either.
- **No schema change and no data reset.**

## 2. Desktop: one refresh rule (Tier 1)

- **R1. One freshness module.** `src/renderer/freshness.ts` owns the change
  check loop, the last fingerprints, and what each area's move re-reads. The
  surfaces keep their existing loaders. Their scattered refresh triggers
  (resume, windowShown, the quiet check) are replaced by calls into this
  module, and main's window events by one `window.state` (`onScreen`,
  `front`), sent when either changes.
- **R2. When a check runs.**
  - *Sign-in or start:* every page of your projects is read at once, and fills
    the sidebar. This first check learns the baseline from that read, your open
    follow-ups, and those closed since their newest change, and never
    notifies.
  - *Timer:* every `check_again_after_seconds`. After a failure it backs off up
    to 5 minutes, never sooner than the pace the server set; it is never faster
    than 15 s.
  - *Came back:* the window on screen and in front again (from another app,
    the tray or the shortcut, minimized, or covered by other windows), on both
    platforms, with no recorded departure required.
  - *Navigation to any page:* at most one check per 10 s from navigation.
  - *System wake:* main sends `system.woke` on `powerMonitor` `resume`.
  - *Signed out or account switch:* the loop stops or restarts.
- **R3. What a moved area re-reads.**
  - *`projects`:* every page of your projects, active and archived, is read
    side by side, to find the ones you were added to (N2), however far past
    the sidebar's pages they sort. The same read feeds the sidebar as many
    pages as it showed, with More going on from there. This full read happens
    only then and at sign-in, since each page is audited.
    - The open project's header (name, role, status) is then taken from the
      fresh sidebar row.
    - If the open project is gone, ECHO goes Home and shows a toast that you
      no longer have access to it.
  - *`follow_ups`:* every page of the open `involved` rows, and of the closed
    `involved` rows changed since the newest change the last read saw
    (`changed_since`, on the Authority's clock; from the start until a change
    was seen, never the desktop's clock), is read rows-only, side by side.
    `involved` pages oldest first by creation (section 1.5), so a change can be
    on any page and there is no early stop. Each open row is compared with the
    row the last read had. An item that is no longer among them is settled by
    the closed read when it is there; otherwise it is read by its id,
    rows-only, to say what happened to it (twenty a check; the rest, and any
    whose read failed, at the next). A follow-up sent and closed between two
    checks is told; one already handled is never told twice. These reads feed
    notifications (section 3). Whatever follow-ups surface is on screen is
    then re-read quietly: Home, the Follow-ups list, an item page, a project's
    follow-ups line, or a meeting's impact line.
  - *`reviews`:* Home and the decision page are re-read if on screen.
- **R4. Came back is one handler on both platforms.** Each time the window is
  on screen and in front again, it does three things once:
  - It reads status.
  - It runs a check, side by side with the status read.
  - Then it quietly re-reads the page on screen, with what the check found
    moved:
    - Home;
    - the Follow-ups list or item page;
    - the open project, meaning its feed's first page, its roster if open, and
      its line;
    - Mine;
    - Tools;
    - People & invites;
    - the sidebar, when its last read failed or the check could not say
      whether projects moved (it failed, or an older Authority, R8);
    - the bar's matches and an answer's sources.

  The reader keeps what it shows.
- **R5. Navigation.** The opened page reads as it does today, plus the
  debounced check from R2.
- **R6. Hidden or covered window.** Checks continue, so notifications still
  arrive. Screen re-reads are held until the window can be seen again (shown,
  restored or uncovered), then applied once.
- **R7. Privacy cover.** The cover shown while another app is in front stays
  exactly as it is, and actions stay blocked while covered. It no longer
  swallows refresh triggers: checks still run while covered.
- **R8. Fallback for an older Authority.** On `not_supported`, the module scans
  `mine` rows only, every five minutes and on wake, and notifies the N2 events
  among them; the sidebar is read again on came back or window shown. The
  Follow-ups list reads `mine` too, and no closed rows are read. It logs
  `changes unsupported` once, and checks again on the next start.
- **R9. Diagnostic log.** `desktop.log` records codes only:
  - `lifecycle conceal`, `lifecycle resume` (the window leaves or takes the
    front), `lifecycle shown` (it is on screen again), `lifecycle wake`;
  - `changes moved projects,follow_ups`, with area names only, never digests
    or ids, and `changes unsupported`.
- **R10. The five-minute quiet check is removed.** It is replaced by
  `follow_ups` handling, or by R8's fallback.

## 3. Notifications

- **N1. Involvement.** You are involved in a follow-up if you sent it
  (approver), own it, or were the last to hand it on (`owner_set_by`). You stay
  involved after handing it on until the next person hands it on; the full
  chain is deferred.
- **N2. What notifies.** Each case is notified only when that change was made
  by someone else, meaning its `*_set_by` is not you:
  - *Handed to you:* the owner became you. This includes a first Send to you.
  - *Completed, not relevant, or reopened:* the state changed on an item you
    are involved in.
  - *Handed on:* the owner changed to someone other than you on an item you
    sent or last handed on.
  - *Added to a project:* a project id is new among every project you belong
    to, active and archived, read in full (R3). It is not notified when it was
    created on this desktop, or when you lead it and it was created after the
    newest project of the last full read, on the Authority's clock, which is
    taken to be your own creation from elsewhere. With no project to measure
    against, one you lead is notified. A full read that fails part-way
    notifies nothing and keeps what the last one learned, so the next move
    notifies it.
- **N3. What never notifies:**
  - checks;
  - your own actions, from any device;
  - other activity in your projects;
  - meetings and reviews;
  - removal from a project;
  - role changes.

  These update the screen only.
- **N4. Noise.**
  - **One notification per check.** Two or more events become one summary
    ("3 follow-ups changed", "Added to 2 projects"). A follow-ups summary
    opens a list of exactly the follow-ups it counted, each read again by its
    id under your current access (one you can no longer read is left out);
    several project adds open the first of those projects. A summary counts
    and opens at most 100 follow-ups.
  - **An item whose page is open is not notified** while the window is
    visible and uncovered, but its page is refreshed.
  - **The first check after start or sign-in only learns.** After a wake, the
    in-memory baseline carries on, so changes made while the machine was
    asleep notify, in one summary.
- **N5. Wording and click targets.** Names are first names. Titles are each
  row's title, clipped as today.

  | Event | Text | Click opens |
  |---|---|---|
  | Handed to you | "Ana handed you *title*" | The item page |
  | Done / not relevant | "Ana marked *title* done" / "… not relevant" | The item page |
  | Reopened | "Ana reopened *title*" | The item page |
  | Handed on | "Ana handed *title* to Ben" | The item page |
  | Added to a project | "You were added to *Project*" | That project |
  | Several | "3 follow-ups changed" | A list of exactly those follow-ups |
  | Follow-ups and a project add | "2 follow-ups changed · added to 1 project" | The list of those follow-ups (one follow-up: its page) |
  | Several project adds | "Added to 2 projects" | The first of those projects |
- **N6. Plumbing.** Main's `notify.followUps` becomes `notice.show`, and its
  click event becomes `notice.open`: one generic notice.
  - It carries the text plus a click target, which is an item, the items a
    summary counted, or a project. Only a target this account was told of
    opens.
  - A click brings the window forward and opens that target.
  - Where the system has no notifications, nothing shows.

## 4. Testing

- **Organization API:**
  - the `echo-person-changes-v1` validator: exact keys, digests, seconds bounds;
  - the `involved` request validation.
- **Authority:**
  - each area moves on its listed changes and on nothing else;
  - the ADR-0012 privacy test (§1.3);
  - `involved` lists approver, owner and `owner_set_by` items and nothing
    unreadable;
  - no audit row and no live read;
  - an HTTP route test.
- **Person client:** the `changes` command, including 404 → `not_supported`.
- **Desktop unit tests, using the existing harness:**
  - every R2 trigger, on both platforms' lifecycle;
  - R3 re-reads for each area, and R4 for each page;
  - the hidden-window hold (R6);
  - the fallback (R8);
  - each N2 event and each N3 non-event;
  - coalescing, open-item suppression, and first-check learning;
  - the open project header following its sidebar row;
  - a lost project going Home.
- **Desktop e2e:** the 2026-10-15 scenario. B's window keeps focus, A adds B
  to a project, and within one check B's sidebar shows it and B is notified,
  with no click.
- **Final gate:** one `npm run check` on the integrated branch.

## 5. Rollout

- Deploy the Authority first, then publish the desktop release. The desktop
  tolerates an older Authority (R8).
- No schema change and no data reset.
