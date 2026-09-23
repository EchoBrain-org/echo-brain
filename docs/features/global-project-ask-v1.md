# Global and project Ask

Status: implementation candidate; live qualification is separate. The accepted
direction is [ADR-0015](../decisions/ADR-0015-global-and-project-scoped-person-ask.md).

## User behavior

Ask defaults to all context the signed-in person can access: personal material,
organization-shared material, joined-project material, and approved records.
Selecting a project narrows Ask to readable context actually associated with
that project. The scope is visible and stays bound to the submitted question.
An empty project result does not trigger a global fallback.

The person's own private context is eligible within a project when explicitly
associated with that project. This is the initial definition of related personal
context. Other people's private material, unassociated personal context, and
unrelated organization or other-project material remain excluded.

The separate Find saved context and Organization people sidebar entries are
removed. File browsing is not a prerequisite for asking. Owner administration
remains under the menu-bar Organization → People entry. Project leads can browse
and search a paginated organization directory inside the project people picker;
rows show names only. Add preserves the role of anyone already in the project.

A valid Ask submission displays the submitted question and clears the input.
Invalid input remains editable. A second submission must not silently replace
a running request. This is one question and answer at a time; it does not add
persistent chat history or conversational memory.

## Evidence and permission boundaries

Supported originals include saved editor text and usable extracted text from
the existing text/Markdown, PDF, and DOCX upload path. The original upload and
extraction limits remain in [Project documents V1](project-documents-v1.md).
Encrypted, scanned/no-text, failed, or still-extracting files do not acquire
invented textual evidence. Partial extraction remains partial evidence.

Approved-record citations and source-revision citations are distinct. Source
citations bind the original/revision and derived representation actually used.
Opening cited evidence uses current authorization and exact immutable
coordinates. It must not substitute the latest revision silently. Source
statements do not become approved decisions by appearing in an answer.

Global scope does not widen permissions. Only-me material remains private even
when associated with a project. Association, audience, and project membership
are independent checks. The server checks access before sending source material
to the answer model and again before returning the answer, including uncited
model context. Shared context survives its contributor's departure; removed
readers lose access, while newly authorized project members can access history.

## Current limits

- Approved records currently have no authoritative project association. They
  contribute to global Ask; project Ask uses associated original context. A
  project name appearing in an approved record is not sufficient to include it.
- Raw meeting snapshots and pending/rejected approvals are not exposed merely
  because they exist in the shared source tables.
- Retrieval remains bounded and lexical, with up to three planned queries in
  addition to the question, at most 16 context atoms and 49,152 UTF-8 context
  bytes, and at most one answer model call. This is not a promise to inspect
  every accessible document exhaustively.
- Ask does not request decision/action extraction or publish approvals. The
  requested-only analysis policy remains unchanged.
- Professional role/title/team metadata and Undo of completed uploads or
  approvals are outside this round.
- The next search and answer refinement must define whether personal context
  can be related without an explicit project association, how that relationship
  is established, and how to explain it. Keyword similarity alone does not widen
  project scope in this version.

## Compatibility and validation

The new client uses `POST /v2/person/ask` with request schema 2 and response
schema 3. The response carries global/project scope and typed citations. The
CLI accepts `person ask --question <text> [--project <project-id>]`. Old clients
can continue using `/v1/person/ask` for the original approved-record-only
contract. The new client does not silently downgrade a project request to
global or approved-record-only Ask.

Cited original evidence is read through `POST /v2/person/ask/source` or
`person ask-source`, using the answer's scope and exact source, revision,
representation, and anchor coordinates. The response is a bounded evidence
excerpt, not a new browsing interface.

Directory browsing and role-preserving Add use the existing authenticated
project capability and durable mutation receipts. New source retrieval uses
existing immutable custody; no staging reset is required by this feature.

Focused proof and complete repository checks belong to the PR head. Live
qualification must exercise separate people, exact installed artifacts,
project/private isolation, document citations, and revocation before calling
the candidate accepted.
