# Ask memory v1: a clean page over one main thread

Date: 2026-11-24. Status: built, not released. The founder chose each
decision below and said to build it on 2026-11-24; he validates the result on
the desktop. The decision record is
[ADR-0057](../decisions/ADR-0057-ask-memory.md), proposed.

It builds on [Ask threads v1](2026-11-23-ask-threads-v1.md) (ADR-0056). It
changes that version's page, one of its rules (R2), how long a thread lives,
and how two threads are joined. Everything of threads v1 this document does
not name stays as it is.

## November 27 milestone

Ask now shows one chronological conversation for Home and one for each project. The rules below describe the previous desktop. This milestone supersedes its visible thread changes, placement notes, Undo, and collapsed groups of older questions. Older answers still open in place. Repeated questions each keep their place.

The desktop writes a submitted question into the existing account file before starting research. If the write fails, the person can retry. Its answer, retry, or clarification updates the same ID. Reopening the transcript restores the latest prompt if it is waiting for clarification. A new question submitted from Home starts a separate turn. Only completed turns supply research context. After an interruption, Echo regenerates source-derived choices against current access.

An explicitly opened turn anchors a follow-up. Otherwise Ask uses a recent same-scope conversation and supplies other same-scope topics to the existing resolver. A named callback can continue an older topic silently. An implicit match after the existing seven-day window, or a topic selected automatically from another conversation, is a candidate. A bare reference with a weak match prompts for clarification. The user can pick a suggestion or type an answer.

The reader introduced in `7ee96ef` preserves unknown rows on write. The installed staging desktop at `18af498` also preserves them. Earlier writers, including `1441d68`, can read a file containing an unfinished question as empty and replace its history on the next write. Use a desktop with the `7ee96ef` fix or later when rolling back on a device with pending questions.

The new desktop sends `previous.candidate` for implicit older context. Release the updated Authority before the desktop and its bundled Person client. Older desktops can continue sending the existing request format.

This milestone covers clarification before research. Clarification during research and retrieval of an exact historical quote are separate work.

## Why

The founder, 2026-11-24, on a mock that drew threads on the page: "too noisy.
the threads should be how the backend and architecture works not on visual."

What he wants on screen: "a clean page for chat only", where a person reaches
another conversation "without switching to another page".

What he wants underneath: "one main thread ... a timeline from start to end".
Sub-threads stem from it and return to it "after these threads become inactive
for a while", so that "the memory is a continous thread and easy for the echo
agentic loop to find. and user does not have to manage it themselves".

So threads become how ECHO keeps context. A person never manages one. They
ask, ECHO decides where the question belongs, and they can undo it.

## Goals

The founder's goal for the page: "hide all the complexity while giving user
flexibility". The rule this design takes from it: nothing is on the page for
its own sake. A control appears at only three moments: ECHO just did
something, ECHO needs the person, or the person reaches for it.

- The Ask page shows one conversation and the bar. Nothing on it names or
  lists threads until one of those three moments.
- ECHO places every question. A person undoes a placement with one click.
- Everything a person asked is one memory, kept on their device, that ECHO's
  placement reads.
- A thread ends by itself after a week of quiet. A later question about it
  starts a new conversation that carries the old one along.
- A thread has a label that a person and the model both understand, made only
  of words the person typed.

## What must never happen

- A word about a thread is shown or sent that the person did not type.
- A turn that has become part of memory is moved, relabelled or removed.
- ECHO changes scope without a click, or guesses between conversations.
- Stored state about threads is added: no thread table, no timer, no
  migration.

## Decisions the founder made (2026-11-24)

| Decision | His words or pick |
|---|---|
| Memory stays on the device | "Device only" |
| A question about a thread already in memory starts a new thread linked to it; a thread still going continues | "A: new, linked", then "if the thread is still open it contibues from the thread right?" |
| Threads are not drawn | "too noisy ... not on visual" |
| ECHO decides where a question goes, the person can undo | "ECHO, I can undo" |
| A thread joins memory a week after its last question | "after quite for a whole week each atctive question inside the thread restarts the timer" |
| A label is built from the person's own words | "From my own words" |
| Open or joined is worked out, not stored | "A: compute it" |
| Nothing lists threads when a person goes to ask | "no need to surface it when the user click ask it can let user select if there is ambigiouties" |
| A person can still reach their conversations, through one door that shows nothing until used | "One hidden door" |
| Two conversations about the same thing are linked, and nothing moves | "Link them" |
| Threads are kept as fields on each saved question, with no thread records | "yes continue", to the shape under "How it is stored" |
| The page reads like texting a coworker, with no mark on ECHO's replies. Look and feel only | "i want it to feel like a real conversation like how they would text and ask their co worker. this is strictly a UI/UX requerst", then "no need fo E actaully" |
| ECHO's replies are plain text on the page, with no box around them (2026-11-25, after he used the built page with real answers) | "also i dont liek the UI and UX for current ask page", then his pick among three mocked looks: "B, plain reply" |

## Words

Turn, thread, home and own words mean what they mean in threads v1.

- **Shown thread:** the one thread the page shows. Threads v1 called it the
  open thread, and the kernel's prompt still does.
- **Active thread:** a thread whose newest turn was asked less than 7 days
  ago, by this computer's clock.
- **Joined thread:** any other thread. It is part of memory.
- **Continues:** a thread continues another when one of its turns names that
  thread in `continues`, a list of thread ids.
- **Conversation (chain in the code):** a thread together with every thread
  it continues or is linked to, and every thread those name. To placement and
  to labels it is one conversation.
- **Label:** one line that says what a conversation is about.

Active, joined and conversation are worked out from the saved turns whenever
they are needed. None is stored.

## What a person sees

1. **One chat and the bar.** The thread's name line is gone. The shown
   thread's turns read as a conversation (see "The look"). What shows of each
   is as before: in full, the latest turn, the one that was the latest when
   Ask opened, and every question asked since; short, the three before
   those; older ones behind "N earlier questions".
2. **They ask.** Most of the time nothing else happens. The answer lands under
   the chat they are in, or a new chat starts for a new subject. When ECHO
   sees that two conversations are about the same thing it links them, and
   nothing shows on the page.
3. **ECHO moves the question to another active thread.** The chat swaps in
   place. One faint line in the conversation, just above the moved question,
   says "Continuing (label) · Undo". When the answer lands in the chat the
   person was already looking at, nothing moved, so there is no line.
4. **The question is about a joined thread.** A new chat starts. One faint
   line at its top says "Continues (label) from (date)". The label opens the
   older chat. When ECHO sent the question there from another conversation,
   the line also carries "Undo" right after. A question the person asked
   there themselves has the line and no Undo.
5. **ECHO cannot tell.** It asks, as a reply: "Which one do you mean?", with
   a quick reply for each conversation it could be and "New question" last.
   A quick reply shows the label, and the project's name when the
   conversation lives in another project.
6. **The door.** The page's title, "Ask", is a button. Clicking it, or
   pressing the up arrow in the empty bar while Ask is open, opens one list
   under the title. Nothing shows that it is there until then.
   - A "Find" field has the cursor. Typing narrows the list. It matches a
     label or any question typed in the conversation. Return picks the first
     conversation found.
   - "New question" is the first row. It shows an empty chat, and the next
     question typed is asked with nothing carried and is not placed, so it
     starts a conversation of its own.
   - Then one row for each conversation, the one asked in most recently
     first: its label and when it was last asked in. A row in a project other
     than where Ask is also shows that project's name. There are no group
     headings, and active and joined conversations look the same.
   - Picking a row jumps to that conversation's newest thread. In another
     project that is the click R5 needs.
   - Escape, or a click outside, closes it, and the cursor goes back to the
     bar.
7. **Undo** takes back what ECHO just did with the question:
   - The question is still on its way: it is stopped, as Cancel stops it.
   - Its answer has landed: that turn is removed from this computer, once
     this computer's file agrees.
   - Then the same words are asked as a new question with nothing carried,
     as "New question" asks them. The page shows that new chat. A person who
     meant the conversation they were in reaches it through the door.
   Undo is offered until the next question, the next jump, or Ask closing.
   It is offered only when ECHO named another conversation for the question.
   A question ECHO started as a new subject has no Undo, and neither does one
   the person placed themselves: typed in the conversation it continues,
   picked under "Which one do you mean?", or asked again. Try again on a
   question ECHO placed keeps its Undo. So does a quick reply between things
   that is asked in such a question's place.
8. **Unchanged:** the bar and its "Try asking" suggestions (shown only while
   Ask is closed), the scope chip, progress, what an answer contains,
   sources, Copy, drafted follow-ups, and the sidebar's Ask.

## The look: a conversation

Look and feel only. Nothing here changes what is asked, kept or sent.

- **Your questions** are messages on the right, in a soft grey bubble, as
  typed. A quick reply shows the question it asked, and Ask again the
  question it asked again, as in threads v1.
- **ECHO's replies** are plain text on the left, in a measure short enough
  to read, with no box, avatar or name. As first built a reply was a white
  bubble, and the rest of the answer a second outlined box. With real answers
  that drew a box inside a box around every table and card, and the founder
  chose the plain reply on 2026-11-25.
- **Short first.** The statement the answer opens with comes first, in
  slightly larger and heavier type: its direct answer, or the first sentence
  of a one-part answer that opens with a sentence. The rest of the answer
  follows under it, a step quieter, in the blocks the writer arranged
  (ADR-0051) with their citations. An answer with no direct answer that opens
  with a table, a list or a card, or has several parts, has no such first
  line.
- **The seven blocks, drawn plainly** (this updates how the desktop draws
  ADR-0051's blocks, and nothing of what they hold). A block's title is a
  small quiet label over it, not a bold heading, and the paragraph right
  after the answer shows no title, since it reads on from the answer. A table
  has no box, only a hairline between its rows. A card is one thing, so it
  alone keeps a soft panel, with no line. Points, a timeline and a quote read
  as before.
- **While ECHO works** nothing changes: the one quiet line under the question
  (a pulse, the step now, a timer, Cancel), which was already plain text.
- **A sentence's source numbers** stay on the line of its last word. A number
  never starts a line alone.
- **Times** sit in the middle between messages, as in a texting app: above
  the first turn shown, the first of a day, and one asked an hour or more
  after the one before it.
- **Earlier exchanges** stay as messages. For the three before the ones
  shown in full, the question shows as typed and the reply shows its first
  message only, which opens the rest in place on a click and folds it again.
- **Sources** are one small "N sources" link under a reply, opening the pane
  as before.
- **"Which one do you mean?"** is a reply from ECHO, in the type of a short
  answer, with quick replies under it.
- **The faint lines** of items 3 and 4 are centred notes in the conversation,
  like the notes a texting app shows.
- A reply whose every sentence cites a source the person can no longer read
  says so in one line, where it showed nothing before.
- The bar is unchanged, and still says "Ask ECHO".

Mock: boards A to E of "Redesign: a conversation, threads underneath" on the
canvas https://claude.ai/artifact/LPH5TbV5ZLNaufcJEk1xxf, and for the plain
reply, look B on its page "New look".

## Rules

Threads v1's R1 and R3 to R9 stand. R2 is replaced, R10 is tightened, and six
rules are added.

- **R2 (replaced). Only own words describe a thread.** A label is either a
  question the person typed in the conversation, or a line in which every
  word is a word they typed in it. Nothing else about a thread is sent. A
  label that fails this is dropped, wherever it is found. One exception stays
  from threads v1, on this device only: a thread none of whose turns kept the
  person's words is listed behind the door by its first turn's heading.
  Nothing of it is sent, so ECHO never places a question in it. Nowhere else
  does the page show that heading, which a model may have written: a line
  that would name such a thread says "an earlier conversation".
- **R10 (tightened). A model-written question goes only while all it was
  written from is readable, all the way back.** Threads v1 checked the turns
  a question followed and what each of those carried. A link can now bring
  another conversation's turns into a request, so the check follows every
  turn a request carried, and what each of those followed and carried in
  turn, until it reaches turns that followed nothing. The check fails, and
  the typed words go, on a turn no longer kept, one saved before what a turn
  followed was recorded, one that names its thread without recording what it
  carried, or a history that comes back on itself (a turn that names itself
  through what it followed and carried). The order the file keeps turns in
  does not matter.
- **R11. A thread is active for 7 days after its newest turn.** Each new turn
  starts the 7 days again. Nothing is stored: a thread is active or joined by
  the age of its newest turn. Exactly 7 days is joined. The time that counts
  is when the person asked the question, or picked a quick reply for it,
  however long placing it or reading a project then took. That is also the
  time its turn is kept under.
- **R12. A joined thread never changes.** No turn is added to it, moved into
  it or moved out of it, and none of its turns is removed.
- **R13. A question that belongs to a joined thread starts a thread that
  continues it.** This holds however the question got there: ECHO placed it,
  the person typed it while that thread was shown, or they pressed Ask again
  on one of its turns. The new thread lives in the same home. Its first turn
  names the joined thread in `continues`. A question belongs to a joined
  thread when it is asked 7 days or more after that thread's newest turn.
- **R14. A conversation is one conversation.** It is sent to placement as one
  entry, it has one label, and "Which one?" never offers it twice. A question
  in it carries its turns, oldest first, under R6 and R10. It never forks: a
  question typed while any older part of it is shown continues its newest
  thread. If that thread is active the question lands in it and the page
  shows it; if it is joined, R13 starts a thread that continues it. One thing
  stays from threads v1: a question typed while an earlier exchange is open
  (from its line, or from one of the bar's suggestions) continues that
  exchange and carries the turns up to it. Its answer still lands at the end.
- **R15. ECHO acts, and the person can undo.** After ECHO puts a question
  in a conversation other than the one the person was looking at (in its
  active thread, or in a new thread that continues its joined one), the page
  says so in one line and offers Undo. Undo removes only the turn ECHO just
  placed, and only while it is still the newest turn of its thread and no
  other turn names it. Only ECHO naming a conversation is a placement. Where a rule
  lands a question the person asked in a conversation (R13, R14), nothing was
  placed for them, so there is no Undo. What the person was looking at is
  what showed when they asked: a question waiting alone, under "Which one do
  you mean?" or after a failure, hides the conversation behind it.
- **R16. ECHO joins conversations by linking, never by moving.** When an
  answer names another conversation as plainly the same thing, the turn that
  lands names that conversation's newest thread in `continues`. From then on
  they are one conversation (R14). No turn changes thread, so R12 holds. A
  link stays inside one home (R9). It has no line on the page and no Undo of
  its own: undoing the placement (R15) removes the turn, and its links go
  with it.

R4 (never guess) and R5 (another home is always a click) are unchanged and
decide when ECHO asks instead of acting.

## Labels

- A conversation with one typed question is labelled by that question.
- A conversation with two or more gets a line ECHO writes: the thing it is
  about, then what was asked about it. Example: "pilot: start, owns, annual
  plans".
- **The check.** A word is a run of letters, marks or digits. A label passes
  for a conversation when it is one line of 1 to 80 characters with at least
  one word, and each of its words, ignoring case, is a word of a question the
  person typed in that conversation. Words are used as typed: "owns" does not
  allow "owner". Words are read as the text shows them. A character that
  shows as nothing (a soft hyphen, a zero-width space, a mark that sets the
  direction of text) splits no typed word, and a label holds none: between
  two typed words it would show them as one word, or their letters in
  another order. A joiner inside a word, which Persian and the Indic scripts
  need, is part of that word. Between its words a label may hold spaces and
  punctuation. Any other character, such as a symbol or an emoji, must be
  one the person typed, because a symbol can say a word too. One function
  holds the rule for the API, the kernel and the desktop
  (`personAnswerLabelFitsV1`).
- **Who checks.** The desktop holds the person's typed words, so its check
  decides: before it keeps a label, and each time it shows or sends one. The
  Authority checks what it can see (T1 to T3). A label that fails is dropped,
  never repaired, and the Ask goes on without it.
- **What a conversation's label is.** The label on the newest of its turns
  that has one and still passes. With none, the first question typed in its
  newest thread that has one, which is threads v1's name. Only turns asked
  in the conversation's home count, for its label and for its links.
- **Stable.** ECHO is shown the current label and keeps it unless the new
  question adds something it does not cover.
- **No extra call.** The label comes back from the call that already places
  the question. A label can therefore arrive one question late, and a failed
  label never fails an Ask.

## How it works underneath

### How it is stored

There is no stored thread. The one thing kept is the file threads v1 keeps,
one per account on the person's computer (`ask-timeline-v1/<account>.json`),
and its shape does not change:

```ts
{
  schema_version: 1,
  kind: "echo-desktop-ask-timeline-v1",
  turns: [ /* oldest first: this list is the main thread */ ]
}
```

A saved turn gains two optional fields, and nothing else changes:

```ts
interface TimelineTurn {
  // id, asked_at, text, question, scope, answer, typed, follows,
  // thread, carried and the rest, as before
  /** The label that came back with this turn's answer. */
  readonly label?: string;
  /** Threads this turn's thread continues or is linked to: thread ids, each once. */
  readonly continues?: readonly string[];
}
```

An example, read on Nov 27:

| Turn | Asked | Typed | `thread` | `continues` | `label` |
|---|---|---|---|---|---|
| 1 | Nov 17 | When does the pilot start? | 1 | | |
| 2 | Nov 17 | who owns it? | 1 | | pilot: start, owns |
| 3 | Nov 19 | Is the pilot delayed? | 3 | | |
| 4 | Nov 27 | did the pilot date move? | 4 | 1, 3 | pilot: start, owns, delayed, date |

Turns 1 and 2 are thread 1, quiet for more than a week, so turn 4 started
thread 4, which continues it (R13). ECHO also found thread 3 to be about the
same thing, so turn 4 links to it (R16). Threads 1, 3 and 4 are one
conversation. No turn changed.

Everything else is worked out from the saved turns each time
(`product/echo-desktop/src/renderer/timeline.ts`):

| Thing | Where it comes from |
|---|---|
| A thread | The turns with the same `thread` value (`threadsOf`) |
| Active or joined | The age of the thread's newest turn (`threadActive`) |
| What a thread continues or is linked to | `continues` on its turns |
| A conversation | Following `continues` both ways (`chainsOf`) |
| A conversation's label | `label` on its turns, checked (`labelOf`) |
| What ECHO just placed | One short-lived record on the page (`AskState.placed`) |

A table of threads would need a new key in the file. The file's reader
accepts exactly its three keys, so that would be a new file version and a
migration. This design needs neither.

### T1. Request

```ts
interface PersonAnswerThreadV1 {
  // questions, asked_at as before
  /** The conversation's label. Each word is a word of `questions`. */
  readonly label?: string;
}

interface PersonAnswerPreviousV1 {
  // as before
  /** The label of the conversation `previous` belongs to. Only on a follow-up. */
  readonly label?: string;
}

interface PersonAnswerRequestV3 {
  // as before
  /** The client reads labels. Only `true`. */
  readonly labels?: true;
}
```

- A label comes back only to a request that carried `labels: true`. The
  response validator checks keys exactly, so a desktop from before labels
  would refuse an answer that carried one. With this, the Authority can be
  released first and older desktops keep working.
- One `threads` entry is one conversation: the questions typed across it,
  oldest first, and when it was last asked in.
- `previous.earlier` carries the older turns of the whole conversation,
  oldest first.
- The validator refuses a label that is not in form. It refuses a
  `threads[i].label` with a word that is not in that entry's `questions`. It
  cannot tell typed words in `previous`, so there it checks the form only.
- `previous.label` and `labels` are refused beside `purpose: 'ask_again'`, as
  `threads` and `earlier` are.

### T2. Response

```ts
interface PersonAnswerResponseV8 {
  // as before
  /** The label of the conversation the question continues. */
  readonly label?: string;
}
```

- Only on an ordinary answer that names its `question`: never beside
  `clarify`, `thread` or an Ask again's `since`.
- In form. The answer's hash covers it.
- A client refuses, as `invalid_response`, a label on an answer to a request
  that did not carry `labels: true`, or carried no `previous`
  (`personAnswerThreadsProblemV1` returns `unasked`).
- `merge` is unchanged on the wire. The desktop now acts on it by linking
  (R16) instead of moving turns.

### T3. Kernel

- The thread resolver's prompt gains the label: what it is, that it uses only
  words from the questions the person typed, and that the current label is
  kept unless the new question adds something. Its reply schema gains
  `label`. The resolver is shown the open thread's label and each other
  thread's.
- A label is kept only on an `open` reply that is `same` or `resolved`. The
  thread resolver sees the person's questions only inside the request's
  turns, where a question may be a model's rewrite. The kernel first takes
  the label as it takes any line a model writes: trimmed, with line breaks,
  control characters and runs of spaces made single spaces, and no word
  changed or cut. Then it
  checks the form, and drops a label with a word that is in no question of
  the open thread and not in the new question. A dropped label is counted
  (`resolver_label_dropped`), never sent back for repair, and the answer goes
  without one.
- A request with neither `threads` nor `previous.earlier` still takes the
  follow-up resolver's path byte for byte, and returns no label.
- The response carries the label only when the request carried
  `labels: true` (`agenticThreadFieldsV1`).

### T4. Authority

Nothing new is stored, logged or audited. Labels reach the kernel as sent,
after T1's validation. On staging, while LangSmith tracing is on, a label
appears in a run's exported model inputs and outputs, as the questions it is
made of already do.

### T5. Person client

`person ask` takes `--labels`. `--threads=<json>` and `--previous=<json>`
accept `label` and validate it with the API's validator. The client refuses a
returned label as T2 says.

### T6. Desktop

- **Saved turn.** `TimelineTurn` gains `label?` and `continues?`. The host's
  `timelineTurn` accepts a label in form, and in `continues` a list of turn
  ids, each once. When the file is read, a saved label that is not in form is
  left out and its turn still shows.
- **Landing, one rule.** An answer lands in its conversation's newest thread
  when the question was asked less than 7 days after that thread's newest
  turn. Otherwise it lands in a thread of its own whose turn names that
  thread in `continues` (R13). A new subject lands in a thread of its own
  that names nothing. Until its answer lands, a question shows where it was
  typed, or alone when its answer will start a thread.
- **Placement.** When ECHO names one other conversation in the same home:
  - its newest thread is active: Ask jumps there and asks;
  - its newest thread is joined: Ask shows a new chat and asks the words as a
    follow-up of the conversation's newest turn, carrying the conversation.
  Several conversations, or one in another home, is "Which one do you mean?".
- **Undo.** The page keeps one record of what ECHO just placed: the question
  on its way says so itself, and once it lands the record holds its turn, the
  typed words and where they were asked. It is cleared by the next question,
  a jump, Ask closing, or the timeline being read again. Removing a landed
  turn is one host call, `timeline.remove`, compare-and-set: it removes the
  turn only when the file has it as the newest turn of its thread, less than
  7 days old, and no kept turn names it in `follows`, `again_of`, `carried`
  or `continues`. Otherwise it removes nothing and the page says so, as a
  warning that stays until the next page. Nothing shows removed before the
  file agrees, and while it is being kept nothing else can be asked. A later
  change to a kept turn (the sources a check found unreadable) is written
  only in that turn's place (`timeline.put` with `known`), so a change still
  on its way when Undo removes the turn never brings it back. Such a change
  fails, and the page says so, when the file cannot be read.
- **What was decided stays decided.** A failed question keeps that ECHO
  placed it, so Try again offers the same Undo. A "Which one do you mean?"
  between things keeps the links and the placement of the question it is
  for, and the quick reply picked lands with both. Undo of a quick reply
  asks the person's own words again, never the reply's.
- **The timeline forgotten.** Signing out, or another account signing in,
  stops a question on its way or still being prepared, and a pick still
  reading its project: they were built from turns that are gone.
- **Linking (R16).** When an answer's `merge` names other conversations, the
  turn that lands lists the newest thread of each in `continues`, in the same
  write that saves the turn. One in another home is left out (R9). Nothing
  else is written, shown or undone.
- **The "Continues" line** shows on a thread whose first turn continues a
  joined thread (R13), and its label opens that thread. A turn names the
  thread it continues first and any links after it, and a link (R16) alone
  never adds a line. An answer that goes on no conversation writes no link.
- **The door.** The list opens from the title. "New question" sets one flag
  on the page, "next question is fresh": the next typed question is sent with
  neither `previous` nor `threads`. The flag is cleared when a question is
  asked, a conversation is picked, or Ask closes. Capture or a sheet coming
  up over the page closes the list, so its Return never picks a conversation
  behind them.
- **Removed.** The thread's name line and merging by hand. Also everything
  that existed only to move turns between threads: `timeline.move`, the
  merge's Undo, the "Merged with" line and the messages about questions that
  could not be moved. Their tests went with them.

## State this adds

The founder asked that this work add no state-machine problems.

- No stored state. Active, joined, conversation and label are worked out.
- One short-lived record on the page, "what ECHO just placed": none, on its
  way, landed, cleared. "On its way" is a field of the question on its way,
  so it cannot outlive it. It takes the place of the merge's Undo record and
  is cleared at the same points. A failed question and a "Which one do you
  mean?" between things carry the same mark, so Try again and a quick reply
  keep the Undo.
- `timeline.remove` takes the place of `timeline.move` and its busy flag
  (`timeline.removing`).
- Taken away: the move between threads and the merge's Undo, with their
  states.
- One flag on the page, "next question is fresh", set by "New question" and
  cleared by the next question, a pick, or Ask closing.
- The door's list is open or closed. Starting a question or showing another
  thread closes it.

## Eval

- The registered thread eval keeps its 28 cases and its gate: the whole set
  run once, and rules 1, 2 and 4 decide. It has not been run. The prompt
  changed here, so the first run is on the new prompt.
- Rule 4 (never merge wrongly) now guards links. It matters more than
  before: a wrong link joins two conversations for good.
- Added, reported only: for trials that answer in the open thread, how many
  returned a label that passed the kernel's check. A label that fails that
  check is dropped before it is counted. No label result gates a release.
- Not built: how often a label is kept unchanged. No registered case
  shows a current label, and the registered cases do not change.
- **If the gate fails,** ECHO does not place questions: the desktop stops
  sending `threads`, as threads v1 says. What is left works without it. A
  question continues the conversation shown, "New question" starts one, a
  person reaches any conversation through the door, and R11 to R14 still
  hold. No label is written, so the door lists first questions. The door
  would then be the only way to move, and whether it should stay hidden is a
  call for that day.
- Unit and end-to-end tests pin each rule: R2's check on the desktop and in
  the API, R10 all the way back, R11's 7 days at the boundary, R12, R13 for
  each of its three ways in, R14, R15 (Undo while on its way, Undo after
  landing, each reason `timeline.remove` refuses, and no Undo for the
  person's own question), R16, and the door.

## Known and accepted

- A link cannot be taken apart. If ECHO links two conversations wrongly,
  they stay one conversation, unless the person undoes that question right
  away. Nothing on the page says a link was made. The eval's rule 4 is the
  guard.
- The door is hard to discover. Nothing on the page says the title opens a
  list. The founder chose this over a line that always shows.
- The door exists only on the Ask page. From Home or a project, a person
  gets to Ask as before: the bar, its suggestions, or the sidebar's Ask.
- "Active" uses this computer's clock. A clock set back makes old threads
  active again. Nothing is lost either way.
- A thread asked in every few days never joins. Its chat grows, and folding
  handles that as before.
- Follow-ups an undone answer drafted stay, unsent, in the person's own
  list. Undo removes the answer from this computer only.
- A save that fails can split a conversation after a restart. If the first
  turn of a thread that continues another could not be saved, later turns in
  it are saved without the link, and after ECHO restarts they show as a
  conversation of their own. The page says at the time that the answer could
  not be saved.
- "Which one do you mean?" between things shows no "Continuing" line and no
  Undo. When ECHO placed the question first, they come back once a quick
  reply is picked. A chat's own "Continues" line stays throughout.
- Find, behind the door, looks at a conversation's label and its typed
  questions as they are sent. A question a later one repeats is found by the
  later wording.
- A word is a run of letters, so in a language written without spaces a
  whole phrase counts as one word. There a label can only repeat a phrase as
  it was typed, and most conversations keep their first question as their
  name. Nothing is shown or sent that was not typed.
- 7 days and 80 characters are product choices. The first is the founder's
  rule. The second keeps a label to one line of a "Which one?" button.

## Not in this version

- Any change to what an answer contains: its blocks, citations and sources
  are as before, shown inside the reply.
- Several questions running at once.
- Keeping an answer current, or marking one to keep.
- Memory on the Authority, or on a second computer.
- A list of chats that shows without being asked for.
- A label that uses what answers said.
- Merging, renaming, splitting or deleting a thread by hand.

## Calls the founder has not made

1. **Ask again on an old answer starts a new chat.** R12 says a joined thread
   never changes, so Ask again on one of its turns lands in a thread that
   continues it.
2. **Undo removes the answer.** It was researched with the wrong context, so
   it is not kept. The words are asked again as a new question.
3. **A new subject has no Undo.** Otherwise every new chat would carry a
   line.
4. **"Continues (label) from (date)" stays** on a chat that continues
   another, so the older part is one click away. Only its Undo is temporary.
5. **Merging by hand goes** with the thread's name line. A link, once made,
   cannot be taken apart in this version.
6. **Labels use words exactly as typed,** at most 80 characters, and can
   arrive one question late.
7. **The look's details.** Grey for the person's messages; the answer's
   opening statement first, in larger type; earlier replies cut to that first
   line; times in the middle, said again after an hour.
8. **The door's list is flat.** No project headings: a row from another
   project shows that project's name. The up arrow opens it only from an
   empty bar, and only while Ask is open.
9. **No line when nothing moved.** When ECHO places a question in the chat
   the person was already looking at, the answer just lands there, with no
   line and no Undo. When that chat ended a week ago, a new chat continues
   it, with its "Continues" line and no Undo.
10. **An earlier turn shows the question as typed,** not the full question
    ECHO worked out, because the reply's first message sits right under it.
11. **Undo leaves drafted follow-ups** in the person's own list.
12. **Undo only when ECHO chose.** A question the person typed in a
    conversation, even one a week old, gets no Undo: they put it there. Only
    a question ECHO moved to another conversation has one.
13. **"an earlier conversation".** A line that would name a conversation
    none of whose questions kept the person's words says this, because its
    old heading may be a model's.
14. **No title on the paragraph right after the answer.** The writer often
    titles it ("Source", "Details"), and under a short answer that label is
    noise. The page leaves it out, and so does Copy answer; every other
    block keeps its title. The mock he picked drew it this way, and he was
    told it was his call.
15. **The plain reply's details.** A reply is at most 680 px wide; what
    follows the short answer is a step quieter than it; a card is at most
    480 px wide; the line under an answer still says how long it took.

## Delivery

- Branch `claude/ask-memory-v1`, on main after PR #428, one pull request,
  with ADR-0057 and this document.
- The full check, a state-machine audit against the catalog, a Codex review
  on the strongest model, then a lean pass, as for threads v1.
- Release order is unchanged: the Authority before the desktop, because an
  older Authority refuses `label` and `labels`. A newer Authority works with
  older desktops, since it sends a label only when asked.
- The registered thread eval still has to run before ECHO's placement is
  trusted.
