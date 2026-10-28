# Ask timeline v1: history that says what changed, follow-ups, and project dots

Date: 2026-10-25. Status: shipped in #365 (aa79d90); shipped is not deployed
or qualified, and the founder validates the result on the desktop. Decision
record: [ADR-0047](../decisions/ADR-0047-ask-timeline.md).
Design canvas: "Ask timeline" (clickable prototype and five state boards).
[Quieter Ask v1](2026-10-26-quieter-ask-and-only-me-v1.md) (#368) later
showed one thread per place, made the question a 15px, weight 600 heading,
dropped "Nothing changed since …" from the page, and folds away a turn asked
again. [ADR-0048](../decisions/ADR-0048-retire-older-person-routes.md) made a
404 from C2's read `not_found`.

## What the founder asked for

Ask was one question and one answer. Leaving the page threw the thread away,
and nothing carried over to the next question. That was deliberate: the
context underneath changes quickly, and a stale answer is more dangerous than
no answer. The founder asked for history that keeps that rule:

- Keep every question and answer, but an old answer never sits there looking
  current. It always says whether what it was based on has changed.
- One continuous conversation with a colleague who remembers, not a list of
  sessions to open one by one. History must not take over the screen or push
  the existing tools aside.
- A question can follow from the answer before it ("what are the details on
  that ticket?").
- Every action takes two or three steps at most. No layers of UI, few words.
- Home stays what needs you. Projects show a dot when something new arrived.

Success: the founder asks a question, leaves, comes back days later, sees
which old answers changed, reopens one in one tap, asks it again in one more
and reads what changed first; asks a follow-up in the same bar and gets the
right ticket without naming it; sees which projects have news from the
sidebar.

## Behavior

### The timeline

- One timeline per person per device, across pages and days. There are no
  sessions. It opens over the page like Ask does today; Back or Escape
  returns to the page, and the timeline stays.
- The latest turn and the turns asked since Ask was opened show in full.
  Every earlier turn folds to one line: the project's identity square (none
  for all context or Mine), the full question, a "Changed" tag only when a
  source it cited changed, and the date. Nothing else is labelled.
- A quiet "Today" divider sits above the first of today's turns when there are
  earlier ones.
- The question reads as the asker's message: 15px, medium weight, the same
  size as the answer text. There is no "Asked as" line, no date or scope line
  under each question, and no divider between turns.
- Answers render as today (ADR-0045 layout, citations, collapsed sources),
  without the coverage note, without the assumption and off-scope banners
  (no current path produces them) and without "Try again" on a successful
  answer. A failed Ask keeps its Try again. "Nothing in <project> matched"
  with "Ask across everything you can see" stays.

### Opening an old answer, and Ask again

- Tapping a folded row opens the answer as it was, dimmed. Sentences that cite
  a source that changed are highlighted, and a line says "Highlighted parts
  changed since Oct 14". When nothing changed it says "Nothing changed since
  Oct 20". A sentence that cites a source the person can no longer read is
  simply left out, with no note. When every sentence is left out, only Ask
  again shows.
- Ask again (one tap) asks the same full question in the same scope. The new
  answer lands at the bottom and opens with "Since Oct 14" and a short list
  of what is different, each item cited. When nothing material changed it
  says "Nothing changed since Oct 14". The old row stays where it was, without
  its tag.
- The empty bar's suggestions list the person's recent questions from the
  timeline (newest first, in the bar's scope) before the meeting and week
  suggestions it shows today. Choosing one opens the timeline at that turn,
  opened, instead of asking again. So revisiting an answer is: bar, question,
  and Ask again if it changed.

### Follow-ups

- Typing in the bar while Ask is open continues the conversation. The
  previous turn is the opened earlier turn when one is open, otherwise the
  latest turn when it was asked in the last 60 minutes. Otherwise the
  question is asked on its own.
- ECHO works out what "it" or "that ticket" means from the previous question
  and answer. When exactly one thing fits, it answers at once, starting from
  that source. When more than one fits, the turn says "Which one?" with one
  button per candidate; tapping one asks that candidate's full question. It
  never guesses.
- The answer names its subject in its own words ("Dev owns THERM-482, since
  Oct 21"). The timeline keeps the full question the answer answered, so a
  folded follow-up reads "Who owns THERM-482?", not "who owns it?", and Ask
  again works on it later.

### Project dots

- A project in the sidebar shows a small signal dot when something new arrived
  since the person last opened it: a meeting record approved into it, a note
  or document added to it, or a follow-up of its meetings that changed owner,
  status or was sent, each by someone else and readable by the person. Live
  Jira and Confluence edits do not count.
- Opening the project clears its dot. Its rows that arrived since the previous
  visit show a quiet "New" tag for that visit.
- Home does not change. Nothing about answers appears on Home or on a project
  page.

## Architecture

- **The timeline is device-only.** The desktop host keeps it in one file per
  account next to the person session, owner-only. The Authority stores no Ask
  content, as before. Our own sign-out and an account change delete the file;
  a session that merely expired keeps it.
- **What changed is a cheap check, not a re-run.** One new Person read takes the
  sources an old answer cited and returns, per source, `same`, `changed`,
  `unreadable` or `unknown`. No model call, no content returned, nothing
  stored. The desktop runs it when Ask opens, for the last ten turns, and caches
  the result for five minutes.
- **The previous turn rides on the Ask request.** An optional `previous` on the
  existing request carries the earlier question and the sentences the person
  can still read. It is the asker's own context, like the question: never
  evidence, never stored. A follow-up adds one small model call that resolves
  what the question refers to, or asks which one; Ask again lets the writer add
  the "since" list. A request without `previous` is byte for byte what it is
  today.
- **Project activity is one more cheap read**, polled with the existing change
  check, computed only from rows the person can read.

## Contracts

All new and changed contracts live in `packages/organization-api`. Every
validator uses exact keys, as the package does. Times are ISO-8601 UTC with
milliseconds, as elsewhere.

### C1. Ask source check: `POST /v1/person/ask/check`

Request, at most 64 KiB:

```ts
interface PersonAskCheckRequestV1 {
  readonly schema_version: 1;
  readonly kind: 'echo-person-ask-check-request-v1';
  /** 1 to 100, in the order the response answers them. */
  readonly items: readonly {
    /** When the turn whose answer cited this source was asked. */
    readonly asked_at: string;
    /** The evidence citation exactly as the answer's `citations[i].citation` carried it. */
    readonly citation: PersonAnswerEvidenceCitationV8;
    /** Only for a ticket: the marker an earlier check returned for it. */
    readonly marker?: string;
  }[];
}
```

Response:

```ts
interface PersonAskCheckV1 {
  readonly schema_version: 1;
  readonly kind: 'echo-person-ask-check-v1';
  /** Same length and order as the request's items. */
  readonly items: readonly {
    readonly state: 'same' | 'changed' | 'unreadable' | 'unknown';
    /** Only for a readable ticket: its current marker. */
    readonly marker?: string;
  }[];
}
```

Only these citation kinds are accepted; any other kind is `invalid_request`:

| Kind | Readable when | Changed when |
|---|---|---|
| `approved_record` | the Layer-1 exact read with current grants returns it (`readableDecisions`); no search generation | never: records are immutable |
| `source_revision` | the batch original ACL and scope filter pass (`personOriginalAclV1`, `personOriginalScopeFilterV1`), read without writing audit rows or throwing | a newer readable revision of the same `source_id` exists (imported and pasted meetings); notes and documents never change |
| `follow_up` | `SqliteImpactItemsV1.read` then `assessOpenItemsV1` grants `see_row` | the latest of `owner_set_at`, `state_set_at`, `sent_at` is after `asked_at` |
| `ticket` | the caller's own Jira connection for `tool_id` returns it in a bulk fetch by `ticket_id` | its marker differs from the request's `marker` |
| `page` | the caller's own Confluence connection for `tool_id` returns it in a metadata read by id | its `version` differs and either the citation's `text_sha256` is the empty-text hash or the cited section's text hash no longer matches |

- **Readability first.** `changed` and a marker are only ever returned for a
  source the caller can read now, so the check reveals nothing that opening
  the source would not. `unreadable` covers hidden, deleted, out of scope and
  never existed, and never says which (ADR-0012, ADR-0036).
- **Ticket marker:** `sha256:` and the hex SHA-256 of the canonical JSON of
  the ticket's summary, description, status name, assignee display name and
  due date, as the Jira reader parses them (`parseJiraIssueV1`). A readable
  ticket without a request marker returns `same` and its current marker (the
  desktop's baseline). Jira's `updated` is not used: it moves on every
  comment.
- **`unknown`** for a source whose tool is not connected or failed, or that
  exceeds the request's budget: at most two metadata calls per tool (batches
  of 50) and ten Confluence page bodies per request, and 15 seconds overall.
- No audit row and no write lock, like the change check (ADR-0036); content-free
  observability events only. Same session, membership and access errors as
  other Person reads.
- **Person client:** `person ask-check --request=<json>` validates the request,
  posts it and prints the validated response as the last line of stdout. A 404
  is `not_supported`.

### C2. Project activity: `GET /v1/person/project-activity`

```ts
interface PersonProjectActivityV1 {
  readonly schema_version: 1;
  readonly kind: 'echo-person-project-activity-v1';
  /** Every active project the caller is a member of, at most 500. */
  readonly items: readonly {
    readonly project_id: ProjectIdV1;
    /** The newest time something arrived from someone else that the caller can read, or null. */
    readonly latest_at: string | null;
  }[];
}
```

- `latest_at` is the newest of: a note associated with the project
  (`associated_at`, associator not the caller); a document associated with
  it (`associated_at`, associating receipt not the caller's); a meeting
  record associated with it (`receipt_issued_at`, approver not the caller);
  and a follow-up of the project's records whose owner, state or sent time
  moved (`owner_set_at`, `state_set_at`, `sent_at`, set by someone other than
  the caller). Each counts only when the caller can read the row.
- No query or body. No audit row, no write lock (one deferred read
  transaction). Never derived from authorization-state revisions or anything
  that moves with activity the caller cannot see.
- **Person client:** `person project-activity` prints the validated response as
  the last line. A 404 is `not_supported`.

### C3. The previous turn on Ask

`PersonAnswerRequestV3` gains one optional field, validated with exact keys.
The whole body stays within the existing 16 KiB bound:

```ts
interface PersonAnswerPreviousV1 {
  readonly purpose: 'follow_up' | 'ask_again';
  /** The earlier turn's full question, within the question bound. */
  readonly question: string;
  readonly asked_at: string;
  /** 0 to 8 sentences of the earlier answer the asker can still read, each at most 400 characters. */
  readonly statements: readonly { readonly text: string; readonly citation_indexes: readonly number[] }[];
  /** 0 to 12 of the earlier answer's citations, as its response carried them; statements index into these (at most 4 each). */
  readonly citations: readonly PersonAnswerCitationV8[];
}
```

- `previous` is accepted on `/v7/person/ask`, Ask's one route, plain and
  streamed, whose answers are V8. It is the asker's own context: the server
  neither verifies nor stores it, and it never becomes evidence.
- **`follow_up`:** before research, one resolver call (role `answer`, span
  `ask_resolve`, through the existing model gate) reads the previous question,
  the numbered statements with their sources' labels, and the new question.
  It returns one of:
  - `same`: the question stands alone. Research runs on it unchanged.
  - `resolved`: a full question and the previous citations it is about.
    Research runs on the full question and starts from those citations
    (`brief.starting`, `if_unreadable: 'skip'`, openable kinds only:
    approved records, source revisions, tickets, pages). A citation that
    cannot be read is reported, as `report` does. One whose tool cannot be
    read for now (`unavailable`, `rate_limited`, `quota_exceeded`) is
    skipped: research goes on without it, and neither the planner nor the
    writer is told. Anything else still fails the Ask: a cancel, the
    deadline, `stale_access_state`, and any other error.
  - `clarify`: 2 to 4 choices, each a label (at most 60 characters) and a
    full question (at most 240 characters, the Ask question rule). No
    research runs.

  A resolver that fails after one repair counts as `same`. It must never pick
  one of several plausible referents.
- **`ask_again`:** the request's question must equal `previous.question`;
  a request whose question differs is refused with `invalid_request`.
  Research runs on the question as usual. The writer also
  receives the earlier statements with their date and returns `since`: 0 to 6
  sentences, each citing current evidence, saying what is different now. A
  `since` sentence without a valid current citation is dropped. No new
  sentence repeats an unchanged fact.
- **Response**, only when the request carried `previous`:
  - `question`: the full question the answer answers. For `same` it is the
    question as asked; for `ask_again` the earlier question.
  - `since: { statements: PersonAnswerStatementV4[] }` for `ask_again`, with
    citation indexes into the response's citations.
  - Outcome `clarify` with `choices: { label, question }[]`, `parts: []` and
    `citations: []`.
- A request without `previous` gets byte-for-byte the prompts, schemas and
  responses of today, so the quality baselines and golden fingerprints do not
  move.
- Audits record `clarify` as an outcome and the resolver as a generation.
  Observability adds the `ask_resolve` span and the `clarify` outcome.
- **Person client:** `person ask … --previous=<json>` validates it and sends
  it to `/v7`, the only route `person ask` asks.

### C4. Removed from the contract

No current path produces them. Only the A1 pipeline did, from `298ebfd`
(2026-09-27) to `e0b6980` (2026-09-28), and nothing re-reads stored audit
outcomes:

- `assumption` on Ask responses (V4 to V8 validators, the kernel's
  pass-through, the person client's validator, the desktop).
- The `off_scope` outcome (outcome enums, observation vocabulary, audit
  outcome list, journey metrics, the staging journey test, the desktop and its
  fake Authority).

`notice` and `gap` stay in the contract (the person client prints them, and
the evals read them); the desktop no longer shows them.

### C5. Desktop

Host RPCs added to `product/echo-desktop/src/shared/protocol.ts`:

```ts
'timeline.read': { params: { expect: Expect }; result: { turns: TimelineTurn[] } };
'timeline.put': { params: { expect: Expect; turn: TimelineTurn }; result: Record<string, never> };
'ask.check': { params: { expect: Expect; items: AskCheckItem[] }; result: { items: AskCheckResult[] } };
'projects.activity': { params: { expect: Expect }; result: { items: { project_id: string; latest_at: string | null }[] } };
// 'ask.run' params gain `previous?: AskPrevious`.
```

```ts
interface TimelineTurn {
  readonly id: string;
  readonly asked_at: string;
  /** What the person typed: shown while the turn is in full. */
  readonly text: string;
  /** The full question the answer answers: shown when folded, and what Ask again asks. */
  readonly question: string;
  readonly scope: AskScope;
  /** As the host built it; each checkable source keeps its raw evidence citation (`check`). */
  readonly answer: Answer;
  readonly since?: readonly AnswerStatement[];
  /** The turn this one asked again. */
  readonly again_of?: string;
  /** Ticket baseline markers by source index. */
  readonly markers?: Readonly<Record<string, string>>;
}
```

- **File:** `<person data dir>/ask-timeline-v1/<hex sha256 of "<authority> <membership_id>">.json`,
  holding `{ "schema_version": 1, "kind": "echo-desktop-ask-timeline-v1", "turns": [...] }`.
  Directory 0700, file 0600, atomic write (temp file, then rename). It keeps
  at most 200 turns and drops turns older than 90 days on every put. Host
  logout deletes the signed-out account's file. An unreadable or malformed
  file reads as empty and is replaced on the next put.
- **Checks:** opening Ask checks the checkable sources of the last ten turns in
  one `ask.check` (at most 100 items, deduplicated per turn), caches results
  for five minutes and fails quiet: no tags, and the next opening checks
  again. After a new answer is stored, its
  tickets get a baseline check and their markers are saved with `timeline.put`.
  A turn shows Changed when any cited source is `changed`. A statement is
  highlighted when any of its citations changed, and left out when any is
  `unreadable`. A turn asked again later shows no tag.
- **Previous:** built from the previous turn's statements whose citations are
  all readable, trimmed from the end until the body fits 16 KiB. An Ask
  refused with it fails as any Ask does, with Try again; the desktop never asks
  again without it.
- **Activity:** each freshness tick also reads `projects.activity`. Last-opened
  times live in renderer localStorage per account
  (`echo.projectSeen.<account hash>`). A project seen for the first time is
  marked seen now (no dot). A read that fails, `not_supported` included, is
  quiet: it lights no dot, leaves the others, and the next check reads again.
- **Removed:** `EarlierTurn`, `MAX_EARLIER`, `earlierTurns`, the in-memory
  `askedQuestions`, `CoverageNote` and the Markdown coverage note, the
  assumption and off-scope banners, Try again on a successful answer, and their
  CSS and tests.

## Follow-up resolution eval (pre-registered)

Written before any run. Cases live in `tools/evals/ask-follow-up/cases.json`.
Each has a previous turn (question, statements, labelled sources), a new
question and an expectation. Grading is deterministic: no model judge. Three
trials per case with the product's model route (ADR-0037).

| Group | Cases | Expectation |
|---|---|---|
| One referent | 10 | `resolved`, `about` contains the expected source, and the question names it |
| Several referents | 10 | `clarify`, and the choices cover the candidates |
| Unrelated new question | 5 | `same`, or `resolved` with the question unchanged in meaning (grader: expected terms) |
| Already standalone follow-up | 5 | `same` or `resolved` naming the same subject |

Rules:

1. **Never guess:** every trial of every "several referents" case returns
   `clarify`. One guess fails the rule.
2. **Resolve the obvious:** at least 90% of "one referent" trials pass.
3. **Leave unrelated questions alone:** at least 90% of "unrelated" and
   "already standalone" trials pass.
4. **Do not over-ask:** at most 10% of "one referent", "unrelated" and
   "already standalone" trials return `clarify`.

If rule 1 or 2 fails, follow-ups ship switched off: the desktop sends
`previous` only for Ask again, and the result goes to the founder. Rules 3 and
4 failing is reported and judged by the founder.

A trial whose resolver fell back (no usable reply after one repair, so the
product left the question as asked, as `same`) fails, in every group. The
grader first counted a fallback as `same`, a pass for an unrelated or already
standalone case; it was corrected after the run below.

**Result, 2026-10-26T00:44Z** (source `cffe227`, cases
`sha256:0ee0b552…47be94`, the product route `anthropic/claude-sonnet-5.5`
through OpenRouter): all four rules passed, and follow-ups ship. 90 of 90
trials passed. Several-referent cases asked "Which one?" in 30 of 30 trials,
one-referent cases resolved in 30 of 30, unrelated and standalone questions
were left alone in 30 of 30, and no trial outside the several-referent group
asked back. There were no fallbacks and no repairs, so the corrected grader
gives the same result, and it stands. The resolver's time was
1.1 s at the median and 2.6 s at p95, using 142,504 tokens in all. The report
is private, outside the repository.

## Release and compatibility

- Server first. The Authority with C1 to C4 must be live before a desktop that
  uses them reaches anyone. The desktop does not retry an Ask without
  `previous`, and a failed check or activity read stays quiet (no tags, no
  dots).
- Ask routes before `/v7` are retired (ADR-0047): no Authority serves only
  them, and clients older than the 2026-10-22 release update from the feed.
  The desktop and `person ask` ask `/v7` alone, streamed in progress V3; an
  Authority without it fails the Ask as `not_supported`.
- The desktop always sends the existing headers; nothing new is header-gated.
- Removing `assumption` and `off_scope` changes no response anyone receives
  now: no current path produces them (only the A1 pipeline did, from
  `298ebfd` on 2026-09-27 to `e0b6980` on 2026-09-28), and nothing re-reads
  stored audit outcomes.

## Known limits

- The check sees changes to what an answer cited, not new things it never saw.
  Ask again finds those; project dots point at them.
- A ticket that changed between research and the baseline check (seconds) is
  not flagged.
- Approved records never count as changed; a later decision is a new record.
- A note filed into a project long after it was written keeps its original
  date on the project page, so its "New" tag may not show even though it lit
  the dot.
- Project activity looks only at each project's newest 500 filed meeting
  records: an older record, or a follow-up of one, never lights the dot. A
  project whose newest 500 records are all the person's own approvals (or
  all records they cannot read) has no meeting time, however many it holds.
- The timeline lives on one device. A second Mac starts empty.

## Build tracks

| Track | Owns | Notes |
|---|---|---|
| A. Source check | C1: `person-ask-check-v1` contract, Authority route and composition, Jira and Confluence connection methods, batch readability reads, person client `ask-check`, tests, the route row in `docs/components/permissions.md` | Live reads go through the caller's own connections |
| B. Project activity | C2: contract, route, read model, person client `project-activity`, tests, route row | Readability through the same grants as the project list |
| C. Ask | C3 and C4 in the API, kernel, Authority and person client; the eval harness and its offline tests | Requests without `previous` must not move any baseline |
| D. Desktop | C5 and everything under `product/echo-desktop`, its README and its fake Authority | Codes against C1 to C4 as written here |

Shared files (`packages/organization-api/src/index.ts`, the HTTP server's route
list, `organization-authority-api-runtime.ts`, the person client's
`authority-client.ts`, `client.ts` and `commands.ts`, and `permissions.md`)
take additive edits only; the integration owner merges them.
