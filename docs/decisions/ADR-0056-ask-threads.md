---
schema_version: 1
id: ADR-0056
kind: decision
title: Ask is one page of threads kept on the device, and ECHO picks the thread
component_ids:
  - CMP-ORGANIZATION-AUTHORITY
  - CMP-PERSON-CLIENT
created_at: 2026-11-23
reviewed_at: 2026-11-23
reviewed_ref: 3912cf763b80a2f6ddf1e60936418810139b949d
status: proposed
supersedes: []
superseded_by: []
updates:
  - ADR-0007
  - ADR-0015
  - ADR-0019
  - ADR-0021
  - ADR-0047
  - ADR-0049
---

# ADR-0056: Ask is one page of threads kept on the device, and ECHO picks the thread

On 2026-11-23 the founder asked to turn Ask into "a continuous big thread"
with "multiple smaller sub threads so it is all in one place", where "the
complexity of context mgmt and diff threads is handled underneath the UI UX":
"i do not like how i have to search diff chat history session history." The
design is [Ask threads v1](../product/2026-11-23-ask-threads-v1.md). The
founder chose its approach ("go with 1 take it end to end") and has not yet
accepted this record; the status is proposed. Nothing here is deployed or
qualified.

## Context and options

Ask keeps one timeline file per account on the device (ADR-0047) and shows
"the thread of its place" (ADR-0049): every turn from Home, a project's own
turns from that project. A follow-up carries exactly one earlier turn, and one
small model call works out what it refers to or asks "Which one?". Nothing
older reaches a model, and a person who wants an earlier subject has to find
its question again.

The founder's decisions in the design conversation:

- One Ask page and one bar. Threads exist underneath and there is no list of
  sessions to manage. The thread's name on the page opens a short list for
  jumping by hand.
- A vague question gets "Which one?", listing threads, and the page jumps to
  the one picked.
- A thread has exactly one home: one project, or none. "main thread is scoped
  by person, project thread is scoped by project".
- Threads can be merged, "since there will be a lot of threads".
- "the things i asked should be me only but the context is server side gated
  by permission".

Options for where threads live and who picks:

1. **Threads on the device, ECHO picks.** The desktop groups its saved turns
   into threads. Each Ask also carries the asker's other threads as their own
   question text, and the resolver call that already runs before research
   places the question. The Authority stores nothing.
2. **Threads on the Authority.** History would follow a person across
   computers, but it reverses "the Authority still stores no Ask content"
   (ADR-0047) and needs storage, deletion and a permission check on every
   read of an old answer.
3. **Threads on the device, the person picks.** No model decides anything, so
   nothing is handled underneath.

## Decision and consequences

Adopt option 1, the founder's choice.

- **Device-only, as before.** A thread is a label on saved turns in the
  existing timeline file: each turn names its thread by the id of the
  thread's first turn. The Authority stores no thread, no title and no Ask
  content. Sign-out and an account change delete the file as they do today.
- **One home per thread.** A thread's home is the place its first turn was
  asked in: one project, or none. A question asked in a thread is asked in
  its home's scope. This replaces ADR-0049's "Ask shows the thread of its
  place": Ask shows one thread, and the list shows them all, grouped by home.
- **The asker's other threads ride on the Ask.** `POST /v7/person/ask` takes
  an optional `threads`: for each other thread, the questions the asker typed
  in it and when it was last asked in. They are the asker's own words, never
  a model's rewrite and never an answer's text. Like `previous` they are
  context, never evidence, and are not stored. A project Ask carries only
  that project's threads, so nothing from outside a project enters a
  project-scoped request.
- **A follow-up carries the thread's earlier answers.** `previous` gains
  `earlier`: the older turns of the same thread. Every sentence of every
  carried turn passes the same check as today before a model sees it
  (INV-PERMISSIONS-015, ADR-0055): a sentence resting on a source the asker
  can no longer read is removed. Earlier citations are never cited as they
  are; research opens them again under this request. This widens the
  cross-request context ADR-0007 and ADR-0019 excluded and ADR-0047 first
  allowed for one turn.
- **One call places the question.** When a request carries `threads` or
  `earlier`, the resolver call (still one `answer` call in the `ask_resolve`
  span, one repair) also says where the question belongs: the open thread, a
  new thread, or other threads. It never guesses: when the question could
  belong to more than one thread it names them all and the page asks "Which
  one?". A reply no repair makes usable leaves the question in the open
  thread, answered as asked.
- **Belonging elsewhere is not answered in place.** The answer is outcome
  `clarify` with the threads named by index, and no research runs. The
  desktop jumps and asks again in that thread. A model's verdict never sets a
  request's scope (ADR-0015, ADR-0007): the desktop jumps on its own only
  inside one home, and a thread in another home is always the person's
  click, asked as a new, visible question in that home (ADR-0021).
- **Merging.** A person merges any thread into the open one from the list.
  The resolver may also name other threads that are plainly the same subject
  as the one the question belongs to; the desktop merges those within one
  home and says so with Undo. A merge only relabels saved turns.
- **No new limits (ADR-0055).** No count of threads, questions or earlier
  turns. The request's transport bound is the only limit; when it is reached
  the desktop leaves out the oldest threads, then the oldest earlier turns.
- **Unchanged.** A request with neither `threads` nor `earlier` gets
  byte for byte today's prompts, schemas and responses. The audit record
  stays one content-free row per request; no outcome, role or span is added.

Consequences: the Authority, the person client and the desktop change
together, because every validator on the path uses exact keys. The answer
contract gains `thread` and `merge`, sent only to a request that carried
`threads`.

## Migration, rollback, and evidence

- No stored data changes on the Authority. On the device, a turn saved
  before this change has no thread label; it joins the thread of the turn it
  followed, in the same place, and nothing is lost. An older desktop keeps
  the new field untouched and ignores it.
- Server first: an Authority that takes `threads` and `earlier` is released
  before the desktop that sends them. Rollback is a desktop that stops
  sending them; the earlier behaviour needs neither.
- Evidence required before this record is accepted: the pre-registered
  thread cases added to the follow-up resolution eval pass their "never
  guess" rule on the product's model route; negative disclosure tests show a
  sentence of an earlier turn whose source is unreadable never reaches a
  model; and the founder validates the page on the desktop.
