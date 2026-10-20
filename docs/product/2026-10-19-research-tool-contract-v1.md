# Research tool contract v1

Date: 2026-10-19. Status: approved by the founder on 2026-10-19 with the five
recommended decisions, and shipped the same day in #340 (84c8038). Shipped is
not deployed or qualified.
[ADR-0042](../decisions/ADR-0042-research-tool-contract.md) owns the contract
as built and says where the build differs from this design.

Code references are at staging release `40ba71c`. Trace ids are in the
`echo-staging` LangSmith project.

## Goal

The founder's goal for research (2026-10-19): full visibility of ECHO and of
every tool the person has connected, within the person's permission scope. The
tools must be simple, and the model combines them to find the context.

A prompt can't hold everything, so full visibility means four things:

1. **Research knows what exists:** every collection, in ECHO and in each
   connected tool, with its fields and its links to other collections.
2. **It can see any slice quickly:** a short list of any collection, filtered
   by its fields or by a time window.
3. **It can reach any single item** and follow its links: from an open item to
   its meeting and the people in it, or from a project to its leads.
4. **It never sees more than the person.** ECHO's rules decide what the person
   sees in ECHO, and the person's own account decides what they see in each
   tool.

The questions it must answer, in the founder's words:

- What are the open items, and who owns them?
- Which meeting is each from, and who was in it (when that was recorded)?
- How long has it been since each was assigned?
- What are the current projects, and who are the project leads?
- What happened yesterday?
- Give me the link to the Jira space for project X.
- Any question whose answer is in Jira, Confluence or Slack.

## Why

On 2026-10-19 staging ran 13 Asks on `40ba71c`. The 11 that named a meeting,
a release, a source and a date, or follow-ups finished in 2 or 3 rounds, each
within 25 seconds. The 2 open-ended ones failed without reading anything in
full:

- **"what happened yesterday"** (`14cf3f41-1550-4d18-9a62-ef117dd9d6a9`)
  stopped on its time budget after 6 rounds. Its meeting lists that filtered by
  date were marked unavailable, because some meetings have no recorded date,
  while the result the model read said "nothing more to list". The model sent
  the same date filter in 4 shapes, paged through the meeting list, and
  searched for the date as text. The answer: it can't verify meetings for that
  day.
- **"what are my current active projects?"**
  (`d8cd5a3e-78ea-4927-895d-df4e286d9e6d`) stopped with no progress after 5
  rounds. It sent a refused date filter to follow-ups 7 times. No tool can list
  projects.

The causes:

1. **Research starts blind.** The model sees each source's description and
   nothing else. Before the first step, ECHO searches every source for 20
   items, but shows them to the model only when everything the person can
   access fits in those 20 (the small-scope preload in
   `agentic-research-loop-v1.ts`).
2. **Whole parts of ECHO have no tool, and items hide their dates and links.**
   - ECHO stores projects with their status, members and roles, an
     organization directory, each project's Jira project and Confluence
     spaces, and when each record was approved. No research tool reaches any
     of it.
   - An open item records when it was created, sent to its owner and
     reassigned (`PersonOpenItemV1`), but the follow-up research sees drops
     those dates (`PersonFollowUpEvidenceV1`).
   - Its meeting is held server-side and never given to the model.
   - Meetings record their participants and approver
     (`PersonOpenMeetingDetailV1`), but research's meeting items don't carry
     them.
   - In the connected tools, research can't list Jira projects, Confluence
     spaces or Slack channels, and it reads Slack only when the question names
     a channel.
3. **Calls are narrow, and a failed path gets retried.** A step makes at most 4
   calls, and the time budget allowed "what happened yesterday" 6 rounds.
   Nothing stops research re-sending a refused call, so both runs spent their
   calls retrying one path.
4. **The contract is prose, and it contradicts itself.** Which filters and date
   fields a source takes is written in its description, sometimes. The
   follow-ups description says each follow-up has a "due date"
   (`follow-up-evidence-v1.ts:53`), while the `date_field` description says
   "follow-ups have no dates" (`agentic-ask-v1-model-protocol.ts:73`). A
   filter that didn't work comes back four different ways.
5. **Nothing tests open-ended questions,** so this release passed every check.

## What stays the same

- **Read only.** Research never writes to ECHO or to a connected tool.
- **ADR-0041's guarantee.** A list never passes a wider set off as the one
  asked for, and a date filter is never quietly applied to a different date
  field. A date filter a collection can't apply is still refused.
- **ADR-0040's due date.** A follow-up's due date comes from the item it
  follows in a connected tool, and shows only after a live open, so follow-ups
  can't be filtered by due date. (This design does give follow-ups ECHO's own
  dates: created, sent, reassigned and checked.)
- **The rest of Ask.** The access check before each model call (ADR-0038), Ask
  progress (ADR-0039), the answer writer, code stating complete lists, and the
  existing answer versions.

## Testing open-ended questions

Nothing tested an open-ended question, so this design added an open-ended
family to the research-loop eval, in development and holdout. It is graded on
what research reached and what it spent, never on the answer's wording, and a
release's staging Ask check asks a few of its questions. The
[research-loop README](../../tools/evals/research-loop/README.md#open-ended-family)
owns the family and its checks as built.

## The founder's decisions

The founder approved the five recommended decisions:

1. **Date refusals.** A date filter a collection can't apply is still
   refused, as ADR-0041 decided, now as a structured outcome.
2. **Items with no such date** are counted and kept out of the list.
3. **Dates without a field.** `since` and `until` with no `date_field` match
   any of the item's dates, and each row shows which date matched.
4. **Calls per step.** Up to 10, from 4.
5. **New citation kinds.** Projects, people, Jira projects, Confluence spaces
   and Slack channels become citable, in a new answer version the desktop and
   CLI must adopt. (Slack channels were not built; see As built.)

## As built

[ADR-0042](../decisions/ADR-0042-research-tool-contract.md) records the
contract as built: the tools, each source's capabilities as data, one outcome
per filter, dates, links, sources, the V8 answer with progress V3, and the
permission rules. It replaces this design's map, three tools, collections,
connector contract and build order. Two parts of the design were not built:

- **Slack channels.** Production has no Slack reader, so Slack stays out of
  scope and there are no Slack containers (ADR-0042, "Sources").
- **A `total` on lists.** Only projects declare `count`; a list's size is
  still its number of members (ADR-0042, "Known limits").

The receipt fix came later, in
[ADR-0043](../decisions/ADR-0043-ask-receipt-counts-what-research-looked-through.md).
