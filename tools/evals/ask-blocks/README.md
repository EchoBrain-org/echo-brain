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

At `4769016` with no uncommitted change, through the founder's Claude account
(`claude-sonnet-5-5`): 45 trials, no failed call and no repair. The gate
passes: `built` meets rules 1 to 5.

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
