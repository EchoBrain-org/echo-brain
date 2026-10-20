# Global and project Ask

Status: implementation candidate; live qualification is separate. The accepted
direction is [ADR-0015](../decisions/ADR-0015-global-and-project-scoped-person-ask.md).

## User behavior

Ask defaults to all context the signed-in person can access: personal material,
organization-shared material, joined-project material, and approved records.
Selecting a project narrows Ask to readable context actually associated with
that project. The scope is visible and stays bound to the submitted question.
An empty project result does not trigger a global fallback. The desktop says
that nothing in the project matched and offers one tap to ask the same question
across everything the person can see
([ADR-0021](../decisions/ADR-0021-ask-reach-and-approval-owners.md)).

The person's own private context is eligible within a project when explicitly
associated with that project. This is the initial definition of related personal
context. Other people's private material, unassociated personal context, and
unrelated organization or other-project material remain excluded.

Choosing **Mine** narrows Ask to what the person added: the notes they saved
and the documents they uploaded under their current membership, and the
meetings they approved as final approver, while each is still readable to them
([ADR-0024](../decisions/ADR-0024-person-list-open-and-mine-scope.md)). Mine
excludes live external sources and, in this version, shared transcripts. It is
a narrowing of global scope, never another view: a teammate's item is excluded
even when the person can read it. "My" in a question is only a search hint; it
does not select Mine. Its citations carry a `ref`, which `person open` reads
under global scope.

The separate Find saved context entry is removed. File browsing is not a
prerequisite for asking. Owner administration is **People & invites**, under
Organization in the desktop app's sidebar and its menu bar icon's menu, and
shown to owners only. Project leads can browse
and search a paginated organization directory inside the project people picker;
rows show names only. Add preserves the role of anyone already in the project.
Any active member can search the same names with no project through
`person directory` (`POST /v1/person/directory`), so people can be picked while
a project is being created; see
[ADR-0016](../decisions/ADR-0016-organization-people-directory.md). Adding them
still needs the project's lead grant.

A valid Ask submission displays the submitted question and clears the input.
Invalid input remains editable. A second submission must not silently replace
a running request. This is one question and answer at a time; it does not add
persistent chat history or conversational memory.

In the desktop app, Escape steps back one level: a sheet, then Capture, then
the answer with the source beside it, then the reader, then the project, Mine
or People & invites, then Home. The reader names where its Back goes. Back from
an item or an answer returns to the place the project page or Mine was
scrolled to. Escape or Close puts an unsent note or attached file away until
Capture opens again, and a save in flight cannot be dismissed. See the desktop
app's [known gaps](../product/2026-09-24-electron-desktop-known-gaps.md).

Capture, and a file dropped on the window, a project row or the Capture sheet,
use one sheet: a note or one file, the projects it is filed in, and **Who can
read** (**Only me**, **Projects** or **Organization**). Opened on a project
page, or by a file dropped on a project's row, it starts with that project
ticked under **Projects**. **Save** commits
the original and its project links once. See
[Upload projects and sharing](upload-projects-and-sharing.md) for the full contract.

## Evidence and permission boundaries

Supported originals include saved editor text and usable extracted text from
the existing text/Markdown, PDF, and DOCX upload path, meeting transcripts
the approver shared at approval
([ADR-0021](../decisions/ADR-0021-ask-reach-and-approval-owners.md)), and a
person's imported meeting notes. Imported notes carry the `imported_meeting`
kind and an unapproved label; the importer reads their own, and members of a
project suggested for that meeting read them while they are members
([ADR-0030](../decisions/ADR-0030-personal-meeting-custody-and-review.md)). A
transcript is read under its approval grant: the record's current audience and,
for project Ask, its project association. Its packets are labeled
"Transcript: <meeting title>". The original upload and
extraction limits remain in [Project documents V1](project-documents-v1.md).
Encrypted, scanned/no-text, failed, or still-extracting files do not acquire
invented textual evidence. Partial extraction remains partial evidence.

Approved-record citations and source-revision citations are distinct. Source
citations bind the original/revision and derived representation actually used.
Opening cited evidence uses current authorization and exact immutable
coordinates. It must not substitute the latest revision silently. Source
statements do not become approved decisions by appearing in an answer.
Document evidence uses the original filename verified against source admission;
its display label is bounded without changing the full evidence or anchor.
The client rechecks its current local session before returning either an Ask
answer or cited evidence, so an account change cannot release an older session's
response.

Global scope does not widen permissions. Only-me material remains private even
when associated with a project. Association, audience, and project membership
are independent checks. The server checks access before sending source material
to the answer model and again before returning the answer, including uncited
model context. Shared context survives its contributor's departure; removed
readers lose access, while newly authorized project members can access history.

[Archiving a project](project-settings-v1.md) preserves this read and Ask
authorization. Leaving a project revokes that caller's project grant, and cited
evidence still requires current access when opened.

## Current limits

- An approved record is associated with a project only when its owner approved
  it with the **Projects** audience
  ([ADR-0017](../decisions/ADR-0017-project-meeting-approval-v1.md)). Project
  Ask includes those records while their audience still admits the reader;
  Only me, Team and older records remain global-only. A project name appearing
  in an approved record is not sufficient to include it. The approval card
  refuses projects chosen with another audience rather than dropping them.
- Raw meeting snapshots, meetings approved with transcript sharing off, and
  pending/rejected approvals are not exposed merely because they exist in the
  shared source tables.
- Original-context search computes query-local corpus statistics over every
  readable packet of the selected source kinds, including shared transcript
  packets. This is sized for the current retained-original and approved-meeting
  volumes, not for a large archive.
- Ask is the agentic loop of
  [ADR-0022](../decisions/ADR-0022-agentic-ask-only.md): at most 10 research
  steps and 24 model calls within 90 s. Live model answer quality and latency
  remain separate checks.
- Original search matches whole Unicode terms, omitting a closed English
  function-word list while preserving uppercase acronyms, and ranks stable
  citable packets with Okapi BM25 (`k1 = 1.2`, `b = 0.75`). Statistics include
  only the complete current readable scope and selected source kinds. Positive
  scores tie-break by recency, source, extraction ordinal and packet ordinal.
  The diversity cap is three ranked packets per document; packet-level counting
  is necessary because distinct relevant windows can come from one long
  extracted passage. This remains lexical matching: synonyms and conceptual
  paraphrases can still miss evidence.
- BM25 is migration-free and scans eligible note, extracted-document,
  shared-transcript and imported-meeting text at query time. Packet text is
  analyzed once per query; lightweight document scan rows avoid retaining repeated immutable
  representations, but runtime and transient memory still scale linearly with
  readable packets and their text. The synthetic production-path proof uses
  106 extracted passages (beyond the former 100-candidate window), verifies the
  late rare packet is returned and citable, and completes as part of the focused
  test suite. This is correctness evidence, not a large-archive capacity claim;
  a future index would need reader/scope-safe statistics and invalidation rather
  than silently imposing a scan cap. No index or migration is added here.
  A development run measured the search call alone for the existing
  640-passage, approximately 1.97 MiB document: 171.3 ms and an observed heap
  increase of approximately 4.1 MB. Upload and extraction were excluded.
  This single-run observation is neither a peak-memory measurement nor a
  capacity or service-level guarantee; tests assert correctness and bounded
  SQL result bytes rather than wall-time thresholds.
- Ask does not request decision/action extraction or publish approvals. The
  requested-only analysis policy remains unchanged.
- Professional role/title/team metadata and Undo of completed uploads or
  approvals are outside this round.
- The upload project picker pages independently of Home and accepts at most
  20 selected projects per original.
- The next search and answer refinement must define whether personal context
  can be related without an explicit project association, how that relationship
  is established, and how to explain it. Keyword similarity alone does not widen
  project scope in this version.

## Compatibility and validation

This version shipped as `POST /v2/person/ask` (request schema 2, response
schema 3), beside the approved-record-only `/v1/person/ask`. Both were retired
by [ADR-0022](../decisions/ADR-0022-agentic-ask-only.md). The default CLI Ask,
and the desktop's Mine Ask, use `POST /v3/person/ask` with V4 answers, and the
scope rules here still apply to every route. The CLI accepts
`person ask --question <text> [--project <project-id> | --mine] [--tickets | --live [--progress [--expected-membership-id <id> --expected-authority <origin>]]]`;
`--project` and `--mine` are exclusive, as are `--tickets` and `--live`. The
client does not silently downgrade a project or mine request to global Ask.

`--live` calls `POST /v7/person/ask`, which returns V8 answers: those of
`/v6` (V7), which may cite ECHO's shared follow-ups, seen as Home shows them
([ADR-0040](../decisions/ADR-0040-follow-ups-as-ask-evidence.md)), and may
also cite the asker's workspace: their projects, the people in their
organization, their tools, and the Jira projects and Confluence spaces of the
tools they connected
([ADR-0042](../decisions/ADR-0042-research-tool-contract.md)). A follow-up's
`follow_up:<item_id>` ref opens with `person runs` operation `item`, a
project's `project:<project-id>` with `person projects read-v2`, and a tool's
`tool:<tool>` in `person tools`, not `person open`; a person and a tool
container carry no ref. In a project Ask the workspace is that project and
its roster, and the containers are those its lead mapped. It uses every
configured request-local live source: Jira ticket citations
([ADR-0026](../decisions/ADR-0026-jira-person-live-evidence-nango.md)) and
Confluence page citations, read under the asker's own connections. Global
scope reads what those connections can access; a project reads only its
lead-configured [Jira mapping](project-settings-v1.md#jira-project-mapping) and
[Confluence spaces](project-settings-v1.md#confluence-space-mapping). Mine and
unmapped projects exclude live tools, and Mine excludes follow-ups and the
workspace. The desktop uses `--live` for every question outside Mine. An older
Authority gets the newest route it has, down to the ticket-capable
`POST /v4/person/ask`, as the
[Person client architecture](../architecture/person-client-architecture.md#account-and-answer-sources)
describes; permission failures never fall back. `person ask --tickets` keeps
that `/v4` route for compatibility.
`--live --progress` streams Ask's progress
([ADR-0039](../decisions/ADR-0039-ask-progress-names-after-the-access-check.md)): one JSON line per step before the final
line, which adds the answer's receipt; on `/v6` a step may name a follow-up,
and on `/v7` also a project, a person, a tool or a tool container. An Authority that does not stream
gets today's output. The desktop pins the streamed Ask to the account it
shows (`--expected-membership-id` and `--expected-authority`): a client
signed in as another asks nothing and prints no step. See [Person client architecture](../architecture/person-client-architecture.md)
for the client side.

Cited original evidence is read through `POST /v2/person/ask/source` or
`person ask-source`, using the answer's project scope (global for a global or
Mine answer, since global contains mine) and exact source, revision,
representation, and anchor coordinates. The response is a bounded evidence
excerpt, not a new browsing interface.

Directory browsing and role-preserving Add use the existing authenticated
project capability and durable mutation receipts. New source retrieval uses
existing immutable custody; no staging reset is required by this feature.

Focused proof and complete repository checks belong to the PR head. Live
qualification must exercise separate people, exact installed artifacts,
project/private isolation, document citations, and revocation before calling
the candidate accepted.

## Temporal research

Ask gives the LLM a captured client instant and time zone. The model resolves
absolute and relative expressions, including "yesterday" and event-relative
phrases, into structured inclusive `since`/`until` calendar dates. It must find
a referenced event before resolving a date relative to that event. Code
validates and executes the selected bounds; it does not parse the person's
natural-language question.

Both keyword `search` and keyword-free `list` carry date bounds. An explicit
`date_field` selects the meaning and requires a source for keyword search:

| Source | Date fields | Default |
| --- | --- | --- |
| Meetings: approved records, imported notes and shared transcripts | `occurred` (when recorded), `approved` (approved records), `received` (imported notes and transcripts), action `due` | `occurred` |
| Saved notes and uploaded documents | `received` | `received` |
| Follow-ups | `created`, `sent`, `reassigned`, `checked` | any of them |
| Projects | `created` | `created` |
| Jira tickets | `created`, `updated`, `due` | `created` |
| Confluence pages | `created`, `updated` | `updated` |

Each source declares these in its capabilities. For Ask, a window with no
field matches any of an item's dates, and a field a source does not declare
is refused; [ADR-0042](../decisions/ADR-0042-research-tool-contract.md#dates)
says how items without the asked date are counted.

Timestamps are compared in the request's time zone; date-only deadlines and
all-day events retain their stated date. The evidence carries named source
timestamps separately from display dates. Unknown dates do not become capture
dates. Date filters narrow reader-admitted records before result caps; original
note/document inventories filter capture dates before SQL limits. Provider
queries use coarse date bounds to accommodate the provider account's zone,
then filter the current permission-checked values exactly in the client's
zone. Empty filtered provider pages may still have a continuation.

A meeting inventory includes readable imported notes and explicitly shared
transcripts as well as approved records. Transcript permission and Mine-scope
exclusion remain unchanged. Every metadata release remains audited and fenced.

A list read to its end answers which items exist
([ADR-0041](../decisions/ADR-0041-complete-lists-as-ask-evidence.md)). For a
question such as "Which Confluence pages were created on October 4?", research
may finish on a complete list without opening its items, and code writes the
sentence that counts and names them, citing each item's own row: at most 25
names across an answer, then "and N more", with N from ECHO's own list of
items the asker can read, never a vendor's total. A list not read to a
confirmed end (its last page was exactly full, or it was cut short) gives "at
least N" and a partial answer. A requested filter the source cannot apply,
such as an owner on pages, is named in the response notice rather than
silently widening the list; a date field the source lacks is refused. A list
supports titles, dates, status and owner only: what an item says still needs
the item opened, and a question about which listed items say something notes
how many were checked.

An upload date is not an event date inside a document, a due date is not a
completion date, and the current revision's update timestamp is not a complete
change history. The model may search a date quoted in content as a keyword
when that is what the question asks. Unsupported date fields are refused;
missing dates and truncated inventories limit what an empty result proves.
Live natural-language qualification remains part of staging, separate from
scripted-model transport and retrieval tests.

A dated read counts the reader-visible items that lack the asked date as
`unchecked` (ADR-0042, "Dates"); research and the writer see the count, and an
answer that uses the list says how many were not checked, even for an empty
list. A meeting on a different day cannot answer the requested day or
establish that nothing happened then.
Synthetic staging submissions accept optional `started_at`, `ended_at` and
`time_zone` fields; the source preserves them as meeting time. Existing undated
submissions stay undated, and capture/approval times never substitute for them.

If the approved record log advances during Ask, a valid old snapshot is
classified as unavailable rather than failed authentication. Ordinary Ask
restarts once with a new desk and research state, within the original 90-second
work deadline. Cooperative timeout auditing finishes before the response returns;
cleanup has a separate one-second bound if a connector does not settle after cancellation.
The old evidence never enters the new attempt. Revoked access,
changed grants, corrupt or foreign pointers and unknown failures are not
retried. Diagnostic captures remain single-attempt so their content and fence
cannot mix attempts; a snapshot change returns unavailable and the person may
start a fresh capture. A still-building index can produce an explicit partial
answer from other sources under the existing originals-only policy.
