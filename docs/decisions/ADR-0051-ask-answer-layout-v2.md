---
schema_version: 1
id: ADR-0051
kind: decision
title: The Ask writer arranges an answer from a catalog of seven blocks
component_ids:
  - CMP-ORGANIZATION-AUTHORITY
  - CMP-PERSON-CLIENT
created_at: 2026-11-02
reviewed_at: 2026-11-02
reviewed_ref: 9e6bc8a356c826d77e2094a268340ba3fa848549
status: accepted
supersedes: []
superseded_by: []
updates:
  - ADR-0041
  - ADR-0042
  - ADR-0045
---

# ADR-0051: The Ask writer arranges an answer from a catalog of seven blocks

On 2026-11-02 the founder agreed that Ask answers are "model-arranged": the
writer picks from a closed set of blocks, code checks them, and fixed desktop
components draw them. The same day an offline, pre-registered evaluation
([block evaluation](../../tools/evals/ask-blocks/README.md)) compared four
block catalogs on 15 synthetic THERM questions, three trials each, on
`claude-sonnet-5-5`, and the founder ranked the answers blind. Seven
meaning-sized blocks ("balanced") passed all six rules: valid, grounded and
nothing lost in 45 of 45, fit in 39 of 45, a mean founder rank of 1.40 against
production's 2.33, best in 10 of 15. The plain-English design is
[Ask answer layout v2](../product/2026-11-02-ask-answer-layout-v2.md). The
founder accepted this record on 2026-11-02, before it was built. Acceptance
does not mean the change is deployed or qualified.

## Context and options

Layout v1 ([ADR-0045](ADR-0045-ask-answer-layout.md)) lets each writer sentence
say it is the lead, a bullet or a table row, and name its section; the blocks
are described in prose in `ANSWER_LAYOUT_PROMPT`. Research sources, by
contrast, reach the model as a catalog of entries since
[ADR-0042](ADR-0042-research-tool-contract.md). The evaluation tested blocks
described the same way, as data beside `source_catalog`.

1. **Keep layout v1 and tune its prompt.** Rejected: the founder ranked it
   below the balanced catalog in 11 of 15 cases, and it cannot show a
   timeline, a card, a quote or numbered steps.
2. **Whole-answer templates or small layout primitives.** Rejected by the
   evaluation: templates lost facts in `trap-undated` in all three trials, and
   primitives fit only 20 of 45 and ranked last.
3. **The balanced catalog as layout v2, asked for by a new header value.**
   Chosen.

Within option 3:

- **A second header**, so an Authority that predates v2 would answer v1
  instead of refusing. Rejected: there are no older servers to stay
  compatible with ([ADR-0048](ADR-0048-retire-older-person-routes.md)).
- **New block kinds inside `layout`.** Rejected: the answer's validator does
  not know which value the request sent, and v1's `table` would mean two
  things. v2 gets its own part field, so a v1 part, and every answer saved
  with one, is unchanged.
- **The writer's own words as each item's claim.** Rejected: a date, label or
  attribution the block shows could then differ from the claim that is
  checked and audited. Code writes those claims from the fields, as it writes
  a v1 row's statement from its cells.
- **A repair when a block falls short.** Rejected: a second writer call costs
  seconds for a fault code can mend by reading the block more plainly.
- **A repair when the answer block writes out a list** (2026-11-02, after the
  build). A v2 answer block whose sentence wrote out three or more items
  after a colon would have taken the writer's one repair, asking for a short
  answer with the items below it. Rejected by the founder: the extra call
  rewrites the whole answer whenever the check refuses the first draft, "no
  need for extra round that is a patch". The answers it produced did win the
  founder's blind ranking in all 7 questions it changed, so a short answer
  with its list below is the shape to reach, without a second writer call
  ([block evaluation](../../tools/evals/ask-blocks/README.md), "Quick lead
  check").
- **The answer block's description and an example reply** (2026-11-03, after
  the build). That repair's rule went into what the writer reads first: the
  answer block's description and the prompt's line about it said it never
  writes out three or more items, and one example reply on an unrelated topic
  showed a short answer with its points below. Both gates passed, but leads
  that write out a list fell only from 18 of 60 to 15, and the founder's
  blind ranking preferred the writer without it in 4 of the 5 questions it
  changed. Rejected, and the founder closed the tuning: "no further tuning
  needed. i want to use it live" ([block
  evaluation](../../tools/evals/ask-blocks/README.md), "Quick lead on the
  first try").

## Decision

### Asked for by `x-echo-answer-layout: 2`

- A client sends `x-echo-answer-layout: 2` on an Ask. `1` keeps layout v1 and
  no header keeps no layout, both byte for byte as today; any other value is
  refused, as before. An Authority that predates this record refuses `2`, so
  the Authority is released before a desktop that sends it.
- The person client sends `2` on every Ask. Only an answer to a request with
  `2` carries `blocks`.

### The contract: a part's `blocks`

A V8 part may carry `blocks` (answer layout v2) instead of `layout`, never
both. Its statements stay the cited claims, validated as before. `blocks`
groups them, in their order, every statement in exactly one block:

| Block | Fields | Statements |
| --- | --- | --- |
| `answer` | none | 1 or 2; only as the first block |
| `text` | `title`? | 1 or more |
| `points` | `title`?, `ordered` | 2 or more, one item each |
| `table` | `title`?, `columns` (2 to 6), `rows`, `caption`? | as a v1 table |
| `timeline` | `title`?, `events` | 2 or more, one event each |
| `card` | `title`, `entity` (`person`, `project`, `ticket` or `decision`), `facts` | 2 or more, one fact each |
| `quote` | `text`, `from`? | exactly 1 |

- An event is `{date, text, who?}`, its `date` a calendar day; a timeline's
  dates never go back. A fact is `{label, value}`. An event, fact or quote is
  exactly one statement and cites what that statement cites.
- A table is layout v1's: each row its cells and citations, and its rows
  together cite exactly what its statements cite. A list statement is one
  table with a row per member it names; a writer's row is one statement.
- Every text stays within bytes like layout v1's. Layout never adds a claim
  or a citation.

### The writer: a block catalog beside the source catalog

- Only for `2`, the writer's input carries `block_catalog` beside
  `source_catalog`: for each block, `block` (the name it passes),
  `description` (what the block shows, never when to use it) and `params`
  (each field it takes, with its meaning and limits). Its prompt is the
  answer prompt followed by the evaluation's layout part, whose two wording
  rules are layout v1's word for word, with two production lines: the reply
  names the lists it uses, and the writer never writes items, rows or events
  for a list's members, which code states. The reply is
  `{lists, blocks, not_found}`, and `since` for an Ask again
  ([ADR-0047](ADR-0047-ask-timeline.md)); its schema is built from the same
  entries. The writer keeps layout v1's output room (2,000 tokens, 2,500 for
  an Ask again); the evaluation's longest balanced reply was 589.
- Code writes the statement for a row from its columns and cells, as v1
  does; for an event from its date, who and text ("2026-10-27, Noor Haddad:
  Approved the soak plan."); for a fact from its card's kind, title, label
  and value ("Ticket: THERM-48; Status: In review."); and for a quote from its
  source and words ("Noor Haddad, Oct 27 review: “Ship when the soak
  passes.”").

### Code checks, and downgrades

Code decides which statements fit exactly as before: W1 to W6 of
[ADR-0041](ADR-0041-complete-lists-as-ask-evidence.md), list statements first,
10 statements and 40 citations to a part, repeats dropped, and the one repair
for a sentence resting on list rows alone. Before that, each item is checked
against the evidence the writer read:

- **Every item cites evidence text.** One that does not is left out (W1).
- **A quote is word for word in what it cites**: its words, as a run of whole
  words ignoring case and punctuation, are in the title or text of an item it
  cites. Otherwise it reads as a text sentence, its source and words without
  quotation marks.
- **A timeline date is a date of an item it cites**: one of its recorded
  dates in the request's time zone, or a date its title, text or attributes
  write. Otherwise the event reads as a text sentence without that date, after
  its timeline's other events.

Then code reads the kept statements in order: the answer block first, then
the list statements code writes, then the writer's other blocks in its order,
each block's items as the writer gave them, events by date. A points, table,
timeline or card block left with fewer than two items reads as text, keeping
its title; consecutive untitled text reads as one block. Only when the writer
gave no answer block is its first kept item the answer, and only when it is
an untitled text sentence. A layout that does not pass the contract is left
off, and the answer reads as it would without one.

### The desktop

The desktop owns typography, as in ADR-0045: the answer as v1's lead, a title
as a section heading, points as bullets or numbered steps, tables as v1's, a
timeline with each event's day beside it, a card with its kind's icon and its
facts as label and value, a quote set apart with its source under it. Every
item keeps its own source numbers, in light and dark. Copy answer writes the
blocks as Markdown. An answer saved with layout v1 still draws with it.

## Consequences

- Requests with no header or with `1` are unchanged: the same writer prompt
  and schema, statements, citations, privacy and audits.
- A v2 answer that would exceed its byte bound is released without `blocks`:
  the same claims, a row, event, fact or quote still the claim code wrote, in
  the order and numbering an answer without layout has.
- The audit, the evaluation and the judge read statements as before.
- The writer's input grows by the catalog, about 2 KB, taken from its
  evidence budget.
- Retiring layout v1, once every installed desktop sends `2`, is a later
  decision. Tuning the block descriptions where the evaluation found them
  weak was tried after the build, measured by the block evaluation, and
  closed by the founder with none of it kept ("Context and options").

## Amended 2026-11-02: no count caps

The founder decided the same day, before any release, that the writer
arranges an answer without count limits ("remove the cap"): the block
catalog, the reply schema, code's reading of a reply and the contract cap no
number of blocks, of a text's sentences, of points, of a table's rows or
columns, of a timeline's events or of a card's facts. The answer block keeps
its one or two sentences, every text its length, and every block its
minimum. A table row too wide for one statement (4 KiB) reads as text, cut to
fit, so no reply can fail the Ask. This replaces the table above's 2 to 6
columns for layout v2; layout v1 keeps its own.

These still bound a bigger answer, unchanged until the founder decides:

- **10 statements and 40 citations to a part**
  ([ADR-0041](ADR-0041-complete-lists-as-ask-evidence.md), W6): items past
  them are dropped from the end, and the part says some evidence could not
  fit. Every client's answer validator holds a part to 10 statements.
- **The answer's 64 KiB:** a v2 answer past it is released without its
  blocks, then cut from the end with a gap, as layout v1's.
- **The writer's output room:** 2,000 tokens, 2,500 for an Ask again; the
  evaluations' longest balanced reply was 589.
- **A list table's 25 named members** (ADR-0041).

## Amended 2026-11-02: no count of statements or citations

The founder then lifted ADR-0041's bounds for an answer in blocks ("Yes,
lift it"): a part arranged in blocks has no count of statements of its own,
and its answer no count of citations. The writer is told that the answer
prompt's "up to 10" does not apply to an answer in blocks; W6 drops nothing
of such an answer for those counts; the V8 answer's validator takes a part
with blocks past ten statements and its answer past 40 citations; the Ask
audit records a question's citations up to 1,000, past what an answer's
64 KiB can hold; and the desktop numbers, shows and checks every source of an
answer in blocks, and keeps stored answers of up to 1,000 statements.

Layout v1 and an answer without layout keep ADR-0041's 10 statements and 40
citations, as every installed client checks, and so does a v2 answer released
without its blocks because it passed its 64 KiB. These stay, as guards
against a runaway reply: the answer's 64 KiB, the writer's output room (2,000
tokens, 2,500 for an Ask again), and the 25 members a list's statement names.
So does what one statement may hold, in blocks too: 4 KiB, code's checked
note (ADR-0041's W5) included, so a row too wide to take the note whole is cut,
never the note; and 40 citations, so an item whose list id would bring more of
that list's private rows is left out whole, never cut short of them, the part
saying some evidence could not fit. An Ask again's account of what is
different since is left out whole for the same reason.

## Amended 2026-11-04: preserve selection independently of presentation

Live staging found 43 matching tickets, but the answer showed only 25. The
writer supplied selected ids in two groups; the parser discarded the second
group, and code also forced an unrelated unfiltered inventory into the answer.
The founder asked to fix these deterministic failures and confirmed the
selection and presentation behavior below in PR #400.

Research's found `which_items` needs record the inventory L id and every
requested member E id. These ids preserve the requested selection across
writer and layout choices; supporting facts unrelated to membership belong in
a separate content need. Opened bodies map back to the inventory's member
identity. The writer receives this set as `requested_members`, independently
of `stated`, which says that a membership need cites the inventory. A
`which_items` need still open when research stopped requests its members, or
declares its list, in the same way, as ADR-0041 states such a need's list; the
answer stays partial.

Every layout parses the whole selection before applying presentation bounds.
A `members` array has no 25-item or evidence-array bound. Repeated groups for
the same list merge by id, preserving every selected member once. A selected
opened body or section names the member it is part of, as research's ids do;
ids outside that inventory are removed. A `where` given beside `members` is
kept, and selects when the members name no member of the list. Compound
conditions can name every matching id without extending the one-field `where`
language.

What code states of a stated list is the writer's selection together with
research's. The writer's selection is a use that names at least one member, or
carries a `where`; code adds the precise members research's found membership
needs request that it leaves out, so a selection that omits requested members
never loses them. When the writer selects none of a list and a found
membership need cites the list with no member ids, code states that whole
declared list: all members for a complete list, or known members with
`at least` and partial status for an incomplete list. A selection that names
no member, given empty or left empty by that removal, is no selection, with
one exception: an explicit empty `members` array in a reply that also has
`not_found` says that no member of the list answers, and code states nothing
of it, unless research requested specific members of it, which code still
states. Other inventories do not enter the answer merely because research read
them. Each need retains that fallback independently: another need's precise
subset of the same inventory does not erase an omitted L-only declaration.

A v2 table row or points item may declare an optional internal `member` E id
for the inventory member it presents, independently of its supporting
`evidence`. This allows abbreviated display labels without guessing membership
from wording. Code accepts the declaration only for an actual inventory member
whose own text (or mapped opened body) grounds that retained item. Unknown or
mismatched ids, a citation without a declaration, downgraded rows, and statements
dropped by grounding or per-statement citation limits do not cover a requested
member. Code restores the uncovered members, avoiding duplicate enumeration
when valid rows or points already present them. This writer field is internal;
it does not extend the released answer API or apply to other block kinds.

A v2 answer renders every selected member. Code divides a logical list into
statements that each fit 4 KiB and 40 citations, then groups their rows into
one table with one caption describing the whole selection. Columns are shared
across chunks, and each row keeps its own citations. The 64 KiB answer bound
and plain fallback remain. The fallback recomposes selection without structured
member bindings before applying legacy limits, so lost rows cannot hide members.

Layout v1 and answers without blocks retain 25 named members, 10 statements,
and 40 answer citations. They first merge the complete selection, then show
`and N more` for omitted names and report partial with an explicit fit notice.
A v2 answer that falls back to these bounds follows the same rule. A response
never reports a complete answer while silently dropping selected members.

The research tool's 25-row page size is unchanged; research can continue paging.
This amendment changes selection and presentation, not source access, research
budgets, or what constitutes grounded evidence.
