# Ask progress and internal links v1

Date: 2026-10-16. Status: approved by the founder for build on 2026-10-16; the founder validates the finished result.

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

Today Ask cannot see follow-ups at all. They become one more Ask source:

- **Searchable** by words, and listable by owner and status, so "my open
  tasks" works. That question failed in the traces because ticket lists carry
  no assignee.
- **Same visibility as Home.** A person sees a follow-up when they are in its
  decision's audience or are its owner, and words that came from Jira or
  Confluence still pass through their own live access to that tool
  (ADR-0033).
- **What Ask reads:** title, owner, status, due date, the latest check and its
  decision. It is cited like any other item and opens the item page.
- **What word search matches.** Search matches only text ECHO holds: the
  decision's title and first line, the expected phrase, the item's pointer (a
  ticket key such as THERM-48), and the owner. Only the hits are then
  live-read, for their current titles. That keeps each search to a few tool
  requests, within the per-Ask caps. A follow-up whose only matching words are
  inside a Jira or Confluence title is found by its key, its owner or its
  decision, not by those title words.

Meeting decisions and actions are already searchable through approved
records. They only need the precise link above.

## How it works (for the builder)

1. **Progress signals in the research run.** Add a lean progress callback to
   the Ask run. Do not reuse the diagnostics observer: that observer replaces
   a person's capture sink and copies full prompts. The callback emits:
   - the current stage, from the existing lifecycle stages and model-call
     hooks;
   - each read's source kind and released-item count, from the loop's
     existing content-free read coverage;
   - the names of items that just passed the access check before the next
     model call (the `before_call` point). Each name uses the same projection
     as a citation: kind, label and open reference.
2. **Authority.** Serve a streaming variant of the live Ask route (`/v5`),
   opt-in by request header, so older clients get today's response
   unchanged. Each event is one line. The last event carries the released
   answer, plus the receipt list rebuilt from items that passed the final
   check. Errors after the stream starts arrive as a final error event. A
   disconnect still cancels the Ask. The 90-second research deadline is
   unchanged.
3. **Proxy check first.** The chain is Cloudflare tunnel, then Caddy, then
   Node. It has never carried a streamed response. Verify on staging that
   events arrive without buffering; Caddy may need its flush setting. If
   buffering can't be avoided, fall back to start-then-read: the Ask starts
   and returns an id, the client reads progress every second, then fetches
   the answer. Either way the screen looks the same.
4. **Person client.** `ask --progress` prints each progress event as its own
   JSON line, and the final line keeps today's shape. Without the flag,
   output is unchanged, so scripts and eval tools are unaffected.
5. **Desktop.** The host already reads the client's output line by line,
   which is how sign-in reports its phases. Forward progress lines as a new
   notice to the renderer:
   - drop events from an earlier Ask or another account;
   - render the live line and up to three rows;
   - announce a step to screen readers at most every few seconds, with the
     timer hidden from them;
   - replace the live rows with the audited receipt when the answer arrives;
   - keep the open reference and item id that the desktop drops today.
6. **Follow-up source.** A new evidence source over open items. It reuses
   the open-items visibility path and its live-tool reads. It returns the
   fields listed above, with an open reference to the item page, and it is
   checked and audited like the other sources.

## Safety

Names on screen before the final check are a new way for item content to leave
the Authority. INV-PERMISSIONS-015 requires an accepted ADR, wider enforcement
and negative disclosure tests for that. This work adds ADR-0039 and amends the
invariant. The rules:

- **Names only after the check.** A name is sent only after the access check
  before the next model call has passed for that item. At that moment the
  person could open the item themselves. In code, this is the point where an
  item is marked as read in full.
- **Audit.** Every item is already audited when the evidence desk releases it,
  before any of its bytes leave the Authority, so naming it adds no new
  unaudited item. The one end-of-request audit record also lists which
  released items were named on screen. It uses the same content-free citation
  commitments as today, never labels, and it does this on cancelled and
  timed-out runs too. There is no extra durable write per step.
- **Counts only of what this person may see.** Never hidden counts
  (ADR-0012).
- **Never send** notes, needs, plans, model-written queries, Jira queries,
  bodies or excerpts while the Ask is running.
- **Nothing kept from a failed run.** Cancel, timeout or a refused final
  check sends no further names, and the desktop removes what it showed. The
  receipt that stays on screen comes only from the audited final response.
- **Accepted trade-off:** an item revoked after its check, but before the
  final check, may have its name on screen for the rest of that run. It
  never reaches the answer or the receipt.
- **Negative tests:**
  - a revoked item is never named after its revocation is seen;
  - no hidden count is ever sent;
  - no note, query or body is ever sent;
  - cancel emits nothing further;
  - a refused answer leaves no receipt;
  - events from another account are dropped.

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

## Compatibility and order

- **Old clients** keep calling the current route and see the spinner as today.
- **A new desktop on an old Authority** gets no progress events and falls
  back to the spinner.
- **Ship order:**
  - PR 1, the Authority, client and desktop changes for progress and links;
  - PR 2, follow-ups as an Ask source.
- **Deploy the Authority first.**

## Calls made in this document (not founder decisions)

- streaming first, with start-then-read as the fallback;
- the 3-second threshold;
- three live rows;
- trailing names, rather than a separate check per name;
- what counts as read and found;
- naming recorded in the one end-of-request audit, not per step;
- transcripts open their meeting;
- the full-page "Open" button is hidden while Ask runs;
- the receipt is rebuilt from the audited response;
- follow-ups searchable with Home's visibility, matching ECHO-held text only;
- two PRs.

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
