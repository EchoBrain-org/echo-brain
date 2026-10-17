---
schema_version: 1
id: ADR-0040
kind: decision
title: Follow-ups are an Ask source, seen exactly as Home shows them
component_ids:
  - CMP-ORGANIZATION-AUTHORITY
  - CMP-PERMISSIONS
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
  display name, and a ticket's key read from the item's stored pointer. Never
  a word inside a ticket or page, and never a page's or message's pointer,
  which can hold a title. A hit matched only by its ticket key is released
  only if the live read opened it: Home shows the key only with the opened
  item. A search returns at most 5 hits; only hits are read live.
- **List** takes an owner (every word of a name, ignoring case) and a status
  (`open` or `done`), applied before anything is released or read live. A
  page holds at most 10 rows. Date filters are refused: a follow-up has no
  date of its own.
- **Live reads go through the request's own desk.** A follow-up's tool item
  is opened with the same bound tool source the rest of the Ask uses. Each
  read is that tool's audited live release, counts toward that tool's
  per-request caps, and is rechecked by that tool at every check. At most 20
  distinct follow-ups are read live in one request, each once; past that, and
  when a read is refused or fails, a follow-up is released with ECHO-held text
  only.
- **What is released.** `PersonFollowUpEvidenceV1`: title, owner, status, due
  date, the latest check (verdict and when, not who), the decision (title,
  first line, meeting ref) and `expected`. `followUpDeskFieldsV1` turns it
  into desk fields: the title is the label; owner, status and due date are
  attributes; the rest is text. Visibility follows the decision (`team`,
  `project`, `projects` or `approver_only`, as its policy and projects give)
  when the asker reads it, and is `only_me` when they see the item only as
  its owner. A release whose title or due date was read live is no wider than
  that read: it takes the narrower of the two, so a title from the asker's
  own Jira read is `only_me`, as the ticket itself is. Never released: the approver, other members, who checked, the
  relation, run ids, item keys, pointers, `says_now`, or any count of rows
  the asker cannot see (ADR-0012).
- **Answer.** The V7 answer (`echo-clean-person-answer-v7`) on the additive
  `POST /v6/person/ask` adds the citation kind `follow_up`
  (`{ kind, item_id }`) and the open ref `follow_up:<item_id>`, which every
  follow-up citation carries and which opens the item page. The V3 request
  is unchanged. `/v3`, `/v4` and `/v5` and their answers are unchanged, and
  no version below V7 binds or cites follow-ups.
- **Checks ([ADR-0038](ADR-0038-incremental-access-check-before-model-calls.md)).**
  Before each model call, the source puts every follow-up it released since
  its last successful check through the policy again: the row is still shown,
  and the decision is still shown wherever a release carried it. Outside
  words are rechecked by their tool in the same check. At release, the check
  is full: every follow-up released in the request. A follow-up the asker can
  no longer see fails the check, so no answer is released. Its state or owner
  changing while it stays visible is not an access change. ADR-0038's
  trade-off applies unchanged: an item revoked after its check may reach
  later model calls in that request, never the answer.
- **Audit.** Every search, list and open is audited before its bytes leave
  Layer 3: one content-free row in the read-decision audit
  (`echo-person-follow-up-release-audit-v1`) with the request context, the
  operation, and each item's id and a digest of its released fields; no
  title, name, phrase or decision text. A title read live is also audited by
  its tool's live-release row. The receipt joins the Ask's terminal audit
  like every desk release.

## Migration, rollback, and evidence

No schema or stored-state change: follow-ups are read, never written, and
nothing new is kept after the request. The V7 route is mounted, and the
Person client and desktop prefer it, with the Ask change that follows
ADR-0039, since that change reworks the Ask route. A client falls back from
`/v6` to `/v5` only when the Authority has no `/v6` route. Rollback is a code
revert; older clients never reach V7.

Negative disclosure tests, required by
[INV-PERMISSIONS-015](../invariants/INV-PERMISSIONS-015-layer-3-person-release-boundary.md):

- a follow-up the policy hides is never found, by any word, by search or
  list, and changes no count, truncation or notice;
- an owner who cannot read the decision gets no decision title, first line
  or ref, and decision words do not find their item;
- words inside a ticket or page title never match;
- a match on a ticket key alone is not released when the live read is refused
  or fails;
- no tool title or due date appears without a live open in this request;
- a follow-up hidden, or its decision made unreadable, mid-run makes the
  release check refuse the answer;
- Mine, trigger research and V4 to V6 answers never bind or cite follow-ups;
- audit rows hold no title, name, phrase or decision text.

They are in `services/organization-authority/test/person-follow-ups-evidence-v1.test.ts`
and `person-follow-ups-ask-integration.test.ts`. The contracts are tested in
`packages/organization-api/test/person-answer-v7.test.ts` and
`packages/organization-authority-kernel/test/shared/follow-up-evidence-v1.test.ts`.
