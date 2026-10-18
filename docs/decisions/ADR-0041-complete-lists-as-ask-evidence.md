---
schema_version: 1
id: ADR-0041
kind: decision
title: A complete list is Ask evidence of which items exist
component_ids:
  - CMP-ORGANIZATION-AUTHORITY
  - CMP-PERMISSIONS
created_at: 2026-10-17
reviewed_at: 2026-10-18
reviewed_ref: 6d71eef973d4547688222e83ba3c9e939c67eea8
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
shown in full. Line numbers are at `2fc6a05`, the first build, unless a
passage names another commit.

**Amended 2026-10-18 (restructure, founder decisions "Restructure" and the
answers of 2026-10-18).** As built, code inferred from a sentence's or a need's
citations whether it stated which items exist or what items say. The same
citations can mean either: "which pages were created on October 4" and "which
pages mention BUG-412" can cite the same four opened sections. Each review
round found a shape the inference got wrong, and each fix added a rule.
Research now declares each need's kind, and code follows the declaration. The
rules that guessed are retired (Retirements 9 to 11). The seven additions are
kept. Code never checks a declaration; the Known limits below say what a wrong
one costs.

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

- **Two kinds of support.** A list supports list facts only: which items exist,
  plus each member's title, dates, status and owner. It never supports what an
  item says, which still needs the item's text, read in full.
- **Research declares each need's kind.** In an Ask step with the list tool,
  every need has `kind`:
  - `which_items`: which or how many items exist in a source, or in a set of
    its items picked by list facts (a date, owner, status, kind or channel). A
    list answers it, and code states the list, naming every member with its row
    facts.
  - `which_say`: which members of a set picked by list facts say something
    ("which of the pages created on October 4 mention BUG-412"). It cites the
    list it checks, and its members' text read in full. It is the only kind
    that adds "(k of N checked so far)".
  - `content`: what items say; which items say something when the question
    picks no set by list facts ("which Jira tickets mention BUG-412"), which
    search finds; or any fact about one particular item. Its list ids mean
    nothing.

  A `which_say` set needs a list fact beyond its source because its answer is
  only as complete as the share of the set research read: across a whole
  source, search is the research that can finish, and a member-by-member check
  would only report how little was read.

  The step schema requires the kind, and the reply shape and example show all
  three. A missing or unknown kind is `content`, the finish rule from before
  this record. A task goal, and an Ask brief without the list tool, have no
  kind; their schema, prompts and plan view are unchanged.
- **One item's row facts are content.** "Who owns THERM-46" and "when was the
  PRD created" are content needs: research opens the item, one open, as before
  this record, and the writer answers from its text or selects it by id for
  code to state its row facts. This narrows "a list supports owner" to the
  members a `which_items` statement names; its cost is one open per such
  question.
- **The finish check** replaces `need.evidence.some(citable)` for a question
  goal (`askQuestionCompletionProblemsV1`):
  - A need code reads a list for must cite, by its id, a list research read: a
    found `which_items` need, whose lists code states, and a `which_say` need
    whatever its status, whose list code counts ("none of them" is qualified by
    the count as much as "these"). Otherwise it is refused once with everything
    the repair needs: the ids of the lists holding what it cites ("cite the id
    of the list that holds its items (L1)"). A not_found `which_items` need
    states nothing, so only the not-found rules decide it.
  - A found `which_items` need waits for each list it cites: "keep reading the
    list (repeat list with {args})" while a next page exists, in the same
    refusal when the need named no list. A list that cannot be read further
    (truncated, unavailable, or with an unverified end) is accepted, and the
    answer says "at least N".
  - A found `which_say` or `content` need needs at least one cited item read in
    full, exactly as before. A `which_say` need never waits for its list's end
    to be found. The refusal says what each kind of support is ("a list shows
    which items exist ..., never what an item says; open the items for what
    they say") and never offers a change of kind.
  - A task goal keeps `askResearchCompletionProblemsV1` unchanged. The
    not-found rules are unchanged for every goal and kind: a not_found need, a
    `which_say` need included, still needs two completed searches or a
    completed list.
- **Research can finish on a complete list** without opening any member, by
  citing its id for a `which_items` need, within the existing 12-id cap.
- **Content across a list (addition 4).** A `which_say` need declares it. A
  member is checked when research read its text in full, or opened its row
  through an open that was not truncated, carried no notice or error, and
  returned only bodies research read in full. When not every member of a list a
  `which_say` need cites was checked, whatever the need's status, the part is
  partial, and each kept sentence citing a member's text gets "(k of N checked
  so far)". No other list gets the note, and citing a list's members never
  makes a need content across.

### The writer and the answer

- **The writer sees lists as rows** (`AgenticWriterListV1`). It gets each list
  research read, at most 5, with the lists the plan's `which_items` and
  `which_say` needs cite first. Each shows its id, source, filter,
  `filter_applied`, `complete`, count, checked count, `read_at`, whether it is
  stated (a found or open `which_items` need cites it), and up to 100 members
  (`AgenticWriterListMemberV1`: id, kind, title, dates, status, owner, due
  date, checked). Members never carry text; `members_omitted` counts any
  members past 100. Built: the rows take at most half of the writer's prompt
  room; a smaller context window halves how many members of each list it
  shows, never how many lists, and code still names members from every row.
  The 5-list bound is the writer's view only: code reads every list research
  read, so it states, notes and filters each list the plan's kinds read, past
  the five the writer sees too.
  This changes the documented rule that items without text
  never reach the writer, for list members only. Related references and
  continuation metadata still never reach it.
- **The writer chooses how code states a list** (`AgenticAnswerListUseV1`): in
  full (`{id}`), by one row fact (`where`: an owner or status by value, or a
  due, created, updated, received or occurred date within an inclusive range,
  matched as the desk matches a list's date filter, in the list's time zone),
  or by members' ids (`members`), for those members' row facts. Code writes a
  `where` selection's condition into the statement ("2 of the 12 follow-ups
  with owner Mara Lind and status open are due from October 18 to October 24,
  2026: ..."); a selection by id states its members' facts, never a condition.
  A list may be used once in full or by `where`, and once by id. It never
  writes names, counts or row facts itself. A use in full or by `where` says
  which items exist; for a list that is not complete it reads "at least", and
  the part gets the list-end gap. A by-id statement gives row facts only,
  however many members it selects ("1 of the 8 Confluence pages created ...:
  PRD (status current, created October 4, 2026, updated October 4, 2026)", or
  "25 of at least 25 ..."), and adds no gap. Two uses that select the same
  members are one statement, named by id, with the lead and gap of the use
  that says which items exist. A list's statement saying which items exist
  comes before its by-id statement.
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
    statement; a complete empty list keeps today's not-found answer;
  - a list that is not complete is never evidence of absence, whatever it
    names: a selection that matches none of its members, or a list with no
    member, keeps the list-end gap, and the answer is partial.

  The noun comes from the source catalog (the tool and the selector). The
  phrase comes from the applied filter. Each name is the member's list label,
  or its label when it has none, cut to 120 characters, followed by its status,
  owner and due date wherever those differ between the named members. There is
  no source-specific branch: Confluence pages read by title; Jira tickets by
  key and summary, with status and assignee; meeting records by a line of their
  own text; follow-ups by title, with owner and due date. Built: the noun says
  what the members are, from their desk kinds after the catalog's tool
  (`agenticListMembersNounV1`): "Jira tickets", "Slack messages", and
  "decisions" or "actions" for a meeting list of those records, never
  "meetings". A kind filter the noun names has no words of its own ("2 actions
  with owner Mara"). Members of several kinds are "items from" the source's
  noun. Members that share a name, and the same status, owner and due date, are
  one name with their kinds counted. Members whose row facts differ are named
  apart, each with its own, so a merge never hides one: one meeting's actions
  due on two days are two names, each with its due date. A meeting's decision,
  action or rationale carries the meeting's label, so its row also has a list
  label: one line of its own text, at most 80 characters, then its meeting
  ("Send fixture drawings to vendor (THERM DVT sync, 2026-10-04)"). The records
  route sets it, so it is released, audited and access-checked with the row,
  which still has no text. Only Ask's list rows and code's statements read it;
  the research step, citations, impact cards and sweeps read the label, so
  their inputs do not change. It is internal research metadata, like `ref` and
  named dates: the public evidence search and open doors strip it, and their
  contract is unchanged. The count and "and N more" still count members, from
  the list itself; a name is cited by each member it covers, within the
  answer's share. That holds for a statement's first name too, which is always
  written: when it merges more members than the share allows, it covers only
  those it cites, and the rest are in "and N more".
- **Long lists.** One answer names at most 25 distinct members across all its
  lists: members selected by id first, then the rest shared round-robin
  between the statements that say which items exist, a member named by id
  costing nothing when it is named again (`agenticListNameSharesV1`).
  Each statement ends "and N more" for the rest. Names stop early if the
  statement would pass the 4 KiB statement bound. The 40-citation, 10-statement
  and 64 KiB response bounds are unchanged: list statements come first, then
  the writer's sentences, all dropped from the end to fit, and a part that
  drops one says "Some evidence could not fit in this response."
- **Filters are never silently widened (addition 3).** The response notice
  names a requested filter that a source ignored, or applied only where items
  record it, for example "Jira tickets could not be filtered by owner, so this
  list is not limited to that owner." Code adds it to the response notice for
  each list the answer uses, whatever the use selects, and each list a
  `which_say` need checks (`agenticListFilterNoticeV1`, with the noun from the
  members' kinds).
  A source that cannot apply a requested date field refuses the read. It never
  answers empty and never substitutes another field. A desk asked for an owner
  or status filter a source cannot apply refuses the read too.
- **Code states every list a `which_items` need cites,** with or without
  members, in full unless the writer selected it by `where`, whatever the writer
  replies: no list, a selection by id only, not_found, or no usable reply. No
  repair asks for it. The writer's own not_found phrases stay in the gap. A need
  code reads a list for (a found or open `which_items` need, or a `which_say`
  need of any status) that cites no list research read (rows only, or nothing
  when research stopped early) makes the part partial: "I could not confirm the
  full list of items asked for."
- **A writer's sentence stands only on text.** Its citations are the items
  whose text the writer read. Row ids and list ids in it are not citations. A
  sentence with no such citation is left out. If it cites a row or a list the
  writer saw, the reply goes back once first, saying that list facts go through
  `lists` and what no text says goes in `not_found`; if the reply code keeps
  still has one, the part is partial: "Part of the answer was left out because
  no item's text supports it." "Is DVT on hold?" answered from the Gate reviews
  page's title ends partial or not found, never answered.
- **A sentence that only restates a stated list is left out.** Code leaves out
  a writer's sentence when every text item it cites is a member, or part of
  one, of a list code states, and no other need asks about it: no `which_say`
  need's list holds it, and no found `content` need cites that member.
  "The pages are A, B, C and D", cited to four opened sections beside the eight
  names code wrote, is left out. "The PRD requires 0.1 C", cited to the PRD's
  section for a content need about the PRD, stays. Code reads what a need asks
  about from what it declares: a list kind's list, and a found content need's
  items. A need research left declaring nothing (a content need still open, or
  a list kind without its list, when research stopped) could ask about any
  member, so then no sentence is left out as a restatement.
- **One citation per cited object.** The response refuses duplicate
  citations, and a listed ticket's row and its opened body cite the same
  ticket. Code gives them one citation, in first-citation order, so a list
  statement and a writer's sentence about the same ticket share it.
- **No usable writer reply.** When the writer gives no usable reply, code
  still states each list a `which_items` need cites, and the part is partial.
  For that case only, this replaces the fallback to three released records
  ([ADR-0022](ADR-0022-agentic-ask-only.md)).
- **Prompts (addition 6).** Ask's research step gets its own wording of rules
  3 and 4. Rule 3 accepts a list's id as support for which items exist. Rule 4
  names `lists`, and says that a question about which or how many items exist
  is supported only by a complete list, cited by its id, never by some of its
  items, and that a list which cannot be read to its end is cited anyway, for
  "at least N". "You may stop early when the facts the question asks for are
  already supported" becomes "Stop as soon as every requested fact is
  supported; a question about which items exist is supported only by a complete
  list." Ask's writer prompt gets the list rules above. Task prompts do not
  change. Built: Ask's rule 3 gives each need one of three kinds, with
  examples of each: a `which_items` need is found on a list's id; a `which_say`
  need cites the list it checks, whatever its status, beside the text read;
  both list kinds are for a set the question picks by list facts, so which
  items say something when the question picks no such set is content, found by
  search; a fact about one item is content. Its examples are provider-neutral,
  as Ask's prompts must be: "which tickets mention BUG-412: search finds them",
  and the example step asks "Which tickets were created on October 4, and which
  of them mention the fixture vendor?". The reply shape names the three kinds,
  and the example has one need of each. Rule 4 and the stop rule say a
  `which_items` need is supported once each list it cites has more false, and
  that research on a `which_say` need stops once it has read every member its
  list has shown, or can open no other, without waiting for the list's end.
  Ask's search and open descriptions say a list's members need no open to show
  which items exist. The writer's prompt says code states every list marked
  `stated` and adds how many members were checked, and that its own sentences
  cite evidence text only.

### Evaluation (addition 7)

The research-loop evaluation gets a `list` part type, whose evidence names
every member. A list part scores on naming the whole list: it counts only when
the answer cites every member, and naming some members earns nothing. A
citation of a member of a list in the research result resolves like a citation
of an item read in full. A development case asks the October 4 question, with
its 8 pages as members. Built: a list part's research measures hold only for
the whole list too (found; read, when a complete list holds every member;
cited, when the plan cites every member or a found `which_items` need cites a
list holding it; handed over), and whether the answer names every member is a
code check, "lists named in full", that holds without a judge and overrides a
judge's "yes" (`tools/evals/research-loop/lib/checks.mjs`). Past an answer's 25
names, a statement that ends "and N more" names the whole list when the members
it cites plus N are exactly the list. The rows the writer sees are never
counted as noise or distractors handed, and hand over a part only when it is a
row fact (a date, owner or status). Each run reports its plan's needs by
declared kind, and a case may name the kinds its plan should declare
(`expected_kinds`), which code checks. A development case asks which October 4
pages mention BUG-412 (`which_say`), so an answer that is only the list fails.
Another asks which Jira tickets mention BUG-412 (`content`): it picks no set by
list facts, so search answers it, and a plan that declares a list kind fails.
Both keys, drafted from the export, await the founder's confirmation.

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
   - Replacement: `agenticNeedSupportV1` (itself retired, item 9) and the
     finish check above. A need with list support is checked against its lists
     ("keep reading the list"). A need without one keeps "at least one cited
     item read in full". Task goals keep line 37 unchanged.
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

9. **Inferring a need's support from its citations.** Retired; research
   declares the kind.
   - Where (at `026f60d`): `agenticNeedSupportV1`, which read a cited member
     row, or two or more cited members, as the list, and a row beside its
     opened body as content (`agentic-list-evidence-v1.ts:372-405`); its
     lookups (`:228-263`, `first`); the finish check's division
     (`agentic-ask-research-state-v1.ts:71-97`); the loop's and the
     evaluation's copies (`agentic-research-loop-v1.ts:896-907`, `:1253-1265`;
     `tools/evals/research-loop/lib/checks.mjs:104-164`).
   - Evidence: review rounds 1 and 2 found that one division gave wrong
     answers both ways. "When is THERM-41 due?" was made to read its list to
     its end. "What does the gate review page say?" got the full list stated in
     front of it. Four opened sections of the October 4 list passed as content.
   - Replacement: the declared kind and the finish check above. Membership
     still words a refusal; it never supports a need.
10. **Code's check of the writer's list use, and its repair.** Retired; code
    states the lists research declared.
    - Where: `usesList`, `listsUse`, `listProblems` with `final` and
      `foundNothing`, and the forced lists
      (`renderers/ask-renderer-v1.ts:249-302`, `:394-409`).
    - Evidence: each shape of list use the check accepted was a way past it. A
      list id beside rows, beside sections or beside members' own text; a
      selection by id; a not_found reply: each let 4 of 8 through, or replaced a
      correct content answer with the full list.
    - Replacement: code states every list a `which_items` need cites, and a
      list-kind need with no list makes the part partial.
11. **Reading meaning from what a writer's sentence cites.** Retired.
    - Where: `restates`, `claimsAcross`, `rowsOnly`, `membersCited`,
      `rowClaims`, `onlyNamed`, `rowClaimReason`, and `ROWS_NOT_FOUND` with
      `rowsLeftOut` (`renderers/ask-renderer-v1.ts:67-68`, `:238-327`,
      `:435-474`, `:485`), and the member-count rule for a by-id selection's
      gap (`:415-417`), with the statement lead's matching rule
      (`agentic-list-evidence-v1.ts:717`, a selection by id of every member
      reading as the list in full).
    - Evidence: the same citations mean a restated subset or a content claim.
      Each rule that told them apart by shape (a list id beside text, two or
      more members' text, every member checked) failed on a shape another round
      found. The not-found phrase claimed something a summary sentence never
      said. A list id beside one ticket made "When is THERM-3 due?" partial.
    - Replacement: sentences stand only on text, and one left out after its
      repair makes the part partial without saying what it claimed; a sentence
      is a restatement when it speaks only of members of a stated list that no
      other need asks about; and the checked note comes from `which_say` needs
      alone.

**Known limits.** Code follows the declaration, and nothing at run time checks
it: a check would have to read meaning from citations, which Retirements 9 to
11 retire. The guards are the required kind, the shape that names all three
kinds, rule 3 with an example need of each, the content refusal that offers no
change of kind, and the evaluation's declared-kind score (`expected_kinds`),
"lists named in full" and its two BUG-412 cases.

- **A which-question declared `content`, or left without a kind,** gets
  content's rules: no list is stated unless the writer uses it. The held answer
  (4 of the 8 pages, marked answered) comes back this way, as does "you have 10
  open follow-ups" on a first page of 10 (confirmed findings 9 and 11).
- **A content question declared `which_items`** gets the list stated, and a
  writer's sentence about its members' text is left out as a restatement, so
  the answer can be the list alone, marked answered.
- **A `which_say` question declared `content`** is answered with no checked
  note, however few members were read (confirmed finding 4).
- **A which-question or one-item question declared `which_say`** gets the
  checked note and is partial while some listed member is unchecked, and no
  list is stated unless the writer uses it. Once every member was checked,
  which the stop rule asks research to do and every shown follow-up row
  already is (its row carries its text), there is no note and no gap: the
  writer's sentence is answered as it stands. A sentence naming 4 of the 8
  October 4 pages from their opened text then comes back marked answered,
  the held answer, and so does "your open follow-ups are THERM-41 and
  THERM-42" over 12 follow-ups.
- **A question about which items of a whole source say something** ("which
  Jira tickets mention BUG-412") declared a list kind: as `which_say`, it is
  refused until it cites a list, so research lists the source and the answer
  is partial with a checked note that measures little ("4 of at least 25
  checked so far", research being shown 25 rows a list call); as `which_items`,
  the whole source is stated and the sentences naming the hits are left out as
  restatements.
- **A selection by id of the members that meet a condition** ("which of my
  open tasks are due this week", answered with `members` instead of a `where`
  date range) states those members' facts and the full list, never the
  condition, and a writer's sentence saying the condition is left out as a
  restatement. A condition on two row facts the list did not filter (an owner
  and a due date) has only this path, since `where` takes one row fact.
- **A list with both a `which_items` and a `which_say` need** keeps every
  sentence that cites its members' text, even one that only restates the list:
  with the note while some member is unchecked, and with none once every
  member was checked, when a restated subset ("the pages are A, B, C and D")
  stands unqualified beside the statement naming all eight, and the part is
  answered.
- **Both answered outcomes once every member was checked** (a which-question
  declared `which_say`, and a list with both kinds of need) can change only by
  telling a restatement from a sentence about content, which needs the
  meaning of the cited text: the guessing Retirement 11 retires.
- **A sentence about one member of a `which_say` list** carries that list's
  note even when it answers a content need about that member.
- **A content need found on one item, answered from another.** When the
  writer answers a found content need from the text of a stated list's member
  the need does not cite (the need cites a meeting record, the sentence the
  Gate reviews page), the sentence is left out as a restatement and the part
  is answered without it. Telling which need a sentence answers needs the
  meaning of its text.
- **One item's row facts cost one open** (above).
- **A writer that repeats a sentence citing only rows or list ids** after its
  repair makes the part partial, even when the sentence only restated the list
  ("All eight are current pages.").

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
- an answer that names 4 of the 8 pages without the list: code writes the full
  list anyway, and the restating sentence is left out;
- a 60-member list names 25 and says "and 35 more";
- an unfinished list refuses the finish with "keep reading the list"; a list
  that cannot be read further gives "at least N" and a partial part;
- an exactly full last page with no next link is never complete;
- "which are assigned to me" names only the members with that owner;
- a `which_say` question across a list says "k of N checked so far" until
  every member is checked, whether or not the writer cites the list; a content
  need beside its list adds no note;
- a requested filter the source ignored appears in the response notice;
- an item whose access is revoked mid-request stops the answer at the next
  check, even when it is only a list member;
- the same cases for Jira tickets, meetings and follow-ups;
- task goals: identical model inputs and the unchanged impact-card baseline;
- the research-loop evaluation's `list` part scores whole lists only;
- a found `which_items` need, or a `which_say` need found or not_found, without
  a list id is refused once, naming the list that holds its items, and a
  `which_items` need is also asked to keep reading it when it has not ended;
  `which_say` and `content` needs never wait for a list to be found;
- a list-kind need left without a list when research stops makes the part
  partial, a not_found `which_say` need included;
- a `where` date range names the members whose date falls in it, in the list's
  time zone, and the statement says the range;
- the public evidence search and open doors return a meeting record without
  its list label;
- a sentence citing only rows or list ids, repeated after its repair, makes the
  part partial;
- a missing or unknown kind is content;
- meeting records in a list are named by their own line, which no task-goal
  input carries;
- task goals: identical schema, prompts and model inputs.

Built (2026-10-18): each row of the restructure design's scenario table is a
test named by its id, in `agentic-ask-lists.test.ts`,
`renderers/ask-renderer-v1.test.ts` and, for the public doors,
`services/organization-authority/test/cross-source-ask-e2e.test.ts`.

The live check is a staging rerun of the October 4 question, comparing the
names in the answer against the list itself.
