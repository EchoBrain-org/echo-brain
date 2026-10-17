---
schema_version: 1
id: ADR-0033
kind: decision
title: Open items are one shared row per affected item, seen by the decision's audience
component_ids:
  - CMP-ORGANIZATION-AUTHORITY
  - CMP-PERMISSIONS
  - CMP-PERSON-CLIENT
created_at: 2026-10-08
reviewed_at: 2026-10-08
reviewed_ref: 814470f928db81112ffec1bc8d5d7f28795b9d0f
status: proposed
supersedes: []
superseded_by: []
updates:
  - ADR-0032
---

# ADR-0033: Open items are one shared row per affected item, seen by the decision's audience

## Context and options

ADR-0032 stores an approved record's impact card as a frozen, approver-only
run result. That is enough to show the approver what a decision changes, but
not to align a team on it: the affected items cannot change state, cannot be
found by owner or project, and nobody but the approver knows they exist. The
founder's pilot partner hits exactly this failure with manual alignment today:
an important follow-up that nobody is linked to is invisible to everyone.

Where follow-up state lives:

1. **Inside the run result.** No schema beyond V12, but a finished run is
   frozen and approver-only, so no status, no owners' view, no project view.
2. **A copy per person** (approver and each owner). Easy per-person queries,
   but one item's status lives in several rows that must be kept in step.
3. **One shared row per affected item (chosen).** Each person's view is a
   filter over the same rows; a click is immediately what everyone sees.

When an item enters the shared state:

1. **On Send.** The approver reviews first, but a decision whose approver
   never sends leaves its effects invisible.
2. **When the check finishes (chosen).** Everything ECHO found is visible at
   once, marked "not reviewed" until Send.

Who sees an item:

1. **Approver and owner only.** Narrow; no project view; keeps the gap.
2. **Everyone, as counts.** Leaks that confidential work exists and cannot
   be explained to anyone who cannot open the rows.
3. **The decision's audience plus the owner, with outside words behind each
   tool's live access (chosen).** Follows permissions the company already set:
   the decision's audience in ECHO, and each tool's own access for its words.

## Decision and consequences

As specified in
[open items and Home v1](../product/2026-10-08-open-items-and-home-v1.md):

- `authority_impact_items_v1` holds one row per `conflicts`,
  `needs_updating` or not-assessed item, written in the impact run's finishing
  transaction, `unsent`, always with an owner (the exact match, else the
  approver). Send moves rows to `open` or `not_relevant`; only a person's
  click changes state afterwards.
- The latest sweep result is one shared value per item; newest wins. Sweep is
  a second trigger in `authority_trigger_runs_v1`.
- Rows follow the decision's audience plus the owner. Item titles, text and
  current details follow each tool's live access; a sweep keeps only its
  verdict. An ECHO `expected` phrase is written from the decision so the
  decision's audience may see it.
- The run's `view` widens from the approver to everyone who can read the
  decision (updates ADR-0032).
- Every see and act question is answered by one access policy function, and
  the database enforces structure only. The founder treats this round's rules
  as a foundation: later organization rules change that function, not the
  storage.

Consequences: rows store no outside text, so every item view costs one live
read per item shown (at most 50 per call). Checks run only from a signed-in
desktop, so freshness depends on someone involved opening ECHO. One live run
per person means sweeps queue behind impact checks.

## Migration, rollback, and evidence

- Ships in Authority baseline V13 with a staging reset; the founder confirmed
  on 2026-10-08 that all current data is disposable.
- Rollback: V12 images cannot read V13 state; no data outlives the reset.
- Evidence: tests that items are written once per run in its transaction,
  that the access policy gives each role the specified answers, that no new
  row holds seeded outside text, that a sweep never changes state, and the
  desktop end-to-end path from approval through Send to an owner's Done.

## Implementation note, 2026-10-08

Built as decided above, in both parts of
[open items and Home v1](../product/2026-10-08-open-items-and-home-v1.md).
Details the decision text does not spell out:

- Send records, once per item, whether it included the item
  (`send_included`), and a repeated Send answers its original counts. An
  owner who cannot read the decision sees an item once it has reached them:
  Send included it, or it is open or done after Send (someone reopened an
  item Send left out).
- The access policy is three functions in `open-items-policy-v1.ts`: one per
  item, one for Send, and one for whether a viewer sees a decision's parts.
  Every open-items operation asks them. The run's `view` does not yet: it
  checks itself that the viewer is the approver or reads the decision now,
  so an approver keeps the card after losing read access to the decision
  (the spec's "Not in this round").
- A last check is a verdict, its time, who ran it and which sweep. The
  database refuses any change to them that is not strictly newer. A sweep run
  stores only its counts by verdict.
- A sweep takes up to 20 of the open items the caller sees in its scope,
  never-checked first. It names the decision to research only when the caller
  can read the decision. The server refuses to start a sweep (`busy`) while
  one of the person's impact runs is pending or running, so impact runs go
  first. `home` says a sweep is due at most once an hour per person (a sweep
  left pending longer does not hold it back); a sweep the person asks for
  directly is not limited. The runs list holds at most the 20 newest sweeps
  and fills the rest of its 100 with impact runs, so however often sweeps
  run, at least 80 places stay for impact runs and their Try again.
- Items on a Slack message are not swept and never make a sweep due: no
  reader in ECHO can open a Slack message citation yet, so a sweep could only
  record them unreadable.

## Implementation note, 2026-10-16

The research fixes the founder approved on 2026-10-16 change these details
of the decision and the note above, as
[open items and Home v1](../product/2026-10-08-open-items-and-home-v1.md)
now specifies (rulings R77–R82). The choices themselves stand.

- A row no model assessed (the impact card's fallback) is only possibly
  affected and makes no item (R82). `authority_impact_items_v1` gets rows for
  `conflicts` and `needs_updating` items only, never for the meeting's own
  record or the transcript its approver shared. A row made earlier from a
  card that was not assessed keeps its empty relation.
- "Newest wins" holds among judged verdicts. `unreadable` never replaces
  `landed`, `still_open` or `changed`, from anyone, and a judged verdict
  replaces an `unreadable` one whenever that was made (R79). Since the
  database lets a last check only move forward, a judged check that replaces
  a later unreadable one is stamped 1 ms after it.
- A sweep run stores its counts by verdict and the ECHO ids of the items it
  could not read, so Home does not ask the same person to sweep them again
  within the day; still no line, title or citation.
- A sweep covers a ticket or a page only in a tool its caller has connected
  (R78), and runs no planner (R77). It puts an item one of the caller's
  sweeps of the last day could not read after all the others, and Home waits
  a day from that sweep before such an item makes a sweep due again.
- While the search index lags the record log, `start` holds a pending impact
  run or sweep: it answers `pending` with no claim, attempt or trace
  ([runs store and impact card v1](../product/2026-10-07-runs-store-and-impact-card-v1.md)).

## Implementation note, 2026-10-16: follow-ups in Ask

[ADR-0040](ADR-0040-follow-ups-as-ask-evidence.md) makes these rows an Ask
source on V7 answers. It reads them through this record's access policy and
the same assessment and live-read path as `items`, so a person sees in Ask
exactly the follow-ups, decisions and outside words that `items` shows them.
It adds no table, column or state and never changes an item. Ask matches words
only in what ECHO holds, and reads an outside title live only for the rows it
returns.
