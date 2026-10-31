---
schema_version: 1
id: ADR-0049
kind: decision
title: Only me is a lock on an item, Ask shows one thread per place, and Mine goes
component_ids:
  - CMP-ORGANIZATION-AUTHORITY
  - CMP-PERSON-CLIENT
created_at: 2026-10-26
reviewed_at: 2026-10-27
reviewed_ref: d06d3a8a327831f30635e1a22022873936ae1681
status: accepted
supersedes: []
superseded_by: []
updates:
  - ADR-0017
  - ADR-0023
  - ADR-0024
  - ADR-0045
  - ADR-0046
  - ADR-0047
---

# ADR-0049: Only me is a lock on an item, Ask shows one thread per place, and Mine goes

The founder said on 2026-10-26 that the desktop Ask page is too noisy, then
decided how private context and Ask's history are organised. The design is
[Quieter Ask, one thread per place, and Only me as a lock](../product/2026-10-26-quieter-ask-and-only-me-v1.md)
and the "Quieter Ask" canvas. The founder accepted this record on 2026-10-31,
as built in #368 (`bb976f5`) and #369 (`d06d3a8`). #378 later moved the
desktop's Only me link from Home's footer to the sidebar. Acceptance does not
mean the change is deployed or qualified.

## Context and options

Three different things carried a lock: Jira and Confluence items (always
`only_me`, because ECHO reads them with the person's own access), meetings in
private custody before review, and things kept to oneself (an Only me capture
or a meeting item routed to Only me). Capture made "who can read" one
exclusive choice, although audience and association are separate facts in the
data (ADR-0017). An Only me capture was still saved filed in the projects
ticked, but a meeting item routed to Only me could not be filed in a project.
Mine listed what the person added, with any audience, and had its own Ask
scope. Ask showed one timeline for every place (ADR-0047).

Options for private context:

1. **An Only me section beside the projects, with its own thread.** It mixes
   who can read with where something lives: a private note about THERM would
   live outside THERM.
2. **Only me as a lock on an item, places are Home and projects.** A private
   item can be filed in a project and shows there only for its owner; what is
   in no project is reachable from Home.
3. **Keep Mine.** It answers "what did I add", which the founder did not ask
   for, and keeps a second place and a third Ask scope.

## Decision

Adopt option 2, the founder's choice.

- **Who can read and where it lives are separate.** A note, a document or a
  meeting item may be filed in 1 to 20 projects with an audience of only its
  owner. It appears in those projects' lists, search and Ask for its owner
  alone; every other member never learns it exists.
- **Mine goes from the desktop.** Home's footer links to Only me: every item
  the person can read whose only reader is the person, filed or not. Mine's
  Ask scope leaves the desktop; the Authority keeps it for the CLI.
- **Ask shows the thread of its place.** The device timeline stays one store;
  from Home Ask shows every turn, from a project only that project's.
- **The lock means "ECHO keeps this for you alone".** Live tool items (Jira,
  Confluence) carry none.

## Consequences

- Notes and documents need no server change: the Authority already accepts an
  `only_me` audience with associations and admits such an item to its owner
  alone in the project's list, search and Ask.
- The person list gains an Only me scope (list-only; Ask's scope type is
  unchanged), so the desktop's Only me page lists what only the caller can
  read, filed or not.
- A meeting item kept private inside a project needs records whose audience
  is the approver and whose association is the projects. That relaxes
  ADR-0017's lean V1 rule and ADR-0046's "audience equals association per
  record" for private routes only, and needs a record log V6 baseline (fresh
  state). It ships as its own change, after the founder accepts the reset.
- The desktop timeline file is unchanged; older turns asked in Mine stay on
  Home's thread.
- Meeting items kept private inside a project, as built: a route says
  `private: true` only beside 1 to 20 projects, and every other route, record
  id and decision digest keeps its bytes. Kept items group by (private,
  project set); a private group's record binds the restricted reviewer with no
  project audience and the projects as its association, and its approval id
  hashes `private: true` in. Like Only me it keeps its quotes and the reasons
  for its own items. A reason that supports no item goes to at most one
  record: the plain Only me group's, else the first private group's in group
  order; with neither it is left out.
  Record log V6 binds such association rows to the approval;
  retrieval admits the record to its approver and then narrows it by
  association. Receipts and record refs say `private`; Slack's closed card
  reads "THERM, only you" and Slack never routes privately; the desktop review
  shows the Only me lock beside each item's place, as Capture does, pressed
  while projects stay ticked and on for good with no project. Existing
  record logs (V5) are refused at startup, so this ships with a fresh-state
  reset.

Update (2026-10-31): the Authority no longer keeps the mine scope for the CLI.
`person ask` and `person list` refuse `--mine`, the Ask request refuses mine,
and the shared answer scope (`PersonAnswerScopeV3`) and the research kernel
know only global and one project. The person list takes exactly one of a
project and Only me.
