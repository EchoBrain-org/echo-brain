---
schema_version: 1
id: ADR-0024
kind: decision
title: Person list, open by ref, and the mine scope
component_ids:
  - CMP-PERMISSIONS
  - CMP-ORGANIZATION-AUTHORITY
  - CMP-PERSON-CLIENT
created_at: 2026-09-29
reviewed_at: 2026-09-29
reviewed_ref: f6effed96764fcb742f65f191cb04288031a7dbc
status: proposed
supersedes: []
superseded_by: []
updates:
  - ADR-0012
  - ADR-0013
  - ADR-0015
  - ADR-0017
  - ADR-0019
  - ADR-0021
  - ADR-0022
---

# ADR-0024: Person list, open by ref, and the mine scope

## Disposition

Proposed. The founder approved the design choices on 2026-09-29.
[INV-PERMISSIONS-015](../invariants/INV-PERMISSIONS-015-layer-3-person-release-boundary.md)
requires an accepted ADR before any new release path ships, so `status`, this
section and the index row change to `accepted` in the change that merges the
implementation. `reviewed_ref` is the source the design was checked against;
it is not an implementation claim.

## Context and options

Nothing today lists what a person can read or has added:

- `person updates search` and `search-v3` need a query, return at most 10
  results and have no cursor.
- `person projects feed-v2` needs a project.
- `person documents search-v2` returns documents only.
- `person records` returns signed envelopes with log positions
  ([ADR-0020](ADR-0020-minimized-person-layer-1-record-projection.md)).

The desktop app therefore has no view of a person's own notes, uploads and
approved meetings, and its project page stitches several per-kind reads
together.

Three options were considered:

- **(a) Desktop only, over the existing routes.** Rejected. It cannot list
  notes outside a project without a query, cannot page meetings without log
  positions, and cannot compute "mine" for meetings, because the approver is
  server-only.
- **(b) Per-kind mine routes.** Rejected. Three new release paths, cursors and
  audits for one question, and every client would still merge the kinds.
- **(c) One `list` and one `open`, scoped like Ask.** Chosen.

## Decision

### Commands and routes

| CLI | HTTP | Kind returned |
| --- | --- | --- |
| `echo-brain person list [--project <project-id> \| --mine] [--cursor <next_cursor>]` | `POST /v1/person/list` | `echo-person-list-v1` |
| `echo-brain person open --ref <ref> [--cursor <next_cursor>]` | `POST /v1/person/open` | `echo-person-open-v1` |
| `echo-brain person ask --question <text> [--project <project-id> \| --mine]` | `POST /v3/person/ask` (existing) | `echo-clean-person-answer-v4` |

`--project` and `--mine` are exclusive (exit 2). List takes no other flags, and
open takes no scope. Success prints one line, `{"ok":true,"result":...}`; a
failure prints `{"ok":false,"action":...}` and exits 1; usage errors exit 2.
Neither route calls a model or reads Slack.

A ref is `note:ctx_<hex>`, `document:doc_<hex>`, `meeting:sha256:<hex>` or
`transcript:sha256:<hex>`, each with 64 lowercase hex digits. List rows carry
only the first three. A `transcript:` ref names the same record digest as its
meeting and appears only on an open meeting page and on Ask citations. A ref
carries only the item's id or record digest, never a source, revision,
representation or source content hash.

### Scopes and ADR-0012's clause

The shared Ask scope gains `{kind:"mine"}` beside global and project.
[ADR-0012](ADR-0012-person-public-response-privacy.md) says "no owner-only
bypass or caller-selectable scope is introduced". The reading recorded here,
for both project and mine: a caller may choose a filter that **narrows its own
global readable set**, and may never choose another policy view. The request
carries only `project_id` or `mine: true`; the server binds principal and
membership from the session. Every scope decision is an exhaustive switch, so
mine can never fall through to global. Tests prove mine ⊆ global and
project ⊆ global for owner and employee readers.

A project the caller is not a member of, and a project that does not exist,
get the same 401 as `ask --project`, before any store runs.

### What mine means

Mine is notes and documents whose `membership_id` and `principal_id` are the
caller's, plus meetings whose final approver is the caller. Anything the caller
cannot read now is omitted, including the caller's own items reachable only
through a project they left.

- Mine is tenure-bound. A re-provisioned membership does not see earlier items
  in Mine; they stay in global wherever they are still readable.
- Approved means the final approver, not an attendee or action owner.
- The approver identity stays server-only.
- "My" in an Ask question is a search hint, not the mine scope.
- Ask with mine reads no Slack and, in this version, no shared transcripts.

### Released fields (INV-03)

INV-03 separates existence from content. List and open add no discovery
surface: they release only items the caller may read now, and nothing about
items the caller cannot read. Every released field:

| Where | Field | Value and source | Already released to this reader? |
| --- | --- | --- | --- |
| Page | `scope` | The request's scope, echoed on every page | Yes: the request |
| Page | `items`, `next_cursor` | Rows below; an opaque cursor over emitted rows | New, content-free |
| Page | `notice` | `meetings_unavailable` only | New closed token |
| Global page 1 | `me.display_name`, `me.membership_type` | The caller's directory name and membership type | Yes: directory and status |
| Global page 1 | `connected[].tool`, `connected[].status` | Tool id and personal status, without external scope or subject ids | Yes: Person tools route |
| Global page 1 | `projects[]` (id, name, role, status), `projects_more` | The caller's active grants, active before archived, at most 50 | Yes: projects list-v2 |
| Project page 1 | `project` | The selected joined project | Yes: projects read |
| Row | `ref` | Context id, document id or record digest | Yes: updates, documents and records reads |
| Row | `kind` | `note`, `document` or `meeting`, from the ref | Yes, derived |
| Row | `title` | Stored or brief title, NFC, at most 200 bytes; `Untitled` or `Approved meeting` when empty | Yes |
| Row | `added_at` | Notes and documents: `received_at`. Meetings: the approval receipt's `receipt_issued_at` | Notes and documents: yes. Meetings: **new** |
| Row | `visibility` | `only_me`, `team` or `project`, collapsed from the audience | Derived from the released audience |
| Row | `projects[]` (id, name) | Association ∩ the caller's current grants, at most 20 | Yes: project feed, document metadata, record envelope |
| Document row | `media_type`, `extraction_state`, `size_bytes` | Detected type, extraction state (all ten), original size | Yes: documents metadata |
| Meeting row | `meeting_date` | The brief's local start date | Derived from the brief time |
| Open note | `text` | Custody text | Yes: updates read |
| Open document | `filename`, `chunks[]` (`anchor{kind,start}`, `text`) | Extracted text rows by ordinal | Yes: documents read-v2 |
| Open meeting | `started_at`, `ended_at`, `timezone`, `all_day`, `participants[]` (names only), `participants_more`, `approved_by` | Brief times and participant names; the approver's current directory name | Yes: person records envelope and `source_metadata` |
| Open meeting | `atoms[]` (`kind`, `text`, `status`, `owner`, `due_at`, `part`) | Approved decisions, actions and rationales; ADR-0021 confirmed owners | Yes: person records. `part` is new and content-free |
| Open meeting | `transcript_ref` | `transcript:` plus the record digest, when shared and readable | New pointer to the released digest |
| Open transcript | `text` | One transcript page through the approval grant | Yes: person transcript |
| Ask | request `mine`; response scope `{kind:"mine"}`; citation `ref` | Scope echo; the cited item's ref | New |

Rows carry at most 20 projects, which is the association cap for notes,
documents and meetings, and have no per-row `projects_more`. That makes the
list response bound 320 KiB; the header keeps `projects_more`.

**Never released** by list or open:

- text or excerpts in rows, and evidence quotes anywhere;
- author, uploader or approver identities (open meeting's `approved_by`
  display name is the only approver attribution, as in `person records`);
- `request_id`;
- any original, source, revision, representation or transcript hash;
- counts or totals;
- log positions or predecessors, generation ids, head digests, audit
  sequences;
- the envelope;
- approval, approver, Slack, participant, signal and atom ids;
- provenance and source locators, and transcript coordinates;
- audience rosters and audience project ids;
- unjoined project ids or names;
- whether an audience names one project or several;
- pending or rejected meetings, unshared transcripts, and Slack;
- desk ids and receipts.

### Paging

A page holds at most 25 rows, merged newest first: `added_at` descending, then
ref ascending. One opaque cursor holds a position for each source (notes,
documents, meetings). It is bound by digest to the operation, scope,
organization and membership, and a cursor from any other binding is refused.
It is not a MAC: a forged position only filters rows the caller may read. It
never holds a log position, generation, head digest, audit sequence, count, or
an id the caller did not receive in the same walk. Responses carry no counts.

There is no separate scan budget. Originals read at most 26 rows per source by
keyset. Meetings read the pinned search generation's record list, which the
generation's 1,024-atom admission ceiling bounds at 1,024 records.

Meetings are held, never skipped, while the search generation lags the record
log. They are held only when the lag is verified **and** a record the reader
can read in this scope (under mine, one the reader approved) was appended
after the generation's head; that probe reads only the log after the head, and
a Mine lag of more than 100 readable records holds without reading further.
A held page carries
`notice: "meetings_unavailable"` and keeps the meeting position. A lag with no
readable new record lists from the generation with no notice. If a search, a
superseded rebuild or a restart dropped the process handle during the lag, the
list validates and warms the published generation again instead of failing.
So the list never names an approval the reader cannot see, and its rows do not
change when one lands. It does not hide that the index lags: during a lag,
Layer 2 search answers 503 and Ask carries its lag notice for every reader.
Any other state (organization or contract mismatch, a cold handle with no lag,
a generation that fails validation) fails the whole page with 503.

Page 1 while meetings are held still returns its header, the rows it has (or
`items: []`), the notice and a cursor. A cursor page that would carry zero
items while meetings are held returns 503 `unavailable` instead, so a client
never loops on the same cursor.

### Open by ref

Open always uses global access; a cited item from a mine or project answer
opens under global, which is safe because both scopes are subsets of it. A
malformed ref, or a cursor bound to another ref, person or operation, is a 400.
After that, every refusal other than `unavailable` returns one `not_found`
(HTTP 404, fixed body): unknown, unreadable, left project, pending or rejected
meeting, unshared or unreadable transcript, out-of-range cursor, and fence
failures.

- **Notes** come from custody: the full text, at most 8 KiB.
- **Documents** come from extracted chunks, paged like documents read-v2: at
  most 8 chunks, 8,192 raw bytes and 20 KiB of canonical JSON per page. A
  document that is still extracting opens with no chunks.
- **Meetings** go through the Layer 1 exact read (`PersonRecordReaderV1`,
  current grants) and are projected server-side from the validated envelope.
  The envelope is never returned. The first page (a request without a cursor)
  carries the meeting detail and, when the approver shared the transcript and
  the reader may read it, `transcript_ref`; later pages carry neither. Atom
  text is split at 3,072 bytes into numbered parts and never dropped. A page
  holds at most 25 parts and 32 KiB of atoms, and at least one part, except
  the first page of a zero-signal record, which opens with no atoms.
- **No evidence excerpts.** A brief's evidence spans are verbatim transcript
  quotes, and the approver's Slack card never shows them, so open releases
  decision, action and rationale text only.
- **Transcripts** are read only after the meeting passes the same Layer 1
  exact read, then through the ADR-0017 transcript grant, read at global
  scope by the store ADR-0021 gave Ask.

Every open response fits the client's ordinary 64 KiB bound.

### Originals read custody rows

List reads notes and documents from their custody tables, not only from
admitted sources. The access SQL is byte-identical to the Ask evidence desk's,
moved into one shared helper. List therefore shows a just-saved note and
documents in every extraction state, while Ask may not find them yet.
Quarantined notes (`authority_person_text_source_failures_v1`) are excluded.
Approved records with no signals open by ref but never list, as in Ask.

### Meeting approval time and approver

Both are read at query time.

- `added_at` is `organization_record_log.receipt_issued_at`, which the record
  log binds to the signed receipt.
- The approver comes from the composed `record_approver` projectors. Mine
  needs them: a runtime composed without them returns 503 for any mine list
  page that reaches meetings and for any mine Ask records call. Production
  always composes them.
- There is no record-log, retrieval-fact, baseline or lineage change.
- Cost bound: R ≤ 1,024 records, the generation's admission ceiling. A warm
  page costs an O(atoms) scan, an O(R log R) sort, at most 25 indexed lookups
  and the audits. A cold page adds one batched receipt read and, for mine only,
  at most R envelope parses, cached by immutable `record_sha256`.
- Revisit with persisted facts and a lineage transition if the benchmark or
  production p95 exceeds 50 ms for a warm page or 3 s for a cold mine page at
  1,024 records.

### Runtime boundary

- Both routes are model-free, reserved in `ORGANIZATION_AUTHORITY_HTTP_ROUTES`
  and mounted outside the answer-model gate, so they serve without an answer
  model.
- Each call is a fresh authenticated read. The project grant check runs before
  any store.
- Each store audits exactly the rows it emitted before the route responds; a
  store that emitted nothing writes no audit row.
- Before responding, the route revalidates every store release, the session
  and the caller's grant set, then writes one page audit.
- A grant-set change during a list request returns 401. A change only in a
  project's name, role or status returns 503, so a concurrent rename does not
  look like lost access.
- The route alone shapes titles, visibility and project lists, from its own
  projections; it never reuses the upload or document metadata readers.

### Desktop

The desktop app adds a Mine page, opened from a sidebar row under New project,
that shows `list --mine` 25 rows at a time, with More. A Mine chip in the bar
scopes Ask to mine. The project page reads `list --project`, and the reader
opens every list row and live match by ref, joining split meeting parts across
pages. Ask citations do not open by ref yet: a cited original is read with
`ask-source` under global scope (a mine answer's too, since global contains
mine), and a cited meeting with `person records`, until a follow-up moves the
source pane to open by ref. The "Saved for you" and "Shared with your
organization" toasts, whose items no project page shows, open Mine; "Saved to
<project>" does not. Signing out leaves the Mine page and clears it. A 401 on
a project page means the caller is no longer a member: the page shows "This is
no longer available to you." instead of "Sign in again", and status and
projects are re-read once.

### Refinements of the 2026-09-29 choices

Specifying the approved choices against the code refined them as follows:

- Rows have no per-row `projects_more`; the list bound is 320 KiB.
- Open pages are byte-bounded as well as capped at 25.
- `notice` is a closed token, not prose.
- Meetings are held only on a verified lag with a readable new record. A lag
  with no readable new record lists without a notice, warming the published
  generation again if its handle was dropped, and any other generation state
  is a whole-page 503.
- A cursor page that would carry zero items while meetings are held is a 503;
  page 1 never is.
- Ask with mine reads no Slack and no shared transcripts.
- Open meeting releases no evidence excerpts.
- Ask citations and evidence-desk items keep their uncollapsed visibility
  tokens (`projects` and `approver_only` included); the never-released
  one-or-several distinction applies to list and open only.
- The desktop Ask source pane keeps reading `person records` for now.
- A project page 401 shows "This is no longer available to you."
- `transcript_ref` is on the first meeting page only.
- `meeting_date` is the brief's local date when its time zone is valid, the
  stored date for an all-day meeting, and otherwise the UTC date.
- The list fence separates lost access (401) from renamed projects (503).
- Mine requires the `record_approver` projectors.

## Relations to other decisions

- [ADR-0012](ADR-0012-person-public-response-privacy.md): list and open follow
  its public shape, with no generation, head, position or hidden count, and the
  cursor encodes none of them. Its caller-selectable-scope clause is read as
  recorded above.
- [ADR-0013](ADR-0013-project-context-v1-contract.md): project discovery stays
  limited to current members. Headers and rows name only the caller's joined
  projects, and a non-member and a missing project get the same denial.
- [ADR-0015](ADR-0015-global-and-project-scoped-person-ask.md): global list
  covers the notes, documents and approved meetings global Ask may read, but
  not the Slack messages or shared transcripts Ask may also read, and project
  list uses the same membership and association rule with no fallback. ADR-0015 removed Find saved context
  without a replacement file browser; list adds a newest-first view with no
  query, filter or count, and Ask remains the way to search.
- [ADR-0017](ADR-0017-project-meeting-approval-v1.md): only approved meetings
  list. Project audiences and associations decide meeting rows, and open
  transcript uses the same explicit transcript release.
- [ADR-0019](ADR-0019-agentic-ask-v1.md): the evidence desk pushes mine into
  every store query. Desk items carry a server-owned `ref` that never reaches a
  model, and the public evidence-desk contract stays exact-key without it.
- ADR-0020 (proposed; related in prose only): list and open never return the
  envelope. `person records` is unchanged, and its exposure stands until
  ADR-0020 is decided.
- [ADR-0021](ADR-0021-ask-reach-and-approval-owners.md): shared transcripts stay
  Ask evidence for global and project Ask, but not for mine. Open meeting shows
  only confirmed owners.
- [ADR-0022](ADR-0022-agentic-ask-only.md): `/v3/person/ask` stays the only
  Ask. Its request gains `mine` and its citations gain an optional `ref`; the
  answer kind is unchanged.
- [ADR-0023](ADR-0023-reader-scoped-upload-releases.md): document metadata
  releases `request_id` only to the uploading tenure, which is the
  prerequisite that keeps refs non-attributing (see Consequences). ADR-0023
  names only the reader's current projects in a released upload audience;
  list and open go further, collapsing it to `only_me`, `team` or `project`
  and naming no audience project. Both leave the Ask evidence desk's
  `projects` label as it is.

## Consequences

- **Release.** Server and clients change together in one coordinated update
  window under
  [PB-OPERATIONS-001](../operations/PB-OPERATIONS-001-authority-operator-lane.md)
  and the [coordinated release rules](../../deploy/release/README.md), server
  first. Old clients validate Ask citations exactly, so they fail closed on
  cited answers until they update, as ADR-0012 requires; nothing is disclosed.
  A new desktop against an old server fails its project pages, which is why
  the server goes first.
- **Refs are non-attributing only while `request_id` stays secret and
  high-entropy.** Note and document ids are digests of organization,
  membership and `request_id`.
  [ADR-0023](ADR-0023-reader-scoped-upload-releases.md) stopped releasing a
  document's `request_id` to readers other than its uploader, and note reads
  never released it, so this prerequisite is met. Any later path that releases
  `request_id` to another reader would make refs attributing and needs its own
  decision.
- Ask citations and evidence-desk items still carry the uncollapsed
  visibility tokens, so a project reader can learn from Ask that a cited
  item's audience names other projects. `person records` already exposes the
  full audience. ADR-0023 deferred the same desk label. Collapsing them is a
  follow-up alongside ADR-0020.
- **Measured cost.** The meetings collect for page 1 (`collectMeetings`
  alone: no originals, commits, revalidation or audits) over 1,024
  single-atom approved records, on one development Mac: global 20.9 ms cold
  and 1.4 ms warm; mine 213.2 ms cold and 1.5 ms warm. All four are inside the
  revisit thresholds (50 ms warm, 3 s cold mine), so approval time and
  approver stay query-time reads. The benchmark asserts no threshold; a full
  route page adds the originals reads, commits and audits.
- Each of these needs its own decision: placeholders for items lost with a
  left project, counts, a since filter, Slack in mine, pending meetings,
  unjoined projects, persisted approver facts, and listing meetings past the
  generation's admission ceiling.

## Migration, rollback, and evidence

There is no database migration and no SQL, baseline or lineage change.

There is no joint rollback. Before promotion, the release lane's
exact-candidate rollback returns the host to the previous server, and the CLI
feed must not have been published. After promotion or feed publication the
host rollback is not a general undo, the feed has no lower-sequence rollback,
and desktops do not update themselves, so recovery is a reviewed forward fix
or a compatible recovery release
([coordinated release rules](../../deploy/release/README.md)). Updated CLI and
desktop seats keep calling `/v1/person/list` and `/v1/person/open`, so a
server without them fails their project pages and Mine.

Merge checklist, in the change that merges the implementation:

- `status`, the Disposition section and this ADR's row in the decision index
  change to `accepted`, and "proposed" goes from the Person list sentence in
  [organization-authority.md](../components/organization-authority.md) and
  from the ADR-0024 served-path rows in
  [permissions.md](../components/permissions.md).
- Done: the change that stops releasing `request_id` to readers other than the
  uploader merged as [ADR-0023](ADR-0023-reader-scoped-upload-releases.md).
  This ADR's server, Person client and desktop app ship in a release that
  includes it.
- The pull request states the coordinated server-first release plan.

Evidence:

- `services/organization-authority/test/person-list-disclosure.test.ts`
  covers the negative disclosure cases below for owner and employee readers,
  including Ask with mine. It composes the runtime's own stores and routes over
  SQLite and signed approvals, served by the real HTTP server.
- `services/organization-authority/test/person-list-route.test.ts` and
  `services/organization-authority/test/person-list-cursor-v1.test.ts` cover
  the merge, cursor binding, full walks and fences.
- `services/organization-authority/test/person-list-http.test.ts` covers the
  mount outside the answer-model gate.
- `services/organization-authority/test/person-original-items-v1.test.ts` and
  `services/organization-authority/test/person-original-context-mine.test.ts`
  cover originals listing, open and mine.
- `services/organization-authority/test/person-meeting-list-route.test.ts`
  covers meeting listing, mine by approver, holding and the cost benchmark.
- `services/organization-authority/test/person-meeting-open-route.test.ts`
  covers meeting open, split parts, transcripts and the absence of evidence
  quotes.
- `services/organization-authority/test/person-answer-v3-http.test.ts`,
  `services/organization-authority/test/person-evidence-desk-records.test.ts`
  and `packages/organization-authority-kernel/test/answer-composition/agentic-ask-v1.test.ts`
  cover Ask with mine and citation refs.
- `services/organization-authority/test/organization-authority-api-runtime.test.ts`
  covers list and open served by a fresh runtime with no answer model.
- `packages/organization-api/test/person-list-v1.test.ts` and
  `packages/organization-api/test/person-answer-v4.test.ts` cover the
  contracts and their never-released keys.
- `tests/person-client/person-list-cli.test.ts` covers the CLI.
- `product/echo-desktop/test/unit/views.test.ts` and
  `product/echo-desktop/test/e2e/mine.spec.ts` cover the desktop app.

Negative disclosure cases, as the tests name them:

- N-1: another member's Only me note, document and meeting never list in any
  scope, and open gives the 404 a random ref gets.
- N-2: items reachable only through a project the reader left, the reader's
  own included, leave every scope and give 404; a team item stays, with no
  project.
- N-3: unjoined project ids and names appear in no row, header, open item,
  decoded cursor or notice.
- N-4: no body carries counts, totals, log positions, generation ids, audit
  sequences, approval or request ids, the envelope, member or principal ids,
  or source coordinates.
- N-5: a cursor is refused (400) for another person, tenure, scope, ref or
  operation.
- N-6: mine and every project list are subsets of global.
- N-7: mine holds the meetings the reader finally approved, not the ones the
  reader can only read.
- N-8: a guessed ref of each kind gets the same 404 body as an existing
  unreadable one.
- N-9: pending and rejected meetings never list and give 404.
- N-10: no note or document `request_id` appears in any body, the
  uploader's included.
- N-11: every cursor of a walk holds only ids that walk emitted.
- N-12: an approval the reader cannot see, or under mine did not make, never
  holds meetings or adds the notice; a readable one does.
- N-13: a transcript opens only through a shared, readable record, and every
  other transcript ref is the same 404.
- N-14: a session or grant change between collect and response releases and
  audits nothing.
- N-15: document chunks, meeting parts and transcript pages join to exactly
  the stored sequence, with no duplicate at a page end.
- N-16: Ask with mine cites only the caller's items, each citation opens, it
  cites no Slack or transcript, and mine with a project is a 400.
- N-17: no evidence quote appears in any list, open or Ask body.
- N-18: the contract validators refuse every never-released field.
- N-19: a project the reader has not joined and one that does not exist get
  the same 401 before any store runs.
- N-20: the desktop copies no project id or header field into the renderer,
  and its host refuses a malformed scope, ref or cursor without a CLI call.
