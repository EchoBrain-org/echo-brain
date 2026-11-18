---
schema_version: 1
id: ADR-0053
kind: decision
title: A chat answer may carry a not-sent card, and a card no longer needs a meeting
component_ids:
  - CMP-ORGANIZATION-AUTHORITY
  - CMP-PERSON-CLIENT
created_at: 2026-11-18
reviewed_at: 2026-11-18
reviewed_ref: 45b788a840454f47bf4f28472d976deb66b84a58
status: proposed
supersedes: []
superseded_by: []
updates:
  - ADR-0033
  - ADR-0042
  - ADR-0051
---

# ADR-0053: A chat answer may carry a not-sent card, and a card no longer needs a meeting

The founder said on 2026-11-18 that follow-up cards must not depend on
meetings, and approved the design below in the same conversation. This record
is proposed until the founder accepts it. Nothing here is built, deployed or
qualified.

## Context and options

At `45b788a`:

- A card is one row of `authority_impact_items_v1` (ADR-0033). Rows are
  written in one place only: an impact run's finishing transaction, by code,
  from the impact card and the approved meeting's own actions. Every row
  requires a run and an approved record.
- Research is read only: "Research never writes to ECHO or to a connected
  tool" (research tool contract v1, ADR-0042).
- Ask cannot create a card.
- A card has no due date, and Send acts on the cards of one run.

The founder's case: while chatting with ECHO they notice a task the meeting
missed and want to hand it to its owner now. Today that takes another meeting,
or an email that ECHO never tracks. In their words: "cards can definitely
exist without a meeting. I don't want the system to have the assumption that
only meetings can provide cards. A meeting is just the easiest place to
extract, that's why I started with it."

Options for how ECHO makes a card:

1. **A card tool inside the research loop.** Every trigger gets it at once. It
   changes the loop every question runs through, so all research has to be
   evaluated again. One model call would make the card and another would write
   the answer, so the two can disagree. It reverses the read-only rule for
   research itself.
2. **The Ask writer returns cards with its answer (chosen).** The loop stays
   read only. One call writes the answer and the card, so they agree. It is
   the pattern cards already follow after approval: a writer's checked output
   is turned into rows by code. Each trigger's writer has to adopt it
   separately.
3. **A plain form with no model.** Cheapest, but the person retypes what ECHO
   already knows, and it is not the founder's goal.

Options for a card nobody owns yet:

1. **A new parked state.** The founder asked whether this was over-engineering.
2. **The existing `unsent` state (chosen).** A new card already waits in its
   creator's list until sent, and shows "no owner" until one is picked.

Options for deciding when to make a card:

1. **Intent rules or a classifier in code.**
2. **The model decides (chosen).** The founder: "we can just keep it very
   simple and leverage the LLM capability to decide."

Options for asking the person whether they want a card:

1. **ECHO asks in words in its answer.** The Ask writer's rules remove any
   sentence that cites no evidence, so the question would be dropped. A reply
   of "yes" also reaches the next writer only as a rewritten question, without
   the earlier offer.
2. **The not-sent draft is the question (chosen).** When the model sees a
   task it makes a draft. The person sends it, edits it or dismisses it.

## Decision and consequences

- **A card may come from a chat answer.** It records who created it and that
  it came from a chat. No run and no approved record stand behind it.
- **The Ask writer may return cards with its answer.** They are part of its
  fixed, code-checked output. Code saves each one with the answer as an
  `unsent` card in the asker's own list.
- **The model decides.** The writer gets one short instruction and either
  makes a not-sent draft or makes none. There are no intent rules in code.
- **The draft is the question.** ECHO does not ask in words whether the
  person wants a card. A draft reaches nobody until its creator sends it, and
  a draft they do not want is dismissed like any other card.
- **Only the task is required to create a card.** An owner is optional to
  create and required to send. A due date is new and optional. Links to what
  the card is about are optional and may point only at items the run read.
- **One card system.** Chat cards use the same rows, states, owner matching,
  reassignment, lists and desktop drawing as cards from meetings.
- **Who sees a chat card:** its creator, and its owner once it is sent. This
  is a new case in the one access policy function ADR-0033 names.
- **No outside text is stored.** A card keeps pointers and ECHO's own words,
  never text read from a connected tool (ADR-0032, ADR-0033). Code replaces a
  title of an outside item in a draft's line and drops a draft that copies
  six or more consecutive words from an outside item's text, unless the
  person's question or one of ECHO's own items says the same words.
- **A dismissed draft is final.** Only its creator ever sees it, and it cannot
  be reopened, closed or given to someone else.
- **Edits.** The creator can change the task and the due date. The owner can
  hand the card on or close it.
- **Send works on one card.**
- **Research stays read only.** ADR-0042's rule holds for the loop. What
  changes is that an answer's release may also save not-sent cards for the
  person who asked.
- **Research no longer refuses the request.** The researcher was told that Ask
  cannot change data, so a request to hand someone a task ended as "can't make
  changes". It is now told that drafting a follow-up is the one supported
  action, and its finish may say the person asked for one. That flag lets the
  writer run when research found nothing, so a task about something ECHO has
  no record of can still be drafted. No research tool is added or changed.
- **A card is about at most one item.** When the writer links a draft to a
  ticket, a page, an ECHO record or an ECHO document it was shown, that item
  is the card's own pointer, read live like any other card's. Otherwise the
  card points at itself.

Consequences:

- ECHO writes to its own state as the result of a question for the first
  time. The write is limited to the asker's own not-sent cards.
- Because the model decides, a draft can appear after an ordinary question
  and wait in the person's list until they dismiss it. The writer's
  evaluation has to cover "no card here" as well as "card here".
- An answer that carries cards is a change to the Ask response, so the
  desktop and older clients are affected (ADR-0050, ADR-0051).

Known limits of what was built, found in review on 2026-11-18:

- A phrase shorter than six words taken from an outside item's text can still
  reach a draft. The person reads every draft before sending it.
- A person who asks again after an answer was saved but never arrived gets a
  second draft, because an Ask request carries no retry key. The duplicate is
  an unsent draft in their own list.
- If saving a draft fails after the answer's audit row is written, the request
  fails while the audit still records the answer.
- A member who stops owning a card while they are reading it may still receive
  that one read.

Not decided here: the after-approval impact check adopting the same card
form, a card tool inside the loop, and a plain "new card" form.

## Migration, rollback, and evidence

- Built on branch `worktree-chat-cards` on 2026-11-18; not merged, deployed or
  qualified. `run_id` and `record_sha256` were required columns, an insert
  trigger demanded a finished impact run, and an update trigger kept a card's
  text fixed, so the storage changed: Authority baseline V17. It carries no
  migration, as no baseline has. The release rules say an incompatible
  baseline needs a designed migration or an authorized reset
  ([deploy/release/README.md](../../deploy/release/README.md)); which of the
  two is the founder's call and is not made yet.
- The cleanups other documents deferred to the next baseline (the unused sweep
  columns among them) are not part of V17.
- The older step-by-step research path has no "asked for a follow-up" flag, so
  with it a task about something ECHO has no record of is not drafted.
- Existing clients reject an Ask answer that carries a key they do not know,
  so the Authority, the CLI and the desktop change together (ADR-0050).
- Rollback is not designed yet. A chat card has no run or record to fall back
  to, so removing the feature after cards exist needs its own answer.
- Evidence still to gather: the Ask writer's live evaluation. Its five cases
  (a clear request, an implied task, an ordinary question, an unknown owner and
  a relative date) are pre-registered in `tools/evals/ask-blocks` and have not
  been run against a model.
