# Private meeting intake and per-item routing (v1)

Status: direction agreed in conversation on 2026-10-24. The founder asked for
the whole change built end to end, in parallel, and will validate the result;
the written-spec review is waived. Rulings made while writing are listed at the
end. Decision record: [ADR-0046](../decisions/ADR-0046-private-meetings-and-item-routing.md).

## Goal

Meetings enter ECHO automatically and stay private. Sharing is a choice made
per item: each decision or action goes to its own project, to several, to the
reviewer alone, or nowhere. A meeting source only delivers meetings; it never
decides who can read them. Granola is one source; a pasted meeting is another.

The principle: remembering is automatic; sharing and commitments are
intentional.

## What changes for people

- Turning on automatic import needs no project and no Granola folder. "My
  meetings" brings in the meetings you recorded. A folder is an optional
  filter, and a project is an optional suggestion.
- Imported notes are yours alone until you approve items from them. A
  suggested project's members no longer read unapproved notes.
- A meeting with no decisions and no actions makes no card. It stays in your
  own context, searchable by you.
- The approval card gives every decision and action its own destination: Only
  me, one or more projects, or not kept. Destinations start from the meeting's
  suggestion, so when the suggestion is right, Approve is still one click. One
  control in the side panel changes every item at once.
- Each project sees only the items sent to it, with their supporting quotes.
  The full notes and the transcript are never shared from the card; the
  transcript checkbox is gone.
- In Slack, Approve sends every item to the suggestion. Choosing per item
  happens in the desktop app.
- Anyone can paste a meeting from any tool: title, optional date, notes, and an
  optional transcript. It gets the same card as a Granola meeting.

## Product rules this design follows

- Build for everyone: the pasted-meeting door works with any meeting tool.
- A suggestion is a pre-tick, never access (the confused-deputy rule: data
  read with one person's login is not released to a project by a container
  link).
- Audience equals association per record (ADR-0017), unchanged. A record never
  carries per-item permissions; a meeting with several destinations writes one
  record per destination.
- Owners need the approver (ADR-0021), unchanged.
- Approved records stay the only thing project members read from a meeting.
- The repository is public: fixtures stay fictional.

## The shape

```
any source ──► private custody ──► extract once ──► one proposal per meeting
(Granola watch,   (importer reads    (no card when       │
 pasted meeting)   it, nobody else)   no decision and    ├─► desktop card: a destination per item
                                      no action)          └─► Slack DM: approve as suggested
                                                                   │
                                     decide() ◄────────────────────┘
                                        │  one decision row, first click wins
                                        ▼
                      one signed record per destination group
                      (THERM · ECHO · THERM+ECHO · Only me)
                                        │
                      receipts written together, then one impact check per record
```

## Part 1: private intake, sources decoupled

### 1.1 Watch modes

A personal meeting source has one watch: `off`, `mine` or `folder`.

- `mine`: meetings the person captured (Granola `involvement.captured_by_me`),
  in a rolling window of the last 7 days.
- `folder`: meetings in one Granola folder, in the same rolling window.
- Either may name one suggested project. It pre-ticks destinations and grants
  nothing.
- One watching source per person, as today.

Turning a watch on records what is already in the window and imports none of
it (ADR-0030's no-history rule). After that, new meetings and edited meetings
are imported. A meeting is imported only after it has settled: its
`updated_at` is at least 10 minutes old, so a meeting that is still being
recorded is not extracted on every poll. A meeting with no `updated_at` counts
as settled.

### 1.2 The Granola list contract

`list_meetings` is called with `time_range: 'custom'`, `from_date`,
`to_date`, `limit: 200`, `involvement: { captured_by_me: true }` for `mine`,
`folder_id` for `folder`, and `cursor` while `pagination.has_more` is true.

The response, as observed live on 2026-10-24, is an optional
`<requested_range>` element, Granola's warning line, the `<meetings_data>`
element (its `count` is this page's count), and an optional `<pagination
has_more total_count remaining_count next_cursor />` element after it. Each
meeting carries `id`, `title`, `date`, `meeting_at`, `created_at`,
`updated_at`, `captured_by_me`, `listed_as_participant`, `url`, a
`<known_participants>` element that may carry `total` and `omitted`
attributes, and a `<folders>` element. Unknown attributes and elements are
ignored. An empty title is read as no title rather than failing the page.

At most 200 meetings fit the window; above that the watch fails closed with a
clear error. Change detection reads `updated_at` from the list and fetches
details only for new or changed, settled meetings. The normalizer's revision
no longer includes folder membership, so moving a note between folders is not
an edit.

Folder listing pages with `offset` up to 200 folders.

### 1.3 Who reads unapproved notes

Only the importing person, in global and Mine scope. Project scope never
includes unapproved imported notes. The suggestion tables stay as they are and
feed the card's pre-ticks only.

### 1.4 No card without decisions or actions

The processing state treats an extraction with no decision and no action
signal as `no_signals` (today only an empty extraction is). The meeting stays
in custody, readable by its importer, and no proposal is queued.

### 1.5 Desktop

The Granola sheet's automatic import becomes: Off, My meetings, or One folder
(with a folder picker), an optional suggested project, and the existing
consent. The line "Project members can read imported notes" goes. Adding one
meeting by hand keeps its optional suggested project.

## Part 2: per-item routing

### 2.1 What the card reads (`review_open`)

`review_open` returns structured items instead of the proposal text:

- `items`: every decision and action, in brief order (decisions first), each
  with `signal_id`, `kind`, `text`, `subject`, `status` (decisions), `due_at`
  (actions), `quotes`, `owner` and `owner_editable`, and `project_ids`.
  - Pending: `owner` is the grounded proposal and `owner_editable` is true
    when there is one; `project_ids` is the suggestion filtered to projects
    the reviewer can read now (`[]` = Only me).
  - Decided: `owner` is the confirmed owner, `owner_editable` is false, and
    `project_ids` is the chosen destination (`null` = not kept).
- `reasons`: every rationale with `signal_id`, `text`, `supports` and
  `quotes`.
- `participants`, `suggested_projects` (names for every project id the items
  name that the reviewer can read), and `records` (below).

The review rows of `reviews` gain `records`: the published records of a
decided approval, each `{ approval_id, project_ids }`. It is empty until the
approval is published.

### 2.2 What the card sends (`review`)

`review` carries `approval_id`, `command_id`, `snapshot_sha256`, `action`,
`routes` and `owners`. `project_ids` and `share_transcript` are gone.

- Approve: `routes` lists every decision and action signal of the frozen
  snapshot exactly once, in brief order, each `{ signal_id, project_ids }`
  where `project_ids` is `null` (not kept), `[]` (Only me) or 1 to 20 project
  ids, strictly ascending. At least one item is kept. At most 20 distinct
  projects across all routes. Owners name kept actions with a grounded
  proposal, in brief order.
- Reject: `routes` and `owners` are empty.
- The database trigger checks every routed project for the reviewer's active
  membership, as it checks `project_ids` today.

### 2.3 Records per destination group

The publisher groups kept items by their exact project set. Each group becomes
one record:

- Its subset snapshot holds only that group's decisions and actions, plus the
  rationales that support any of them, with `supports_signal_ids` pruned to
  that group. A rationale that supports nothing kept is dropped. A rationale
  that supports nothing at all goes to the Only-me group when there is one,
  and is dropped otherwise.
- Its record approval id is derived: `apr_` + the hex of
  `canonicalSha256({ kind: 'echo-approval-route-v1', approval_id, project_ids })`.
  The record log's one-record-per-approval rule then holds per destination,
  and the record log baseline does not change.
- It carries a new reference, `echo-approval-decision-ref-v2`, which replaces
  v1 (fresh state). It names the record's own approval id and
  `proposal_approval_id`, `proposal_snapshot_sha256` (what the reviewer saw),
  `approved_snapshot_sha256` (this record's subset), `route_signal_ids`, the
  group's audience as both audience and association, `share_transcript:
  false`, and the confirmed owners of this group's actions only.
- Groups are ordered by the first item of each in brief order.

Every group is built and validated before the first append. At append, the
record log's policy projector recomputes the group's subset, with the
publisher's own function, from the snapshot the reviewer saw (the append
witness carries it; the log never stores it), and refuses a record whose
content differs. Appends are deterministic, so a retry returns `duplicate`
for groups already in the log.
Once every group is in the log, one Authority transaction writes the receipt,
`{ records: [{ approval_id, project_ids, record_sha256, receipt }, …] }` in
group order, and runs the after-record hooks once per record. The approval is
`publishing` until then and `approved` after.

### 2.4 Impact checks and follow-ups

The after-record event names the record approval id, the proposal approval
id, the record digest, the reviewer and the decision time. The impact-check
hook enqueues one run per record with `event_ref` = the record approval id;
the database trigger finds that record in the decision's receipt. A run's
research desk never offers the meeting's other records (its siblings), their
transcripts, or the meeting's own source (its unapproved notes): researching
as the reviewer could read them, and the card's own words reach the record's
audience. A run never offers its siblings or their transcripts as follow-ups
either. Open items and follow-ups already work per record and follow each
record's audience.

### 2.5 Desktop

- The card lists decisions and actions with a destination chip on each. A
  chip opens Only me, the person's projects (several allowed), and Don't keep.
  The side panel has one "All items" control that sets every kept item, a
  one-line summary, Approve and Reject. The transcript checkbox and Seen by
  are gone. Approve needs at least one kept item.
- After approval, the page shows each destination with its own check and
  follow-ups, and the items with their final destinations.
- Home and the decision page match runs to an approval through its `records`.

### 2.6 Slack

The DM card keeps its owner inputs, shows where the items go in one line, and
offers Approve and Reject. Approve sends every item to the suggestion (Only
me when there is none). Its button carries a digest of the destination the
card shows; when the suggestion the reviewer can read has changed since (a
project joined or left), Approve decides nothing and the card is redrawn with
the new destination. Its fallback text says that choosing per item happens
in the ECHO desktop app. The closed card names the destinations.

## Part 3: hand in a meeting

- A production personal source, `hand-in`, exists for every member with no
  connection step. Its tool is always linked.
- `submit` with tool `hand-in` takes `title`, optional `started_at` (or a date
  for a whole-day meeting), `notes`, optional `transcript`, an optional
  suggested project, and `retain: true`. Notes or transcript must be
  non-blank. The payload is at most 60 KiB, inside the 64 KiB provider-route
  body limit.
- The external id is derived from the content, so pasting the same meeting
  twice is one meeting.
- The submitted payload and its queued import are saved in one Authority
  transaction (a V15 table), and the source pulls from that table.
- The desktop has a "Paste a meeting" sheet from the Tools page. Home shows
  meeting reviews whenever any meeting tool is there, not only Granola.
- The person CLI gets a matching verb that reads the text from files.
- The staging-only synthetic source stays owner-only and staging-only.

## Release

Authority V15 is fresh state only. Staging needs the reset (replace-rehearsal,
then initial-owner onboarding). The meetings API moves to `schema_version: 3`
because the request and response shapes change, so the Authority, the person
client and the desktop ship together.

## Rulings made while writing

1. Unapproved imported notes are readable by their importer only. This
   reverses ADR-0030's project read of unapproved notes.
2. The transcript is not shared from the approval card. Records carry
   `share_transcript: false`; ADR-0017's grant reader stays for its own sake.
3. Items kept for the reviewer become an Only-me record, searchable as the
   reviewer's approved decisions.
4. One record per destination group, not per item and not one record with
   per-item permissions.
5. Record approval ids are derived per destination, so the record log keeps
   its baseline.
6. The rolling window is 7 days, the settle time 10 minutes, and the window
   cap 200 meetings.
7. One impact check per record. A meeting with three destinations costs three
   checks; most meetings have one or two.
8. Person list and Mine show one row per record; grouping rows by meeting is
   a follow-up that needs a contract field.
9. A record with one project researches in that project's scope, where a
   meeting shared with two projects researched globally before.
10. The pasted-meeting payload stays within the existing 64 KiB route limit.
