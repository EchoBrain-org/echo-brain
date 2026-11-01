# Ask: older questions behind one line, and Ask in the sidebar (v1)

Date: 2026-10-27. Status: building; the founder validates the result on the
desktop. Builds on [Ask timeline v1](../product/2026-10-25-ask-timeline-v1.md) and
[Quieter Ask v1](../product/2026-10-26-quieter-ask-and-only-me-v1.md). Design canvas:
"Quieter Ask", page "Ask history and the way back".

## What the founder asked for

On 2026-10-27, with twelve earlier questions above an answer on staging, the
founder said the previous questions get noisy when there are a lot: they
should be collapsed, leaving the last two or three. Switching pages also made
Ask disappear, and the only way back was the bar's suggestions, by clicking a
question asked before.

Both came from the timeline design: every earlier turn folds to its own line,
and Ask opens over the page with nothing in the sidebar leading back to it.

## Behavior

### The earlier questions

- Ask shows the newest three earlier questions as lines, as before. The older
  ones fold into one line above them, "9 earlier questions" ("1 earlier
  question" for one), with a chevron. No line shows for three or fewer.
- The line opens them in place, above the three, and folds them again. It
  starts folded each time Ask opens.
- A suggestion that opens one of the older questions opens the line, so the
  question shows where it is.
- Folding the line folds a question opened among them, so a follow-up never
  continues a question out of sight. For the same reason, × on a project's
  chip opens the line when Home's thread puts the opened question behind it.
- The questions the line opens are kept out of Ask's live region, so a screen
  reader does not read them all out.
- Today's line stays with the first of today's questions: folded away with it,
  and back in place when the line opens.

### Ask in the sidebar

- The sidebar gains Ask under Home: Home, Ask, Capture, Follow-ups, then
  Projects.
- Ask goes back to Ask where you left it: the thread of your latest question
  (Home's, or that project's while it is one of your active projects), with
  its answer at the bottom. If Ask is already open, it stays as it is.
- The page you are on stays under Ask when its bar already asks that thread
  (Home's pages, Tools, Follow-ups and People & invites ask Home's). On that
  project's own page with the bar widened, the bar narrows back. Otherwise
  Home or the project opens first.
- With nothing asked yet, it puts the cursor in the bar.
- Cancelling a question asked in an Ask opened this way keeps Ask open, as it
  does for any Ask that was open before the question.
- While Ask is open over any page, Ask is the sidebar's current row and the
  page under it is not.
- Back and Escape still return to the page, and the bar's suggestions still
  open a question at its turn.

## Not changed

- What Ask asks, checks or keeps: no host, Authority or contract change.
- How a line opens an old answer, "Changed", Ask again and follow-ups.

## Evidence

- Desktop unit tests: the folding rules in the store and on the page, Today's
  line, suggestions, and the sidebar's Ask (store and row).
- Desktop e2e tests: the line folding and opening in the real app and folding
  again on the next open; the sidebar's Ask going back to Home's Ask and to a
  project's Ask, and to the bar with nothing asked.
- The founder's validation on the desktop.
