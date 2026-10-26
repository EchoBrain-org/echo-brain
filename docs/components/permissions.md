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

- [Organization permission architecture](../product/2026-08-09-organization-permission-architecture.md)
- [Permission pilot V1](../product/2026-08-10-permission-pilot-v1-contract.md)
- [Invariant registry](../product/2026-08-11-architecture-invariant-registry.md)
- [Reviewer permission V1](../product/2026-08-11-reviewer-permission-v1-log-facts-design.md)
- [Permission-aware searchable Layer 2](../product/2026-08-11-trusted-permission-aware-searchable-layer-2-design.md)
- [Project context V1 contract](../decisions/ADR-0013-project-context-v1-contract.md)

## Documentation rule

Permission claims must name their enforcement scope. A bounded pilot or one
retrieval operation is not evidence of a globally enforced permission system.
The served-path table below covers the ADR-0024 paths; other served Person read
paths are governed by
[INV-PERMISSIONS-015](../invariants/INV-PERMISSIONS-015-layer-3-person-release-boundary.md)
and the ADR that introduced them.

Person upload reads (notes and documents) release an audience that names only
the reader's current projects, and a document request ID only to its uploader.
[ADR-0023](../decisions/ADR-0023-reader-scoped-upload-releases.md) records the
enforcement point and the negative disclosure tests.

Ask is specified by [ADR-0019](../decisions/ADR-0019-agentic-ask-v1.md) as
updated by [ADR-0022](../decisions/ADR-0022-agentic-ask-only.md): the V3 route
and shared evidence desk are composed whenever an answer model is configured,
with no capability switch. Live qualification is separate.

## Served paths

| Path | Invariant | Enforcement point | Denial behavior | Audit evidence | Qualification |
| --- | --- | --- | --- | --- | --- |
| `POST /v1/person/list` ([ADR-0024](../decisions/ADR-0024-person-list-open-and-mine-scope.md)) | [INV-PERMISSIONS-015](../invariants/INV-PERMISSIONS-015-layer-3-person-release-boundary.md) | `createPersonListRouteV1` in `services/organization-authority/src/composition/person-list-v1-route.ts`: session and project grant before any store; the originals store (`SqlitePersonOriginalItemsV1`) and the records route's meeting collect, commit after their own fences and revalidate; the route rechecks the session and grant set before responding | 401 for no session, a project not joined or not existing (one body), or a grant change during the request; 400 for a cursor from another person, tenure, scope or operation; 503 for a rename during the request, a cursor page that could only wait for meetings, a mine page that reaches meetings without the composed approver projectors, or a generation that cannot serve | Originals: `authority_person_upload_read_audit_v1`. Meetings: `authority_person_read_decision_audit_v2` with read mode `person_list`. Page: `authority_project_read_audit_v1` with the response digest and the store receipts. A store that released nothing writes no row | `person-list-disclosure.test.ts`, `person-list-route.test.ts`, `person-list-cursor-v1.test.ts`, `person-list-http.test.ts`, `person-original-items-v1.test.ts`, `person-meeting-list-route.test.ts`, `person-list-v1.test.ts`, `person-list-cli.test.ts`; no live qualification yet |
| `POST /v1/person/open` ([ADR-0024](../decisions/ADR-0024-person-list-open-and-mine-scope.md)) | [INV-PERMISSIONS-015](../invariants/INV-PERMISSIONS-015-layer-3-person-release-boundary.md) | The same route, always under global access: notes, documents and the caller's own imported meetings from custody, meetings through the Layer 1 exact read; no transcript opens ([ADR-0046](../decisions/ADR-0046-private-meetings-and-item-routing.md)); the route revalidates the store release, the session and the grant set | 401 for no session; 400 for a malformed ref (a `transcript:` ref included) or a cursor from another ref, person or operation; one fixed 404 `not_found` for anything unknown, unreadable, pending, rejected or past the end, and for a fence failure; 503 when a store cannot serve | The store's release audit (originals, or `person_open` for meetings), then one page audit | `person-list-disclosure.test.ts`, `person-list-route.test.ts`, `person-original-items-v1.test.ts`, `person-meeting-open-route.test.ts`, `person-list-cli.test.ts`, `mine.spec.ts`; no live qualification yet |
| `GET /v1/person/changes` ([ADR-0036](../decisions/ADR-0036-person-change-check.md)) | [INV-PERMISSIONS-015](../invariants/INV-PERMISSIONS-015-layer-3-person-release-boundary.md) | `createPersonChangesV1` in `services/organization-authority/src/composition/person-changes-v1.ts`: the session first, then one Authority read transaction (the record check reads the record log on its own connection); projects from `SqliteProjectContextRepositoryV1.personChangeView` (the grants `captureAuthorization` gives, and the rows the V2 list pages); follow-ups through `visiblePersonalOpenItemsV1`, the reader `runs` `items` `involved` lists from: every involved row, a page at a time, through `assessOpenItemsV1`, with no bound before it, and with the record check (`readableDecisionProjects`: readability and projects only) reading the grants read in that transaction; reviews as the meeting runtime's `reviews` lists them (`proposalStatuses`: ids and statuses only). Only digests leave, never content, positions or revisions | 503 when not composed; then 401 for no session or an inactive membership, before the request's shape; 400 for a query or a body; reviews that cannot be read count as none; an Authority without the route answers 404, which the person client reports as `not_supported` | None: the check releases no content and writes nothing; the reads it triggers are audited as ever | `person-changes-v1.test.ts` (each area moves on its changes and not on checks, others' rows or unreadable items; the ADR-0012 privacy test; no write, audit or write lock), `person-record-search-route.test.ts`, `person-meeting-runtime-v1.test.ts`, `person-changes.test.ts`; no live qualification yet |
| `GET /v1/person/project-activity` ([ADR-0047](../decisions/ADR-0047-ask-timeline.md), [Ask timeline v1](../product/2026-10-25-ask-timeline-v1.md) C2) | [INV-PERMISSIONS-015](../invariants/INV-PERMISSIONS-015-layer-3-person-release-boundary.md) | `createPersonProjectActivityV1` in `services/organization-authority/src/composition/person-project-activity-v1.ts`: the session first, then one Authority read transaction (the record reads use the record log's own connection); the caller's active projects from `SqliteProjectContextRepositoryV1.personChangeView`, at most 500; notes and documents filed by someone else through `SqlitePersonProjectActivityV1.originals`, under the person list's ACL (`personOriginalAclV1`, a quarantined note left out); meetings through the records route's `projectRecordActivity`: the exact Layer 1 check with the grants read in that transaction, leaving out the caller's own approvals (their published decisions, or the approver their signed record names); follow-ups of each project's newest 500 records moved by someone else (sent, owner set or state set), every row through `assessOpenItemsV1` with no bound before it, counted only where the policy shows the row and its decision (`readableDecisionProjects`). Only one time per project leaves, never content, ids, positions or revisions | 503 when not composed; then 401 for no session or an inactive membership, before the request's shape; 400 for a query or a body; an Authority without the route answers 404, which the person client reports as `not_supported` | None: the read releases no content and writes nothing | `person-project-activity-v1.test.ts` (each source moves it; the caller's own notes, documents, approvals and moves do not; unreadable notes, documents, meetings and follow-ups, archived and left projects do not count; the ADR-0012 privacy test; no write, audit or write lock), `organization-authority-api-runtime.test.ts`, `person-project-activity.test.ts`; no live qualification yet |
| `POST /v1/person/ask/check` ([ADR-0047](../decisions/ADR-0047-ask-timeline.md)) | [INV-PERMISSIONS-015](../invariants/INV-PERMISSIONS-015-layer-3-person-release-boundary.md) | `createPersonAskCheckV1` in `services/organization-authority/src/composition/person-ask-check-v1.ts`, readability first: the session, then one Authority read transaction for approved records (the Layer 1 exact read with the grants read in that transaction, `readableDecisionProjects`; no search generation), source revisions (the originals ACL and global scope filter, `SqlitePersonOriginalContextRetrievalV1.checkSourceRevisions`) and follow-ups (`assessOpenItemsV1`'s `see_row`, as `runs` `item` reads one); then tickets and pages through the caller's own Jira and Confluence connections (`ticketMarkers`, `pageVersions`, `pageSections`), each tool on its own, within two metadata calls of 50 per tool, ten page bodies and 15 seconds. `changed` and a ticket's marker come only for a source the caller reads now; only states and ticket markers leave, never labels, text, counts or ids | 503 when not composed; then 401 for no bearer; 400 for a malformed request (a kind other than approved records, source revisions, follow-ups, tickets and pages; a marker off a ticket; 0 or over 100 items; over 64 KiB), before the session is checked; then 401 for no session or an inactive membership; hidden, deleted, out of scope and never existed are one `unreadable`; a tool not connected, failing, over budget or past the deadline is `unknown`, reported without content; an Authority without the route answers 404, which the person client reports as `not_supported` | None: the check releases no content and writes nothing | `person-ask-check-v1.test.ts` (each kind; the ADR-0012 unreadable test; budgets, deadline and cancellation; no write, audit or write lock; the route), `person-ask-check-live-v1.test.ts` (the real Jira and Confluence connections), `organization-authority-api-runtime.test.ts`, the API's `person-ask-check-v1.test.ts`, `person-ask-check.test.ts`; no live qualification yet |
| `POST /v3/person/ask` with `mine` ([ADR-0024](../decisions/ADR-0024-person-list-open-and-mine-scope.md)) | [INV-PERMISSIONS-015](../invariants/INV-PERMISSIONS-015-layer-3-person-release-boundary.md) | `scopeOf` in `services/organization-authority/src/composition/person-answer-v3-route.ts` maps the request to exactly one scope; the evidence desk pushes mine into every store query: originals by the caller's tenure, records by final approver in the records route, and no Slack | 400 for mine with a project; 503 when the records route has no approver projectors, never global; the Ask denials otherwise | The Ask answer audit (`authority_person_read_decision_audit_v2`, `answer_composition`) and each store's release audit, as for global Ask | `person-answer-v3-http.test.ts`, `person-evidence-desk-records.test.ts`, `person-list-disclosure.test.ts` (N-16), `agentic-ask-v1.test.ts`; no live qualification yet |
| `POST /v5/person/ask` with `x-echo-ask-progress: 1` ([ADR-0039](../decisions/ADR-0039-ask-progress-names-after-the-access-check.md)); retired 2026-10-19, so `/v5` now answers it in JSON, and these are the stream rules `/v6` and `/v7` keep | [INV-PERMISSIONS-015](../invariants/INV-PERMISSIONS-015-layer-3-person-release-boundary.md) | Names only at the model gate's `before_call` hook (`createAgenticModelGateV1` in `packages/organization-authority-kernel/src/answer-composition/agentic-model-gate-v1.ts`), after its incremental access check, for the research loop's entries first read in full (`agentic-research-loop-v1.ts`); every event passes the exact-key validators in `packages/organization-api/src/person-ask-progress-v1.ts` before it is written; the receipt is built only after `releaseAgenticResultV1` passes | Before the stream starts, today's JSON errors; after it, one final `error` event with the same status and body; the deadline or a refused check sends no further progress event and no receipt, only that `error` event; a cancellation (the client disconnected) sends nothing further | The request's one Ask audit record (`authority_person_read_decision_audit_v2`, `answer_composition`) adds `named_citation_digests` on released, cancelled and timed-out records; each named item keeps its desk release audit | `person-ask-progress-v1.test.ts` (wire contract and framing) and the ADR-0039 negative disclosure tests; no live qualification yet |
| `POST /v6/person/ask`, JSON or with `x-echo-ask-progress: 2` ([ADR-0040](../decisions/ADR-0040-follow-ups-as-ask-evidence.md), [ADR-0039](../decisions/ADR-0039-ask-progress-names-after-the-access-check.md)) | [INV-PERMISSIONS-015](../invariants/INV-PERMISSIONS-015-layer-3-person-release-boundary.md) | The V7 Ask: the `/v5` desk and checks plus the follow-ups source (`createPersonFollowUpsEvidenceSourceV1` in `services/organization-authority/src/composition/person-follow-ups-evidence-v1.ts`), which releases only what the open-items policy shows the asker, outside Mine; its stream is `/v5`'s, every event passing the progress V2 validators in `packages/organization-api/src/person-ask-progress-v2.ts`, so a follow-up is named only by its citation projection, after the access check before the call that reads it | As `/v5`; a follow-up hidden mid-run refuses the answer at the release check; `/v6` answers JSON for any other header value, and an Authority without the route 404s without the route header, the only case a client falls back to `/v5` | As `/v5`, plus one `echo-person-follow-up-release-audit-v1` row per follow-up search, list and open, content-free | `person-ask-progress-v6-http.test.ts`, `person-ask-progress-v2.test.ts`, `person-follow-ups-ask-integration.test.ts` and the ADR-0040 negative disclosure tests; no live qualification yet |
| `POST /v7/person/ask`, JSON or with `x-echo-ask-progress: 3` ([ADR-0042](../decisions/ADR-0042-research-tool-contract.md), [ADR-0039](../decisions/ADR-0039-ask-progress-names-after-the-access-check.md)) | [INV-PERMISSIONS-015](../invariants/INV-PERMISSIONS-015-layer-3-person-release-boundary.md) | The V8 Ask: the `/v6` desk and checks plus the asker's workspace (`createPersonWorkspaceEvidenceSourcesV1` in `services/organization-authority/src/composition/person-workspace-evidence-v1.ts`), read as the asker and never in Mine: their project list and each project's roster, the organization directory (in a project Ask, only that project and its roster), and their person tools list, never a tool's site or account; and each connected tool's Jira projects or Confluence spaces, read through the asker's own connection and the audited live boundary (`createPersonToolContainerReaderV1` in `providers/shared/src/person-tool-container-reader-v1.ts`), only the mapped ones in a project Ask. Its stream is `/v6`'s, every event passing the progress V3 validators in `packages/organization-api/src/person-ask-progress-v3.ts`, so a workspace item or container is named only by its V8 citation projection, after the access check before the call that reads it | As `/v6`; at the next check, a project grant lost or replaced, a released person no longer active, a changed tool connection, or a container whose name, key, link or named ECHO projects changed refuses with `stale_access_state`; `/v7` answers JSON for any other header value; an Authority mounted without the V8 Ask answers 503 with the route header, and one without the route 404s without it, the only case a client falls back to `/v6` | As `/v6`, plus one `echo-person-workspace-release-audit-v1` row per workspace search, list and open (item kinds, ids and digests only) and each container release's durable live-read audit | `person-ask-progress-v7-http.test.ts`, `person-workspace-evidence-v1.test.ts`, `cross-source-ask-e2e.test.ts`, `person-ask-progress-v3.test.ts`, the Jira and Confluence container reader tests and the ADR-0042 negative disclosure tests; no live qualification yet |
