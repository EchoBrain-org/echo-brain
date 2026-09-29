---
schema_version: 1
id: ADR-0021
kind: decision
title: Ask over shared transcripts, refused project choices, and confirmed action owners
component_ids:
  - CMP-PERMISSIONS
  - CMP-ORGANIZATION-AUTHORITY
  - CMP-PERSON-CLIENT
created_at: 2026-09-28
reviewed_at: 2026-09-28
reviewed_ref: d453bd7f962a1c01b4eeae7f93698a40ea0a0ae4
status: accepted
supersedes: []
superseded_by: []
updates:
  - ADR-0015
  - ADR-0017
---

# ADR-0021: Ask over shared transcripts, refused project choices, and confirmed action owners

## Context and options

Staging Ask answered most questions with "Insufficient accessible evidence".
Probing the staging CLI on 2026-09-28 found three causes in the data Ask can
reach, not in the answer writer:

1. Project Ask found nothing. The approved meetings had no project
   association, and the approval card silently dropped projects the approver
   picked while the audience stayed Only me or Team (ADR-0017 kept those
   choices "dormant"). The desktop then showed the bare no-evidence answer.
2. Questions about people found nothing. Extraction writes every action
   owner-neutral (the 2026-09-01 decision: a wrong owner is worse than none),
   and ADR-0017 kept shared transcripts out of Ask ("Automatic raw-meeting
   search or Ask ingestion is outside V1"; ADR-0015 "no raw-meeting bypass").
   Who said or owns what therefore exists only in transcripts Ask cannot read.
3. The new Ask loop did not know who was asking, so "my" had no referent.
   That fix lives in the Ask loop (RFC-0003) and needs no decision here.

For each, the founder chose on 2026-09-28:

- Empty project answer: offer a one-tap wider ask; never widen silently.
- Owners: the model proposes an owner, and the approver confirms it on the
  card; only confirmed owners are recorded and searchable.
- Transcripts: Ask reads a transcript only when the approver shared it at
  approval, and only for people who may read that meeting's record.

## Decision and consequences

**No silent widening.** A project answer that cites nothing says that nothing
in the project matched and offers "Ask across everything you can see". The
wider ask is a new, visible question in all accessible context; the bar's
scope widens with it. ADR-0015's rule that project Ask never falls back to
global context is unchanged. An answer Ask cannot give by its nature
(authorship unsupported) offers no wider ask.

**Project choices are refused, not dropped.** Approve fails when the chosen
audience and projects disagree: projects chosen with Only me or Team, or
Projects with none chosen. Only me stays the default, so a mistaken tap never
widens a record's audience. The picker's existing hint already says to choose
projects only with Projects; its text is unchanged so that pending cards keep
their frozen bytes. Slack shows its generic error for a refused button; a
message that names the problem needs a separate reply path and is not part of
this decision. Reject ignores both fields, as before.

**Shared transcripts are Ask evidence.** This amends ADR-0017's V1 exclusion.
Original-context retrieval now also searches transcripts that have an approval
grant (share transcript on at approval), under the same checks as the direct
transcript read: the grant's policy contract, the record's current audience,
and for project Ask the record's project association and the asker's project
grant. The exact retained revision is re-verified before any text is scored.
Packets are cited as source revisions whose anchor binds the approval, and
every read, revalidation and final fence re-derives the packet from the grant.
A raw meeting without a grant, a pending or rejected approval, and a meeting
approved with sharing off stay out of Ask. Transcript text keeps its custody:
it is not copied into records, indexes or audits; audits keep digests only.

**Owners need the approver.** Extraction proposes an owner only for an
explicit assignment ("Jules will send the quote"). Code keeps a proposal only
when the cited evidence supports it: the name appears in a cited quote, or the
cited speaker, known by that name, commits in the first person ("I'll send
it"). The model's judgment alone never sets an owner.

- The approved snapshot never carries an owner. The stager clears every
  proposal from the brief it commits to, so a brief without proposals keeps its
  exact bytes and hash.
- A card with proposals is a V3 card: the V2 card plus one editable owner field
  per proposed action, starting at the proposal. If the fields would not fit
  Slack's 50-block limit, the card falls back to V2 and offers no owners.
- The approver keeps, edits or clears each field. The signed V3 action carries
  every field as left; the V3 receipt keeps it; finalization binds the same V2
  policy decision and adds only the owners still filled in (a V3 resolution).
- The record's V3 human-act reference names each confirmed owner by the
  approved action's signal ID. Its policy facts are exactly the V2 facts:
  owners grant nothing.
- Search indexes an owned action as "<action> Owner: <name>.", and the source
  pane shows the owner beside the action.

V1 and V2 cards, receipts, resolutions and records keep their meaning and
bytes. Extraction's prompt and schema versions change (processor identity
changes; signal IDs do not), so meetings processed again after deploy produce
new candidates, which supersede cards still pending.

## Migration, rollback, and evidence

Nothing already recorded changes. Transcripts shared under ADR-0017 become
searchable as soon as the retrieval change is deployed; they were already
readable through `echo transcript` by the same people. Rolling back the
retrieval change removes them from Ask again without any data change. Card
and approval versions are additive: pending older cards keep their exact
bytes and parsing.

Evidence: `person-original-context-adversarial.test.ts` covers transcript
search, project association, revalidation after leaving every audience
project, and exclusion without a grant.
`private-slack-approval-interaction-handler-v1.test.ts` covers the refused
project choices and the V3 owner fields. `private-slack-dm-approval-stager-v3`,
`private-slack-approval-block-kit-card-v2`, the persistence and coordinator
tests, and `private-slack-record-append.test.ts` cover owners from proposal to
searchable record. The desktop Ask end-to-end suite covers the offered wider
ask.
