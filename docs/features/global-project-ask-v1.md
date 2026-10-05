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
the existing text/Markdown, PDF, and DOCX upload path, and meeting transcripts
the approver shared at approval
([ADR-0021](../decisions/ADR-0021-ask-reach-and-approval-owners.md)). A
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
- BM25 is migration-free and scans eligible note, extracted-document and
  shared-transcript text at query time. Packet text is analyzed once per query;
  lightweight document scan rows avoid retaining repeated immutable
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
by [ADR-0022](../decisions/ADR-0022-agentic-ask-only.md): Ask is now
`POST /v3/person/ask` with V4 answers, and the scope rules here still apply to
it. The CLI accepts
`person ask --question <text> [--project <project-id> | --mine]`; the two
flags are exclusive. The client does not silently downgrade a project or mine
request to global Ask. With Jira live evidence configured
([ADR-0026](../decisions/ADR-0026-jira-person-live-evidence-nango.md)),
`person ask --tickets` calls `POST /v4/person/ask`, which returns V5 answers.
A connected Jira account contributes ticket citations in global scope or in a
project with a lead-configured [Jira mapping](project-settings-v1.md#jira-project-mapping).
Project reads stay inside that mapped Jira project using the asker's own
connection. Mine and unmapped projects exclude Jira.

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
