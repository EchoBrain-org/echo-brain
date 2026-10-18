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
is built, deployed or qualified. Code paths are at `reviewed_ref`, relative to
`packages/organization-authority-kernel/src/answer-composition/` (tests to
`packages/organization-authority-kernel/test/answer-composition/`) unless
shown in full.

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
    apply it, so the list is wider than asked). A field named here is
    `ignored` exactly when it is absent from `filter`.
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
  read to its end. Built: a member counts once across the request's lists.
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
  Any other cited id supports nothing. Built: a need that cites two or more
  members of one list also rests on that list, read in full or not. A
  follow-up's row carries its text, and an opened meeting record keeps its
  row's id, so "my open follow-ups" citing a first page of ten members must
  still read the list to its end. One member read in full stays content. An
  item belongs to a list when it is a member or cites the same object as one
  (`agenticListMembershipV1`): Confluence releases an opened row's sections as
  new items, so four opened sections are four of the list's members, for the
  finish check and the writer's check alike. A member row cited beside a body
  its own clean open returned (an open that was not truncated, carried no
  notice or error, and returned only bodies research read in full) names that
  body's item, so it is content, not its list (`agenticOpenReadsV1`): "what
  does the gate review page say", citing the page's row and its section, never
  has to read the page's list to its end or name it. A row cited without such
  a body still gives list support. The finish check, the loop's and the
  renderer's lists a need rests on, and the evaluation read the same relation
  from research's rounds.
- **The finish check** replaces `need.evidence.some(citable)` for a question
  goal:
  - A need with list support is checked against those lists. A list that can
    still be read further (`ended` is false) refuses the finish with "list Ln
    is unfinished: keep reading the list (repeat list with {args})". A list
    that cannot be read further (truncated, unavailable or an unverified end)
    is accepted, and the answer will say "at least N".
  - A need without list support still needs at least one cited item read in
    full, exactly as today.
  - Member rows alone are not enough: a need that cites rows of a list must
    also cite the list by its id, or an item read in full. Otherwise a content
    need ("when is launch?") that cites a listed row would finish before its
    item is read, and the writer, which never sees a row's text, could not
    answer it. The refusal names both ways on: "cite L1 for which items
    exist, or open the items for what they say".
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
  partial. Built: a member's row is checked through the open of that row, whose
  bodies may have new ids, once research read every body it returned. Code
  finds the claim from what a sentence cites, not how it cites it, since the
  writer may cite only a member's section: the list's id beside text the
  writer read; the text of two or more of its members (a section counts as its
  page); or the text of one member of a list that a found need of the plan
  rests on beside text of its members ("which pages mention BUG-412", found on
  L1 and the Traceability section). The note is added whether the list reaches
  the answer through `lists`, a sentence or code's own statement.

### The writer and the answer

- **The writer sees lists as rows** (`AgenticWriterListV1`). It gets each list
  research read, at most 5, with the lists the plan cites first. Each shows its
  id, source, filter, `filter_applied`, `complete`, count, checked count,
  `read_at`, whether the plan cites it, and up to 100 members
  (`AgenticWriterListMemberV1`: id, kind, title, dates, status, owner, due
  date, checked). Members never carry text; `members_omitted` counts any
  members past 100. Built: the rows take at most half of the writer's prompt
  room; a smaller context window halves how many members of each list it
  shows, never how many lists, and code still names members from every row.
  This changes the documented rule that items without text
  never reach the writer, for list members only. Related references and
  continuation metadata still never reach it.
- **The writer says which lists answer the question**
  (`AgenticAnswerListUseV1`): a list id, with an optional selection by one row
  field, owner or status, for questions such as "which are assigned to me?". It
  does not write the names itself. Built: or members it selects by id
  (`members`), for those members' row facts ("who owns THERM-46", "when was
  the PRD created"). Code names each alone, with every row fact its row
  records (status, owner, due date and dates, each day in the list's time
  zone), after "1 of the 8 Confluence pages created ..." when they are not
  every member, or "1 of at least 25 ..." for a list not complete. Their
  facts stand whether or not the list ended, so such a selection adds no
  list-end gap.
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
  owner and due date. Built: the noun says what the members are, from their
  desk kinds after the catalog's tool (`agenticListMembersNounV1`): "Jira
  tickets", "Slack messages", and "decisions" or "actions" for a meeting list
  of those records, never "meetings". A kind filter the noun names has no
  words of its own ("2 actions with owner Mara"). Members of several kinds are
  "items from" the source's noun. Members that share a label are one name with
  their kinds counted, since every record of a meeting carries the meeting's
  label: "THERM DVT sync (2026-10-04) (1 decision and 2 actions)". The count
  and "and N more" still count members, from the list itself; a name is cited
  by each member it covers, within the answer's share.
- **Long lists.** One answer names at most 25 members across all its lists,
  shared round-robin between the lists it uses (`agenticListNameSharesV1`).
  Each statement ends "and N more" for the rest. Names stop early if the
  statement would pass the 4 KiB statement bound. The 40-citation, 10-statement
  and 64 KiB response bounds are unchanged: list statements come first, and the
  writer's sentences fill the room left, dropped from the end.
- **Filters are never silently widened (addition 3).** The response notice
  names a requested filter that a source ignored, or applied only where items
  record it, for example "Jira tickets could not be filtered by owner, so this
  list is not limited to that owner." Research adds it to the bundle's
  coverage notices, which reach the writer and the response notice, for each
  list a found need rests on (`agenticListFilterNoticeV1`, with the noun from
  `agenticListNounV1`). A source that cannot apply a requested date field
  refuses the read. It never answers empty and never substitutes another
  field. A desk asked for an owner or status filter a source cannot apply
  refuses the read too.
- **A list id in a sentence** adds no citation of its own: the sentence cites
  the members or texts it also names, and a sentence left with no citation is
  dropped, as today.
- **A writer's sentence rests on text.** Built: a list never says what an
  item says, and code cannot tell a row fact from a claim about content, so
  the guarantee is code's, not the prompt's. A writer's sentence is kept only
  when it cites text the writer read; rows and list ids may sit beside that
  text. One citing only rows or list ids is left out, and, unless it restated
  two or more members of a list code names, the part gains the not-found
  phrase "what the listed items say, since they were listed but not opened":
  "Is DVT on hold?" answered from the Gate reviews page's title ("EVT pass,
  DVT hold, PVT pending") ends partial or not found, never answered. Row facts
  stay answerable through a selection by id, which code states. The check
  sends such a sentence back once, pointing at that selection. A kept sentence
  citing a member's row beside other text claims content across that list and
  gets its checked note. A reply that answers nothing and says what it could
  not find is honored: the plan's list is neither sent back for nor written
  ("Is DVT on hold?" researched on a list alone is not found, not the list).
- **Code checks the answer.** For each list the writer saw, the answer goes
  back to the writer once, with the reason, if either:
  - the plan found a need on the list (that need's support includes it), but
    the answer does not use it: no `lists` entry for it and no kept sentence
    citing it, unless the reply answers nothing and says what it could not
    find; or
  - the answer cites two or more of the list's members, but not all of them,
    and does not use the list. Built: a member counts whether the writer has
    its text or only its row, and the answer uses a list only through
    `lists`, or through a sentence that cites the list's id beside text the
    writer read that is not one of the list's own rows (an opened section, or
    an item outside the list). A list id beside rows, or beside members' own
    rows that carry text (a follow-up, an opened meeting record), never stands
    in for code's statement: "you have 10 open follow-ups" citing L1 and ten
    of its twelve members is a subset. Rows are list facts only, so a sentence
    that names two or more members by their rows alone is a subset whatever
    else it cites, and only `lists` uses that list then.

  The writer has one repair in total, as today; a failed check uses it if it
  is still unused and the request has time and model calls left. If the
  repaired answer still fails, or no repair can run, code writes that list's
  full statement and keeps the writer's sentences. Built: a sentence that
  cites only members of a list code wrote this way by their rows, or the text
  of two or more of them once every member was checked, is dropped, since it
  restated part of that list (the October 4 answer's "the pages are A, B, C,
  D" beside all eight names would contradict them); so is one that names two
  or more of its members by their rows alone, whatever else it cites. A
  sentence citing the text of two or more members of a list not every member
  of which was checked stays, with its "(k of N checked so far)" note: code
  cannot tell "A and B mention BUG-412" from a restated subset, and the note
  keeps either from reading as complete. For a list a found need claims
  content across, the repair's reason names both ways on: put the list in
  `lists` for which items exist, or cite it beside the evidence for what its
  members say. A first reply that fails only the check stays the writer's
  answer when the repair's reply is unusable.
- **One citation per cited object.** The response refuses duplicate
  citations, and a listed ticket's row and its opened body cite the same
  ticket. Code gives them one citation, in first-citation order, so a list
  statement and a writer's sentence about the same ticket share it.
- **No usable writer reply.** When research found a need on a list but the
  writer gives no usable reply, code still writes that list's statement and the
  part is partial. For that case only, this replaces the fallback to three
  released records ([ADR-0022](ADR-0022-agentic-ask-only.md)).
- **Prompts (addition 6).** Ask's research step gets its own wording of rules
  3 and 4. Rule 3 accepts a list's id as support for which items exist. Rule 4
  names `lists`, and says that a question about which or how many items exist
  is supported only by a complete list, cited by its id, never by some of its
  items, and that a list which cannot be read to its end is cited anyway, for
  "at least N". "You may stop early when the facts the question asks for are
  already supported" becomes "Stop as soon as every requested fact is
  supported; a question about which items exist is supported only by a complete
  list." Ask's writer prompt gets the list rules above. Task prompts do not
  change. Built: rule 4 says one thing for which items exist: cite the list
  by its id once `more` is false; a complete list supports all its items, and
  one that cannot be read to its end supports "at least" its count. The stop
  rule reads "Stop as soon as every requested fact is supported; for which
  items exist, that is once each list you cite has more false." Ask's search
  and open descriptions say a list's members need no open for which items
  exist or their row facts, since "open metadata-only items before relying on
  them" sent the trace's planner to open pages to confirm creation dates.

### Evaluation (addition 7)

The research-loop evaluation gets a `list` part type, whose evidence names
every member. A list part scores on naming the whole list: it counts only when
the answer cites every member, and naming some members earns nothing. A
citation of a member of a list in the research result resolves like a
citation of an item read in full. A development case asks the October 4
question, with its 8 pages as members. Built: a list part's research measures
hold only for the whole list too (found; read, when a complete list holds every
member; handed over), and whether the answer names every member is a code
check, "lists named in full", that holds without a judge and overrides a
judge's "yes" (`tools/evals/research-loop/lib/checks.mjs`). The rows the
writer sees are never counted as noise or distractors handed, and hand over a
part only when it is a row fact (a date, owner or status).

### Safety rules kept

The access checks before every model call and at release, the Ask audit and
its receipts, the release fence, the 90 s deadline, the limits of 10 rounds,
24 model calls and 4 actions per step, and the response bounds are all
unchanged. Progress events ([ADR-0039](ADR-0039-ask-progress-names-after-the-access-check.md))
are unchanged: a list row is not read in full, so progress does not name it.

## Retirements

Each rule below was checked against the code at `reviewed_ref`, the October 4
trace and the research. A rule is retired only where that evidence shows it
fails, and each retirement names what replaces it. "Kept" says why a candidate
stays. The safety rules (access checks, audit, release fence and caps) were
not candidates.

1. **"Any one cited item read" as the only support for a found need.**
   Retired for Ask needs with list support; kept as the rule for content.
   - Where: `agentic-ask-research-state-v1.ts:37`
     (`need.evidence.some(citable)`), with `citable` at
     `agentic-research-loop-v1.ts:779`.
   - Evidence: in the October 4 trace, round 3's finish cited the 8 rows and
     11 sections (cut to the first 12 ids), and the check accepted it because
     one cited section had been read; the answer named 4 of 8. The research calls this shape the "one good
     document" trap ([Corrective RAG](https://arxiv.org/html/2401.15884)), and
     finds that partial context makes models answer confidently instead of
     declining
     ([sufficient context](https://research.google/blog/deeper-insights-into-retrieval-augmented-generation-the-role-of-sufficient-context/)).
     Nothing shows the rule failing for a content need, which one supporting
     text answers.
   - Replacement: `agenticNeedSupportV1` and the finish check above. A need
     with list support is checked against its lists ("keep reading the list").
     A need without one keeps "at least one cited item read in full". Task
     goals keep line 37 unchanged.
2. **Items without text never reach the writer.** Retired for list members
   in Ask.
   - Where: `renderers/ask-renderer-v1.ts:115-127` (the writer gets cited
     items read in full, other items read in full, then items with released
     text); RFC-0003, "Evidence the writer reads" ("Inventory entries without
     text remain excluded"); the
     [research-loop evaluation design](../product/2026-10-06-research-loop-eval-v1.md)
     ("Items without released text never reach the writer").
   - Evidence: the trace's writer got E9 to E19, the sections of 4 pages, and
     none of the rows E1 to E8, and it wrote 4 names. Seeing the rows would
     not be enough on its own: given the right passages, writers still leave
     items out ([QAMPARI](https://arxiv.org/abs/2205.12665): 47.5% found;
     [DeepAmbigQA](https://arxiv.org/html/2511.01323): 71% recall at 93%
     precision).
   - Replacement: the writer's list view (rows only, never text) and the
     code-written list statement. Related references and continuation
     metadata (`agentic-research-loop-v1.ts:518-522`) still never reach the
     writer.
3. **A list kept only as a count.** Retired for Ask; kept for task goals.
   - Where: `agentic-research-loop-v1.ts:760-763` (`inventoryView`: args and
     counts, no id or members), `:1110` (the bundle drops `args`), and
     `renderers/ask-renderer-v1.ts:107-109` ("Filters ... are intentionally
     excluded").
   - Evidence: the writer saw `{source: pages, shown_count: 8, more: false}`,
     with no names and no filter. The planner had no id to cite, so its
     correct round-2 finish could only cite rows, and the check refused it. In
     the research, a complete list is only as good as its filter, so products
     that get lists right show the filter
     ([Snowflake](https://docs.snowflake.com/en/user-guide/snowflake-cortex/cortex-analyst),
     [Weaviate](https://weaviate.io/blog/query-agent)).
   - Replacement: `lists` in the step view and the writer view, each with its
     id, members and filter. `coverage.inventories` stays in the bundle,
     because `renderers/impact-card-renderer-v1.ts:261` reads it.
4. **The not-found guards on lists.** Kept; nothing replaces them.
   - Where: `blockingInventories` (`agentic-research-loop-v1.ts:764-776`) and
     its use at `:1022-1029`; the not-found rule
     (`agentic-ask-research-state-v1.ts:38-44`); exhaustively empty sources
     (`agentic-research-loop-v1.ts:589` and `:1075-1083`).
   - Evidence: these guard a claim that a content fact is absent, which list
     evidence does not cover. A list says which items exist, not that none of
     them says something. The failing run had no not-found need, so the trace
     shows nothing against them. Their tests protect real cases: a listed
     source's unread pages keep blocking while its search did not complete
     (`agentic-research-loop-v1.test.ts:83`); a complete unfiltered list
     covers its filtered ones (`:101`); rows alone need an open before absence
     (`agentic-ask-v1.test.ts:501`). The only redundant part is the
     model-facing `inventories` field, retired in item 3. Built: for a
     question goal they read the same end as list evidence, so a list whose
     last page was exactly full is never "a completed list" for not_found and
     never covers its filtered lists (addition 1). A task goal keeps its rule.
5. **"You may stop early when the facts the question asks for are already
   supported."** Reworded for Ask; kept for task goals.
   - Where: `agentic-ask-v1-model-protocol.ts:286-287`. The same rule 4 tells
     the planner to search a `metadata_only_list` source "instead of paging
     through it".
   - Evidence: in the research, stopping too early is the main failure on list
     questions ([DeepSearchQA](https://arxiv.org/html/2601.20975v1)), and on
     [WideSearch](https://arxiv.org/html/2508.07999) agents abandon the search
     after a first failed attempt. The trace does not show this line causing
     the failure: the planner's round-2 finish was right. But the line gives
     no way to tell a set from a single fact, and the paging sentence tells
     the planner not to read a list to its end, which a "which" question
     needs.
   - Replacement: Ask's own rule 4 (addition 6). The not-found advice about
     `metadata_only_list` sources stays, for facts about content.
6. **RFC-0003's "A second finish is accepted".** Corrected; the code never
   did this.
   - Where: RFC-0003's finish check (lines 257-258 before this record).
   - Evidence: the repair's reply goes through the same check
     (`agentic-model-gate-v1.ts:304-327`), and a second refused finish ends
     research as `unusable_step`, not completed
     (`agentic-research-loop-v1.ts:1036-1051`), as the test at
     `agentic-research-loop-v1.test.ts:83-99` expects.
   - Replacement: the corrected RFC text. The code does not change.
7. **A list page is never progress once research has read some text.**
   Retired for Ask.
   - Where: `agentic-research-loop-v1.ts:405-422` (a row without text is not
     new evidence) and `:1066-1089` (once any item is read in full, only new
     evidence is progress, and 2 or 3 idle steps stop research as
     `no_progress`).
   - Evidence: code only. Reading a list to its end now matters, and a list of
     rows without text that needs more than three list-only steps after any
     text was read stops before its end.
   - Replacement: for a question goal, a list page that adds members counts as
     progress. Built: only members no list had shown before count, so
     re-listing the same items under another date field or range is idle, and
     the two-idle-steps stop still fires.
8. **A date filter a source cannot apply, answered as empty.** Checked when
   building; already refused, so nothing is retired (addition 3).
   - Where:
     `services/organization-authority/src/adapters/persistence/sqlite/person-original-context-retrieval-v1.ts:42`:
     a document read with a `date_field` other than `received` adds `AND 0`.
   - Evidence: code only. Such a list would be empty and complete, and so
     would say that nothing exists when its filter was never applied.
   - Found when building: a document read never reaches `:42` with another
     field. `deskSearch` refuses it first (`:349`, "This source supports
     date_field: received"), as the Jira, Confluence and record readers refuse
     theirs. `AND 0` is reached only by an inventory across sources, where it
     excludes items without that date, as the step prompt documents. A test
     pins the refusal; the code does not change.
   - Elsewhere the build makes the desk refuse, rather than drop, an owner or
     status filter a source cannot apply
     (`services/organization-authority/src/composition/person-live-evidence-desk-v2.ts`).

**Considered and kept:**

- The 4-action cap (`agentic-ask-v1-model-protocol.ts:15`): raising it only
  moves the failure from 8 items to 9 or 13.
- The 12-id evidence cap (`agentic-ask-v1-model-protocol.ts:19` and
  `:142-148`): it cut the trace's round-3 finish from 19 ids to 12, but a list
  need now cites a single list id.
- The 300-entry scratchpad cap (`agentic-research-loop-v1.ts:92`): it bounds
  how many members research can be shown, so a longer list is honestly
  incomplete.
- No new stop signal: no model-judged sufficiency, confidence score or
  "nothing new" completion signal is added. The research found that each
  would have accepted 4 of 8.

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
