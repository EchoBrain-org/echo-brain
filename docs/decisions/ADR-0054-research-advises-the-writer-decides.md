---
schema_version: 1
id: ADR-0054
kind: decision
title: Research advises, the writer decides, the checker verifies
component_ids:
  - CMP-ORGANIZATION-AUTHORITY
created_at: 2026-11-19
reviewed_at: 2026-11-19
reviewed_ref: a06da569a10effeb26c6c553c44cb70a17ea76b7
status: proposed
supersedes: []
superseded_by: []
updates:
  - ADR-0041
  - ADR-0051
---

# ADR-0054: Research advises, the writer decides, the checker verifies

The founder set the rule on 2026-11-19: each step of Ask has one role and a
clear boundary, and research "should only find answers and put them in the
evidence desk and tell how to use them but never enforce it". The founder
chose the decisions below in the same conversation and asked for a Codex
review (`gpt-6.2-astra`, 2026-11-19), whose findings are worked into this
text. This record is proposed until the founder accepts it. Nothing here is
built.

## Context and options

### Why now

On 2026-11-19 every Ask on staging V17 failed because the writer's reply
schema was too large for Claude's strict grammar. That was fixed at the
transport (the schema now travels as a tool, as the Claude Agent SDK sends
it). The failure showed a deeper problem: the writer's reply schema keeps
growing, and part of its size exists only because research reaches across
into the writer's job.

### How it works at `a06da56`

Research returns evidence and a plan. The plan splits the question into
needs, and research labels each need with a kind (`which_items`, `which_say`,
`content`) and a status (found, not found, open).

Code then applies those labels to the final answer
(`renderers/ask-renderer-v1.ts`):

- For every list a `which_items` need cites, code states the list in the
  answer "whatever the writer replies". The writer may narrow a list through
  the reply's `lists` section, but code restores every member a found or open
  need requested, and states the whole list when the writer selects none of
  a list such a need declares.
- A need that cites no list makes code add "I could not confirm the full
  list of items asked for" and marks the part partial.
- For a list a `which_say` need cites, code appends "(4 of 8 checked so
  far)" inside the writer's own sentence.
- A request research flags as asking for a change adds "Ask can read your
  sources, but it can't make changes..." and marks the answer partial.
- The reply carries a top-level `lists` section and a `member` field on
  points and table rows, so the writer can report its selections back to
  code, which then decides what is stated and avoids stating a member twice.

So research's reading of the question overrides the writer's judgement of
what the answer should contain. The reason was sound (ADR-0041): a model
retyping a long list drops items and miscounts. The guarantee is worth
keeping. It lives in the wrong step.

A writer can leave members out for two different reasons, and the current
design treats them alike:

- It slipped: it retyped twelve items and dropped three.
- It chose to: the person asked which tickets are open on the launch, and
  nine of the twelve are about the launch. Restoring the other three makes
  the answer wrong.

### What the app shows today

The desktop does not show the answer's free-text `notice`
(`product/echo-desktop/src/host/views.ts`: "Its diagnostic notice stays out").
It shows three typed explanations from `gap_details`: the request asked for a
change, the search was interrupted, and what was not found. Coverage,
did-not-fit, filter and dropped-claim notices are in `notice` and are not on
the screen. The only way a list's limits reach the reader today is text code
writes into the answer.

### Ways to build it

1. **Replace in place on a branch, gated by the evaluations.** Rewrite the
   writer's contract and the checks on one branch, and merge only when the
   evaluations hold up on both model routes. The old logic is deleted in the
   same change. One large change to review; nothing half-done reaches `main`.
2. **Ship both with a switch.** Real-use comparison and an easy rollback, but
   two answer paths live in the product for a while.
3. **Small steps on `main`.** Small reviews, but the middle steps are the
   worst of both designs: the writer places lists and code still overrides.

The founder chose the first on 2026-11-19.

## Decision and consequences

### The roles

| Step | Owns | Never does |
|---|---|---|
| Research | Finding things, putting them on the evidence desk, leaving notes on how they could be used | Decide what the answer contains |
| Writer | What the answer says, what it shows, and in what order | Retype a list's members; state anything the desk does not support |
| Checker (code) | Verifying each claim against the desk, removing what is not supported, filling the lists the writer placed, and reporting on the run | Add content of its own, or judge what the question asked for |
| The app | Drawing the released answer | Change content |

### Decisions the founder made

1. **Research's plan reaches the writer as notes.** Research keeps its plan
   for its own loop. The writer receives it as data: for each part of the
   question, what was found, where it is on the desk, and what was not
   found. The notes carry research's own wording of each need, marked as
   research's notes and never as the person's question. This reverses the
   earlier exclusion of need text from the writer ("working hypotheses are
   not user requirements"): the hypotheses are shown, as hypotheses. No code
   path lets a research label add or remove answer content after a usable
   writer reply, with the one exception listed under "Left as it is".
2. **The writer never retypes a list. It places a list block.** A list is a
   fact on the desk. The writer adds a `list` block to its blocks, naming
   the list and optionally narrowing it:
   - whole: all members;
   - filtered: by one row fact (the existing `where`: owner, status, or a
     date within since and until);
   - hand-picked: the members it names by id.

   Code fills the block from the desk. A narrowed list says how many it
   shows out of how many there are ("9 of the 12 tickets..."). Because
   nothing is retyped, a member cannot slip and the caption's count is the
   desk's.
3. **When the writer shows no list, its choice stands.** If the person asked
   which items exist and the writer answers without a list block, the answer
   is released as written. Evaluation cases catch a writer that does this
   wrongly, in testing, where the prompt can be fixed. Code does not insert
   the list.
4. **Content gaps are the writer's to say.** What was and was not found is
   content. The writer says it through `not_found`, advised by the notes.
5. **Reports on ECHO's own run are not the writer's to suppress.** Research
   stopped early, source coverage was incomplete, evidence did not fit, and
   the checker left something out: code reports these as it does today.
6. **A partly read list is reported by what research did, not by a label.**
   When the released answer uses a list (places it, or a kept sentence cites
   it) and research read the text of only some of its members, the answer
   says so as a fact: "4 of the 8 items were read in full." Code no longer
   writes inside the writer's sentences.

The founder accepted research's wording in the notes (1), decision 6 and the
gate below "for now", to be revisited after a live test.

### Open for the founder: run reports are mostly not on the screen

Decision 5 was worded in conversation as "always shown by the app". The app
hides `notice` today, on purpose. This change does not alter that: the
reports in decision 5 stay where they are (`notice`, and the two typed
flags), no more and no less visible than now. Making coverage, did-not-fit
and dropped-claim reports visible needs typed fields in the Person protocol
and desktop work, with a coordinated client release. That is a separate
decision for the founder and is not built here.

The rule this change holds itself to instead: **nothing a reader can see
today becomes invisible.** That is why decision 6 puts the partly-read fact
in the answer itself, as a code-written statement that cites the list's
rows, the same shape a prose list statement has today.

### Left as it is, on purpose

**"The request asked for a change" stays a research flag that code acts on.**
It is a research label changing the answer, and by the rule it should become
a note. It is left alone here because it is the one typed explanation the app
shows that keeps a person from believing something was sent, and the writer's
reply has no field to carry it. It moves when actions leave the reply (the
next project), where "Ask cannot do this" becomes the absence of an action.

### Calls made while writing this record (not the founder's; correct any)

- **A usable writer reply is one that parses and has anything left after the
  check:** a statement, a placed list, a `not_found` entry, or a follow-up
  draft. A reply of only `not_found`, only drafts, or only a list is usable.
  Only when nothing is left does today's fallback apply (code states the
  lists the plan's `which_items` needs cite, or shows the records research
  read, or says nothing was found). An empty inventory alone still never
  starts the writer, as today.
- **A narrowed list that matches nothing shows no block.** Code says none
  matched through the existing path (`agenticListSelectionNotFoundV1`), which
  confirms absence only for a complete list whose members all record the
  fact used; otherwise the existing "could not test" wording applies. Twelve
  tickets with unknown owners never become "none owned by Dana".
- **A narrowing code cannot read drops the block; it never widens.**
  `members` that is not an array, or a `where` with no readable field,
  selects nothing, and the reader is told something was left out. (ADR-0041
  read an unreadable `where` as the whole list. With no grammar holding the
  reply's shape, one mistyped selector must not publish every item.)
- **A list block has no title.** Today's layout drops a list's title, and a
  hand-picked list titled "Tickets mentioning the recall" would be a claim
  its rows do not support. The writer says why it chose the members in a
  sentence that cites their text.
- **The writer's order holds.** Today's layout moves every list to just
  after the answer. A list block is released where the writer placed it.
- **Prose counts are not verified, as today.** A sentence cannot rest on
  list rows alone, and that rule stays. A sentence that also cites any text
  can still state a count; nothing checks the number, now or after. The
  guard is the writer's instructions (counts come from the list block) and an
  evaluation case.
- **A list block is filled from the whole list on the desk.** `where` and
  the whole-list form apply to every member, including rows the writer was
  not shown. Hand-picking is limited to rows it was shown. When fitting the
  response cuts rows, the caption says what is shown.
- **The writer can place only the lists it was shown** (at most five, as
  today). Today code states a `which_items` list beyond that bound; after
  this change a sixth list can only be mentioned. The notes say how many
  lists and rows were read and not shown, and `notice` records it.
- **List notices follow use.** The reports about a list's filter, its
  cut-off and its unrecorded facts apply to every list the released answer
  uses (placed, or cited by a kept sentence), not to lists a research label
  names. A sentence that leans on a list cannot shed that list's limits.
- **"I could not confirm the full list of items asked for" becomes a note.**
  Only a research label triggers it.
- **The answer's outcome follows the writer.** After a usable reply,
  `outcome` and the not-found details come from the writer's `not_found` and
  from run status, not from need statuses.
- **Notes are bounded and optional.** Need text is cut to a fixed length
  before it reaches the writer, and the notes never take room from evidence.
  Research on the Claude account route declares its needs only at an accepted
  finish, so an interrupted run has one synthetic open need: the writer must
  work with notes that say nothing.
- **Follow-up drafts stay in the writer's reply for now.**

### Guarantees that do not move

These depend today on code that this change rewrites. They are kept exactly,
with their tests:

- **Visibility follows citations, whatever the layout.** A sentence or a
  `since` sentence that cites a list inherits the visibility of every row of
  that list the reader is shown, so an approver-only fact does not stay
  readable in saved history after access is withdrawn.
- **A statement over the citation limit (40) is dropped whole,** never
  released with some of its citations.
- **A follow-up draft's `about` points only at an item the writer was
  shown.** Filling a list from the whole desk never widens what a draft may
  point at.
- **The released answer's shape does not change.** A list block is released
  the way a code-stated list is today: a captioned table whose rows cite
  their members, or, where `agenticListTableV1` gives no table (one member,
  members with nothing beside a title, more than six columns), the prose
  list statement, whose sentence carries shown-of-total. The Person
  protocol, the app, and saved answers are untouched.

### The writer's reply, before and after

Removed: the top-level `lists` section, and `member` on points items and
table rows, with the rules about not stating a member twice.

Added: one block.

```json
{ "block": "list", "list": "L1", "where": { "field": "status", "value": "open" } }
```

`where` and `members` are optional and are not given together. The list
entries the writer reads lose the `stated` and `requested_members` markers;
what they said moves into the notes.

### Consequences

- The writer's reply schema gets smaller. Record its size in schema
  positions before and after. Getting under the strict-grammar limit is not
  a goal; the transport fix handles size.
- A weak answer is possible where code used to guarantee a list.
- Ask again compares backing statements, as today. A long list can fall out
  of the comparison when its statement passes the previous-turn citation
  budget. That limit exists now and is not changed.
- The part of `ask-renderer-v1.ts` that reconciles the plan's needs with the
  writer's selections is deleted.

### Not in this change

- Moving follow-up drafts and future actions out of the reply. That is the
  next project and gets its own record.
- Showing run reports in the app (see "Open for the founder").
- Any change to how the app looks, or to how research searches.
- The writer not drafting a follow-up for an implied task.

### What would make this a failure even if it works

- A research label that adds or removes answer content after a usable
  writer reply, other than the one left on purpose.
- Two writer paths on `main`.
- Anything a reader can see today becoming invisible.
- A visibility, citation-limit or draft-pointer guarantee weakened.

## Migration, rollback, and evidence

**Order.** The transport fix (branch `claude/ask-writer-grammar-budget`)
merges first. Without it the OpenRouter route cannot run a baseline.

**Gate.** `tools/evals/ask-blocks/run.mjs`, case sets `main` and `wording`,
complete runs (every case, three trials), on both writer routes
(`--writer openrouter` and `--writer claude-account`), once on `main` after
the transport fix and once on the branch. Two runs of one prompt differ by a
few trials (the README records fit at 39 and 36 of 45), so on each route the
branch must:

- meet the evaluation's pre-registered pass marks on the existing cases; and
- on each rule counted in trials, fall no more than 3 trials below `main`'s
  run; on `stable`, counted in cases, no more than 1 case below.

If a rule falls further, both sides are run a second time and the two runs
of each side are added together; the same margins, doubled, then decide. A
branch still below is not merged.

`follow_ups` is run and reported; its known misses do not block.

**What the gate cannot see.** Both routes run the writer against scripted
research. The research-loop evaluation runs against the deployed staging
revision, so before merge it cannot test the change's handoff from live
research to the writer. Kernel tests cover that handoff with scripted
bundles on both research shapes, including an interrupted Claude account
run. The live handoff is checked in the first staging round after merge,
which is the founder's live test.

**New evaluation cases.** The harness has no list cases today:
`tools/evals/shared/ask-cases.mjs` scripts one search, opens and a finish,
and every need is `content` and found. Extending it to script list reads,
need kinds, statuses and partly read lists is part of this change. The new
cases are their own group with their own pass marks, registered before the
first run:

- asked which items exist: the writer places that list;
- asked for a part of a list, by a row fact and by meaning: the writer
  narrows it, and the answer says shown-of-total;
- asked about one named item that sits in a list: the writer places no list;
- research's notes say a part was not found: the answer says so;
- a research note disagrees with the evidence: the answer follows the
  evidence;
- asked how many: the count the reader sees is the list's.

A trial passes only on the writer's own choice: it is graded from the
writer's parsed reply together with the released answer, and a trial whose
release came from the fallback fails, so the removed override cannot pass
its own replacement. These cases gate the branch. They are also run on
`main` for the record, where the which-items case passes by construction.

Kernel tests that assert code-stated lists are rewritten to assert the list
block; tests of narrowing, visibility, the citation limit and draft pointers
are kept. The builder lists every rewritten test in the pull request.

**Release.** The app-facing answer shape is unchanged, so no client release
is tied to this change and saved answers keep drawing.

**Rollback.** Revert the merge. Nothing stored changes shape. Answers and
follow-up drafts saved while the change was live stay as they were saved.

**Left to the builder.** The exact words of the notes and of the writer's
instructions for them; caption and partly-read wording, as long as each
states only the fact; how the deleted renderer logic is cut; test layout.
