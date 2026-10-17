---
schema_version: 1
id: ADR-0041
kind: decision
title: A complete list is Ask evidence of which items exist
component_ids:
  - CMP-ORGANIZATION-AUTHORITY
  - CMP-PERMISSIONS
created_at: 2026-10-17
reviewed_at: 2026-10-17
reviewed_ref: 2fc6a05e2fc06c2b93092f5ff448e2d796e7e45d
status: accepted
supersedes: []
superseded_by: []
updates:
  - ADR-0019
  - ADR-0022
  - ADR-0034
  - ADR-0040
  - RFC-0003
---

# ADR-0041: A complete list is Ask evidence of which items exist

The founder approved this design ("two kinds of support") on 2026-10-17,
with the seven additions from that day's completeness research, to clear a
held release finding on candidate `c15cd0f`. The names, bounds and wording
below are build calls within that design. Acceptance does not mean the change
is built, deployed or qualified. Code paths are relative to
`packages/organization-authority-kernel/src/answer-composition/` unless shown
otherwise, at `reviewed_ref`.

## Context and options

On staging, "Which Confluence pages were created on October 4, 2026?" named 4
of the 8 pages and was marked answered (trace
`ee2f0973-afa6-4044-9b88-5b49e42c2e47`, release `c15cd0f`):

1. Round 1 listed pages with `date_field: created` for that day. The list
   returned 8 rows and was read to its end (`more: false`). The rows carry
   titles and dates, but no text.
2. Round 2 tried to finish, with the need found and all 8 rows cited. The
   finish check refused it: the need "cites no item whose full text you have
   read" (`agentic-ask-research-state-v1.ts:37`).
3. The repair opened 4 pages, the per-step cap. Confluence released their
   sections as new items, so the rows themselves never got text.
4. Round 3 finished citing rows and sections. One read section was enough
   (`need.evidence.some(citable)`), so the check accepted it.
5. The writer got only the 11 sections of those 4 pages, plus
   `{source: pages, shown_count: 8, more: false}`, with no names and no
   filter. Items without text never reach the writer
   (`renderers/ask-renderer-v1.ts:127`), and the bundle drops a list's filter
   (`agentic-research-loop-v1.ts:1110`). The writer named 4 pages, and
   nothing compared its answer with the list.

The cause is that Ask has only one kind of evidence: text that research read.
A list read to its end is exactly the answer to "which...?", but ECHO keeps it
only as a count. It has no id, no members and no filter, so nothing can cite
it. The cap on opens, Confluence's new section ids and the one-read-item rule
only decided where the loss showed up.

The research behind this record found the same pattern across the field. On
"list all" questions, stopping too early and writers leaving out items they
were given are the main failures
([DeepSearchQA](https://arxiv.org/html/2601.20975v1),
[DeepAmbigQA](https://arxiv.org/html/2511.01323),
[QAMPARI](https://arxiv.org/abs/2205.12665)). Products that get lists right
run a filter against the source, treat the result as the answer and show the
filter.

The options:

1. **Raise the caps** (4 opens per step, 12 cited ids). This only moves the
   failure to 9 or 13 items.
2. **Send rows without text to the writer, with no list object.** The writer
   would see the names, but nothing would mark the set as whole, nothing could
   cite it, and the writer could still drop members.
3. **Let a model judge sufficiency or report its confidence.** Model-judged
   stopping quits early ([Stop-RAG](https://arxiv.org/html/2510.14337v1)) and
   confidence does not prove completeness
   ([BrowseComp](https://arxiv.org/html/2504.12516v1)). Each would have
   accepted 4 of 8.
4. **Two kinds of support (chosen).** A complete list becomes first-class
   evidence, but only for list facts. Content still needs an opened item. Code
   names a list's items and checks the answer.

## Decision and consequences

**Ask only.** Everything below applies when the brief's goal is a question.
A task goal (impact cards and sweeps) keeps today's rules, prompts and model
inputs byte for byte, so the impact-card quality baseline does not change.
Every answer version Ask serves (V4 to V7) gets the change. No answer shape,
route, header, database table or client changes.

### A list is a request-local evidence object

- **One list per selection.** Each `list` read opens or continues one list per
  normalized selection (today's `listKey`). Lists get the ids `L1`, `L2`, ...
  in first-read order. That id is the only one a model sees; it is never a desk
  id.
- **The record** is `AgenticListEvidenceV1` in `agentic-list-evidence-v1.ts`:
  - `source`: the selector the model used.
  - `filter`: the filter as applied after normalization (kind, status, owner,
    channel, since, until, date_field, time_zone), never the model's raw
    arguments. A default the catalog declares, such as Slack's 14 days, is in
    `filter` but not in `filter_applied`.
  - `filter_applied`: for each field the model asked for, `applied`; or
    `partial` (applied only to members that record the field, the others kept,
    as meeting-action status works today); or `ignored` (the source cannot
    apply it, so the list is wider than asked). A field is `ignored` exactly
    when it is absent from `filter`.
  - `members`: the E-ids of the rows the list released, after ECHO's own
    owner and status filter, in the source's order, each once.
  - `shown`: how many members were in the prompt of a research step admitted
    after its access check, under `opened` or `seen`.
  - `ended`: there is no next page, and every fetched row is a member.
  - `unverified_end`: the last page had no next link but was exactly full
    (addition 1).
  - `available`: no page carried a notice. `truncated`: a page said more
    items exist than list can show.
  - `read_at`: the UTC time the desk returned the list's first page
    (addition 2: Jira search lags edits).
  - `complete`: available, not truncated, ended, the end verified, and every
    member shown. Code derives it; nothing else sets it.
- **A list counts once the research model has seen every member.** Its row
  alone is enough. The gate's `before_call` hook marks every entry in the
  admitted call's `opened` and `seen`, not only the text that call reads in
  full (`agentic-research-loop-v1.ts:1123-1130`).
- **An exactly full last page is not trusted (addition 1).** A desk list
  result may report `page_full`: the source's raw page held its full page
  size. With no `next_cursor`, a page with `page_full: true` leaves the end
  unverified. When a desk does not report `page_full`, a page with as many rows
  as research asked for does too. This version makes no confirming read, so
  such a list is never complete and supports only "at least N". Live readers
  set `page_full` from the raw vendor page, before ECHO's own date filter. A
  desk that reads one row past its limit, as the local record and document
  desk does, sets it to `false`.
- **Counts are ECHO's own (addition 5).** A list's count is its number of
  members: items released to this person. "And N more" and "at least N" take
  N from the list. A vendor's total is never read or shown, and counts never
  include items the asker cannot see
  ([ADR-0012](ADR-0012-person-public-response-privacy.md)).
- **Nothing new is released.** Members are items the desk already released
  and audited. The access check before every model call and the final release
  check cover them like any other release. Building a list fetches nothing.
- **Research sees lists by id.** The step's `inventories` field becomes
  `lists`. Each entry shows the list's id, args, member ids, shown count,
  `more`, `complete`, `available`, `truncated`, `unverified_end` and notes.
- **Reading a list is progress.** A list page that adds members counts as new
  evidence, so the idle rule cannot stop research while a list is still being
  read to its end.
- **Bundle and evaluation.** The evidence bundle carries `lists`, and its
  trimmed evaluation view carries them unchanged. `coverage.inventories` stays
  as it is, because the impact card renderer reads it.

### What a list supports

- **Two kinds of support.** A list supports list facts only: which items
  exist, plus each member's title, dates, status and owner. It never supports
  what an item says. That still needs the item's text, read in full.
- **How a found need's evidence divides** (`agenticNeedSupportV1`). The lists
  it cites by id, plus the list of each cited member row (a member research
  never read in full), give list facts. Cited items read in full give content.
  Any other cited id supports nothing.
- **The finish check** replaces `need.evidence.some(citable)` for a question
  goal:
  - A need with list support is checked against those lists. A list that can
    still be read further (`ended` is false) refuses the finish with "list Ln
    is unfinished: keep reading the list (repeat list with {args})". A list
    that cannot be read further (truncated, unavailable or an unverified end)
    is accepted, and the answer will say "at least N".
  - A need without list support still needs at least one cited item read in
    full, exactly as today.
  - A task goal keeps `askResearchCompletionProblemsV1` unchanged. The
    not-found rules are unchanged for every goal.
- **Research can finish on a complete list** without opening any member. The
  step protocol accepts `L` ids beside `E` ids in a need's evidence, within the
  existing 12-id cap.
- **Content across a list (addition 4).** "Which of these pages mention X"
  needs each member checked. A member is checked when research read its text
  through an open that was not truncated and carried no notice. A sentence that
  claims content across a list cites the list. When fewer than all members were
  checked, code adds "(k of N checked so far)" to that sentence and the part is
  partial.

### The writer and the answer

- **The writer sees lists as rows** (`AgenticWriterListV1`). It gets each list
  research read, at most 5, with the lists the plan cites first. Each shows its
  id, source, filter, `filter_applied`, `complete`, count, checked count,
  `read_at`, whether the plan cites it, and up to 100 members
  (`AgenticWriterListMemberV1`: id, kind, title, dates, status, owner, due
  date, checked). Members never carry text; `members_omitted` counts any
  members past 100. This changes the documented rule that items without text
  never reach the writer, for list members only. Related references and
  continuation metadata still never reach it.
- **The writer says which lists answer the question**
  (`AgenticAnswerListUseV1`): a list id, with an optional selection by one row
  field, owner or status, for questions such as "which are assigned to me?". It
  does not write the names itself.
- **Code writes the sentence that names a list's items.** Code writes one
  statement per list the answer uses, first in the part. Each statement cites
  every member it names, by that member's own row:
  - a complete list, all members: "8 Confluence pages created on October 4,
    2026: A; B; ...";
  - a selection: "3 of the 60 Jira tickets created ... have owner Dana Lee: A;
    B; C";
  - a list that is not complete: "At least 12 ...". The part is partial, with a
    gap saying the list could not be read to its end;
  - a selection that matches nothing becomes a `not_found` phrase, never a
    statement; an empty list keeps today's not-found answer.

  The noun comes from the source catalog (the tool and the selector). The
  phrase comes from the applied filter. Each name is the member's label, cut to
  120 characters, followed by its status, owner and due date wherever those
  differ between the named members. There is no source-specific branch:
  Confluence pages read by title; Jira tickets by key and summary, with status
  and assignee; meetings by their record's label; follow-ups by title, with
  owner and due date.
- **Long lists.** One answer names at most 25 members across all its lists,
  shared round-robin between the lists it uses (`agenticListNameSharesV1`).
  Each statement ends "and N more" for the rest. Names stop early if the
  statement would pass the 4 KiB statement bound. The 40-citation, 10-statement
  and 64 KiB response bounds are unchanged: list statements come first, and the
  writer's sentences fill the room left, dropped from the end.
- **Filters are never silently widened (addition 3).** The response notice
  names a requested filter that a source ignored, or applied only where items
  record it, for example "Jira tickets could not be filtered by owner, so this
  list is not limited to that owner." A source that cannot apply a requested
  date field refuses the read. It never answers empty and never substitutes
  another field.
- **Code checks the answer.** For each list the writer saw, the answer goes
  back to the writer once, with the reason, if either:
  - the plan found a need on the list, but the answer does not use it (no
    `lists` entry for it and no sentence citing it); or
  - the answer cites two or more of the list's member rows, but not all, and
    does not use the list.

  The writer has one repair in total, as today; a failed check uses it if it
  is still unused and the request has time and model calls left. If the
  repaired answer still fails, or no repair can run, code writes that list's
  full statement and keeps the writer's sentences.
- **No usable writer reply.** When research found a need on a list but the
  writer gives no usable reply, code still writes that list's statement and the
  part is partial. For that case only, this replaces the fallback to three
  released records ([ADR-0022](ADR-0022-agentic-ask-only.md)).
- **Prompts (addition 6).** Ask's research step gets its own wording of rule
  4. It names `lists`, and says that a question about which or how many items
  exist is supported only by a complete list, cited by its id, never by some
  of its items. "You may stop early when the facts the question asks for are
  already supported" becomes "Stop as soon as every requested fact is
  supported; a question about which items exist is supported only by a complete
  list." Ask's writer prompt gets the list rules above. Task prompts do not
  change.

### Evaluation (addition 7)

The research-loop evaluation gets a `list` part type, whose evidence names
every member. A list part scores on naming the whole list: it counts only when
the answer cites every member, and naming some members earns nothing. A
citation of a member of a list in the research result resolves like a
citation of an item read in full. A development case asks the October 4
question, with its 8 pages as members.

### Safety rules kept

The access checks before every model call and at release, the Ask audit and
its receipts, the release fence, the 90 s deadline, the limits of 10 rounds,
24 model calls and 4 actions per step, and the response bounds are all
unchanged. Progress events ([ADR-0039](ADR-0039-ask-progress-names-after-the-access-check.md))
are unchanged: a list row is not read in full, so progress does not name it.

## Migration, rollback, and evidence

No schema, stored state, route or client changes, and nothing new is kept
after the request. Rollback is a code revert. The Ask quality baseline is
re-recorded with `ASK_QUALITY_BASELINE_WRITE=1`; the impact-card baseline must
not change.

Tests required before release:

- the October 4 run, replayed: research finishes on `L1` in two steps and the
  answer names all 8 pages, citing each page's row;
- an answer that names 4 of 8 without the list is sent back once, then code
  writes the full list;
- a 60-member list names 25 and says "and 35 more";
- an unfinished list refuses the finish with "keep reading the list"; a list
  that cannot be read further gives "at least N" and a partial part;
- an exactly full last page with no next link is never complete;
- "which are assigned to me" names only the members with that owner;
- a content question across a list cites the list and says "k of N checked so
  far" until every member is checked;
- a requested filter the source ignored appears in the response notice;
- an item whose access is revoked mid-request stops the answer at the next
  check, even when it is only a list member;
- the same cases for Jira tickets, meetings and follow-ups;
- task goals: identical model inputs and the unchanged impact-card baseline;
- the research-loop evaluation's `list` part scores whole lists only.

The live check is a staging rerun of the October 4 question, comparing the
names in the answer against the list itself.
