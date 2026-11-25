---
schema_version: 1
id: ADR-0057
kind: decision
title: Ask shows one conversation, threads are memory underneath, and ECHO links instead of moving
component_ids:
  - CMP-ORGANIZATION-AUTHORITY
  - CMP-PERSON-CLIENT
created_at: 2026-11-24
reviewed_at: 2026-11-24
reviewed_ref: c6dded8f2db2f675cc7396386e90d447c22f780f
status: proposed
supersedes: []
superseded_by: []
updates:
  - ADR-0047
  - ADR-0049
  - ADR-0056
---

# ADR-0057: Ask shows one conversation, threads are memory underneath, and ECHO links instead of moving

On 2026-11-24 the founder looked at Ask threads (ADR-0056) and a mock that
drew threads on the page, and said: "too noisy. the threads should be how the
backend and architecture works not on visual." He wants "a clean page for
chat only", one memory underneath that is "a continous thread and easy for
the echo agentic loop to find", and "user does not have to manage it
themselves". The design is
[Ask memory v1](../product/2026-11-24-ask-memory-v1.md). He picked each
decision in it and said to build it; he has not yet accepted this record, so
the status is proposed. Nothing here is deployed or qualified.

## Context and options

ADR-0056 put a thread's name at the top of Ask, opened a list of threads
grouped by home from it, and let a person or ECHO merge threads by relabelling
saved turns in one compare-and-set write, with an Undo. A thread never ended.
A thread was named, and sent to the placement call, by the questions the
person typed in it.

The founder's decisions in the design conversation:

- Memory stays on the device ("Device only").
- A thread ends by itself: "after quite for a whole week", and each question
  in it starts the week again. Whether it has ended is worked out, not stored
  ("A: compute it").
- A question about a thread that has ended starts a new thread linked to it;
  one that is still going continues ("A: new, linked").
- ECHO decides where a question goes, and the person can undo ("ECHO, I can
  undo").
- A thread's label is built "From my own words".
- Nothing lists threads when a person goes to ask; a person reaches their
  conversations through "One hidden door".
- Two conversations about the same thing are linked, and nothing moves ("Link
  them").
- The page should "feel like a real conversation like how they would text
  and ask their co worker", with no mark on ECHO's replies.

Options for how conversations are joined once a thread can end:

1. **Link, never move.** A saved turn may name other threads in `continues`.
   Threads joined this way are one conversation, worked out each time. No
   saved turn ever changes thread.
2. **Keep moving turns** (ADR-0056's merge). It needs a write that relabels
   many turns, an Undo that moves them back, and messages for every way that
   write can fail. It also changes threads that have ended.
3. **Store threads as records.** A table of threads with their state and
   links. It needs a new file version, a migration and stored state that can
   disagree with the turns.

## Decision and consequences

Adopt option 1, with the founder's decisions above.

- **A thread is active for 7 days after its newest turn, and then joined.**
  Nothing is stored: active or joined is the age of the newest turn. A joined
  thread never changes: no turn is added, moved or removed. A question that
  belongs to one starts a thread that continues it. 7 days is the founder's
  rule (ADR-0055: a limit needs a reason).
- **Two optional fields on a saved turn, and nothing else stored.**
  `continues` (thread ids) and `label`. The timeline file's shape and version
  do not change, and an older desktop keeps the fields untouched. This
  updates ADR-0047's file.
- **A conversation is a thread with everything it continues or is linked
  to.** It is one entry in the request's `threads`, it has one label, and
  "Which one?" offers it once. A follow-up carries its turns as `previous`
  and `earlier`, under the same checks as before (INV-PERMISSIONS-015). A
  link can bring another conversation's turns into a request, so ADR-0056's
  rule for a question a model wrote is tightened: it goes only while every
  turn it could have been written from is kept and readable, followed all
  the way back through what each turn carried.
- **ECHO links instead of merging.** The answer's `merge` is unchanged on the
  wire. The desktop now writes the named conversations into `continues` on
  the turn that lands, in the write that saves it. `timeline.move`, merging
  by hand, the merge's Undo and its failure messages are removed. A link
  stays inside one home, so a project's request still never carries a turn
  asked outside the project.
- **Undo is of the placement.** When ECHO puts a question somewhere other
  than what the person was looking at, one line says so with Undo. Undo
  stops a question on its way, or removes the one turn that landed in a
  compare-and-set write (`timeline.remove`: only the newest turn of an active
  thread that no kept turn names), and asks the same words as a new question
  with nothing carried. Only ECHO naming a conversation other than the one
  the person was looking at is a placement: a question the person asked in
  a conversation has no Undo, wherever the rules land it. A later change to a kept turn is written only
  in its place, so one still on its way never brings back a turn Undo
  removed.
- **Labels in the person's own words.** This replaces ADR-0056's rule that
  only typed questions describe a thread: a label may also be a line whose
  every word the person typed in that conversation. `POST /v7/person/ask`
  takes an optional `label` on each thread and on a follow-up's `previous`,
  and `labels: true`; the answer may then carry `label`. The placement call
  that already runs writes it, so there is no extra model call. The API
  checks a thread label against that thread's questions; the kernel drops a
  label with a word in no question it was shown; the desktop, which alone
  holds the typed words, checks before it keeps, shows or sends one. A label
  that fails is dropped and never fails an Ask. 80 characters keeps a label
  to one line of a "Which one?" button (ADR-0055). A label holds no
  character that shows as nothing outside a word, and no symbol the person
  did not type, since either could show a word nobody typed; a joiner inside
  a word is part of that word.
- **The page is one conversation.** The thread's name line and the list
  under it are gone (this updates ADR-0049's page and ADR-0056's). Questions
  are messages on the right and replies on the left. The page title is a
  button that opens the one list of conversations; nothing shows that it is
  there until then.
- **No new stored or logged data on the Authority.** Labels are the asker's
  own words, context like `previous`, never evidence, and are not stored.
  The audit record stays one content-free row per request. On staging, while
  LangSmith tracing is on, a label appears in a run's exported model
  payloads, as the questions it is made of already do.
- **Unchanged.** A request with neither `threads` nor `earlier` gets byte
  for byte the earlier prompts, schemas and responses, and no label.

Consequences: a link cannot be taken apart, so a wrong link joins two
conversations for good unless the person undoes that question at once; the
eval's rule that guarded merges now guards links. The door is hard to
discover, which the founder chose. The thread resolver's prompt changed, so
the pre-registered thread eval's first run is on the new prompt.

## Migration, rollback, and evidence

- No stored data changes on the Authority. On the device no file changes
  shape: saved turns gain nothing until a new answer lands, and a turn a
  desktop before this change saved reads as before.
- Server first: an Authority that takes `label` and `labels` is released
  before the desktop that sends them. An older desktop never sends
  `labels: true`, so it is never sent a label it would refuse. Rollback is a
  desktop that stops sending them.
- Evidence required before this record is accepted: the pre-registered
  thread cases pass their deciding rules (1, 2 and 4) on the product's model
  route with the new prompt; the unit and end-to-end tests named in the
  design pin R2 and R11 to R16; and the founder validates the page on the
  desktop.
