---
schema_version: 1
id: ADR-0042
kind: decision
title: Ask reads every source by what it declares, and reaches the asker's workspace
component_ids:
  - CMP-ORGANIZATION-AUTHORITY
  - CMP-PERMISSIONS
  - CMP-PERSON-CLIENT
created_at: 2026-10-19
reviewed_at: 2026-10-19
reviewed_ref: aa5246f78434b16af8da4e3afcc66f0dbcf9df95
status: accepted
supersedes: []
superseded_by: []
updates:
  - ADR-0039
  - ADR-0040
  - ADR-0041
---

# ADR-0042: Ask reads every source by what it declares, and reaches the asker's workspace

The founder approved the design
[Research tool contract v1](../product/2026-10-19-research-tool-contract-v1.md)
on 2026-10-19 with its five recommended decisions, to be built end to end. Its
goal: Ask's research can find everything in ECHO and in the asker's connected
tools that the asker may see, with a few simple tools the model combines
freely. The names, bounds and wording below are build calls within that
design; where the build differs from it, this record says so. Acceptance does
not mean the change is deployed or qualified. Code paths are at
`reviewed_ref`, relative to `packages/organization-authority-kernel/src/`
unless shown in full.

## Context and options

On 2026-10-19 staging ran 13 Asks on release `40ba71c` (LangSmith project
`echo-staging`). The 11 that named their subject finished in two or three
rounds; the two open-ended ones, "what happened yesterday"
(`14cf3f41-1550-4d18-9a62-ef117dd9d6a9`) and "what are my current active
projects?" (`d8cd5a3e-78ea-4927-895d-df4e286d9e6d`), failed. The design's
"Why" gives the causes: refusals that misled and were sent again, parts of
ECHO no source reached, records that hid their dates, four calls a step, and
a receipt that counted only full reads.

The design's five decisions, each chosen over its alternative:

1. **Date refusals.** Keep refusing a date field a source cannot apply, now as
   a structured outcome, rather than accept it as `ignored` with a notice.
2. **Items without the asked date.** Count them and keep them out of the
   list, rather than keep them in as `partial`.
3. **A window with no date field.** Match any of an item's dates and say which
   matched, rather than each source's default date.
4. **Calls per step.** Up to 10, from 4.
5. **New citation kinds** in a new answer version. Clients validate exact
   kinds, so an unknown kind in an existing version would break every
   installed desktop (ADR-0040's reason).

## Decision and consequences

**Ask only.** Everything below applies when research answers a question. A
task goal (impact checks and sweeps) keeps its catalog, prompts and four reads
per step. Every Ask route's research follows this contract; only the V8 answer
reads and cites the workspace and tool containers.

### The tools

The model's tools keep their names and shapes:
`search(query, source?, since?, until?, date_field?)`,
`list(source, kind?, status?, owner?, role?, channel?, since?, until?, date_field?, limit?)`,
`open(id)` and `finish`. `role` is new. `limit` (1 to 25) pages out fewer rows
for a short look; the same arguments continue the same list, and a limit never
starts another one. A research step runs up to 10 reads
(`AGENTIC_ASK_MAX_ACTIONS_PER_ASK_STEP_V1`). The prompt tells research to look
at every source that may hold part of the answer in one step, then follow
paths and links. A search with no source reads every source.

### Capabilities as data

Every built source in the catalog research sees declares
`EvidenceSourceCapabilitiesV1` (`shared/evidence-desk-v2.ts`):

- `filters`: each filter it takes, with its allowed values, `name` for a
  person's name, or `text` for free text;
- `dates`: each date field it can filter on, with a one-line meaning that says
  when not every item records it;
- `any_date`: whether a window with no date field matches any of an item's
  dates;
- `links`: the link names its items may carry;
- `count`: how many items the asker can see there. Only projects declare it.

Meetings and documents declare theirs in `shared/source-capabilities-v1.ts`,
follow-ups in `shared/follow-up-evidence-v1.ts`, the workspace sources in
`shared/workspace-evidence-v1.ts`, and Jira and Confluence in
`services/organization-authority/src/composition/person-live-connector-registry-v1.ts`.
Descriptions now say only what a source holds. Research is checked against the
declaration it is shown, so what it is told and what is accepted cannot drift
apart. A registered source that declares nothing keeps the checks from
before this record; a container must declare its capabilities to register.

### One outcome per filter

Ask checks each `search` and `list` against the source's capabilities before
the desk (`normalizeAskListArgs` and the search date checks in
`answer-composition/agentic-research-loop-v1.ts`):

- A filter the source does not take is `ignored`, with a note, as ADR-0041
  defines it. `applied` and `partial` are unchanged.
- A value outside a filter's allowed values, a `date_field` the source does
  not declare, or a window on a source that records no dates is **refused**.
  Nothing is read, and nothing wider comes back. The result has
  `refused: true`, `filters: {<field>: "refused"}`, `supports` (the source's
  filters, date fields and `any_date`) and the note
  `refused: <source>: <reason>`. It is a result, never an error string.
- Every result states, under `filters`, the outcome of each filter asked for.
- **A refused read is never sent twice.** A read that was refused, or that
  returned an error, is answered from memory when the same arguments come
  again in the same Ask, with the note "refused again: this exact request was
  already refused in this Ask, so it was not sent; change the source, the
  filter or the approach".

### Dates

- The date fields are `occurred`, `created`, `updated`, `due` and `received`,
  and, new, `approved` (when an approved record was approved) and `sent`,
  `reassigned` and `checked` (a follow-up's own) (`shared/temporal-query-v1.ts`).
- A window with no `date_field` reads `date_field: any` where the source
  declares `any_date`: an item matches when any of its dates falls in the
  window. Each row of a dated read says under `matched` which of its dates
  fell in it.
- **Unchecked items are counted, not listed.** A dated read returns
  `unchecked: {count, dates}`: how many items of its selection (scope, Mine,
  source and kinds, never a search's words) the window could not test because
  they lack the date, and which dates they do carry. They are not in the
  result. The list stays available and can be complete for what it checked.
  This replaces the missing-date notice. Research is told to look again by one
  of those dates, or to say they were not checked.
- The answer names them only through a list it uses. That part is partial and
  says, for example, "14 actions have no recorded time, so they were not
  checked against these dates. They have an approval date." A question with no
  date never gets that sentence.
- Every approved decision, action and rationale carries its approval date (the
  approval's `decided_at`) and its meeting's `participants` and `approved_by`,
  as the person open names them, released and audited with the record.
  Staging release canary meetings now record a time.

### Links

- A row may carry `links`: for each link name its source declares, the ids of
  linked items this request released. Research sees them as `E` ids. A link to
  something the asker cannot read is left out, never shown as hidden.
- A result may carry `linked`: items released beside its rows because the rows
  link to them, such as a project's members, a person's projects, and a
  follow-up's decision items and the tool item it follows. They are never rows,
  so never list members or search hits. Research opens one by its id.
- In a search across sources, only items linked by the rows the desk keeps come
  through.
- Projects link `members`, people `projects`, and follow-ups `decision` (only
  where the release carries the decision, which leads to their meeting) and
  `follows` (only when this request read the tool item live). Meetings,
  documents, Jira issues, Confluence pages, tools and containers declare no
  links.
- **No URL reaches the model.** An item's link in its tool travels with the
  answer's citation, and the client opens it.

### Sources

| Source | Filters | Dates | Links |
| --- | --- | --- | --- |
| `meetings` | kind (`decision`, `action`, `rationale`), status (`open`, `done`), owner | `occurred`, `approved`, `received`, `due`, any | none |
| `documents` | none | `received`, any | none |
| `follow_ups` ([ADR-0040](ADR-0040-follow-ups-as-ask-evidence.md)) | status (`open`, `done`), owner | `created`, `sent`, `reassigned`, `checked`, any | `decision`, `follows` |
| `projects` | status (`active`, `archived`), role (`lead`, `member`) | `created`, any | `members` |
| `people` | none | none | `projects` |
| `tools` | none | none | none |
| `tickets` (Jira) | none | `created`, `updated`, `due`, any | none |
| `pages` (Confluence) | none | `created`, `updated`, any | none |
| `jira_projects`, `confluence_spaces` | none | none | none |

- **Projects** are those the asker belongs to, newest first, with the asker's
  role and the project's leads as row facts. A project's text names its
  members with their roles; its Jira project and Confluence spaces are found
  through `jira_projects` and `confluence_spaces`. A project Ask reads only its
  project. Projects declare `count`.
- **People** are the organization directory, or in a project Ask that
  project's roster. Each names the projects they share with the asker and
  their role in each.
- **Tools** are the asker's person tools list: each tool, whether the asker
  connected it, and the organization's setup status. Never a tool's site or
  account.
- **Jira projects and Confluence spaces** (kind `tool_container`) are the
  containers the asker's own connection can see. Research lists them, searches
  them by key, name and the names of the ECHO projects mapped to them, and opens
  one by an exact read through that connection. A container's text names the
  mapped ECHO projects the asker can see, whole names only, then how many more.
  A project Ask reads only the containers its lead mapped, and an unmapped
  project reads none. They refuse a date window. A row that fails validation
  is left out, never released or named, and the result says some could not be
  shown, so a list that left one out is never complete. Only "not found"
  leaves a container out; a credential rejection fails the read.
- **Bounds.** Per call, a workspace source returns at most 10 search hits or
  20 list rows and releases at most 100 items beside them, and a container
  source at most 10 search hits or 25 list rows. A project names at most 50
  members and 10 leads.
- **No Slack containers.** Production has had no Slack reader since `2bb9b25`
  (2026-10-05), so Slack stays out of scope.

**Search across sources.** A search with no source reads meetings, documents,
the connected tools' items, follow-ups and the asker's projects, dated or not:
a window with no `date_field` reads any of each item's dates, and a source
that reads one date only gets its own default. A source that records no dates
sits out a dated search. People, tools and a tool's containers are searched
only when named, since the directory is read whole and a container search
scans the tool. The asker's projects fill the slots the content sources leave,
so a project's name never crowds out what was said about it. A follow-up or
project source briefly unavailable becomes a coverage notice. A source chosen
by name answers or refuses as asked.

### Answer V8, progress V3 and clients

- **Answer.** `POST /v7/person/ask` serves the V8 answer
  (`echo-clean-person-answer-v8`,
  `packages/organization-api/src/person-answer-v8.ts`) on the unchanged V3
  request. A matched response carries the route header
  `x-echo-person-ask-route: 7`. V8 adds four citation kinds
  (`packages/organization-api/src/person-workspace-citation-v1.ts`):
  `project`, with the ref `project:prj_…` that opens the project; `person`,
  with no ref, which opens nothing; `tool`, with the ref `tool:<tool_id>` that
  opens Tools; and `tool_container`, with no ref, whose citation's permalink
  opens it in its tool and whose optional `key` is shown beside its label.
- **Progress.** `/v7` streams Ask progress V3
  (`packages/organization-api/src/person-ask-progress-v3.ts`) for
  `x-echo-ask-progress: 3`, and answers JSON for any other value. V3 is V2
  with three additions: a searched row may name `projects`, `people`, `tools`
  or `{kind: "containers", tool_id}`; a row names up to 16 sources; and a
  named item is a V8 citation.
  [ADR-0039](ADR-0039-ask-progress-names-after-the-access-check.md)'s rules
  apply unchanged.
- **Older routes.** `/v6` (V7, progress V2), `/v5` (V6, progress V1), `/v4`
  and `/v3` keep their answers and never bind or cite the workspace or
  containers.
- **Clients.** `person ask --live` asks `/v7` first and falls back as the
  [Person client architecture](../architecture/person-client-architecture.md#account-and-answer-sources)
  describes; with `--progress` it prints every step as a V3 line. The desktop
  opens a project's page, shows a person by name only, opens Tools for a tool,
  and shows a container as "Jira · KEY" that opens its link.

### Permissions, audit and checks

- **Who sees what.** The workspace binds only for the V8 answer, in global and
  project Ask: never in Mine, trigger research or the evidence doors. Every
  read is made as the asker: their project list, each project's roster, the
  organization directory and their tools list. Containers bind only for the V8
  answer, read
  through the asker's own connection behind the same fences and audited live
  boundary as tickets and pages. Counts (`count`, `unchecked`) include only
  items the asker can read.
- **Audit.** Every workspace release is audited before its bytes leave Layer
  3: one content-free row of kind `echo-person-workspace-release-audit-v1` in
  `authority_person_read_decision_audit_v2`, with the source, the operation,
  and each item's kind, id, whether it was released beside a row, and a digest
  of its released fields (`SqlitePersonAgenticAskAuditV1.forWorkspaceRequest`).
  Empty releases are audited too. A container release is its connector's
  durable live-read audit. A container's citation commits to no text, so the
  audit commits its released value.
- **Checks ([ADR-0038](ADR-0038-incremental-access-check-before-model-calls.md)).**
  Before each model call the sources recheck what they released since their
  last check, and before the answer everything. Projects and people run with
  the final synchronous local checks; the tools check is awaited with the
  providers'. A check fails with `stale_access_state` when the session is
  another person; the asker no longer holds the same grant for a released
  project, or for a project a released person's text named (one left and
  rejoined is a new grant); a released person is no longer an active member;
  or a released tool's connection changed. A project renamed, archived or
  re-roled is not an access change. A container check re-reads every distinct
  release of the container and refuses one whose name, key, link or named ECHO
  projects changed.

### Observability

The counts an Ask records for its research, and container calls'
`evidence_source`, are in
[RB-OPERATIONS-001](../operations/RB-OPERATIONS-001-authority-observability.md).

### Known limits

- **The map is the source catalog.** The first prompt carries the asker,
  today's date and time zone, and each source's description and capabilities;
  the asker's projects and tools are sources research lists, not map entries.
- **No `total` on lists.** Only projects declare `count`. A list's size is
  still its number of members (ADR-0041).
- **Connector items carry no links yet.** Jira issues and Confluence pages
  declare none. An opened ticket still discovers its linked tickets as before.
- **Containers declare no dates, filters or links.**
- **Projects link only their members.** A project's Jira project and
  Confluence spaces are found through `jira_projects` and `confluence_spaces`,
  which name the ECHO projects mapped to them; the founder chose that one
  direction over also naming them in each project's text.
- **The receipt still counts only items read in full.** The design left that
  fix outside research.
- **A task goal sees neither `unchecked` nor the missing-date notice.** No desk
  sends the notice any more, and only Ask is shown `unchecked`.
- **No step schema per source.** The design's open question, a step schema
  generated per source, was not built. The outcome rule covers a filter a
  source does not take.
- **The workspace's first read reads it whole.** A request's first projects
  read takes every project in scope, each roster and each project's Jira and
  Confluence setting, and a people read takes the whole directory. That is
  cheap for today's organizations; a large one would need paged reads.
- **Counts that leave unaudited.** A follow-up release's `unchecked` count and
  the projects source's `count` reach the model without a release witness of
  their own; only the Ask's prompt digest records them.
- **A container names every mapped project the asker sees.** In a project
  scope, a Jira project or Confluence space mapped to two of the asker's
  projects names both. Nothing leaks, but the text is wider than the scope.
- **A row a search left out is still checked.** A workspace item a search
  across sources released but did not keep stays in the workspace's checks, so
  a change to it can refuse the answer though the model never saw it.
- **Older routes research the same way.** `/v6` and older keep their answer
  contracts but research under this contract: any-date windows, `unchecked`
  counts, follow-ups' linked decisions and dated follow-up searches.

## Migration, rollback, and evidence

No schema or stored-state change, and nothing new is kept after the request.
The workspace sources read existing project, directory and tool state, and
their audit rows go to the existing read-decision table. The API runtime
mounts the V8 route (`createPersonLiveAnswerRouteV1(options, 8)`) at `/v7`
with follow-ups, as `/v6` binds them, and the workspace: the project context
application, the project grants, the people read and the person tools list,
each release witnessed by `forWorkspaceRequest`. Without the workspace option a V8 desk
binds no workspace and raises no error. The composition root registers each
tool's items and containers over one runtime (`jiraPersonLiveConnectorsV1`,
`confluencePersonLiveConnectorsV1`), and the API runtime opens every
connector with the names of the asker's projects. An Authority that mounts
`/v7` without an answer model answers 503 with the route header, so a client
does not fall back. Rollback is a code revert. Older clients never reach V8.

The research-loop evaluation adds an open-ended family graded on reach and
cost ([README](../../tools/evals/research-loop/README.md#open-ended-family)).
The staging research evaluation now answers a question as `/v7` does, on the
full catalog, while a task reads what task research reads. Each recorded
research round keeps what the step saw of an Ask read: each filter's outcome,
what a refused read's source supports, and the items a date filter could not
test. The staging release check asks the development cases
`release-check.json` names and checks their traces with `release-check`.

Negative disclosure tests, required by
[INV-PERMISSIONS-015](../invariants/INV-PERMISSIONS-015-layer-3-person-release-boundary.md),
in `services/organization-authority/test/` unless shown in full:

- a project the asker does not belong to is never found or listed, and a
  project Ask reads only its project; a tool's site or account never appears;
  people and tools refuse the filters and dates they lack
  (`person-workspace-evidence-v1.test.ts`);
- the checks refuse a project the asker left, or left and rejoined; a person
  who left the organization, whether released as a row or beside a project; a
  person whose release named a project the asker has since left; a tool whose
  connection changed, or whose organization setup the asker no longer sees;
  and a session of another membership. A change of role alone passes
  (`person-workspace-evidence-v1.test.ts`);
- audit rows hold item kinds, ids and digests only, and the audit refuses
  anything else (`person-workspace-evidence-v1.test.ts`,
  `person-ask-progress-v7-http.test.ts`);
- a search across sources reads the asker's projects after the content
  sources, never people, tools or containers, and brings only the items beside
  the rows it keeps; a desk that bound no workspace refuses workspace reads
  (`person-live-evidence-desk-v2.test.ts`);
- `/v6` never binds the workspace, and a V1 or V2 header value on `/v7` gets
  the JSON answer (`person-ask-progress-v7-http.test.ts`);
- a container the asker cannot see is never found, even through its ECHO
  project; a project Ask reads only its mapped containers; a date window is
  refused before any provider read; every release of a container is
  rechecked, with the ECHO names read after the provider answers
  (`providers/jira/test/jira-person-live-container-reader-v1.test.ts`,
  `providers/confluence/test/confluence-person-live-container-reader-v1.test.ts`);
- containers bind for the V8 Ask alone and name only the asker's projects
  (`cross-source-ask-e2e.test.ts`);
- an unchecked count never counts records outside the asker's scope
  (`person-evidence-desk-records.test.ts`);
- every answer version below V8 refuses a workspace or container citation
  (`packages/organization-api/test/person-answer-v8.test.ts`).

## Later decisions

[ADR-0043](ADR-0043-ask-receipt-counts-what-research-looked-through.md)
(2026-10-19, proposed) lifts the known limit "The receipt still counts only
items read in full": progress V3's receipt counts every item research looked
through, rows included, and every version's `found` counts only what its
reads gave research.

On 2026-10-19 the founder approved moving the desktop's Mine Ask and plain
`person ask` to `/v7` too, with its fallbacks; `--live` then changes nothing.
Mine still binds no workspace or container
([Person client architecture](../architecture/person-client-architecture.md#account-and-answer-sources)).

On 2026-10-25 [ADR-0047](ADR-0047-ask-timeline.md) made `/v7` the only Ask
route, with no fallback. `person ask` now refuses `--live` as an unknown
option.
