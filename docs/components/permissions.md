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
Every served path must link its invariant, enforcement point, denial behavior,
audit evidence, and qualification case.

Person upload reads (notes and documents) release an audience that names only
the reader's current projects, and a document request ID only to its uploader.
[ADR-0023](../decisions/ADR-0023-reader-scoped-upload-releases.md) records the
enforcement point and the negative disclosure tests.

Agentic Ask V1 is specified by [ADR-0019](../decisions/ADR-0019-agentic-ask-v1.md)
and [RFC-0002](../rfcs/RFC-0002-agentic-ask-v1.md). Its V3 route and shared evidence
desk are capability-gated; implementation and live qualification are separate.

## Served paths

| Path | Invariant | Enforcement point | Denial behavior | Audit evidence | Qualification |
| --- | --- | --- | --- | --- | --- |
| `POST /v1/person/list` ([ADR-0024](../decisions/ADR-0024-person-list-open-and-mine-scope.md)) | [INV-PERMISSIONS-015](../invariants/INV-PERMISSIONS-015-layer-3-person-release-boundary.md) | `createPersonListRouteV1` in `services/organization-authority/src/composition/person-list-v1-route.ts`: session and project grant before any store; the originals store (`SqlitePersonOriginalItemsV1`) and the records route's meeting collect, commit after their own fences and revalidate; the route rechecks the session and grant set before responding | 401 for no session, a project not joined or not existing (one body), or a grant change during the request; 400 for a cursor from another person, tenure, scope or operation; 503 for a rename during the request, a cursor page that could only wait for meetings, a mine page that reaches meetings without the composed approver projectors, or a generation that cannot serve | Originals: `authority_person_upload_read_audit_v1`. Meetings: `authority_person_read_decision_audit_v2` with read mode `person_list`. Page: `authority_project_read_audit_v1` with the response digest and the store receipts. A store that released nothing writes no row | `person-list-disclosure.test.ts`, `person-list-route.test.ts`, `person-list-cursor-v1.test.ts`, `person-list-http.test.ts`, `person-original-items-v1.test.ts`, `person-meeting-list-route.test.ts`, `person-list-v1.test.ts`, `person-list-cli.test.ts`; no live qualification yet |
| `POST /v1/person/open` ([ADR-0024](../decisions/ADR-0024-person-list-open-and-mine-scope.md)) | [INV-PERMISSIONS-015](../invariants/INV-PERMISSIONS-015-layer-3-person-release-boundary.md) | The same route, always under global access: notes and documents from custody, meetings through the Layer 1 exact read, transcripts after that read through the ADR-0017 grant; the route revalidates the store release, the session and the grant set | 401 for no session; 400 for a malformed ref or a cursor from another ref, person or operation; one fixed 404 `not_found` for anything unknown, unreadable, pending, rejected, unshared or past the end, and for a fence failure; 503 when a store cannot serve | The store's release audit (originals, or `person_open` for meetings; the transcript read audit for transcripts), then one page audit | `person-list-disclosure.test.ts`, `person-list-route.test.ts`, `person-original-items-v1.test.ts`, `person-meeting-open-route.test.ts`, `person-list-cli.test.ts`, `mine.spec.ts`; no live qualification yet |
| `POST /v3/person/ask` with `mine` ([ADR-0024](../decisions/ADR-0024-person-list-open-and-mine-scope.md)) | [INV-PERMISSIONS-015](../invariants/INV-PERMISSIONS-015-layer-3-person-release-boundary.md) | `scopeOf` in `services/organization-authority/src/composition/person-answer-v3-route.ts` maps the request to exactly one scope; the evidence desk pushes mine into every store query: originals by the caller's tenure, records by final approver in the records route, no shared transcript (`readableTranscriptGrant`) and no Slack | 400 for mine with a project; 503 when the records route has no approver projectors, never global; the Ask denials otherwise | The Ask answer audit (`authority_person_read_decision_audit_v2`, `answer_composition`) and each store's release audit, as for global Ask | `person-answer-v3-http.test.ts`, `person-evidence-desk-records.test.ts`, `person-list-disclosure.test.ts` (N-16), `agentic-ask-v1.test.ts`; no live qualification yet |
