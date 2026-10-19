# Research tool contract v1

Date: 2026-10-19. Status: approved by the founder on 2026-10-19 with the five
recommended decisions, to be built end to end.

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

## The principle: simple tools that the model combines

Research gets a map and three tools. Each tool does one thing and never
guesses. The model decides everything else: which collections to look at, in
what order, how many at once, and which links to follow. That is what it is
good at. Code adds no planning machinery. It enforces four rules the model
never has to think about.

## The map

Before research makes any call, its first prompt carries a map:

- who the person is, their time zone and today's date;
- their projects with their role, up to a bound, then "and N more";
- each tool and whether it is connected, so research can say "connect Jira to
  see this";
- every collection the person can read. Each entry lists the collection's
  fields, its filters and their allowed values, and its links. It also lists
  its date fields, each with a one-line meaning, and whether it can be listed
  to the end. For a collection in ECHO it also gives how many items the person
  can see.

Each collection's entry is data, not prose. The desk checks every call against
the same entry, so what research is told and what the desk accepts can't drift
apart. Descriptions go back to describing content only, which removes the
follow-ups contradiction.

## The three tools

The tools keep today's names and parameters, so the prompt, the evals and the
ADRs change as little as possible. A `source` names a collection, as it names a
source today.

**`search(query, source?, since?, until?, date_field?)`** finds the items
whose title or text matches the keywords, ranked, in one collection or all of
them. Its date filters work as `list`'s do. A search is never complete.

**`list(source, filters?, since?, until?, date_field?, limit?)`** returns
every item in one collection that matches, newest first, a page at a time,
with the total.
- **Complete at the end.** A list read to its end is ADR-0041's list: the
  evidence of which items exist.
- **Filters** are the collection's own fields, such as status, owner, kind,
  role or channel.
- **Dates.** `since` and `until` match any of the item's dates, unless
  `date_field` names one.
- **A short look.** `limit` keeps it to the first few items.

**`open(id)`** returns one item in full: its text, every field and date, its
link when it has one, and the items it links to, each with its id and title.
Following a link is another `open`.

`finish` stays as it is.

**Rows carry what's cheap.** Every row that `search` and `list` return carries
the item's id and title, its link when it has one, all its dates, its main
fields (owner, status, due, kind), and the ids of the items it links to. Most
questions need no `open` at all.

**Several calls per step.** A research step can make up to 10 calls at once
(today 4), so the model can look at several collections in one step.

**Links and ids.** An item in a connected tool carries its own URL in that
tool, such as a Jira project's or a Confluence page's. An ECHO item carries no
URL: the answer cites it and the desktop opens it, as today. Ids are
request-local, like today's E1 and L1, and server references never reach the
model.

## Four rules code enforces

1. **One outcome per filter** (see "When a filter can't be applied").
2. **A refused call is never run twice.** The loop answers a repeat with the
   same refusal, without sending it.
3. **Permission rules** (below).
4. **Items carry their dates and links.** No item hides a date or a link the
   person may see.

## How the model uses them

The prompt describes how a person looks for something, using only these tools:

1. **Understand** what the question needs: its parts, its time window, and the
   people, projects and items it names. Research already writes this as its
   plan.
2. **Look around.** List the likely collections at once, a few items each.
3. **Choose paths** from what came back, more than one when the question is
   broad.
4. **Dig.** Open the items and follow their links, several at once.
5. **Compose.** Unchanged.

## Collections in ECHO

| Collection | Each item holds | Links to | Today |
|---|---|---|---|
| Projects | name, active or archived, created, the person's role | members with role, Jira project, Confluence spaces, meetings, documents, follow-ups | Stored (`ProjectSummaryV2`, `ProjectMembersV1`, each project's Jira and Confluence mapping); no tool |
| People | name | projects, with role | Stored (`OrganizationDirectoryV1`, project members); no tool |
| Meetings | title, participants and approver (when recorded); when held, received, approved | decisions, actions, project | A source today, without participants or approver |
| Decisions, actions, rationale | text, owner, due, status; when held, when approved | meeting, project, follow-ups | A source today, without the approval date |
| Follow-ups (open items) | title, kind, owner, status (unsent, open, done, not relevant), due, the expected change, latest check; when created, sent to its owner, last reassigned, checked | decision, meeting, the tool item it follows | A source today, without its created, sent and reassigned dates, and without a meeting the model can open |
| Documents | text; when received | project | A source today |
| Tools | each tool's name, and whether the person has connected it | none | Stored (`OrganizationPersonToolsV4`); no tool |

## Collections in connected tools

| Collection | Each item holds | Links to | Today |
|---|---|---|---|
| Jira projects | key, name, link | ECHO project, issues | Not listable; each ECHO project's mapping names one |
| Jira issues | key, title, status, assignee; created, updated, due | Jira project, linked issues and pages | A source today |
| Confluence spaces | key, name, link | ECHO project, pages | Not listable; each ECHO project's mapping names its spaces |
| Confluence pages | title; created, updated | space, parent page, linked issues | A source today |
| Slack channels | name, link | messages | Not listable |
| Slack messages | text, author; when sent | channel | Read only when the question names a channel |

## The connector contract

Every connector declares its collections in one shared shape: its containers
(Jira projects, Confluence spaces, Slack channels) and its items. For each
collection it states:
- the fields, filters and dates it supports;
- its links;
- whether it can list to the end;
- how to build an item's link.

A connector:

- answers every call as the person, through the person's own connection;
- reports each filter's outcome by the rule below;
- says when a list was cut short;
- counts only what the person can see.

Adding a connector adds its collections to the map. Nothing in research is
specific to one tool.

## Permission rules

- **Every call is answered as the person.** ECHO's rules decide ECHO items:
  project membership, each record's policy, and who an upload was shared with.
  The person's own account decides tool items. Research never picks an
  account, a connection or a mapping, as today.
- **The map lists only collections the person can read.**
- **Nothing hidden leaks.** Counts, totals and links are computed after that
  filter, so they never reveal that a hidden item exists.
- **Links only to what the person can open.**
- **The access check is unchanged.** The check before each model call
  (ADR-0038) stays as it is.

## When a filter can't be applied

Today a filter that didn't work comes back in one of four forms:
- an error string (follow-ups);
- a notice that marks a list unavailable, while its note says "nothing more
  to list" (`agentic-research-loop-v1.ts:650` and `:699`);
- `ignored` in `filter_applied` (ADR-0041);
- `partial` in `filter_applied`, with a note (ADR-0041).

The follow-ups error was explicit, and the model's own notes acknowledged it,
yet it re-sent the call. Clearer wording alone won't stop retries.

The rule:

- **One outcome per filter.** Every `search` and `list` result states one
  outcome for each filter asked for: `applied`, `partial` or `ignored` (as
  ADR-0041 defines them), or `refused`. A refusal is a result with no items
  that names what the collection does support. It is never an error string.
- **Unchecked items are counted, not hidden.** Some items can't be tested
  against a date filter because they don't record that date. The result says
  how many, and which dates they do have, for example "14 meetings have no
  recorded time; all have an approval date". They are not members of the
  list. The list stays available, and can be complete for what it checked.
  This replaces the notice that some meetings have no recorded date.
- **No false "nothing more".** A note never says "nothing more to list" about
  something that couldn't be checked.
- **Unchecked items reach the answer only through the list.** An answer
  mentions them only when it uses that list. So the answer that found the Date
  coverage meeting (`2970b9ce-c526-4be2-9923-f2907477ce1c`) carries no warning,
  and a question with no date is never told "I can't verify the requested
  date".

## Approved records carry dates

Today an approved decision, action or rationale has a date only when its
meeting's time was recorded, plus a due date on actions. It never carries its
approval time. Yet every approval made through the approval core records one:
`decided_at`, which is also the record's issue time (`approval-core-v1.ts`,
`approval-publisher-v1.ts`). Staging canary meetings and several imported
transcripts record no meeting time, so most staging meeting items have no date
at all. That is why every staging question that filtered meetings by date got
the notice.

The change:

- **A new `approved` date** on every approved record. It shows only to people
  who can already read the record.
- **One set of dates for meetings.** Meetings declare `occurred` (when
  recorded), `approved`, `received` (imported notes and transcripts) and `due`
  (actions), and both halves of the meetings source accept the same set.
  Today imported notes accept occurred, received and due, while approved
  records accept occurred and due (`person-original-context-retrieval-v1.ts:349`;
  `datedRecordSet` in `person-record-search-route.ts`).
- **Canary meeting times.** Staging canary meetings get a meeting time.

## Testing open-ended questions

Today the release check asks one fixed question
(`deploy/release/README.md:483`). The research-loop eval has 26 Ask cases (18
development, 8 holdout), and each names a subject or a source and a date.

The change:

- **An open-ended family** in the research-loop eval, in both development and
  holdout:
  - every question in the goal above;
  - time: "what changed in Jira this week", "what did we decide last week";
  - the person's own work: "what am I working on", "what do I owe this week";
  - structure: "which Confluence spaces belong to project X";
  - reach: one question per desktop screen that shows the person's data,
    answered from that screen;
  - tools: one question per connected tool whose answer is only in that tool.
- **Graded on reach and cost, not wording:**
  - every collection that holds part of the answer was looked at;
  - no refused call was repeated;
  - unchecked items were stated;
  - research finished within 4 rounds.
- **Run on staging.** Two or three run in the staging Ask check after the
  canary, checked from their LangSmith traces.
- **Counted in each trace:** collections looked at, calls per step, refused
  filters, repeated refusals, unchecked items, and rounds.

## What the questions would do

Each research step is one model call. Writing the answer is one more.

| Question | Calls | Research steps |
|---|---|---|
| What are the open items, and who owns them? | `list(follow-ups, status: open)` | 1 (a similar Ask on staging today took 2) |
| Which meeting is each from, and who was in it? | `open` on each meeting id in those rows, in one step | 1 |
| How long since each was assigned? | none: each row has its created, sent and reassigned dates, and the map has today's date | 0 |
| Current projects and their leads | `list(projects, status: active)`; each row carries its leads | 1 |
| What happened yesterday | one step listing meetings, decisions, documents, Jira issues and Confluence pages, each `since` and `until` yesterday; then `open` what matters | 2 (today 7, with no answer) |
| Link to the Jira space for project X | `search("X", projects)`; the row links to its Jira project, with its link | 1 |

## Build order

Each step ships on its own.

0. **Tests first.** The open-ended family, with every question in the goal, and
   the trace counts.
1. **The map and the rules.** The map as data, the one outcome per filter, and
   no repeated refusals. Fix the follow-ups description.
2. **Dates and links on items.**
   - Follow-ups gain their created, sent and reassigned dates, and links to
     their decision and meeting.
   - Meetings gain participants and approver.
   - Approved records gain the `approved` date.
   - Staging canary meetings get a meeting time.
3. **ECHO's missing collections.** Projects (with members, roles and tool
   mappings), people and tools, in a new answer version so they can be cited.
   The desktop and CLI must adopt it.
4. **Wider calls.** `since` and `until` across all dates, `limit`, 10 calls
   per step, and the prompt's guidance on how to look.
5. **The connector contract.** Jira projects, Confluence spaces and Slack
   channels.

## Decisions for the founder

1. **Date refusals.** Keep refusing date filters a collection can't apply, as
   ADR-0041 decided, now as a structured outcome (recommended). The
   alternative is to allow `ignored` for dates, with a notice.
2. **Items with no such date.** Count them and keep them out of the list
   (recommended). The alternative is to keep them in the list as `partial`,
   the way meeting actions with no status are kept today.
3. **Dates without a field.** `since` and `until` with no `date_field` match
   any of the item's dates, and each row shows which date matched
   (recommended). The alternative is each collection's default date, as today.
4. **Calls per step.** Up to 10 (recommended), from 4 today.
5. **New citation kinds.** Projects, people, Jira projects, Confluence spaces
   and Slack channels become citable, in a new answer version the desktop and
   CLI must adopt.

## Open questions

- **Slack.** List only the channels the person is in, or also search across
  Slack where the person's connection allows it.
- **Bounds.** Rows per page, how much each row carries, and how large the map
  may grow before it shows "and N more".
- **One argument shape per collection.** Generating the step's output schema
  per collection would stop the model sending a filter a collection doesn't
  take. Do it only if the routed provider accepts the larger schema; the rule
  on filter outcomes covers it otherwise.

## Not in this design

- **The receipt.** "Looked through 0 items" counts only items read in full,
  and its "found" count can include preload items the model never saw. Both
  are receipt fixes outside research.
- **The answer step's wording.** "I can't verify the requested date" (the
  filter rule removes most cases), and raw timestamps and titles cut mid-word
  in list sentences.
- **Research step latency.** Steps in these traces took 2 to 8 seconds, and
  none used a cached prompt.

## When approved

A new ADR records the contract. It updates ADR-0041 (filter outcomes, unchecked
counts, dates without a field) and ADR-0040 (the follow-ups description, and
follow-ups gaining ECHO's own dates and links to their decision and meeting). It also adds the `approved` date
field, the new collections, and the new citation kinds and answer version.
