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
  check lines follow each tool's live access. An ECHO `expected` line is
  written from the decision so the decision's audience may see it.
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
