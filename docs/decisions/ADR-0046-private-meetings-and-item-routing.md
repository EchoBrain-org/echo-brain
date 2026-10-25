---
schema_version: 1
id: ADR-0046
kind: decision
title: Meetings stay private until each item is approved to its destination
component_ids:
  - CMP-ORGANIZATION-AUTHORITY
  - CMP-MEETING-PROCESSING-CORE
  - CMP-PERMISSIONS
  - CMP-PERSON-CLIENT
created_at: 2026-10-24
reviewed_at: 2026-10-24
reviewed_ref: 915761ccd0f53978ff461a8fc6403118d32fbd42
status: proposed
supersedes: []
superseded_by: []
updates:
  - ADR-0017
  - ADR-0021
  - ADR-0024
  - ADR-0030
  - ADR-0031
---

# ADR-0046: Meetings stay private until each item is approved to its destination

## Context and options

Today a Granola folder watch must name a project, and that project's members
read the meeting's unapproved notes (ADR-0030, as updated by ADR-0031).
Approval then signs one audience onto the whole meeting. That means:

- A container link in one tool decides a project audience. Data read with one
  person's login is released to a whole project before anyone reviews it.
- A meeting that covers several projects can only be shared whole, with every
  chosen project.
- The routing key is a Granola concept. Fathom, Zoom or a pasted transcript
  have no folders, so every new source would need a folder-like workaround.

The watch is also tight in practice: one folder per person, at most 50
meetings in it.

Options considered:

1. **Keep meeting-level sharing; add per-item drop.** Smallest. It does not
   handle a meeting that covers two projects, and keeps the folder grant.
2. **One record with per-item audiences.** Search, citations, Ask, open items
   and follow-ups would all have to filter inside a record. Every reader
   changes, and a missed filter leaks.
3. **Private intake, and one record per destination group (chosen).** Each
   record keeps exactly one audience, so every reader works as it does today.
   Only the decision request, the publisher and the receipts change.

## Decision and consequences

Adopt option 3, as specified in
[private meeting intake and per-item routing v1](../product/2026-10-24-private-meeting-intake-and-item-routing-v1.md):

- **Intake is private.** A watch is `off`, `mine` (meetings the person
  captured, last 7 days) or `folder` (a filter). A project at watch or import
  is a suggestion that pre-ticks destinations and grants nothing. Unapproved
  imported notes are readable by their importer only, never in project scope.
  This reverses ADR-0030's project read of unapproved notes.
- **No card without a commitment.** An extraction with no decision and no
  action makes no proposal; the meeting stays private context.
- **Routes per item.** An approval names a destination for every decision and
  action: not kept, Only me, or 1 to 20 projects. The decision table keeps one
  row per proposal; the first decision still wins across surfaces.
- **One record per destination group.** Kept items are grouped by their exact
  project set. Each group is one signed `echo-approval-decision-ref-v2` record
  holding only its items and their supporting rationales (a project's record
  takes a rationale only when it holds every item the rationale supports, and
  keeps each item's source reference but none of its quotes, since a quote can
  speak of other items; Only me keeps them), with
  a derived record approval id, so the record log keeps one record per approval
  id. Audience equals association per record (ADR-0017), unchanged. Every
  group is validated before the first append, and the receipts of all groups
  are written in one Authority transaction.
- **No transcript sharing.** Nothing shares a transcript, so the whole
  transcript-sharing path goes: ADR-0017's explicit release at approval and its
  grant table, ADR-0021's Ask reach over shared transcripts, and ADR-0024's
  transcript open kind. Records carry no transcript fields.
- **Slack approves as suggested.** Per-item choice happens on the desktop.
- **A pasted meeting is a source.** Every member can hand in a meeting's notes
  and optional transcript. It enters private custody and gets the same card.

Consequences: one impact check runs per record, so a meeting with several
destinations costs several checks. Person list and Mine show one row per
record. A record with one project researches in that project's scope.

## Migration, rollback, and evidence

- Fresh state only: Authority baseline V15 and record log baseline V5, which
  drops the transcript grant table. Existing state is refused at startup;
  staging is reset by the founder's replace-rehearsal procedure, which empties
  the record log too, so neither the v1 reference nor any grant has records to
  read.
- The meetings API's shapes change under `schema_version: 2`; the Authority,
  the person client and the desktop check exact shapes and ship together.
- Rollback is the previous image on its own retained state.
- Evidence: acceptance tests for private reads, watch modes and the Granola
  list contract, routes validation and its database trigger, multi-record
  publishing and its retry, impact runs per record without sibling
  follow-ups, the Slack approve-as-suggested path, the pasted-meeting source,
  and the founder's staging rehearsal.
