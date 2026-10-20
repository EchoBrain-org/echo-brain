# Ask progress: the quiet line v1

Date: 2026-10-19. Status: approved by the founder for build on 2026-10-19,
after a mockup that compared the shipped live rows with this design.

This changes only "While Ask works" and "When the answer arrives" in
[Ask progress and internal links v1](2026-10-16-ask-progress-and-internal-links-v1.md).
What counts as read, when a name may show, what is never shown, links, safety
and the Authority's progress stream are unchanged
([ADR-0039](../decisions/ADR-0039-ask-progress-names-after-the-access-check.md)).

## Why

The founder found the shipped progress too noisy by default. After three
seconds Ask showed three pulsing dots, the stage and the timer, and under them
up to three rows that appeared, folded away and changed every few seconds.
Every name in them was an accent-coloured link, and the thread scrolled to
follow each new row. That is three or four moving lines for a wait of 40 to
120 seconds. The founder wants Ask to look like Claude: clearly working, with
the detail there for anyone who opens it.

## What the person sees

**While Ask works.** There is one line, and it never changes height:

```
● Reading Tuesday sync and 3 more · 31s ›                     Cancel
```

- A pulsing dot and a shimmer that sweeps across the words show that Ask is
  working. With reduced motion turned on, neither animates.
- The words name the step now: "Thinking…" for the first three seconds and
  until the first step comes, then Searching, "Reading N items" until the
  names come, "Reading <first place> and N more" once they have, Checking
  access, and "Writing the answer". A place is named the way its row names it,
  so two decisions of one meeting count as one place.
- The timer and Cancel stay as they were.
- The line has no rows under it until the person opens it. A chevron shows
  once there is something to open.

**Opened.** The line opens onto every search and read so far, not only the
last three, and each read names every place it read. These are the rows the
receipt lists. Names still open beside Ask while it keeps running. Once the
line is open, each new row follows a person who is at the bottom of the
thread. Nothing scrolls while the line is closed.

**When the answer arrives.** The same line becomes the receipt in place:
`Looked through 14 items · 48s ›`. If the person opened the line while Ask
worked, the receipt stays open. Otherwise it is closed. The next question's
line starts closed.

**When there is no answer.** As before: a cancel, a timeout or a refused
answer removes the line and anything it opened.

## How it is built

The change is in the desktop renderer only. The Authority stream, the person
client and the host are unchanged.

- `progress.ts`: `headline()` builds the line's words from the reported steps.
  `liveRows()` returns every row. The three-row cap and the "+N" name cap are
  removed.
- `screens/ask.tsx`: `Asking` renders the one line and, when opened, the rows.
  `Receipt` is the same line in place. `AskView` keeps which Ask's line is
  open, keyed by the Ask's id, which the question on its way and its answer
  share.
- `styles.css`: the line, the pulse and the shimmer, with a reduced-motion
  fallback.

The headline says "Searching" without naming sources, because the stream
names a search's sources only when the search ends. Naming them earlier would
need a change to the progress events, and that is not part of this version.
