---
schema_version: 1
id: ADR-0023
kind: decision
title: Reader-scoped upload audiences and uploader-only request IDs
component_ids:
  - CMP-PERMISSIONS
  - CMP-ORGANIZATION-AUTHORITY
  - CMP-PERSON-CLIENT
  - CMP-PROTOCOLS-CRYPTO
created_at: 2026-09-29
reviewed_at: 2026-09-29
reviewed_ref: f6effed96764fcb742f65f191cb04288031a7dbc
status: accepted
supersedes: []
superseded_by: []
updates:
  - ADR-0013
  - ADR-0014
---

# ADR-0023: Reader-scoped upload audiences and uploader-only request IDs

## Context and options

Two Person read paths released more than the reader was entitled to know.

**Audience project IDs.** A `projects` upload audience (notes and documents)
was released as every stored project ID. A reader who could read the original
through one audience project learned the IDs of the others, including projects
it never joined. The affected reads were `projects feed-v2`, `search-v2` and
`read-context-v2`, `updates read-v3` and `search-v3`, and document V2
metadata, original and search. This contradicts
[ADR-0013](ADR-0013-project-context-v1-contract.md): project discovery is
limited to current members, and public results omit audience rosters. Document
`association_project_ids` were already intersected with the reader's current
grants. The audience was not.

Filtering the IDs alone still leaves a tell. The desktop app sends `project`
for one ticked project and `projects` for two or more, so `projects` with one
visible ID says the audience names other projects the reader cannot see.

**Document request IDs.** Document metadata (V1 and V2, on read, original and
search) included `request_id` for every readable document. A document's ID is
`sha256(organization_id, membership_id, request_id)`. Anyone who could read the
document could combine its `request_id` with membership IDs from
`person directory` and confirm who uploaded it.

**Note status.** `updates status-v3` returned the submitted association and
audience project IDs to the uploader even after it lost one of those grants.
Document status already returns only a minimal saved proof in that case.

The options for the audience were to filter the IDs only, or to filter them and
report a single visible project as `project`. On 2026-09-29 the owner chose to
filter and collapse, and to close the same request-ID leak on the `/v1`
document route. The owner deferred the same status check for `/v2` note status
and the Ask desk's `projects` visibility label.

## Decision and consequences

**Audiences name only the reader's current projects.** Every released
`projects` audience is intersected with the reader's current project grants.
The grants are the ones captured and rechecked by the existing release fence.
If one project remains, the audience is released as
`{kind: 'project', project_id}`. If two or more remain, it stays `projects`
with only those IDs. Stored audiences, custody, authorization and replayed
receipts are unchanged. A read that has no remaining audience project fails
closed with `invalid_output`, because authorization already required one.

**Only the uploader sees a document's request ID.** Document metadata
releases `request_id` only when the reader is the uploading tenure: the same
organization, principal and membership. Otherwise it is `null`. This covers V1
and V2 metadata, original and search. Receipts, saved proofs and status stay
uploader-only and always carry the request ID. A person who rejoins has a new
membership and is not the uploader of earlier documents.

**Note status follows document status.** `updates status-v3` returns the full
status only while the uploader holds every project it names, association and
audience. Otherwise it returns `echo-person-update-saved-v3`: request ID,
context ID, received time and `status: 'stored'`, with no project coordinates.

Contracts in `packages/organization-api`:

- `PersonDocumentMetadataV1` and `PersonDocumentMetadataV2`: `request_id` is
  `string | null`. The kinds keep their names.
- New `PersonUpdateSavedV3` and `PersonUpdateStatusResultV3`, validated by
  `validatePersonUpdateSavedV3` and `validatePersonUpdateStatusResultV3`. The
  route, Person client and Authority port use the union.

The Person client narrows a status `request_id` before reconciling a retained
document snapshot. The desktop app reads the saved-only note status as saved,
and its fixture Authority serializes the new shapes.

Out of scope: `/v2/person/updates/{id}` status keeps its current behavior. The
Ask evidence desk still labels a transcript audience `projects` when its record
names two or more projects. It releases no project IDs.

## Migration, rollback, and evidence

There is no data migration. Every change is computed at read time from existing
rows and grants. An older client fails closed on a `null` request ID or the new
status kind until the matching client is installed. The server, Person client
and desktop app therefore ship together, as
[ADR-0012](ADR-0012-person-public-response-privacy.md) requires. Rollback is a
code revert with no data change.

Negative disclosure tests use owner and employee readers, because the
organization owner has no bypass:
`services/organization-authority/test/person-upload-audience-disclosure.test.ts`
covers every affected note and document read, V1 and V2 request IDs, the
status-v3 saved proof and the served V3 note routes.
`person-documents-http-v1.test.ts` checks the served document routes.
Contract, Person client and desktop view tests cover the new shapes.
