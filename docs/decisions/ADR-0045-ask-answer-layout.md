---
schema_version: 1
id: ADR-0045
kind: decision
title: An Ask answer carries its layout, and the desktop sets its type
component_ids:
  - CMP-ORGANIZATION-AUTHORITY
  - CMP-PERSON-CLIENT
created_at: 2026-10-23
reviewed_at: 2026-10-23
reviewed_ref: 56461ffc1f79ae9facb39cd198bf0bead76efa27
status: proposed
supersedes: []
superseded_by: []
updates:
  - ADR-0041
  - ADR-0042
---

# ADR-0045: An Ask answer carries its layout, and the desktop sets its type

The founder asked on 2026-10-23 for answers that read like a document rather
than a stack of equal paragraphs: the conclusion first, sections and bullets
for distinct topics and parallel items, tables for owners, dates and
statuses, citations beside each claim, sources collapsed, and a quieter note
when research stopped short. The design is the "Ask Answer Format" canvas
(THERM example). This record is proposed until the founder confirms the
result on the desktop. It does not mean the change is deployed or qualified.

## Context and options

The writer returned one flat list of sentences. Code put the statements it
writes for lists (ADR-0041) first, then the writer's sentences, in one part,
and the desktop drew each statement as a paragraph followed by its source
numbers. Nothing told the desktop which sentence was the answer, which were
parallel items, or which named a list's members.

1. **Markdown in statement text.** The writer could write headings, bullets
   and tables in its sentences. Rejected: a statement is a cited claim, and
   Markdown would mix layout into what citation checks, audits and
   fingerprints read, and give the model control of typography.
2. **A new answer version on a new route** (V9 on `/v8`). Rejected for now:
   a new route, a longer client fallback chain and a new progress version for
   a change that adds no claim and no citation kind.
3. **An optional layout on the V8 part, asked for by a header.** Chosen.

## Decision

- **The statements stay the claims.** A V8 part may carry `layout`, a list
  of blocks (`lead`, `heading`, `paragraph`, `bullets`, `table`) that group
  the part's statements in their order. Every statement is in exactly one
  block. A lead comes first and holds one or two statements. A heading is
  followed by a block that is not a heading. A table shows its statements as
  rows, each row with its own citations, and its rows together cite exactly
  what its statements cite. Layout never adds a claim or a citation.
- **Asked for, never assumed.** A client sends `x-echo-answer-layout: 1` on
  an Ask. An Authority that predates this ignores the header. An answer to a
  request without it carries no layout, so an older client never meets the
  field. The desktop runs the person client in-process, so the two update
  together.
- **The writer chooses the shape.** Each writer sentence may say it is the
  lead, a bullet or a table row, and name its section; a table row gives its
  cells under columns the writer declares. Code checks citations exactly as
  before (W1 to W6 of ADR-0041), then builds the layout from the sentences
  that survive.
- **Code tabulates lists.** A list statement that names two or more members
  becomes a table, one row per member it names, its row facts as cells and
  its count phrase as the caption. The writer still never counts or names
  members.
- **The desktop owns typography.** The desktop sets every size, weight and
  space; signal colour marks only what is the asker's and late. Sources start
  collapsed. Research and list notices read as one quiet coverage note after
  the answer, not a banner. Copy answer writes Markdown.

## Consequences

- Statement text, citations, privacy and audits are unchanged for every
  request; only the order of a laid-out answer's statements follows its
  layout (lead first).
- A response that must drop statements to fit its byte bound drops its
  layout too, and reads as before.
- The eval and judge read statements as before.
