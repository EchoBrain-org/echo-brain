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
status: superseded
supersedes: []
superseded_by:
  - ADR-0051
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
(THERM example). The founder accepted this record on 2026-10-31, as built in
#358 (`b36b18e`). Acceptance does not mean the change is deployed or
qualified.

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
- **The writer chooses the shape.** Only when layout is asked for, the
  writer's prompt and schema let each sentence say it is the lead, a bullet
  or a table row, and name its section; a table row gives its cells under
  columns the writer declares. Code writes a row's statement from its cells
  and columns ("Action: Fix BUG-412; Owner: Tomas Okafor."), so the cited
  claim is exactly what the row shows. A row whose cells do not match its
  columns reads as a bullet. Code decides which statements fit exactly as
  before (W1 to W6 of ADR-0041, lists first), then reads the kept ones lead
  first and builds the layout from them.
- **Code tabulates lists.** A list statement that names two or more members
  becomes a table, one row per member it names, its row facts as cells and
  its count phrase as the caption. The writer still never counts or names
  members.
- **The desktop owns typography.** The desktop sets every size, weight and
  space; signal colour marks only what is the asker's and late. Sources start
  collapsed. Research and list notices read as one quiet coverage note after
  the answer, not a banner. Copy answer writes Markdown.

## Consequences

- A request without the header is unchanged: the same writer prompt and
  schema, statements, citations, privacy and audits. A laid-out answer keeps
  statements and citations by the same rules; it reads them lead first,
  numbers its citations in that order, and its table rows' statements are
  written from their cells.
- A laid-out answer that would exceed its byte bound is released without its
  layout: the same claims, a row still its cells' claim, in the order and
  numbering an answer without layout has, and what cannot fit is dropped from
  the end with a gap that says so.
- Every section keeps its own heading: a part has at most ten statements, so
  at most ten headings.
- The eval and judge read statements as before; a row's statement says what
  its cells show.

## Later decisions

On 2026-10-25 [ADR-0047](ADR-0047-ask-timeline.md) dropped the coverage note
above. On 2026-10-26 [ADR-0049](ADR-0049-only-me-is-a-lock.md) shows a
table's caption only when the table opens the answer.

## Lifecycle update

Superseded on 2026-11-04 by
[ADR-0051](ADR-0051-ask-answer-layout-v2.md), and layout v1 is retired. Every
desktop and CLI has asked for layout v2 since its release. The writer's forms,
sections and declared tables, a part's `layout`, and the desktop's drawing of
it are removed. An Ask that still sends `x-echo-answer-layout: 1`, from a
desktop or CLI older than layout v2, is answered as one without the header, in
paragraphs. A desktop drops the layout of an Ask timeline turn saved before
layout v2 and shows its statements as paragraphs. What this record set and
layout v2 kept continues under ADR-0051: the statements stay the claims, a
table's rows cite what its statements cite, code tabulates lists, the desktop
owns typography, Copy answer writes Markdown, and an answer that would pass its
byte bound is released without its layout.

On 2026-11-05 the plain answer was retired too (ADR-0051, amended): the header
is no longer read, so a client that still sends `1` gets an answer in blocks,
and an answer past its byte bound is cut in its blocks.
