# Quieter Ask, one thread per place, and Only me as a lock (v1)

Date: 2026-10-26. Status: building; the founder validates the result on the
desktop. Decision record: [ADR-0049](../decisions/ADR-0049-only-me-is-a-lock.md).
Design canvas: "Quieter Ask" (today vs quieter, a sentence under the pointer,
Home, the Only me list, a project page, Capture, a project's thread).

## What the founder asked for

On 2026-10-26 the founder sent a staging screenshot of Ask and said it is too
noisy: hard to read, a lot of clustered words. Around two or three lines of
answer sat up to five lines of extras ("Looked through 3 items · 16s",
"Nothing changed since 1:20 AM", a table caption restating the lead, "2
sources" with long cut-off titles, Ask again and Copy answer), a number box
and a lock after almost every sentence, a question smaller than its answer's
first line, and the same question shown twice.

In the same conversation the founder decided:

- Ask from Home is one main thread with every question asked. A project's Ask
  is only that project's continuous thread.
- Mine goes. There is no separate Only me section and no Only me thread.
- "Only me" is a lock on an item, not a place. A locked item can be filed in a
  project: it shows there, with a lock, only for the person who added it, and
  only that person's Ask in the project uses it.
- Home gets a quiet "Only me" link: the full list of everything only you can
  read, filed in a project or not.

Success: the founder reads an answer without hunting through chrome; asks
from THERM and sees only THERM's thread; files a private note in THERM, sees
it there with a lock, and gets it back from THERM's Ask; finds every private
thing from Home's Only me link.

## Calls made in building (the founder checks these on the desktop)

1. Capture's picker holds projects, "No project" and "Organization". The
   "Only me" lock applies to a project choice; "No project" is always only
   you; "Organization" is everyone and takes no lock. This keeps today's three
   choices and adds the new one.
2. Jira and Confluence items lose their lock everywhere. ECHO reads them with
   your own access, so the lock said nothing (every one carried it).
3. A question appears once: an Ask again keeps only its newest copy on the
   thread, and an opened line is its own heading.
4. A table's caption shows only when the table opens the answer.
5. "Nothing changed since …" is gone in both places it showed. Only "Changed
   since …" shows, and only when something changed.
6. The live line's steps move into the footer's opened area after the answer
   lands ("3 sources · 20s ›" opens the sources, then what Ask looked through).
7. The Only me list has no per-row lock (everything in it is only yours); a
   filed row names its project.

Not in scope: how the writer words answers (a lead that repeats the question,
long identifiers). That is server prompt work, separate from this page.

## Behavior

### The answer, quieter

- The Ask column is 720px wide (it was 1120px), so lines are short enough to
  read.
- The question is the turn's heading: 15px, weight 600. The answer's first
  sentence is the same size as the rest (15px, regular); it was 18px.
- Turns sit 48px apart; inside a turn, 10px. No borders.
- No number boxes or locks inline. Pointing at a sentence (or a table row, a
  bullet, a "Changed since" item) lights it and shows its source numbers; a
  number still opens the source pane. Tab reaches each number and shows it.
- Under each answer, one quiet line: "3 sources · 20s ›". The count opens the
  source list; the time shows only for an answer asked in this Ask that took
  long enough to show its work, and its steps follow the sources when opened.
  An answer with no sources but a receipt reads "Looked through 68 · 41s ›".
  The source list shows each source's name and kind; a lock only on what ECHO
  keeps for you alone.
- Copy answer shows on the right of that line when the pointer is on the turn
  or focus is in it. Ask again shows there always on a turn asked before this
  Ask.
- "Changed since 1:19 AM" (signal colour) heads the changed items of an Ask
  again, and heads an old answer whose sources changed (its changed sentences
  lit as today). Nothing is said when nothing changed.
- A table's caption shows only when the table opens the answer.

### One thread per place

- The timeline store is unchanged: one per account per computer (ADR-0047).
  What Ask shows is the thread of the bar's scope: from Home (all context),
  every turn; from a project, only that project's turns.
- Clearing the chip (×) moves Ask to Home's thread, as it widens the scope.
- The latest turn of the thread shows in full when Ask opens; a follow-up
  continues the thread's latest (within the hour) or the turn opened.
- Opening Ask checks the newest ten turns of its thread.
- The empty bar's suggestions are the thread's questions: Home's are all of
  them, a project's only its own.
- A turn that a later turn asked again (Ask again), or one whose question a
  later turn of the same thread repeats word for word, folds away; the newest
  stands for it. Stored turns are not deleted.

### Mine goes, Only me is a link on Home

- The sidebar loses Mine: Home, Capture, Follow-ups, then Projects.
- Home's footer line reads "Follow-ups · Only me · checked …". Only me opens
  the list of everything only you can read: notes, files and approved meeting
  records whose only reader is you, filed in a project or not, newest first.
  A filed row names its project; no row carries a lock. Its bar is Home's
  bar (all context). Capture from it starts as "No project".
- A save that only you can read says "Saved for you" (no project) or "Saved
  to THERM · only you"; the toast opens the Only me list on it.
- The bar has no Mine scope any more. Older turns asked in Mine stay on Home's
  thread.

### Capture: a project, and a lock

- One row under the note: the place button ("THERM ▾", "THERM +1", "No
  project", "Organization") and the "Only me" lock toggle.
- The place list: your projects (tick one to twenty), then "No project" and
  "Organization".
- A project chosen: the lock is off by default; on, only you can read it and
  it is filed in the projects ticked. "No project": the lock shows on and
  cannot be turned off. "Organization": everyone can read it, no lock.
- Opened from a project page: that project, unlocked. From Home or Only me:
  "No project".

### A project page

- A locked item filed in the project shows in its list, with the lock, only
  for its owner. Every other member never sees it, in the list, search or
  Ask.

### Meeting review

- Each item's route chip keeps Not kept / Only me / projects, and a project
  choice gains the same "Only me" lock: the item is filed in those projects
  and only you can read it.

## Architecture

What the server already does, verified at aa79d90:

- A note or document may carry an `only_me` audience and 0 to 20 association
  projects at once. The Authority checks only that each project is a current,
  active grant of the uploader (`project-context-v1.ts`, `document-v1.ts`).
  The desktop already sends an association with every capture
  (`filedIn`), so "only me, filed in THERM" is saved today from a project page.
- The person list, project search and project-scoped Ask admit a note or
  document by its audience first (`person-original-access-v1.ts`), then filter
  by association: the owner sees their locked item in the project; every other
  member never does.
- An approved meeting record cannot: a record's audience must equal its
  association (`approval-decision-record-input-v2.ts`), the record log refuses
  an association without a project audience (record log V5 trigger), and an
  Only me record therefore never reaches a project.

So this work is two pieces:

1. **This change (no schema change):** the quieter page, one thread per place,
   Mine replaced by the Only me link and list, Capture's place and lock, and a
   person list scope for Only me.
2. **Meeting items kept private inside a project (stacked, needs a fresh-state
   reset):** a private route on an approval, records whose audience is the
   approver and whose association is the projects, and a record log V6 baseline.
   It ships only when the founder accepts the staging reset.

## Contracts

### C1. Person list, Only me scope

- `POST /v1/person/list` takes `only_me: true`, exclusive with `project_id`
  and `mine` (each request names at most one). The response's `scope` is
  `{ "kind": "only_me" }`, a list-only scope; Ask's scope type is unchanged.
- Rows: every item the caller can read whose only reader is the caller, filed
  or not, newest first, 25 a page, with the same cursor rules:
  - notes and documents whose audience is `only_me` and whose membership and
    principal are the caller's, whatever their association;
  - approved meeting records under the restricted reviewer policy (the
    admission already limits them to their approver);
  - imported meetings in the caller's custody, as the mine scope lists them.
- Each row keeps `visibility` and `projects` (association, named from the
  caller's current projects), so a filed row names its project.
- The person client gains `person list --only-me`, exclusive with `--project`
  and `--mine`; the desktop host passes it for the Only me page.
- `mine` stays for the CLI. The desktop no longer sends it, for the list or for
  Ask.

### C2. Capture

No contract change. The desktop sends:

| Place chosen | Lock | audience | association |
| --- | --- | --- | --- |
| projects P | off | `project` / `projects` P | P |
| projects P | on | `only-me` | P |
| No project | always on | `only-me` | none |
| Organization | none | `team` | none |

A capture opened from a project page starts on that project, unlocked; from
Home or Only me, on "No project". The toast says "Saved to THERM", "Saved to
THERM · only you", "Saved for you" or "Shared with your organization". "Saved
for you" opens the Only me list on it, as it opened Mine; the others open
nothing, as before.

### C3. Desktop Ask (renderer only)

- `threadOf(turns, scope)`: Home's (global, and Mine's older turns) is every
  turn; a project's is its own. `visibleTurns` folds away a turn asked again
  (`again_of`) or repeated word for word later in the same place.
- Ask's `latest`, the follow-up's turn, the opening check and the pane's
  default turn read the thread of the bar's scope (`askThread`).
- The page: the answer's numbers are faint footnote digits with no box; locks
  only on source rows and never for a live tool's item; one footer line per
  answer (`sources-toggle`), Ask again and Copy answer in it; "Changed since"
  (`changed-since`) only when something changed; a table's caption only when
  it opens the answer.

### C4. Meeting items kept private inside a project (stacked change)

- A route may carry `private: true`, only with 1 to 20 projects. Kept items
  group by (private, project set); a private group's record has the restricted
  reviewer policy, an empty project audience and the projects as its
  association; its approval id hashes `private: true` in, so it never collides
  with the plain Only me group. It keeps quotes, as Only me does.
- The record log V6 baseline lets a restricted record carry associations
  (replacing the V5 trigger), and retrieval admits it to the approver alone,
  then filters it by association as any record. Fresh state only.
- Receipts and record refs carry `private`; Slack's closed card says "only
  you" for a private group; the desktop route chip gains the lock on a
  project choice.

## Known limits

- A project's search of documents is unchanged: the desktop's project search
  covers notes, as before.
- Imported meetings in the Only me list keep their custody titles until their
  review state is joined in (separate work).
- The writer still words answers as before (separate work).
