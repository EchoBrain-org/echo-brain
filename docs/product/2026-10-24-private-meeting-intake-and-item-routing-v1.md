# Private meeting intake and per-item routing (v1)

Status: direction agreed in conversation on 2026-10-24. The founder asked for
the whole change built end to end, in parallel, and will validate the result;
the written-spec review is waived. Rulings made while writing are listed at the
end. Decision record: [ADR-0046](../decisions/ADR-0046-private-meetings-and-item-routing.md).
Shipped in #360 (915761c), with ruling 22's quote fix in #362 (8cc3fff).
Shipped is not deployed or qualified.
[Quieter Ask and Only me v1](2026-10-26-quieter-ask-and-only-me-v1.md) (#369)
later added items kept private inside a project, and replaced section 2.5's
destination chip with a place button and an Only me lock.

Surface retirement, 2026-11-01: the Paste a meeting UI and new `hand-in`
submissions described below are retired, without moving them into Capture.
Previously retained and queued hand-ins keep their source identity and custody.
Native reviews now use provider-independent `person reviews` requests, so they
remain available without a connected meeting tool. The remainder records the
original intake and routing design.

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
- Each project sees only the items sent to it, without quotes: a quote is the
  note line or paragraph an item cites, which can speak of other items. A
  project's record keeps where each item came from (meeting and block), and
  only an Only-me record keeps its quotes (ruling 22). The full notes and the
  transcript are never shared from the card; the transcript checkbox is gone.
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
  record per destination. (ADR-0049 later adds items kept for the reviewer
  alone inside projects: their record's projects are its association only.)
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

`review_open` also takes one of those record approval ids (a run's
`event_ref`, which a follow-ups list links) and opens the proposal's review,
whose `review.approval_id` is the proposal's. It resolves through the
decision's receipt, for the reviewer who decided it only; `review` takes the
proposal's approval id alone.

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

- Its subset snapshot holds only that group's decisions and actions and the
  rationales for them. A rationale's text may speak of any item it supports,
  so a project group takes a rationale only when every item it supports is in
  that group. The Only-me group, which only the reviewer reads, takes every
  rationale that supports one of its items, with `supports_signal_ids` pruned
  to that group, and every rationale that supports nothing at all. Any other
  rationale is dropped: one shared by items with different destinations, or
  by an item not kept, reaches no project.
- A project group's evidence spans keep `meeting_id`, `block_id` and their
  times but drop `quote`, on its decisions, actions and rationales alike. A
  quote is the text of the evidence unit the item cites (a note line, or up
  to a few hundred characters of a paragraph or turn), so it can speak of any
  item of the meeting, including one routed elsewhere, kept for Only me, or
  not kept. The Only-me group keeps its quotes.
- Its record approval id is derived: `apr_` + the hex of
  `canonicalSha256({ kind: 'echo-approval-route-v1', approval_id, project_ids })`.
  The record log's one-record-per-approval rule then holds per destination.
- It carries a new reference, `echo-approval-decision-ref-v2`, which replaces
  v1 (fresh state). It names the record's own approval id and
  `proposal_approval_id`, `proposal_snapshot_sha256` (what the reviewer saw),
  `approved_snapshot_sha256` (this record's subset), `route_signal_ids`, the
  group's audience as both audience and association, and the confirmed owners
  of this group's actions only. It has no transcript fields.
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
  Cancelling the queued import deletes the payload in the same transaction,
  unless an admitted source revision already holds the meeting.
- Line breaks of any kind become line feeds and other invisible control
  characters are dropped before the id is derived, so no paste fails on them.
- A whole day is its date at noon UTC, read in UTC: review rows carry
  `all_day`, and the card and Home show that date with no time of day.
- The importer reads a pasted meeting's transcript with its notes, since they
  supplied it; a Granola transcript stays out of the importer's reads.
- The desktop has a "Paste a meeting" sheet from the Tools page. Home shows
  meeting reviews whenever any meeting tool is there, not only Granola.
- The person CLI gets a matching verb that reads the text from files.
- The staging-only synthetic source stays owner-only and staging-only.

## Release

Authority V15 and record log V5 are fresh state only. Staging needs the reset
(replace-rehearsal, then initial-owner onboarding), which empties the record
log too. The meetings API keeps `schema_version: 2`:
its request and response shapes change, and the Authority, the person client
and the desktop check exact shapes and negotiate no version, so a mismatched
client fails as an invalid request with or without a new number. They ship
together.

## Rulings made while writing

1. Unapproved imported notes are readable by their importer only. This
   reverses ADR-0030's project read of unapproved notes.
2. The transcript is not shared from the approval card. (Superseded while
   building, ruling 18: the whole transcript-sharing path is removed.)
3. Items kept for the reviewer become an Only-me record, searchable as the
   reviewer's approved decisions.
4. One record per destination group, not per item and not one record with
   per-item permissions.
5. Record approval ids are derived per destination, so the record log's
   one-record-per-approval rule holds without a schema change for routing.
6. The rolling window is 7 days, the settle time 10 minutes, and the window
   cap 200 meetings.
7. One impact check per record. A meeting with three destinations costs three
   checks; most meetings have one or two.
8. Person list and Mine show one row per record; grouping rows by meeting is
   a follow-up that needs a contract field.
9. A record with one project researches in that project's scope, where a
   meeting shared with two projects researched globally before.
10. The pasted-meeting payload stays within the existing 64 KiB route limit.

## Rulings made while building

The founder asked for the build end to end and for stale code to be removed;
these were decided while building and reviewing it.

11. A watch stamps when it changed. Its first pass records only what the
    window held before that moment, so a meeting that ends between Save and
    the first pass is still imported. Changing only the suggested project
    keeps change detection; Save updates an active watch.
12. A meeting Granola can never give (unusable output) is passed over at its
    listed version, at most five per pull, and the watch moves on; an outage,
    a rate limit or changed access still fails the pull. Titles, participant
    lists and transcripts are trimmed to their caps instead of failing.
13. A transcript Granola says is pending is left for a later pull, without
    passing the meeting over. A meeting with no transcript (`no_transcript`,
    `transcript_deleted`) imports with its notes and summary alone.
    Transcripts are read in 80,000-character pages up to the 256 KiB kept.
14. The 200-meeting window cap is checked at Save and has its own status line.
15. A whole-day pasted meeting is its date at noon UTC; review rows carry
    `all_day`, and the card and Home show the UTC date only. The importer
    reads a pasted transcript with its notes, since they supplied it.
    Cancelling a queued paste deletes its payload unless custody holds it.
16. At append, each destination record is recomputed from the snapshot the
    reviewer saw and must match. Slack's Approve carries a digest of the
    destination its card showed; a different suggestion at click time is
    stale and redraws the card.
17. An impact run's research is fenced off from its meeting's other records
    and from the meeting's own unapproved notes, not only from its follow-up
    candidates. `review_open` also accepts a record's approval id, so a
    follow-up's Approved link opens its meeting even outside the newest 100
    reviews.
18. Transcript sharing is removed, not kept dormant: the grant writer and
    reader, Ask's reach over shared transcripts, the transcript open and list
    kinds, the `person transcript` verb, the desktop's transcript source kind
    and the record's transcript fields. Record log V5 drops the grant table.
    The research-loop eval cites only what a project member can read.
19. The meetings API keeps `schema_version: 2` (see Release).
20. An impact card's unconfirmed notes name no item: an item research saw and
    could not read is counted, and storage keeps only notes of ECHO's fixed
    shapes, since every viewer of the record reads them unfiltered. The
    research of a record shared beyond its approver leaves out what only the
    approver may see (Only-me records, private notes and documents, unapproved
    meetings), so no model-written card line or follow-up phrase can carry it.
    These fences and those of ruling 17 apply inside each store before its
    result limit, so a fenced item never takes the place of one the run may
    read.
21. A rationale reaches a project's record only when that record holds every
    item it supports (section 2.3). Its text can speak of any of those items,
    so one shared with an item routed elsewhere, kept for Only me, or not kept
    reaches no project; the Only-me record keeps it when it supports an item
    kept there.
22. A project's record carries no quote (section 2.3). An item quotes the
    evidence unit it cites, not words chosen for that item: a one-paragraph
    pasted note is one unit, so every item of it quotes the whole note, and an
    item can cite a line about another item. A live test released another
    project's decision and an Only-me item, inside the quote of a shared
    decision, to a member of the shared project through `person records` and
    the desktop record view. The record list returns the signed record whole,
    so the quote is removed at publishing, in the subset function the publisher
    and the append projector share. Records signed before this ruling keep
    their quotes; their recovery is a founder decision.

Known and left for the founder:

- An impact check of a shared record still reads outside tools (Jira,
  Confluence, Slack) with the approver's own access, and a record shared with
  two or more projects researches globally, so it can read items of the
  approver's other projects. Outside titles are removed from what is stored and
  rows are hidden per viewer, but a model-written line could still paraphrase
  such an item for the record's audience. Closing that means researching only
  what every member can read, a product decision (ruling 20 closed the
  approver's private ECHO items).
- Ask's prompts and source descriptions still mention shared transcripts.
  They are pinned byte for byte by ADR-0041's test and two quality baselines,
  so they change with a reviewed prompt change.
- The HUMAN_ACT v1 record codec stays: the authority-core eval's capacity
  corpus relies on its organization-readable records.
- Two different destinations can read alike in the card's summary line
  ("1 to THERM +1 · 1 to THERM +1"); the counts are right, and the labels stay
  short by design.
