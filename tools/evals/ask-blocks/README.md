# Ask block catalog evaluation

On 2026-11-02 the founder asked whether "model-arranged" Ask answers hold up:
treat each UI block as a tool the writer can pick, describe blocks the way
research sources are described, and find the block size that balances how
many blocks the model chooses from against how flexible each one is. This
opt-in evaluation answers that offline, before any product change.

It measures only the writer of a laid-out answer
([ADR-0045](../../../docs/decisions/ADR-0045-ask-answer-layout.md)). Research is
scripted, as in the [wording evaluation](../ask-wording/README.md): for each
case one search returns its synthetic items and research opens them all, so
every trial hands the writer the same evidence. The writer is the product's
model route (OpenRouter, `anthropic/claude-sonnet-5.5`, ADR-0037). Only the
layout part of the writer's instructions, the catalog it is shown and its
reply schema change between catalogs. Nothing is read from any tool, and no
product code changes.

```sh
npm run build:workspaces
node tools/evals/ask-blocks/run.mjs --run --credential-file /absolute/private/credential-file --out /absolute/private/report-directory
```

`--out` must be a private directory outside the repository. Unlike the wording
evaluation, the report keeps full traces: every writer and judge prompt, raw
reply, repair and check. Every case is synthetic, so the prompts carry no
person's data; the credential is read only by the product bundle and never
written. `--cases`, `--catalogs` and `--trials` make a smaller diagnostic run,
which never decides anything.

## Catalogs (pre-registered)

Each catalog entry follows the research tool contract
([ADR-0042](../../../docs/decisions/ADR-0042-research-tool-contract.md)): a
name the model passes, a `description` that says only what the entry shows,
and `params`, each field it takes with what it means and its limits. The
catalog reaches the writer as data beside `source_catalog`, and its reply
schema and checks are built from the same entries. There are no "use this
when" rules: the model picks from what entries show and what the evidence
holds. The entries are in [`catalogs.mjs`](catalogs.mjs).

| Catalog | Modeled on | What the writer picks |
| --- | --- | --- |
| `today` | Production (ADR-0045) | A form for each sentence (lead, prose, bullet, table row), sections and tables, in the production prompt and schema, unchanged |
| `templates` | OpenAI ChatKit widget templates, Microsoft Adaptive Card templates | One whole-answer template of 5 (`fact`, `list`, `report`, `story`, `profile`), filled |
| `balanced` | Vercel json-render style meaning-sized components | Any sequence of 7 blocks: `answer`, `text`, `points`, `table`, `timeline`, `card`, `quote` |
| `primitives` | Google A2UI's basic catalog, without its media and input components | A flat tree of 7 components: `Column`, `Row`, `List`, `Card`, `Tabs`, `Divider`, `Text` |

For `templates`, `balanced` and `primitives`, the system prompt is the
production writer prompt with its layout part replaced by the catalog's. Each
catalog's layout part keeps production's two wording rules word for word
(answer without restating the question; a long identifier at most once), says
that every item cites its evidence, and asks for the conclusion first. Every
catalog, `today` included, gets up to 3,000 output tokens.

## Cases (pre-registered)

Written before any run, in [`cases.json`](cases.json). One synthetic program,
THERM; the asker is Noor Haddad; today is 2026-10-30 in America/Los_Angeles.
Each case names the shapes a good answer takes, the facts it must say, the
people it may name, and, for two cases, a trap.

| Case | Expected shape | The question |
| --- | --- | --- |
| `soak-owner` | single | Who owns a test |
| `notes-due` | single | When a follow-up is due |
| `gate-blockers` | parallel or grid | What blocks a gate |
| `ship-steps` | ordered, grid or sequence, in order | Steps before shipping, in order |
| `pvt-owners` | grid | Owner and due date of five follow-ups |
| `fan-curve-options` | grid or sections | How two options compare |
| `week-events` | sequence, in order | What happened this week |
| `dvt-date-moves` | sequence, in order | How a date moved |
| `ticket-profile` | profile | What a ticket is |
| `person-profile` | profile | Who a person is on the program |
| `pvt-wording` | verbatim | A decision's exact approved wording |
| `review-multi` | sections | A review's decisions and its next steps |
| `workstreams-status` | grid | Where each workstream stands |
| `trap-undated` | sequence, parallel or grid | Events, two known only from tickets created weeks earlier |
| `trap-disagree` | any | A date the approved record and a ticket disagree on |

## Procedure

1. For each case, Ask runs as the kernel runs it with answer layout, over the
   scripted desk, with a writer that answers nothing; this records the
   writer's exact prompts without a network call.
2. Each catalog writes every case three times. A reply that fails its
   catalog's checks gets one repair, with the production repair instruction
   naming the first problem. Calls run four at a time.
3. Each reply is read into common blocks (answer, prose, list, table,
   timeline, card, quote, heading) for grading. `primitives` components have
   no meaning of their own, so code infers tables, cards and quotes from their
   structure, as an app drawing them would have to: a `Column` of two or more
   `Row`s of `Text` is a table, a `Card` holding label and value pairs is a
   card, a `Text` that is a quotation is a quote.
4. A model judge on the same route ranks each case's four trial-1 answers,
   shown as text with the evidence, once in the page's order and once
   reversed. It is reported beside the founder's ranking and decides nothing.
5. The founder ranks the same four answers per case on a private page, blind:
   labels A to D in a fixed random order per case, every catalog drawn in one
   style. After ranking, the page reveals the catalogs, the judge's ranks, the
   grades and every trial's full trace.

## Measures

A **claim** is a unit a reader takes as a fact: an answer or prose sentence, a
list item, a table row, a timeline event, a card fact, a quote. A `primitives`
`Text` is a claim when it is body or caption text of four words or more and
not a table's header row. Headings, titles, column names and labels are not.

- **Valid:** the reply passes its catalog's checks, at once or after its one
  repair. `today` uses production's own reading of the reply.
- **Grounded:** every claim cites at least one evidence id, and every cited id
  is one the writer was given; each date a claim writes (`YYYY-MM-DD`, or a
  month name with a day, read in 2026 unless it names a year) is today or a
  date of an item it cites; each person the case lists whom a claim names
  appears in an item it cites (the asker may be "you"); each quote block, and
  each span of six or more words in quotation marks, is word for word in a
  cited item's text or title; and in `trap-undated` no event date (a timeline
  event's date, a cell under a column named for a date, day, when or due, or
  a date that opens a claim) is a date the case forbids.
- **Nothing lost:** every fact the case requires is written somewhere in the
  answer (one alternative of each). In a case marked "in order", the facts
  first appear in the listed order in the blocks after the answer block (in
  the answer block itself when it is the only block).
- **Fit**, within the catalog's own blocks: the answer shows one of the
  case's shapes, or, only when the catalog cannot show any of them, one of the
  case's fallback shapes. A `single` case fits only a single answer: the
  answer block, at most one prose block of up to two sentences, nothing else,
  and at most three claims in all. Fit cannot compare catalogs (each
  catalog's own blocks decide what it can show); the founder's ranking does.
- **Stable:** in at least two of a case's three trials, the first block after
  the answer has the same shape (or there is none in both).
- **Ranks:** the founder's rank for each catalog's trial-1 answer per case, 1
  best, ties allowed; a trial with no valid answer is shown as having none and
  ranks 4. The judge's rank is the mean of its two orders.

Shapes: **single** as above; **prose** a prose block; **parallel** a list of two
or more items; **ordered** a list marked ordered (only `balanced` and
`primitives` can mark one); **grid** a table of two or more rows and columns;
**sequence** a timeline of two or more events whose dates never go back, or a
table with a date, day, when or due column whose rows never go back, or a list
whose every item writes a date and never goes back; **profile** a card with
two or more facts; **verbatim** a quote, or a quoted span, that passes the
word-for-word check; **sections** two or more headings or titles, each with a
claim under it.

What each catalog can show, for the fallback rule: `today` single, prose,
parallel, grid, sequence, verbatim, sections; `templates` single, prose,
parallel, grid, sequence, profile, verbatim; `balanced` and `primitives` all
nine.

Reported beside them, never as rules: valid at once, repairs, blocks and
claims per answer, which blocks each catalog used, output tokens and latency.

## Pre-registered rules

Written before any run, over 45 trials per catalog (15 cases, 3 trials):

1. **Valid:** at least 43 of 45.
2. **Grounded:** at least 43 of 45.
3. **Nothing lost:** at least 41 of 45.
4. **Fit:** at least 36 of 45.
5. **Stable:** at least 12 of 15 cases.
6. **Ranked by the founder:** `balanced` ranked at least as high as `today` in
   at least 9 of 15 cases.

The model-arranged direction is sound when `balanced` passes all six. The
right block size is the catalog with the lowest mean founder rank among those
that pass rules 1 to 3; a tie (mean ranks within 0.1) goes to fewer repairs,
then to fewer output tokens. The judge's mean ranks, and how often its top
pick and its order of each pair of catalogs match the founder's, are reported
beside it.

## Changes after the diagnostic run

A diagnostic run on 2026-11-02 (three cases, one trial, at `9d626c2`) decided
nothing and found two faults in the harness, fixed before the full run. No
rule, threshold or catalog entry changed.

- The provider refused the `templates` reply schema, a template given as a
  choice of five object shapes, on every call (HTTP 400). The schema is now one
  template object whose `name` is one of the five, and code refuses a field the
  named template does not take, as the five shapes did.
- Two order facts could not tell order. In `week-events` the fourth event's
  fact was "certificate", which the second event's text also says; it is now
  the certificate's date, Nov 3, which only the fourth event says. In
  `dvt-date-moves` each move's reason sat beside its new date, where a writer
  may name either first; the case now checks the three dates, in order.

## Resuming

A run that loses calls to a provider failure is resumed with
`--resume <earlier report>`. It carries every call that got a reply, reads
and checks each again with the current code, and makes only the calls a
trial still needs: the repair after a carried refused reply, or the whole
trial when its first call failed. A judged order is carried when it judged the
same trial-1 answers. The earlier report must be this evaluation's, over the
same cases, with the same writer prompts; the new report names what it
carried and counts the calls that still failed.

The first full run (2026-11-02, at `2834997`) lost calls when OpenRouter
refused them with HTTP 402, for lack of credit: trial 1 was complete, trial 2
lost 15 calls, trial 3 113, and the judge 57 of 59. It is kept as a partial
report and decides nothing.

## Writer route

The founder had ranked nothing yet, so the run of record re-ran every trial
and the judge through the product's personal Claude account writer instead
(`--writer claude-account --claude-executable <signed-in claude binary>`,
`providers/openrouter/src/claude-research`): the same model,
`claude-sonnet-5-5`, through the Claude Agent SDK and the founder's own
`claude` sign-in, with the SDK's JSON-schema output in place of OpenRouter's.
Every answer of the run of record comes from that one route; the report names
it under `model.route`.

## Result, 2026-11-02 (rules 1 to 5)

The run of record, at `0e625a8` with no uncommitted change, on
`claude-sonnet-5-5` through the founder's Claude account: 180 trials and 30
judge rankings, no failed call, one repair in all.

| Catalog | 1. Valid (43) | 2. Grounded (43) | 3. Nothing lost (41) | 4. Fit (36) | 5. Stable (12) | Output tokens | Judge's mean rank |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `today` | 45 | 45 | 45 | 37 | 15 | 18,449 | 2.30 |
| `templates` | 45 | 45 | 42 | 45 | 15 | 16,943 | 2.37 |
| `balanced` | 45 | 45 | 45 | 39 | 15 | 18,839 | 2.47 |
| `primitives` | 45 | 45 | 45 | **20** | 15 | 20,011 | 2.87 |

- `balanced` passes rules 1 to 5; rule 6, the founder's ranking, decides the
  direction and the block size.
- `primitives` fails fit: given only small components it built no table, card
  or timeline, writing lists and prose instead, so the reader gets less
  structure for the same facts.
- `templates` fits every case but loses facts in `trap-undated` in all three
  trials: its story template takes dated events only, so the undated ticket
  updates fall out.
- `balanced` misses fit in two cases only, in every trial: points instead of
  a card for `person-profile`, and one table instead of sections for
  `review-multi`. It is the only catalog that wrote steps in order, a timeline
  for both dated cases, a card for the ticket and the decision's exact words.
- The judge, which reads answers as text, ranks the three structured catalogs
  within 0.17 of each other and `primitives` last.

## Result, 2026-11-02 (rule 6 and the decision)

The founder ranked all 15 cases blind on the page the same day, with nothing
revealed before every case was ranked. The labels the page saved match each
case's fixed order.

| Catalog | Founder's mean rank | Ranked best in | Judge's mean rank |
| --- | --- | --- | --- |
| `today` | 2.33 | 4 cases | 2.30 |
| `templates` | 2.13 | 3 cases | 2.37 |
| `balanced` | **1.40** | **10 cases** | 2.47 |
| `primitives` | 3.80 | 0 cases | 2.87 |

- **Rule 6 passes:** `balanced` is ranked at least as high as `today` in 12 of
  15 cases (9 needed): better in 11, tied in 1, worse in 3. Against
  `templates` it is also better in 11, tied in 1, worse in 3, and it is better
  than `primitives` in all 15.
- **Decision:** the model-arranged direction is sound (`balanced` passes all
  six rules), and the right block size is `balanced`, the lowest mean founder
  rank among the catalogs that pass rules 1 to 3.
- **Where `balanced` lost:** `today`'s bullets or table ranked first in
  `gate-blockers`, `review-multi` and `workstreams-status`, and `templates`'
  card and timeline in `person-profile` and `trap-undated`.
- **The judge does not stand in for a reader:** its top pick matched the
  founder's in 7 of 15 cases and its order of a pair of catalogs in 39 of 90.
  It reads answers as text and cannot see their structure.

## Gate on the built writer, 2026-11-02

Written before any run.
[ADR-0051](../../../docs/decisions/ADR-0051-ask-answer-layout-v2.md) builds
`balanced` into the kernel as answer layout v2, and its design makes a re-run
of this evaluation on the built writer one of its gates
([Ask answer layout v2](../../../docs/product/2026-11-02-ask-answer-layout-v2.md),
"Gates"). The gate adds one arm, `built`, beside the four catalogs, whose
cases, measures, rules and results above are unchanged.

```sh
npm run build:workspaces
node tools/evals/ask-blocks/run.mjs --run --credential-file /absolute/private/credential-file --out /absolute/private/report-directory \
  --catalogs built --judge off --writer claude-account --claude-executable /absolute/path/to/claude
```

- **The arm:** each trial runs Ask through the kernel end to end with answer
  layout v2, over the scripted desk and research of step 1 of the procedure.
  Only the writer's call goes to the model. The kernel's own prompt, block
  catalog, reply schema and output room (2,000 tokens, where the four catalogs
  get 3,000), its reading and checks, its one repair and its downgrades decide
  what is released; the harness adds no repair. The report keeps each writer
  call's prompts, raw reply and usage, and the released answer.
- **What is graded is the released answer:** its part's `blocks`, read into
  the common blocks of step 3: the answer block's statements as the answer's
  claims, a text block as prose, points as a list, ordered or not, and a
  table, a timeline, a card and a quote as themselves, each with its title.
  Each claim's evidence is the evidence ids of its statement's citations, or
  of a table row's own: each of the answer's citations is mapped back, by its
  citation, to the case item it cites, whose id is `E1` to `En` in the order
  research opened the items, as the writer saw them.
- **Valid** means the answer was released with `blocks`; an answer released
  without them is not valid and passes nothing. Grounded, nothing lost, fit
  (`built` can show all nine shapes, as `balanced` can) and stable are
  measured as above.
- **The run:** the arm `built` alone, all 15 cases, 3 trials each, the judge
  off, the writer through the founder's Claude account (`--writer
  claude-account`, `claude-sonnet-5-5`), as in the run of record. That is a
  complete gate run, and the report says so under `complete`; any other run
  with `built` is a diagnostic and decides nothing. A run of the four
  catalogs means what it meant before. `--resume` carries a `built` writer
  reply only when the kernel asks for it with the same prompts again.
- **The gate passes** when `built` meets rules 1 to 5 at their pre-registered
  thresholds: valid in at least 43 of 45 trials, grounded in 43, nothing lost
  in 41, fit in 36, and stable in at least 12 of 15 cases (the report's
  `decision.passes`). Rule 6, the founder's blind ranking, is replaced by the
  founder's check on the desktop.

## Result of the gate, 2026-11-02

At `294bf37` with no uncommitted change, through the founder's Claude account
(`claude-sonnet-5-5`): 45 trials, no failed call and no repair. The gate
passes: `built` meets rules 1 to 5. The run resumed a complete run made at
`4769016`, before five review fixes that change only how code reads a reply,
never what the writer is sent, so the kernel asked with the same prompts and
all 45 writer replies were carried and read again by the final code; that
earlier run's grades were the same.

| Arm | 1. Valid (43) | 2. Grounded (43) | 3. Nothing lost (41) | 4. Fit (36) | 5. Stable (12) | Output tokens |
| --- | --- | --- | --- | --- | --- | --- |
| `built` | 45 | 45 | 45 | 38 | 15 | 18,935 |
| `balanced`, run of record | 45 | 45 | 45 | 39 | 15 | 18,839 |

- `built` misses fit where `balanced` did, in every trial: points instead of a
  card for `person-profile`, and one table instead of sections for
  `review-multi`. It also misses it in one `ticket-profile` trial, whose writer
  wrote text instead of a card.
- Every block the writer gave was released as it gave it: no quote fell short
  of being word for word, no timeline event's day was one its items lacked,
  and no block was left with too few items.
- The writer used 12 tables, 10 points (3 of them numbered steps, one in each
  `ship-steps` trial), 8 timelines, 3 quotes and 2 cards, 2.3 blocks and 4.4
  claims an answer.

## Tuning the block descriptions, 2026-11-02 (pre-registered)

Written before any run.
[ADR-0051](../../../docs/decisions/ADR-0051-ask-answer-layout-v2.md) left
tuning the block descriptions for later, where this evaluation and the
[wording evaluation](../ask-wording/README.md) found them weak. A change to
them changes every desktop answer, so it is measured before and after, and the
founder decides.

Where the built writer is weak, at `294bf37`:

- **The answer block runs long.** The wording evaluation's leads average 14.9
  words (17.7 in its run at `4769016`, the same prompt) against layout v1's
  10.2. In a one-fact answer the writer names the item in full ("The follow-up
  to publish the DVT release notes to the team space is due Nov 4, 2026."),
  adds an owner, a status or a date the question did not ask about, or opens
  with the record ("The approved Pilot Delta review decided ..."). The v2
  prompt never says that its answer block is the lead its no-restating rule
  speaks of.
- **`person-profile` gets points, not a card, and `review-multi` one table,
  not titled sections,** in every trial of `balanced` and `built`; in
  `review-multi` the decisions crowd a lead of 33 to 35 words.
- **Where the founder ranked `balanced` below another catalog:** `gate-blockers`
  third of four, under a long lead and, in two of its three trials, a last
  block that only named the source (one `built` trial too); `review-multi` and
  `workstreams-status` second, under `today`'s table; `person-profile` second,
  under `templates`' card; `trap-undated` second, under `templates`' timeline.

The change, to `ANSWER_BLOCK_CATALOG` and `ANSWER_BLOCKS_PROMPT` only: no
schema, check, reading or drawing changes.

| Where | Before | After |
| --- | --- | --- |
| `answer` description | The direct answer to the question, in one or two sentences. | The lead: the direct answer to the question, in one short sentence, or two when the question asks two things. |
| `card` description | One person, project, ticket or decision, with its key facts as label and value. | One person, project, ticket or decision at a glance, with its key facts as label and value, such as a person's role and the work they own or approve, or a ticket's status, owner and priority. |
| The prompt's answer line | - The first block is "answer": the conclusion, in one or two sentences. | - The first block is "answer", the lead: the conclusion, in one short sentence, or two when the question asks two things. It says only what the question asks: an owner, a status or a date the question did not ask about goes in a block after it. |
| New prompt line, after it | | - When the question asks about two or more different kinds of things, give each kind its own block after the answer, with a title that names it. |
| New prompt line, after that | | - The app shows the sources of every statement, so never add a block that only says where the facts come from. |

Every other description, every `params` text, both wording rules and every
other prompt line stay word for word. A description still says only what its
block shows ([ADR-0042](../../../docs/decisions/ADR-0042-research-tool-contract.md)).

**The comparison.** Before is the writer of PR #394 (`c5bd827`'s prompt, at
this commit); after is the change, at the commit that makes it. Each side gets
one complete gate run of the arm `built` (15 cases, 3 trials, the judge off)
and one complete run of the wording evaluation (10 cases, 3 trials), all
through the founder's Claude account (`claude-sonnet-5-5`), on the same day:
before first, then after. The gate's run at `294bf37` and the wording runs at
`4769016` and `294bf37` are earlier runs of the before prompt, reported beside
it to show how much two runs of one prompt differ.

**Rules.** The change is proposed for PR #394 only when all three hold:

1. **The gate:** after, `built` passes rules 1 to 5 at their pre-registered
   thresholds.
2. **The wording:** after, the wording evaluation passes its three rules, each
   in at least 27 of 30 trials.
3. **The founder's ranking:** the founder ranks each case's trial-1 answers,
   before against after, blind, on a private page that draws both in one
   style, as the 2026-11-02 page did. They are labeled A and B: the 15 cases
   sorted by the SHA-256 of `<case id>:ask-blocks-tuning`, after is A in the
   1st, 3rd, 5th and every other odd place of that order (8 cases) and B in
   the rest. The founder prefers after in more cases than before; a case
   ranked the same counts for neither. The page reveals which is which, the
   grades and the traces only after every case is ranked.

**Reported, never rules:** the lead's words (the wording evaluation's mean
lead, and here the answer block's mean words); fit in each case, where the
change aims at a card in `person-profile` and titled sections in
`review-multi` in at least two of three trials; blocks, claims and the blocks
used per answer; repairs and output tokens.

### Result of round 1, 2026-11-02

Before at `67c6351` and after at `ef42144`, each with no uncommitted change,
through the founder's Claude account (`claude-sonnet-5-5`): 45 gate trials and
30 wording trials a side, no failed call and no repair.

| | Before | After, round 1 | Before at `294bf37` |
| --- | --- | --- | --- |
| 1. Valid (43) | 45 | 45 | 45 |
| 2. Grounded (43) | 45 | 45 | 45 |
| 3. Nothing lost (41) | 45 | 45 | 45 |
| 4. Fit (36) | 39 | 39 | 38 |
| 5. Stable (12) | 15 | 15 | 15 |
| Answer block, mean words | 25.5 | 23.8 | 25.8 |
| Prose blocks | 27 | 21 | 24 |
| Output tokens | 19,738 | 18,915 | 18,935 |
| Wording rules 1, 2 and 3 (27 each) | 30, 30, 30 | 30, 30, 30 | 29, 30, 30 |
| Wording lead, mean words | 14.7 | 13.0 | 14.9 (17.7 at `4769016`) |

- Rules 1 and 2 pass after round 1.
- Blocks that only named a source or added context are gone: `gate-blockers`
  ended with one in 2 of 3 trials before and in none after, and
  `workstreams-status` in 2 and none.
- Both aims are missed. `person-profile` still gets points and `review-multi`
  one table in all three trials, word for word as before: the writer keeps
  the decisions in the lead and counts its next-steps table as the second
  kind's own block.
- Leads shorten unevenly: `workstreams-status` from 25.0 words to 14.7 and
  `ship-steps` from 29.0 to 21.7, but `gate-blockers` grows from 28.7 to 34.7,
  adding "The retrieved records show none of the three as complete."

### Round 2 (pre-registered)

Written after round 1 and before any round-2 run. Round 2 keeps round 1 and
changes two prompt lines, aimed at the two misses. It was written after
reading round 1's answers to these same cases, so a fit it gains in
`person-profile` and `review-multi` says less than one gained blind; the
founder's ranking is the check. The card line is the first in the prompt that
names a block for a kind of question; the descriptions still say only what a
block shows.

| Where | Round 1 | Round 2 |
| --- | --- | --- |
| The prompt's line on kinds of things | - When the question asks about two or more different kinds of things, give each kind its own block after the answer, with a title that names it. | - When the question asks about two or more different kinds of things, the lead only sums them up, such as how many of each there are, and each kind gets its own block after it, with a title that names it. |
| New prompt line, after it | | - A question about who a person is, or what a project or ticket is, gets a card after the lead with its key facts. |

- **The run:** one complete gate run of `built` and one complete wording run
  at the commit that makes round 2, through the founder's Claude account, as
  in round 1. Before and round 1 are the runs above.
- **Rules 1 and 2** apply to round 2 as written.
- **Rule 3 becomes one three-way ranking**, which replaces the two-way page;
  nothing has been ranked. The founder ranks each case's three trial-1
  answers (before, round 1, round 2) from 1, best, to 3, ties allowed, blind,
  on one private page that draws all three in one style. Labels: the 15 cases
  sorted by the SHA-256 of `<case id>:ask-blocks-tuning`, and the three
  versions sorted by the SHA-256 of `ask-blocks-tuning:<version>` (round 2,
  round 1, before); the case in place k, counting from 0, shows that order
  rotated by k mod 3 as A, B and C, so each version is A, B and C in five
  cases each.
- **The proposal** is round 2 when it passes rules 1 and 2, else round 1. Rule
  3 holds when the founder ranks the proposal above before in more cases than
  below. Round 1 against before, and round 2 against round 1, are reported
  beside it.

### Result of round 2, 2026-11-02 (rules 1 and 2)

At `7c7345b` with no uncommitted change, through the founder's Claude
account: 45 gate trials and 30 wording trials, no failed call and no repair.

| | Before | Round 1 | Round 2 |
| --- | --- | --- | --- |
| 1. Valid (43) | 45 | 45 | 45 |
| 2. Grounded (43) | 45 | 45 | 45 |
| 3. Nothing lost (41) | 45 | 45 | 45 |
| 4. Fit (36) | 39 | 39 | 39 |
| 5. Stable (12) | 15 | 15 | 15 |
| Answer block, mean words | 25.5 | 23.8 | 21.6 |
| Prose blocks | 27 | 21 | 20 |
| Output tokens | 19,738 | 18,915 | 18,741 |
| Wording rules 1, 2 and 3 (27 each) | 30, 30, 30 | 30, 30, 30 | 30, 30, 30 |
| Wording lead, mean words | 14.7 | 13.0 | 12.5 |

- Round 2 passes rules 1 and 2, so it is the proposal; rule 3 waits for the
  founder's ranking.
- Both aims are missed again. Given the card line word for word, the writer
  still answers `person-profile` with a lead and points, and `review-multi`
  with the decisions in the lead and one table: a prompt line does not move
  either choice on this model.
- The leads shorten further, in the answer block from 25.5 words to 21.6
  (the two runs of the before prompt differ by 0.3) and in the wording
  evaluation from 14.7 to 12.5 (its three runs of the before prompt range from
  14.7 to 17.7). One-fact leads lose what was not asked: "Dev Okafor owns it.",
  "Lena Brandt approved it." In `gate-blockers` round 2's lead is 24.0 words,
  round 1's 34.7.
- A block that only names a source came back once (`gate-blockers`, trial 2).
- The ranking page is made from these three runs' trial-1 answers, with the
  versions named `before`, `round-1` and `round-2` in the label hash.

### Result of rule 3 and the decision, 2026-11-02

The founder ranked all 15 cases blind on the page the same day, with nothing
revealed before every case was ranked: every rank was saved before the
reveal, and the labels the page saved match each case's fixed order.

| | Before | Round 1 | Round 2 |
| --- | --- | --- | --- |
| Founder's mean rank (1 is best) | 1.60 | 1.67 | 1.80 |
| Ranked best, a tie counting for each | 8 cases | 7 cases | 6 cases |

- **Rule 3 fails:** round 2 is above before in 4 cases, below in 6 and level
  in 5. Round 1 against before: above in 5, below in 6, level in 4. Round 2
  against round 1: above in 4, below in 6, level in 5.
- **Decision:** the tuning is not proposed. PR #394 keeps its writer prompt.
- Round 2 lost to before in `soak-owner`, `gate-blockers`, `week-events`,
  `dvt-date-moves`, `person-profile` and `trap-undated`; it won in
  `notes-due`, `ticket-profile`, `workstreams-status` and `trap-disagree`; the
  other five were level.
- Where before won, its lead carried the substance: the three gate conditions
  by name (`gate-blockers`), what the four records were (`week-events`), the
  soak follow-up's status and due date (`soak-owner`). Round 2's leads summed
  them up instead ("the gate opens only when all three conditions are met",
  "four approved meeting records"). Where round 2 won, its lead was short and
  complete ("The release notes are due Nov 4, 2026.") or carried the
  disagreement ("set the PVT build for Nov 16, but it may slip to Nov 20").
  A last block that only named the source, or added a caveat, did not keep
  before from first place in `gate-blockers` and `week-events`.
- So the reader does not want a shorter lead as such but the answer's
  substance in it: "say only what the question asks" and "the lead only sums
  them up" cut substance along with filler. The three versions' mean ranks lie
  within 0.2 of each other, from one reader.

Both rounds are reverted on their branch (revert commits); the writer's prompt
and catalog are PR #394's again.

## Quick lead check, 2026-11-02 (pre-registered)

Written before any run. After the ranking, the founder asked for a quick
answer block, with three or more things set out below it as points, steps or
a timeline instead of written out in it, and approved this check to get it.
Both blind rankings agree:

- An answer of sentences only lost to one with a points, steps, table,
  timeline, card or quote block every time the two met: 8 of 8 on the
  catalog page, 2 of 2 on the tuning page.
- A shorter lead alone did not win. Where two leads differ by 3 words or
  more, the longer ranked better 17 to 9 on the catalog page and 13 to 9 on
  the tuning page; the shorter ones had cut something the question asked.
- A quick lead with the detail in a block below did win: in `pvt-wording`
  round 1's 20-word lead, the decision's words quoted below it, over 32 and
  36; in `notes-due` round 2's 8 words over 17.
- In `review-multi` every answer either page showed writes the three
  decisions out in one lead of 34 to 36 words, above one block of next
  steps; two rounds of prompt wording did not move it.

**The check, in code.** An answer block's sentence lists items when, outside
brackets, the text after a colon in it is three or more parts, separated by
commas or semicolons, the last joined by "and", "or" or "then" ("and then"
and "and finally" too), unless what follows that word opens with is, are,
was, were, has, have, had, will, would, can, could, should, may, might or
must: then it goes on about the sentence's own subject and names no other
item ("You own it: the follow-up is assigned to you, Noor Haddad, and is
still open."). Only answer layout v2's answer block is checked; layout v1 and
an Ask without layout are unchanged, and the prompt and catalog do not
change.

- **What it does:** a reply whose answer block lists items takes the
  writer's one repair, as a sentence resting on list rows does (that check
  first, when both apply), with the repair instruction "the answer block
  writes out three or more items in one sentence: keep it to the short
  answer, such as how many there are or what they come to, and give the
  items in a block after it: points, numbered points when their order
  matters, or a timeline when each has a date". The repair's reply is
  released whatever its lead; when no repair can run, or the repair's reply
  is unusable, the first reply is.
- **How the rule was chosen:** by reading the 257 distinct leads the two
  evaluations have produced. It holds the 45 that write out three or more
  items after a colon (`gate-blockers`, `review-multi`, `ship-steps`,
  `week-events`, `workstreams-status`) and, with the exception, no other. It
  misses a list with no colon ("cover the DVT build, its gate, shipping and
  the supplier certificate"): a rule without the colon also held clauses
  that are not a list ("Five follow-ups are open, each with a different
  owner and due date, and none has been checked yet.").

**Held-out questions.** Because the rule was chosen on these 15 cases, five
new questions in [`held-out-cases.json`](held-out-cases.json), written before
any run, ask about another synthetic program (HELIX, with other people), each
with a list for an answer: decisions and next steps (`ho-review-next`),
blockers (`ho-launch-blockers`), steps in order (`ho-release-steps`), a status
roll-up (`ho-task-status`) and a month's events (`ho-supplier-month`). They
are graded as the 15 are, with `--case-set held-out` (the built writer only,
the judge off), and decide nothing alone.

**The comparison.** Before is PR #394's writer: the gate and wording runs at
`67c6351` above (its kernel is this commit's), and one held-out run at this
commit. After is the commit that adds the check: one complete gate run of
`built` (15 cases, 3 trials), one complete wording run (10 cases, 3 trials)
and one held-out run (5 cases, 3 trials), through the founder's Claude
account (`claude-sonnet-5-5`).

**Rules.** The check is proposed for PR #394 only when all three hold:

1. **The gate:** after, `built` passes rules 1 to 5 at their pre-registered
   thresholds.
2. **The wording:** after, the wording evaluation passes its three rules.
3. **The founder's ranking:** the founder ranks, blind, each question whose
   trial-1 answer the check changed (its first reply sent back, among the 15
   cases and the 5 held-out ones): before's trial 1 against after's, drawn
   in one style, as A and B. The questions sorted by the SHA-256 of
   `<case id>:ask-lead-check`, after is A in the 1st, 3rd, 5th and every
   other odd place, B in the rest. After is preferred in more questions than
   before; a question ranked the same counts for neither.

**Reported, never rules:** how many first replies the check sent back, of the
45 gate trials, 30 wording trials and 15 held-out trials, and in which cases;
released leads that still list items by the rule; the lead's words; fit in
each case, the held-out ones included; the blocks used; repairs and output
tokens.

### Result of the quick lead check, 2026-11-02 (rules 1 and 2)

At `ca9b9a5` with no uncommitted change, through the founder's Claude account
(`claude-sonnet-5-5`): 45 gate trials, 30 wording trials and 15 held-out
trials, no failed call. Held-out before ran at `c47cd51`, whose kernel is
PR #394's.

| | Before | After |
| --- | --- | --- |
| 1. Valid (43) | 45 | 45 |
| 2. Grounded (43) | 45 | 45 |
| 3. Nothing lost (41) | 45 | 44 |
| 4. Fit (36) | 39 | 42 |
| 5. Stable (12) | 15 | 15 |
| Repairs | 0 | 12 |
| Answer block, mean words | 25.5 | 21.5 |
| Output tokens | 19,738 | 24,697 |
| Wording rules 1, 2 and 3 (27 each) | 30, 30, 30 | 30, 30, 30 |
| Wording lead, mean words | 14.7 | 15.3 |
| Held-out: valid, grounded, nothing lost (of 15) | 15, 15, 15 | 15, 15, 15 |
| Held-out: fit (of 15) | 12 | 15 |
| Held-out: repairs; answer block, mean words | 0; 26.7 | 9; 20.2 |

- **Rules 1 and 2 pass.** Rule 3 waits for the founder's blind ranking of the
  7 questions whose trial-1 answer the check changed: `gate-blockers`,
  `review-multi`, `ship-steps`, `workstreams-status`, `ho-review-next`,
  `ho-launch-blockers` and `ho-release-steps`.
- **Where it fired:** 12 of the 45 gate trials' first replies
  (`gate-blockers`, `ship-steps` and `review-multi` in all 3, `workstreams-status`
  in 2, `week-events` in 1) and 9 of the 15 held-out ones (`ho-review-next`,
  `ho-launch-blockers` and `ho-release-steps` in all 3), and never in the
  wording cases, `fan-curve-options`, `dvt-date-moves` or `ho-supplier-month`.
  After its one repair no released lead lists items by the rule; without the
  check, 24 of 60 released leads did.
- **What it changed:** `review-multi` now gives its decisions as points under
  "Decisions" and its next steps as a table, in all three trials ("The
  approved Oct 28 DVT review made three decisions, listed below, and each has
  an open follow-up."), and so fits; `ho-review-next` does the same on the
  held-out program. `gate-blockers` leads "Three conditions must all be met
  before the DVT gate opens, and the retrieved records show none of them
  completed.", `ship-steps` "The approved DVT ship plan sets four steps that
  must happen in a fixed order before the build ships.", each above its list.
- **The fact lost** (`trap-undated`, trial 1, "chase") is in a trial the check
  did not send back.
- **The cost:** a repaired answer makes a second writer call. Output tokens
  rise 25% on the 15 cases, and a repaired trial's writer time has a median
  of 7.3 seconds against 3.7 for one without a repair.

### Result of rule 3, 2026-11-02

The founder picked between before and after in all 7 changed questions,
blind, with nothing revealed before the last pick: every pick was saved before
the reveal, and the labels the page saved match the fixed order.

| Question | Picked | After was |
| --- | --- | --- |
| `ship-steps` | After | A |
| `ho-release-steps` | After | B |
| `review-multi` | After | A |
| `gate-blockers` | After | B |
| `workstreams-status` | After | A |
| `ho-review-next` | After | B |
| `ho-launch-blockers` | After | A |

- **Rule 3 holds:** after is preferred in 7 of 7 questions, before in none,
  none the same, whether after stood as A or as B. All three rules hold, so
  by the pre-registration the check is proposed for PR #394.
- **It is not merged yet.** ADR-0051 rejected a repair for a block that falls
  short, because a second writer call costs seconds for a fault code can mend
  itself. Code cannot turn a lead that lists items into a short answer and a
  list, so this check needs the call. That cost (a median 7.3 seconds against
  3.7 for a repaired answer, 25% more output tokens on the 15 cases) and the
  ADR's amendment wait for the founder's separate approval.

## Limits

- One model route and synthetic items only, and the writer is the only model
  step: research is scripted and reads no list, so code-written list tables
  are not exercised.
- The page draws every catalog in one plain style, not the desktop's; how the
  desktop would draw a new block is not measured.
- The judge reads answers as text, not as drawn, and is the writer's own model.
- The founder's ranking is one reader's.
- Inferring `primitives` structure is code's reading; another app could read a
  tree differently.
