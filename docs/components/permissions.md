---
schema_version: 1
id: CMP-PERMISSIONS
kind: component
title: Permissions
owners:
  - unassigned
component_ids:
  - CMP-PERMISSIONS
created_at: 2026-08-13
reviewed_at: 2026-08-14
reviewed_ref: 83819a57fd8635384d14d3cc8d591e8f76ad1260
decision_ids:
  - ADR-0048
  - ADR-0046
  - ADR-0044
  - ADR-0043
  - ADR-0042
  - ADR-0041
  - ADR-0040
  - ADR-0039
  - ADR-0038
  - ADR-0036
  - ADR-0032
  - ADR-0033
  - ADR-0031
  - ADR-0030
  - ADR-0034
  - ADR-0026
  - ADR-0012
  - ADR-0002
  - ADR-0003
  - ADR-0004
  - ADR-0005
  - ADR-0006
  - ADR-0007
  - ADR-0010
  - ADR-0011
  - ADR-0013
  - ADR-0014
  - ADR-0015
  - ADR-0016
  - ADR-0017
  - ADR-0018
  - ADR-0019
  - ADR-0020
  - ADR-0021
  - ADR-0023
  - ADR-0024
  - ADR-0028
  - ADR-0029
invariant_ids:
  - INV-ADAPTERS-002
  - INV-IDENTITY-005
  - INV-PERMISSIONS-013
  - INV-PERMISSIONS-014
  - INV-IDENTITY-003
  - INV-PERMISSIONS-015
failure_pattern_ids:
  - FP-ADAPTERS-002
  - FP-PERMISSIONS-001
  - FP-IDENTITY-003
qualification_ids:
  - QMAT-ADAPTERS-001
  - QMAT-JOB-A-STOPPED-001
  - QUAL-20260813-174902-001
  - QMAT-JOB-B-ACTIVE-MEMBER-001
  - QUAL-20260814-050326-001
  - QMAT-READABLE-SEARCH-MINIMUM-V1-001
  - QUAL-20260814-194049-001
---

# Permissions

## Responsibility

Permissions determine whether a specific actor may perform an action or
receive particular organization information. The domain crosses local frozen
approval state, provider action evidence, central membership, record
admission, derived facts, retrieval scope, final authorization checks, and
audit.

Identity answers who the actor is. Permission answers what that actor may do
with a particular action or content boundary.

## Current references

- [Layer 3 release-boundary invariant](../invariants/INV-PERMISSIONS-015-layer-3-person-release-boundary.md)
  and the ADRs this record lists; each served path below names its own
- [Project context V1 contract](../decisions/ADR-0013-project-context-v1-contract.md)

Historical design (August 2026):

- [Organization permission architecture](../product/2026-08-09-organization-permission-architecture.md)
- [Permission pilot V1](../product/2026-08-10-permission-pilot-v1-contract.md)
- [Invariant registry](../product/2026-08-11-architecture-invariant-registry.md)
- [Reviewer permission V1](../product/2026-08-11-reviewer-permission-v1-log-facts-design.md)
- [Permission-aware searchable Layer 2](../product/2026-08-11-trusted-permission-aware-searchable-layer-2-design.md)

## Documentation rule

Permission claims must name their enforcement scope. A bounded pilot or one
retrieval operation is not evidence of a globally enforced permission system.
The served-path table below covers these Person read paths: list and open,
the change check, project activity, the Ask source check, Ask, runs and open
items, and meeting reviews. Other served Person read paths are governed by
[INV-PERMISSIONS-015](../invariants/INV-PERMISSIONS-015-layer-3-person-release-boundary.md)
and the ADR that introduced them.

Person upload reads (notes and documents) release an audience that names only
the reader's current projects, and a document request ID only to its uploader.
[ADR-0023](../decisions/ADR-0023-reader-scoped-upload-releases.md) records the
enforcement point and the negative disclosure tests.

The ADRs that specify Ask are listed in
[CMP-ORGANIZATION-AUTHORITY](organization-authority.md); its enforcement is
the `/v7` row below.

## Served paths

| Path | Invariant | Enforcement point | Denial behavior | Audit evidence | Qualification |
| --- | --- | --- | --- | --- | --- |
| `POST /v1/person/list` ([ADR-0024](../decisions/ADR-0024-person-list-open-and-mine-scope.md)) | [INV-PERMISSIONS-015](../invariants/INV-PERMISSIONS-015-layer-3-person-release-boundary.md) | `createPersonListRouteV1` in `services/organization-authority/src/composition/person-list-v1-route.ts`: session and project grant before any store; the originals store (`SqlitePersonOriginalItemsV1`) and the records route's meeting collect, commit after their own fences and revalidate; the route rechecks the session and grant set before responding | 401 for no session, a project not joined or not existing (one body), or a grant change during the request; 400 for a cursor from another person, tenure, scope or operation; 503 for a rename during the request, a cursor page that could only wait for meetings, a mine page that reaches meetings without the composed approver projectors, or a generation that cannot serve | Originals: `authority_person_upload_read_audit_v1`. Meetings: `authority_person_read_decision_audit_v2` with read mode `person_list`. Page: `authority_project_read_audit_v1` with the response digest and the store receipts. A store that released nothing writes no row | `person-list-disclosure.test.ts`, `person-list-route.test.ts`, `person-list-cursor-v1.test.ts`, `person-list-http.test.ts`, `person-original-items-v1.test.ts`, `person-meeting-list-route.test.ts`, `person-list-v1.test.ts`, `person-list-cli.test.ts`; no live qualification yet |
| `POST /v1/person/open` ([ADR-0024](../decisions/ADR-0024-person-list-open-and-mine-scope.md)) | [INV-PERMISSIONS-015](../invariants/INV-PERMISSIONS-015-layer-3-person-release-boundary.md) | The same route, always under global access: notes, documents and the caller's own imported meetings from custody, meetings through the Layer 1 exact read; no transcript opens ([ADR-0046](../decisions/ADR-0046-private-meetings-and-item-routing.md)); the route revalidates the store release, the session and the grant set | 401 for no session; 400 for a malformed ref (a `transcript:` ref included) or a cursor from another ref, person or operation; one fixed 404 `not_found` for anything unknown, unreadable, pending, rejected or past the end, and for a fence failure; 503 when a store cannot serve | The store's release audit (originals, or `person_open` for meetings), then one page audit | `person-list-disclosure.test.ts`, `person-list-route.test.ts`, `person-original-items-v1.test.ts`, `person-meeting-open-route.test.ts`, `person-list-cli.test.ts`, `only-me.spec.ts`; no live qualification yet |
| `GET /v1/person/changes` ([ADR-0036](../decisions/ADR-0036-person-change-check.md)) | [INV-PERMISSIONS-015](../invariants/INV-PERMISSIONS-015-layer-3-person-release-boundary.md) | `createPersonChangesV1` in `services/organization-authority/src/composition/person-changes-v1.ts`: the session first, then one Authority read transaction (the record check reads the record log on its own connection); projects from `SqliteProjectContextRepositoryV1.personChangeView` (the grants `captureAuthorization` gives, and the rows the V2 list pages); follow-ups through `visiblePersonalOpenItemsV1`, the reader `runs` `items` `involved` lists from: every involved row, a page at a time, through `assessOpenItemsV1`, with no bound before it, and with the record check (`readableDecisionProjects`: readability and projects only) reading the grants read in that transaction; reviews as the meeting runtime's `reviews` lists them (`proposalStatuses`: ids and statuses only). Only digests leave, never content, positions or revisions | 401 for no session or an inactive membership, before the request's shape; 400 for a query or a body; reviews that cannot be read count as none | None: the check releases no content and writes nothing; the reads it triggers are audited as ever | `person-changes-v1.test.ts` (each area moves on its changes and not on checks, others' rows or unreadable items; the ADR-0012 privacy test; no write, audit or write lock), `person-record-search-route.test.ts`, `person-meeting-runtime-v1.test.ts`, `person-changes.test.ts`; no live qualification yet |
| `GET /v1/person/project-activity` ([ADR-0047](../decisions/ADR-0047-ask-timeline.md), [Ask timeline v1](../product/2026-10-25-ask-timeline-v1.md) C2) | [INV-PERMISSIONS-015](../invariants/INV-PERMISSIONS-015-layer-3-person-release-boundary.md) | `createPersonProjectActivityV1` in `services/organization-authority/src/composition/person-project-activity-v1.ts`: the session first, then one Authority read transaction (the record reads use the record log's own connection); the caller's active projects from `SqliteProjectContextRepositoryV1.personChangeView`, at most 500; notes and documents filed by someone else through `SqlitePersonProjectActivityV1.originals`, under the person list's ACL (`personOriginalAclV1`, a quarantined note left out); meetings through the records route's `projectRecordActivity`: the exact Layer 1 check with the grants read in that transaction, leaving out the caller's own approvals (their published decisions, or the approver their signed record names); follow-ups of each project's newest 500 records moved by someone else (sent, owner set or state set), every row through `assessOpenItemsV1` with no bound before it, counted only where the policy shows the row and its decision (`readableDecisionProjects`). Only one time per project leaves, never content, ids, positions or revisions | 401 for no session or an inactive membership, before the request's shape; 400 for a query or a body | None: the read releases no content and writes nothing | `person-project-activity-v1.test.ts` (each source moves it; the caller's own notes, documents, approvals and moves do not; unreadable notes, documents, meetings and follow-ups, archived and left projects do not count; the ADR-0012 privacy test; no write, audit or write lock), `organization-authority-api-runtime.test.ts`, `person-project-activity.test.ts`; no live qualification yet |
| `POST /v1/person/ask/check` ([ADR-0047](../decisions/ADR-0047-ask-timeline.md)) | [INV-PERMISSIONS-015](../invariants/INV-PERMISSIONS-015-layer-3-person-release-boundary.md) | `createPersonAskCheckV1` in `services/organization-authority/src/composition/person-ask-check-v1.ts`, readability first: the session, then one Authority read transaction for approved records (the Layer 1 exact read with the grants read in that transaction, `readableDecisionProjects`; no search generation), source revisions (the originals ACL and global scope filter, `SqlitePersonOriginalContextRetrievalV1.checkSourceRevisions`) and follow-ups (`assessOpenItemsV1`'s `see_row`, as `runs` `item` reads one); then tickets and pages through the caller's own Jira and Confluence connections (`ticketMarkers`, `pageVersions`, `pageSections`), each tool on its own, within two metadata calls of 50 per tool, ten page bodies and 15 seconds. `changed` and a ticket's marker come only for a source the caller reads now; only states and ticket markers leave, never labels, text, counts or ids | 401 for no bearer; 400 for a malformed request (a kind other than approved records, source revisions, follow-ups, tickets and pages; a marker off a ticket; 0 or over 100 items; over 64 KiB), before the session is checked; then 401 for no session or an inactive membership; hidden, deleted, out of scope and never existed are one `unreadable`; a tool not connected, failing, over budget or past the deadline is `unknown`, reported without content; an Authority without the route answers 404, which the person client reports as `not_supported` | None: the check releases no content and writes nothing | `person-ask-check-v1.test.ts` (each kind; the ADR-0012 unreadable test; budgets, deadline and cancellation; no write, audit or write lock; the route), `person-ask-check-live-v1.test.ts` (the real Jira and Confluence connections), `organization-authority-api-runtime.test.ts`, the API's `person-ask-check-v1.test.ts`, `person-ask-check.test.ts`; no live qualification yet |
| `POST /v7/person/ask`, JSON or with `x-echo-ask-progress: 3`, global, project or `mine` ([ADR-0042](../decisions/ADR-0042-research-tool-contract.md), [ADR-0039](../decisions/ADR-0039-ask-progress-names-after-the-access-check.md), [ADR-0040](../decisions/ADR-0040-follow-ups-as-ask-evidence.md), [ADR-0024](../decisions/ADR-0024-person-list-open-and-mine-scope.md), [ADR-0047](../decisions/ADR-0047-ask-timeline.md)) | [INV-PERMISSIONS-015](../invariants/INV-PERMISSIONS-015-layer-3-person-release-boundary.md) | The V8 Ask, the only Ask route ([ADR-0047](../decisions/ADR-0047-ask-timeline.md)). `scopeOf` in `services/organization-authority/src/composition/person-answer-v3-route.ts` maps the request to exactly one scope, and the evidence desk pushes Mine into every store query: originals by the caller's tenure, records by final approver in the records route, and no live tool, follow-up or workspace source. Outside Mine the desk adds each live source bound to the asker's own connection (`bindPersonLiveEvidenceDeskV1` in `services/organization-authority/src/composition/person-live-answer-route-v1.ts`); the follow-ups source (`createPersonFollowUpsEvidenceSourceV1` in `services/organization-authority/src/composition/person-follow-ups-evidence-v1.ts`), which releases only what the open-items policy shows the asker; and the asker's workspace (`createPersonWorkspaceEvidenceSourcesV1` in `services/organization-authority/src/composition/person-workspace-evidence-v1.ts`), read as the asker: their project list and each project's roster, the organization directory (in a project Ask, only that project and its roster), and their person tools list, never a tool's site or account; and each connected tool's Jira projects or Confluence spaces, read through the asker's own connection and the audited live boundary (`createPersonToolContainerReaderV1` in `providers/shared/src/person-tool-container-reader-v1.ts`), only the mapped ones in a project Ask. A stream names items only at the model gate's `before_call` hook (`createAgenticModelGateV1` in `packages/organization-authority-kernel/src/answer-composition/agentic-model-gate-v1.ts`), after its incremental access check, for the research loop's entries first read in full (`agentic-research-loop-v1.ts`), each by its V8 citation projection; every event passes the progress V3 validators in `packages/organization-api/src/person-ask-progress-v3.ts` before it is written; the receipt is built only after `releaseAgenticResultV1` passes | 400 for Mine with a project; for Mine, 503 when the records route has no approver projectors, never a global answer. Before a stream starts, the JSON errors; after it, one final `error` event with the same status and body; the deadline or a refused check sends no further progress event and no receipt, only that `error` event; a cancellation (the client disconnected) sends nothing further. A follow-up hidden mid-run refuses the answer at the release check; at the next check, a project grant lost or replaced, a released person no longer active, a changed tool connection, or a container whose name, key, link or named ECHO projects changed refuses with `stale_access_state`. `/v7` answers JSON for any other header value; an Authority without the route 404s without the route header, which the person client reports as `not_supported`. `/v3` to `/v6` are retired and answer a plain 404 | The request's one Ask audit record (`authority_person_read_decision_audit_v2`, `answer_composition`), with `named_citation_digests` on released, cancelled and timed-out records, and each store's release audit, each named item keeping its desk release audit; one `echo-person-follow-up-release-audit-v1` row per follow-up search, list and open, content-free; one `echo-person-workspace-release-audit-v1` row per workspace search, list and open (item kinds, ids and digests only); and each container release's durable live-read audit | `person-ask-http.test.ts`, `person-ask-progress-http.test.ts`, `person-ask-progress-follow-ups-http.test.ts`, `person-ask-progress-v7-http.test.ts`, `person-evidence-desk-records.test.ts`, `person-list-disclosure.test.ts` (N-16), `person-follow-ups-ask-integration.test.ts`, `person-workspace-evidence-v1.test.ts`, `cross-source-ask-e2e.test.ts`, `agentic-ask-v1.test.ts`, the API's `person-ask-progress-v3.test.ts`, the Jira and Confluence container reader tests, and the ADR-0039, ADR-0040 and ADR-0042 negative disclosure tests; no live qualification yet |
| `POST /v1/person/runs` ([ADR-0032](../decisions/ADR-0032-stored-trigger-runs.md), [ADR-0033](../decisions/ADR-0033-shared-open-items.md)) | [INV-PERMISSIONS-015](../invariants/INV-PERMISSIONS-015-layer-3-person-release-boundary.md) | `createPersonTriggerRunsV1` in `services/organization-authority/src/composition/person-trigger-runs-v1.ts` (`list`, `start`, `retry`, `view`) and `createPersonOpenItemsV1` in `services/organization-authority/src/composition/person-open-items-v1.ts` (`home`, `items`, `item`, `send`, `set_state`, `assign`, `sweep`), the session first in each. A run is its actor's alone to list, start and retry; `view` also serves anyone who reads the run's decision now (`readableDecisions`) and rebuilds the stored card through a fresh desk under the viewer's access, hiding and counting what the viewer can no longer open. Every see and act question about an open item, and who may send a run's items, is answered in `services/organization-authority/src/composition/open-items-policy-v1.ts` (`openItemAccessV1`, `openItemSendAccessV1`) from facts read in that request (`assessOpenItemsV1`); an item's outside words come only from a live open through one desk bound to the viewer (at most 50 opens a call), then that desk's fence. Stored runs and items keep pointers, ECHO's own phrases, member ids and verdicts, never words read from outside ECHO | 401 for no session; one 404 `not_found` for a run or item the caller may not see or act on; 409 `conflict` for a send whose items changed; 400 for a malformed request or cursor, or for an act that must wait until the item is sent; an item the viewer cannot open live comes back `no_access`, and one that could not be read `unavailable`, with no outside content | The fresh desk's release audits for each item it opens and each card it rebuilds; the run and item rows hold no outside content | `person-trigger-runs-v1.test.ts`, `person-open-items-v1.test.ts`, `open-items-policy-v1.test.ts`, `person-sweep-runs-v1.test.ts`, `impact-items-v1.test.ts`, `person-runs-http.test.ts`; no live qualification yet |
| `POST /v1/person/meetings` `reviews` and `review_open` ([ADR-0030](../decisions/ADR-0030-personal-meeting-custody-and-review.md), [ADR-0046](../decisions/ADR-0046-private-meetings-and-item-routing.md)) | [INV-PERMISSIONS-015](../invariants/INV-PERMISSIONS-015-layer-3-person-release-boundary.md) | The personal meeting runtime's route in `services/organization-authority/src/composition/person-meeting-runtime-v1.ts`: the session first. A review belongs to the person who brought the meeting in, whatever projects it suggests: `reviews` lists only the caller's, and `review_open` opens a frozen proposal (or the proposal of one of its published records) only when its reviewer is the caller's exact principal and membership, naming a suggested project only when the caller can read it now; no transcript opens | 400 for a request without a bearer token or JSON body, or a malformed one; 401 for no session; one 404 `not_found` for a review that is not the caller's or does not exist | None: the importer reads their own proposal and nothing is written; a decision is written once to `authority_approval_decisions_v1` | `person-meeting-runtime-v1.test.ts`, `hand-in-person-meeting-provider-v1.test.ts`; no live qualification yet |
