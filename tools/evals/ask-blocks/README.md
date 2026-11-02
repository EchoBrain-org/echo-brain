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
