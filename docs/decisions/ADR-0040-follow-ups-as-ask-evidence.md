---
schema_version: 1
id: ADR-0040
kind: decision
title: Follow-ups are an Ask source, seen exactly as Home shows them
component_ids:
  - CMP-ORGANIZATION-AUTHORITY
  - CMP-PERMISSIONS
  - CMP-PERSON-CLIENT
created_at: 2026-10-16
reviewed_at: 2026-10-16
reviewed_ref: c9d77a23ebf60008a67702dc36176aeb9ab04ac3
status: accepted
supersedes: []
superseded_by: []
updates:
  - ADR-0033
---

# ADR-0040: Follow-ups are an Ask source, seen exactly as Home shows them

The founder approved this direction on 2026-10-16, in the design "Ask progress
and internal links v1" (section "Follow-ups become something Ask can search"),
and validates the built result. The answer version, route, names and bounds
below are build calls within that design. Acceptance does not mean the change
is deployed or qualified.

## Context and options

Ask cannot see follow-ups, the shared open items of
[ADR-0033](ADR-0033-shared-open-items.md). In the staging traces of
2026-10-11 to 2026-10-16, "help me understand all my open tasks" paged an
unfiltered Jira inventory five times and still could not answer, because
ticket rows carry no assignee. ECHO already knows who owns each follow-up,
its state and its latest check; Ask only has no way to read them.

How follow-ups could reach Ask:

1. **Index them in the search generation.** Fast, but the index would hold
   words read from Jira and Confluence, which ADR-0033 keeps out of storage,
   and it would go stale whenever an item changes state.
2. **Read every visible follow-up live on each search.** Matches current
   titles, but costs one tool read per item, up to 50 a call, and breaks the
   per-Ask request caps.
3. **A request-bound source over the open-items policy (chosen).** It reads
   rows at request time as the asker, matches words only in text ECHO holds,
   and reads outside titles live only for the rows it returns.

How an answer could cite one:

1. **As the decision's approved-record citation.** No new kind, but it names
   the meeting, not the item, and opens the wrong place.
2. **A new citation kind in a new answer version (chosen).** Clients validate
   answers with exact kinds, so an unknown kind in an existing version would
   break every installed desktop.

## Decision and consequences

- **One source.** Selector `follow_ups`, desk item kind `follow_up`. A desk
  that bound it lists `FOLLOW_UPS_SOURCE_DESCRIPTOR_V1` in its
  `live_sources`, which puts it in the research catalog. It is bound for
  global and project Ask. It is never bound for Mine, which reads only what
  the asker added, nor for trigger research (impact checks and sweeps), the
  model-free evidence doors, or the desks open items bind for themselves.
- **Who sees what: the open-items policy, and only it.** The source asks the
  same policy functions, through the same assessment and live-read path, that
  the runs API's `items` and `item` use (`open-items-policy-v1.ts`,
  `person-open-items-v1.ts`). Nothing restates a rule.
  - A follow-up is released only when the policy shows its row to the asker:
    they are in its decision's audience, or they own it and it has reached
    them.
  - Its decision's title, first decided line and meeting ref come only when
    the policy shows the asker the decision.
  - A title or due date from the item's tool comes only when the asker opened
    the item there in this request and the policy shows them its outside
    words. Otherwise the title is ECHO's `expected` phrase, else
    `Follow-up`. A meeting action is ECHO's own data and is never read live.
  - In a project, only the decisions the asker reads in that project, as the
    `items` project scope reads them.
- **Search matches ECHO-held text only:** the decision's title and first line
  (only where the decision is shown), the `expected` phrase, the owner's
  display name, each with any word shaped like a ticket key (a build name such
  as `EVT-2`) as written, and a ticket's key read from the item's stored
  pointer. Never a word inside a ticket or page, and never a page's or
  message's pointer, which can hold a title. Hits rank by ECHO-held words
  alone, so a key never moves or cuts a hit. A hit matched only by its ticket
  key ranks after every word match and is released only if the live read
  opened it: Home shows the key only with the opened item. A search returns at
  most 5 hits. It reads live only its hits, and each candidate matched only by
  its ticket key, to decide whether it is a hit. A keyword search across
  sources reads none live, since the desk keeps only some of each source's
  hits: its follow-ups carry ECHO-held text only, and a ticket key alone finds
  none there. A search with a ticket key says so in a notice when it ran
  across sources, or when the request had already made nearly all its live
  reads; the notice turns on the query and those reads, never on whether a
  follow-up holds the key.
- **List** takes an owner (each word a whole word of the name, ignoring
  case) and a status (`open` or `done`), applied before anything is released
  or read live. An owner of `me`, or the asker's own display name, which
  research passes for "I" and "my", lists the asker's own follow-ups by
  membership, never another member whose name holds theirs. A page holds at
  most 10 rows. Date filters are refused: a follow-up has no date of its own.
- **Live reads go through the request's own desk.** A follow-up's tool item
  is opened with the same bound tool source the rest of the Ask uses. Each
  read is that tool's audited live release, counts toward that tool's
  per-request caps, and is rechecked by that tool at every check. At most 20
  distinct tool items are read live for follow-ups in one request, each once,
  so follow-ups on one item share its read; past that, and when a read is
  refused or fails, a follow-up is released with ECHO-held text only.
- **What is released.** `PersonFollowUpEvidenceV1`: title, owner, status, due
  date, the latest check (verdict and when, not who), the decision (title,
  first line, meeting ref) and `expected`. `followUpDeskFieldsV1` turns it
  into desk fields: the title is the label; owner, status and due date are
  attributes; the rest is text. Visibility follows the decision (`team`,
  `project`, `projects` or `approver_only`, as its policy and projects give)
  when the asker reads it, and is `only_me` when they see the item only as
  its owner. A release whose title or due date was read live is no wider than
  that read: it takes the narrower of the two, so a title from the asker's
  own Jira read is `only_me`, as the ticket itself is. Never released: the
  approver, other members, who checked, the relation, run ids, item keys,
  pointers, `says_now`, or any count of rows the asker cannot see
  (ADR-0012).
- **Answer.** The V7 answer (`echo-clean-person-answer-v7`), served by the
  additive `POST /v6/person/ask`, adds the citation kind `follow_up`
  (`{ kind, item_id }`) and the open ref `follow_up:<item_id>`, which every
  follow-up citation carries and which opens the item page. A matched `/v6`
  response carries the route header `x-echo-person-ask-route: 6`. The V3
  request is unchanged. `/v3`, `/v4` and `/v5` and their answers are
  unchanged, and no version below V7 binds or cites follow-ups.
- **Progress ([ADR-0039](ADR-0039-ask-progress-names-after-the-access-check.md)).**
  `/v6` streams exactly as `/v5` does, for its own header value
  `x-echo-ask-progress: 2`, in Ask progress V2
  (`person-ask-progress-v2.ts`). V2 adds only what follow-ups need: a
  searched row may name `follow_ups`, and a read event or receipt row names a
  follow-up by its V7 citation. A follow-up is named under ADR-0039's rules,
  only after the access check before the model call that reads it in full,
  and its owner, status, check and decision never travel in a step. `/v5`
  keeps streaming V1 for `1`; `/v6` answers JSON for any other value, so a
  V1 client never meets a follow-up.
- **Checks ([ADR-0038](ADR-0038-incremental-access-check-before-model-calls.md)).**
  Before each model call, the source puts every follow-up it released since
  its last successful check through the policy again: the row is still shown,
  and the decision is still shown wherever a release carried it. Outside
  words are rechecked by their tool in the same check. At release, the check
  is full: every follow-up released in the request. A follow-up the asker can
  no longer see fails the check, so no answer is released. A request reads
  the follow-ups its scope shows once, at its first search or list, and the
  checks read each release again from fresh rows: one hidden since that read
  is refused before the next model call, and one shown since appears in the
  next request. Its state or owner changing while it stays visible is not an
  access change. ADR-0038's trade-off applies unchanged: an item revoked
  after its check may reach later model calls in that request, never the
  answer.
- **Audit.** Every search, list and open is audited before its bytes leave
  Layer 3: one content-free row in the read-decision audit
  (`echo-person-follow-up-release-audit-v1`) with the request context, the
  operation, and each item's id and a digest of its released fields; no
  title, name, phrase or decision text. A title read live is also audited by
  its tool's live-release row. The receipt joins the Ask's terminal audit
  like every desk release.

## Migration, rollback, and evidence

No schema or stored-state change: follow-ups are read, never written, and
nothing new is kept after the request. The API runtime mounts the V7 route
(`createPersonLiveAnswerRouteV1(options, 7)`) at `/v6` with its follow-up
sources as `follow_ups` (the runs store, open items, people and record
search); without them a V7 desk would bind no follow-ups and raise no error.
Its JSON and streamed paths both pass the request's `response_version` to
the desk and answer V7 with `createAgenticAskV4`, inside the same
snapshot-retry wrapper as `/v5` (`withPersonAskSnapshotRetryV1`).

The Person client's `ask --live` prefers `/v6`. It falls back to `/v5` only
on a 404 without the route header, as an Authority without `/v6` answers,
and from `/v5` to `/v4` as before; a failure `/v6` itself answers never falls
back. With `--progress` it streams `/v6` as progress V2 and `/v5` as V1. The
desktop reads V7 answers and V2 steps: a follow-up opens in Ask's side panel
with its title, owner, status and latest check, its Open (shown only once the
answer came) goes to the item page, and its source row says "owner ·
status". Rollback is a code revert; older clients never reach V7.

The staging research evaluation's question goal
(`person-research-eval-v1.ts`) still runs Ask as `/v5` does, with V6
answers and no follow-ups, so it does not measure the Ask that desktops and `ask --live`
now run. Validate a follow-ups question, such as "help me understand all my
open tasks", with the research-loop `trace` command, which captures the
ordinary live Ask on `/v6`.

Negative disclosure tests, required by
[INV-PERMISSIONS-015](../invariants/INV-PERMISSIONS-015-layer-3-person-release-boundary.md):

- a follow-up the policy hides is never found, by any word, by search or
  list, and changes no count, truncation or notice;
- an owner who cannot read the decision gets no decision title, first line
  or ref, and decision words do not find their item;
- words inside a ticket or page title never match;
- a match on a ticket key alone is not released when the live read is refused
  or fails, and a key never moves or cuts a hit for an asker who cannot open
  its ticket;
- a search across sources reads nothing live and finds nothing by a key
  alone, and a key notice is the same whether or not a follow-up holds that
  key;
- no tool title or due date appears without a live open in this request;
- a follow-up hidden, or its decision made unreadable, mid-run makes the
  release check refuse the answer;
- Mine, trigger research and V4 to V6 answers never bind or cite follow-ups;
- audit rows hold no title, name, phrase or decision text;
- a streamed `/v6` Ask names a follow-up only by its citation projection,
  never its owner, status, check, due date or decision, and `/v5` never
  names one. The projection's label is the follow-up's title, so when
  nothing was read live for it in this request (a meeting action, a search
  across sources, a ticket the asker cannot open or could not be read, or
  the live-read cap reached) the label is ECHO's `expected` phrase, which the
  runs API already shows whoever sees the row.

They are in `services/organization-authority/test/person-follow-ups-evidence-v1.test.ts`,
`person-follow-ups-ask-integration.test.ts` and, for the stream,
`person-ask-progress-v6-http.test.ts`. The contracts are tested in
`packages/organization-api/test/person-answer-v7.test.ts`,
`person-ask-progress-v2.test.ts` and
`packages/organization-authority-kernel/test/shared/follow-up-evidence-v1.test.ts`.
`tests/architecture/ask-progress-roundtrip.test.ts` carries a cited
follow-up from the real Authority runtime through the Person client to the
desktop page and its item page; the Person client's fallback chain is in
`tests/person-client/person-ask-progress.test.ts`, and the desktop's opener
and panel in `product/echo-desktop/test/unit/ask-follow-up.test.ts`.
