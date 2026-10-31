# Ask progress and internal links v1

Date: 2026-10-16. Status: shipped in #330 (d2d03c6: progress and links) and
#331 (6d9e597: follow-ups as an Ask source).
[Ask progress: the quiet line v1](../archive/2026-10-19-ask-progress-quiet-line-v1.md)
(#338) later replaced what the person sees while Ask works and when the answer
arrives.

The founder decided on 2026-10-16:
- Direction B, "a line plus what it opened", chosen from a two-option mockup.
- Answers cite internal items in general, including follow-ups.
- Opened items show beside Ask, and Ask keeps running.

## Why

In desktop Ask a person sees three pulsing dots, "Thinking…" and a seconds
counter for up to about two minutes. The research loop is busy the whole time:
it searches, reads, checks access and writes. Staging traces from Oct 11–16 ran
7–74 s, plus binding and network. A silent wait that long reads as stuck.

The founder wants Ask to show a glimpse of what it is looking through, at a
high level and without noise, the way Claude, ChatGPT and coding agents do.
When an answer draws on something ECHO already holds (a follow-up, a meeting's
decision or action, or any other internal item), the person should be able
to open that thing directly.

Research on how those products do it is summarized at the end of this
document.

## What the person sees

**While Ask works.** The spinner row becomes one live line that changes only
when a real step changes, with the timer and Cancel kept. Under it are at most
three rows naming what ECHO searched and read:

```
●●● Reading · 31s                                             Cancel
  ✓ Searched meetings, follow-ups and Jira · 22 found
  ✓ Read THERM DVT recovery sync, THERM-48, THERM-46 +2
  ● Reading 3 more
```

- **Verbs:** Searching, Reading, Checking access, Writing. A row switches
  from present to past tense ("Searched", "Read") when its step finishes.
- **Searches name source kinds, never the words searched.** Source kinds
  are meetings, documents, follow-ups, Jira, Confluence and Slack.
- **Reads name items.** A name appears only once ECHO has checked that this
  person may open the item (see Safety), so names trail by about one step.
  Until a step's names are cleared, the row says how many items are being
  read.
- **What counts as read:** an item whose full text the research model has
  actually been given. That covers an item it opened, a search hit shown in
  full, or a starting item. Metadata-only list rows, related-ticket references
  and neighbours an open pulled along are not named.
- **What the counts mean:**
  - "N found" is the number of distinct items a search returned to this person.
  - The receipt's "Looked through N items" is the number of distinct items read.
  - Both come from ECHO's own record of reads, so they are honest by
    construction.
- **Repeated reads group into one row,** with "+N" for the overflow. With more
  than three rows, the oldest rows fold away, and the full list is in the
  receipt.
- **Every name is a link** that opens the item in its own place (see Links).
- **Short Asks show nothing extra.** Under about 3 seconds there is no live
  line and no receipt.

**When the answer arrives.** Everything folds into one dim receipt above the
answer: `Looked through 14 items · 48s ›`. Opening it shows the grouped rows
with links. The answer, its sentence markers and its source list look as they
do today, except that sources open the exact item.

**When there is no answer.** If the person cancels, the Ask times out, or the
final access check refuses the answer, the live rows and the receipt are
removed. The usual message or "Try again" shows. Names already on screen are
not kept anywhere.

**Never shown.** The model's thinking, notes, plans and needs. The search
terms the model wrote. Jira queries. Ids such as E5. Round numbers, model
names or tool internals. Status text is built only from what ECHO actually
ran, never written by the model.

## Links to internal items

Every citation and every receipt name opens one place, chosen by the kind of
item:

| Item | Opens |
|---|---|
| Approved meeting | The meeting in the reader (exists today) |
| A meeting's decision, action or rationale | The meeting in the reader, scrolled to that item and highlighted |
| Follow-up | The follow-up's item page, with owner and status (the page exists today) |
| Document, note, imported meeting notes | The reader (the reader exists; the desktop must stop dropping the reference it needs) |
| Transcript | The meeting it belongs to, because there is no transcript reader |
| Jira ticket, Confluence page, Slack message | The browser, through the existing checked link |

New kinds of internal items join this table by naming their opener. The
desktop keeps one mapping from item kind to opener, used both by citations
and by the receipt.

**Inside Ask, everything opens in the panel beside it, and Ask keeps
running.** This was the founder's decision on 2026-10-16. A name in the live
rows, a receipt row or a source in the answer opens in Ask's side panel, never
on a page that replaces Ask.
- **Meeting, decision or action:** the panel shows the meeting, scrolled to
  and highlighting the cited item.
- **Follow-up:** title, owner, status and latest check.
- **Document, note or imported notes:** the cited passages.
- **Transcript:** its meeting.
- **Jira, Confluence or Slack:** an "Open in …" button, as today.

Once the answer has arrived, the panel also shows an "Open" button that goes
to the item's full page from the table above. While Ask is still working,
that button is hidden, because leaving Ask cancels it.

A source row in the answer shows one short qualifier only where it helps. A
follow-up shows its owner and status, for example `Mara · Open`. Kind labels
are not shown on the default case.

## Follow-ups become something Ask can search

Ask could not see follow-ups. They became one more Ask source: searchable by
the words ECHO holds, listable by owner and status, and seen exactly as Home
shows them. [ADR-0040](../decisions/ADR-0040-follow-ups-as-ask-evidence.md)
owns the source as built (#331).

## Safety

A name shows only after the access check before the next model call has
passed for that item. The founder accepted one trade-off: an item revoked
after its check may keep its name on screen for the rest of that run, but
never reaches the answer or the receipt.
[ADR-0039](../decisions/ADR-0039-ask-progress-names-after-the-access-check.md)
owns these rules, the audit, the progress stream and its negative tests as
built (#330), with
[INV-PERMISSIONS-015](../invariants/INV-PERMISSIONS-015-layer-3-person-release-boundary.md).

## Non-goals and anti-goals

**Non-goals:**
- streaming the answer text, which the audit seals as one response;
- lifting the 90-second deadline;
- background Asks with notifications;
- a transcript reader;
- links to projects;
- links from outside the app;
- progress in Slack or for CLI users (the CLI can opt in later).

**Anti-goals:**
- a growing log;
- model-written status;
- anything that looks like a chat client's thinking panel;
- any name or count that reveals an item the person can't open.

## Research behind the direction

The details are in the 2026-10-16 research notes. Patterns the best products
share:
- one live line that changes at real steps;
- verb plus thing, with past tense when a step is done;
- reads grouped but names kept (users complained when Claude Code hid them);
- counts with "+N";
- a one-line receipt after the answer;
- detail that grows with the job.

None of them shows raw thinking or the model's search terms. Sources open the
original, with internal items opening inside the app.
