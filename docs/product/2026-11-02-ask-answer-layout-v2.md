# Ask answer layout v2: model-arranged blocks

Status: accepted by the founder on 2026-11-02. Decision record:
[ADR-0051](../decisions/ADR-0051-ask-answer-layout-v2.md).

## What changes for the person

An Ask answer on the desktop reads as a short document the writer arranges from
seven blocks, instead of layout v1's lead, headings, paragraphs, bullets and
tables:

| Block | What it shows |
| --- | --- |
| answer | The conclusion, in one or two sentences, first |
| text | A short paragraph, optionally under a title |
| points | Parallel items, or numbered steps when the order matters |
| table | Items that share the same fields, under columns |
| timeline | Events in date order: when, what happened, who |
| card | One person, project, ticket or decision, with its key facts |
| quote | The exact words of one source, and who said or recorded them |

Every item keeps its own source numbers, and Copy answer writes the same
answer as Markdown.

## Why

On 2026-11-02 the founder blind-ranked four block catalogs on 15 synthetic
THERM questions ([block evaluation](../../tools/evals/ask-blocks/README.md)).
These seven "balanced" blocks passed all six pre-registered rules: valid,
grounded and nothing lost in 45 of 45 trials, fit in 39 of 45, a mean founder
rank of 1.40 against production's 2.33, and best in 10 of 15 cases.

## How it works

1. **The desktop asks for it.** The person client sends
   `x-echo-answer-layout: 2`. A client that sends `1` keeps layout v1 exactly as
   today, and one that sends nothing keeps plain sentences. An Authority that
   predates v2 refuses `2`, as it refuses any value it does not know, so the
   Authority is released before the desktop that asks for it
   ([ADR-0048](../decisions/ADR-0048-retire-older-person-routes.md): no older
   servers to stay compatible with).
2. **The writer picks blocks from a catalog, like it picks sources.** The
   catalog reaches the writer as data beside `source_catalog`: each block's
   name, what it shows, and each field it takes with its limits
   ([ADR-0042](../decisions/ADR-0042-research-tool-contract.md)'s shape). The
   entries, prompt and reply shape are the evaluation's, with two lines
   production needs: the reply also names the lists it uses, and the writer
   never writes items for a list's members, because code states them.
3. **Every item is one cited claim.** An answer or text sentence, a point, a
   table row, a timeline event, a card fact and a quote are each one statement
   with its own citations. Code writes the statement for a row, an event, a
   fact and a quote from what the block shows ("2026-10-27, Noor Haddad:
   Approved the soak plan.", "Ticket: THERM-48; Status: In review."), so the
   claim that is checked and audited is the one you read.
4. **Code checks, and downgrades instead of failing.**
   - An item that cites no evidence text it read is left out, as today.
   - A quote whose words are not word for word in an item it cites reads as
     plain text, without quotation marks.
   - A timeline event whose date is not a date of an item it cites reads as
     plain text without that date, after the timeline.
   - A points, table, timeline or card block left with fewer than two items
     reads as text; a layout code cannot build is left off, and the answer
     reads as plain sentences.
5. **Everything else stays.** Code still writes list members as tables, right
   after the answer; an answer too large for its byte bound is released
   without layout; the writer's one repair, and the writer's prompt and reply
   shape for v1 and for no layout, are unchanged byte for byte.
6. **No count of blocks, items, statements or citations.** The founder
   lifted them for an answer in blocks (ADR-0051, both amended 2026-11-02):
   what bounds it is its 64 KiB, the writer's output room, the 25 members a
   list's statement names, and what one statement may hold, 4 KiB and 40
   citations. Layout v1, no layout, and a v2 answer released without its
   blocks keep ADR-0041's 10 statements and 40 citations.
7. **The desktop draws each block in its own style**, light and dark: the
   answer as today's lead, titles as section headings, bullets, numbered
   steps, tables as today, a timeline with dates down the side, a card with
   its kind's icon and label and value rows, a quote with its source under it.
   It numbers, shows and checks every source of an answer in blocks, however
   many. Answers saved before this change still draw with layout v1.

## Gates

- `npm run check` and the desktop CI jobs pass.
- The [wording evaluation](../../tools/evals/ask-wording/README.md) still
  passes its three rules with the v2 prompt.
- The block evaluation, merged with this change, re-runs on the built writer
  (the kernel's own prompt, schema, reading and checks) and passes rules 1 to 5
  at their pre-registered thresholds. Rule 6, the founder's ranking, is
  replaced by the founder's check on the desktop.

## Not in this change

- Tuning block descriptions. `balanced` lost to plain bullets or a table in
  gate-blockers, review-multi and workstreams-status, and to a card or
  timeline in person-profile and trap-undated: that is prompt work, measured
  by the block evaluation.
- Retiring layout v1 once every installed desktop asks for v2.
- People annotating block choices, and any staging release, which follows
  the [operator playbook](../operations/PB-OPERATIONS-001-authority-operator-lane.md)
  after the founder validates on the desktop.
