# Ask threads v1: one page, hidden threads, ECHO picks

Date: 2026-11-23. Status: proposed; the founder chose the approach on
2026-11-23 and validates the built result. Not deployed or qualified.
Decision record: [ADR-0056](../decisions/ADR-0056-ask-threads.md). It builds
on [Ask timeline v1](2026-10-25-ask-timeline-v1.md) and replaces "one thread
per place" in
[Quieter Ask](2026-10-26-quieter-ask-and-only-me-v1.md).

## Why

The founder: "why can i just use one page and one thread in one place". A
person should not hunt through sessions or histories. They ask in one place,
and ECHO works out which earlier conversation a question continues.

## Words

- **Turn:** one saved question and its answer (unchanged).
- **Thread:** the turns that share a thread id. The id is the id of the
  thread's first turn.
- **Home:** where a thread lives: one project, or none. It is the scope of
  the thread's first turn. A question asked in a thread is asked in its
  home's scope.
- **Open thread:** the one thread Ask shows.
- **Own words:** what the person typed for a turn: its `typed` text, or its
  `text` when the turn is recorded as following nothing (`follows` is null).
  A model's rewrite is never own words. A turn saved before turns recorded
  what they followed has none, because its `text` may be a model's rewrite:
  such a thread still shows in the list, but ECHO cannot place a question in
  it until one new question is typed there.

## What a person sees

1. **One thread on the page.** Ask shows the open thread's turns exactly as
   it shows a place's turns today: the latest in full, the three before it as
   one line each, older ones behind "N earlier questions".
2. **The thread's name is the first line.** It is the first question typed in
   the thread, on one line. It is a button that opens the thread list. With
   no thread open it reads "New thread". The line shows whenever the person
   has any thread.
3. **The thread list.** A "Find a thread" field, then every thread, grouped
   by home: the open thread's home first, then "No project", then projects by
   most recent. Newest first inside a group. A row is the thread's name and
   when it was last asked in. Find matches any question typed in a thread.
   - Clicking a row **jumps** to that thread.
   - Every row but the open one has **Merge**, which merges that thread into
     the open one. With no thread open there is no Merge.
4. **Jumping** moves Ask to the thread's place, as the sidebar's Ask does
   today (Home for no project, the project's page otherwise), opens the
   thread, and checks its turns' sources.
5. **Asking.** A person is **in** a thread once they have asked in it or
   picked it since Ask opened: its row in the list, a "Which one?" button, one
   of its earlier questions, or a suggestion. Ask merely showing the thread
   they last used, as the sidebar's Ask does, is not being in it.
   - In a thread, a typed question continues it: it carries the previous
     turn, the thread's earlier turns, and the person's other threads.
   - Otherwise (from a page with Ask closed, or back in Ask with nothing
     asked or picked yet) a typed question carries no previous turn. It
     carries every thread it may be placed in, the one shown included, and
     shows alone while it is on its way. So "did that change?" typed on
     coming back asks which thread, and the same words typed right after an
     answer continue that thread.
6. **Where the answer lands.**
   - It continues the open thread: saved in it.
   - A new subject: saved as a new thread, which becomes the open thread.
   - It belongs to exactly one other thread in the same home: Ask jumps there
     without asking and asks the same words again in that thread.
   - Anything else that belongs elsewhere: **"Which one?"** with a button per
     thread (a thread in another home also names its project) and "New
     question". A thread jumps there and asks again in it. "New question"
     asks the words with nothing carried and starts a new thread.
7. **Merging.** The merged thread's turns join the open thread in time order.
   One faint line says "Merged with (name) · Undo". ECHO also merges on its
   own when the answer names another thread as plainly the same subject, in
   the same home only, with the same line. Undo is offered until the next
   question, jump or close.
8. **Unchanged:** the bar, the scope chip, progress, answers, sources, Copy,
   Ask again (it stays in its thread), "Which one?" between things inside one
   answer, drafted follow-ups, the sidebar's Ask (it opens the thread asked
   in most recently), and the bar's suggestions (picking one opens its
   thread at that turn). "Ask across everything you can see" starts a new
   thread with no project.

## Rules

- **R1. Device-only.** Threads are labels on turns in the timeline file. The
  Authority stores nothing about them.
- **R2. Only own words describe a thread.** A thread's name, and what is sent
  about it, are the person's own words. Never an answer's text and never a
  model-written question, which can name a source the person can no longer
  read.
- **R3. A project Ask carries only that project's threads.** An Ask in all
  context carries every other thread.
- **R4. ECHO never guesses a thread.** When a question could belong to more
  than one, the page asks.
- **R5. ECHO never changes scope on its own.** A jump without a click happens
  only inside one home. A thread in another home is always a click, and the
  question is then asked visibly in that home.
- **R6. Every carried sentence is checked.** A sentence of any carried turn
  goes only when every source it cites was found readable in the last five
  minutes, and the Authority checks again before a model reads it.
- **R7. No counts.** Nothing limits how many threads, questions or earlier
  turns ride on a request but its transport bound. When the body would pass
  it, the desktop leaves out the oldest threads, then the oldest earlier
  turns, then sentences as today.
- **R8. Nothing saved is lost.** A turn without a thread id belongs to the
  thread of the turn it followed while both were asked in the same place;
  otherwise it starts its own.

## Contracts

### T1. Request

`PersonAnswerRequestV3` gains one optional field and `PersonAnswerPreviousV1`
gains one, both validated with exact keys inside the existing body bound:

```ts
interface PersonAnswerRequestV3 {
  // schema_version, question, project_id?, previous? as today
  /** The asker's other threads, most recently asked first. May be empty. */
  readonly threads?: readonly PersonAnswerThreadV1[];
}

interface PersonAnswerThreadV1 {
  /** The questions the asker typed in the thread, oldest first. At least one; each passes the question rule. */
  readonly questions: readonly string[];
  /** When the thread was last asked in: ISO-8601 UTC with milliseconds. */
  readonly asked_at: string;
}

interface PersonAnswerPreviousV1 {
  // purpose, question, asked_at, statements, citations as today
  /** The older turns of the same thread, oldest first. At least one when present. */
  readonly earlier?: readonly PersonAnswerEarlierTurnV1[];
}

/** One older turn: a previous turn without a purpose, under the same rules. */
interface PersonAnswerEarlierTurnV1 {
  readonly question: string;
  readonly asked_at: string;
  readonly statements: readonly PersonAnswerPreviousStatementV1[];
  readonly citations: readonly PersonAnswerCitationV8[];
}
```

- `threads` and `earlier` are refused beside `purpose: 'ask_again'`.
- They are the asker's context: never stored, never evidence.
- The desktop sends `threads` with every typed question it wants placed, even
  when the person has no other thread and the list is empty. Without that a
  person with one thread could never start a second from inside it. A request
  without `threads` is never placed: Ask again, a choice between things in one
  answer, the question asked again after a jump, and "New question".

### T2. Response

Only an answer to a request that carried `threads` may carry these:

```ts
type PersonAnswerThreadPlacementV1 =
  | { readonly kind: 'new' }
  | { readonly kind: 'other'; readonly threads: readonly number[] };

interface PersonAnswerResponseV8 {
  // as today
  /** Where the question belongs, when not the open thread. */
  readonly thread?: PersonAnswerThreadPlacementV1;
  /** Other threads that are plainly the same subject as the one the question belongs to. */
  readonly merge?: readonly number[];
}
```

- Numbers are indexes into the request's `threads`, each once.
- `thread` absent: the question continues the open thread (the request's
  `previous`). A request with `threads` and no `previous` never gets it
  absent with an answer: its answer says `new`.
- `{ kind: 'new' }`: an ordinary answer, to the question as asked.
- `{ kind: 'other' }`: outcome `clarify`, no parts, no citations, `question`
  the question asked, and no `choices`. One index means the question belongs
  to that thread; several mean it could belong to any of them. The outcome
  `clarify` now comes with exactly one of `choices` and an `other` thread.
- `merge`: only when `thread` is absent or names exactly one other thread;
  never beside `new` or `choices`; never the thread the question belongs to.
  An answer that offers choices names none: the question is asked again once
  one is chosen, and that answer does.
- `question` is named on every answer to a request that carried `previous` or
  `threads`.
- The answer's hash covers `thread` and `merge`.

### T3. Kernel

- A request with neither `threads` nor `previous.earlier` takes today's path
  byte for byte: the same resolver prompt, schema, calls and response.
- Otherwise the **thread resolver** runs in its place: one call through the
  request's gate, role `answer`, span `ask_resolve`, one repair. It is shown
  today's date, the open thread when the request has `previous` (its turns
  oldest first, sentences and sources numbered across the whole thread), the
  other threads numbered from 1 with their questions and the day each was
  last asked in, and the new question.
- It returns where the question belongs:
  - `open` with a resolution (`same`, `resolved` with the full question and
    the sources it is about, or `clarify` with choices), read by today's
    rules. Only when the request has `previous`.
  - `new`: a subject none of the threads is about. Research runs on the
    question as asked, with no starting item. Only when the request carried
    `threads`, empty or not; a request with `earlier` alone is answered in
    its thread.
  - `other` with the numbers of the threads it belongs to.
  - Optionally `merge`, the numbers of other threads plainly about the same
    subject as the one the question belongs to. A number that names no
    thread, or the target, is dropped and counted; the rest stand. A reply
    that asks which thing is meant names no merge.
  - A reply that says two things (a place other than the open thread, and
    also a resolution or choices) has not said where the question belongs
    and goes back for the one repair.
- Never guess: more than one other thread that could fit is named, never one
  picked. A question that depends on something no thread gives stays in the
  open thread as `same`.
- A reply no repair makes usable is `open` and `same` when the request has
  `previous`, and `new` when it has none.
- With no `previous` and an empty list there is nowhere else the question
  could belong: it is a new thread and no call is made, so a person's first
  question waits for none.
- `about` addresses the thread's citations as one list: earlier turns' first,
  each citation once. Research starts from the openable ones, as today.
- A snapshot restart reuses the resolution only when the checked `previous`
  and the `threads` are identical.

### T4. Authority

- `readablePreviousV1` checks the citations of `previous` and of every
  `earlier` turn in one check and removes each sentence that rests on a
  citation not found `same`, turn by turn. A turn left with no sentence keeps
  its question. With no check available every turn keeps its question only.
- `threads` reaches the kernel as sent. Nothing about it is stored, logged
  or audited beyond the request's existing prompt digest.

### T5. Person client

- `person ask … --threads=<json>` validates the list with the API's own
  validator before sending and sends it to `/v7`. `--previous` takes
  `earlier`.
- An answer that carries `thread` or `merge` to a request without `threads`
  is refused as `invalid_response`.

### T6. Desktop

- `TimelineTurn` gains `thread?: string`, the id of the thread's first turn.
  Every turn saved from now on has it. The host accepts only a turn id there.
- `'ask.run'` params gain `threads?`; `Answer` gains `thread?` and `merge?`,
  which are never saved on a turn.
- A merge saves each moved turn with the open thread's id through
  `timeline.put`. Undo saves them back.
- A thread's sources are checked when it opens, as a place's thread is today,
  with the five-minute freshness kept per thread.
- A list the host's validator refuses is not sent: the Ask goes without
  `threads`, as it goes without a refused `previous` today.

## Thread resolution eval (pre-registered)

Written before any run. Cases live in
`tools/evals/ask-follow-up/thread-cases.json`; grading is deterministic, with
three trials per case on the product's model route.

| Group | Cases | Expectation |
|---|---|---|
| Continues the open thread | 6 | `open` |
| One other thread | 6 | `other` naming exactly that thread |
| Several other threads | 6 | `other` naming every candidate |
| New subject | 6 | `new` |
| Same subject twice | 4 | the expected thread, and `merge` names its duplicate |

Rules:

1. **Never guess:** every trial of every "several other threads" case names
   every candidate. One trial that names a single thread fails the rule.
2. **Route the obvious:** at least 90% of "continues the open thread" and
   "one other thread" trials pass.
3. **Leave new subjects alone:** at least 90% of "new subject" trials return
   `new`.
4. **Never merge wrongly:** no trial outside "same subject twice" names a
   merge.
5. **Merge the obvious:** reported for "same subject twice"; the founder
   judges it.

A trial whose resolver fell back fails, in every group. If rule 1, 2 or 4
fails, ECHO does not pick threads: the desktop stops sending `threads`, and
jumping and merging stay by hand until a prompt passes. Rule 2 decides with
the other two because a resolver that names every thread for every question
never guesses and never merges, and is useless. Rules 3 and 5 are reported
and judged by the founder. Only the whole registered set decides: all 28
cases, each once, three trials each. The existing thirty follow-up cases are
unchanged, and so is the path they test.

**Result:** not run yet.

## Known and unchanged

These hold for a follow-up on `main` today and hold the same way for a
question placed among threads. This change does not alter them:

- An attempt restarted by a snapshot change reuses the resolution it already
  paid for, so the audit row of the attempt that answers can record no model
  call for it; and an attempt that audited and then restarted audits again.
- A snapshot change during the resolver's repair restarts the attempt, which
  may call the resolver again: at most one call and one repair per attempt.
- A question near the request's byte bound cannot be answered when the
  request carried `previous` or `threads`, because the answer names it twice.
- "Which one?" between things in one answer may offer a single choice.
- Prompts, which hold the carried turns and thread questions, reach the
  staging-only trace exporter like every other prompt (INV-PERMISSIONS-015).

## Not in v1

- History on the Authority, or following a person to a second computer.
- Splitting a thread, moving one turn, renaming a thread, or deleting one.
- A short model-written thread name.

## Calls the founder has not made

- A thread's name is its first question, cut to one line.
- Inside a project, "Which one?" never offers a thread from outside it (R3).
- Merging by hand may cross homes; ECHO's own merging never does.
- Being in a thread is what makes a bare "did that change?" continue it. No
  clock decides: a thread asked in an hour ago and one asked in last week
  behave the same once the person has asked in or picked it.
- In a thread, the open thread wins over another thread that could also fit,
  and what a question refers to is read from the latest turn first, then
  from older turns.
