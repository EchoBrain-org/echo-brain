---
schema_version: 1
id: ADR-0014
kind: decision
title: Unified source ingestion and project-owned document processing
component_ids:
  - CMP-MEETING-PROCESSING-CORE
  - CMP-ORGANIZATION-AUTHORITY
  - CMP-PERMISSIONS
  - CMP-PERSON-CLIENT
created_at: 2026-09-23
reviewed_at: 2026-09-23
reviewed_ref: 6d90a187221258bba37a8b7a052c12f3911dc002
status: accepted
supersedes: []
superseded_by: []
updates:
  - ADR-0013
---

# ADR-0014: Unified source ingestion and project-owned document processing

## Disposition

The founder selected this direction on 2026-09-23 while preparing SCOUT's
single-project PM, Hardware, Software and QA simulation. The accepted decisions
are persistent project context, one Person source capability across input
formats, a common source ingestion boundary, immutable evidence separated from
derived content, and Person decision/action analysis only when requested.

`reviewed_ref` identifies the upload candidate examined before this extension.
It does not certify the subsequent working-tree implementation or a deployed
artifact. PR review, exact candidate qualification and release remain distinct.
The founder also confirmed staging data is disposable and there are no live
users. This removes retained staging data migration as a readiness prerequisite;
it does not authorize startup to reset state or replace the operator lane.

## Context

ADR-0013 introduced project association and audience rules for text originals.
Its initial scope deferred binary files and tied optional enrichment to the
uploader's active tenure. A pending project document would therefore stop
processing when its contributor departed, even though the project must retain
that context for existing and newly admitted members.

The document candidate added original byte custody and deterministic PDF/Word
extraction alongside meeting processing. Separate format handlers are useful;
separate source identity, admission and permission conventions are not. A
common source boundary must preserve the existing specialized processor,
approval and delivery ports without making every uploaded file a meeting or
forcing every source through decision extraction and approval.

## Decision

### One source capability, explicit downstream policy

`SourceAdapterV1<TContent>.pull()` returns a `SourceBatchV1<TContent>` containing
versioned source envelopes and an optional provider cursor. A Person adapter
pulls accepted document and text-note originals from the durable Authority inbox;
the initial HTTP
submission still pushes bytes into that inbox. The core never needs to retrieve
the file from the contributor's computer after acceptance.

`pullAndAdmitSourceBatchV1()` owns shared batch limits, canonical shape and hash
validation, source identity consistency, cancellation, and the call to
`SourceAdmissionStoreV1`. The entire batch is validated before writes. The
store atomically retains source identity, revision and typed content. A replay
returns `duplicate`; different evidence under an existing revision conflicts.
A duplicate admission does not mean extraction or another downstream job has
finished. Cursor advancement and durable work leases remain owned by their
respective processing workflows.

Person document policy is `on_request`. Its automatic work retains the
original, extracts supported text and indexes authorized document context. It
does not invoke a decision model, create approval candidates or publish
approved records. A future request-driven analysis feature must explicitly
select its evidence and still require the existing human approval boundary for
approved-record publication. This change does not add that request API.

The existing meeting workflow retains its explicit `automatic` analysis policy.
`MeetingSourceBridgeV1` adapts canonical `MeetingDocument` values to the same
source port. The production cycle durably admits them before its existing
decision processor. Zero-signal or coalesced outcomes still skip a new approval
card. Common admission does not grant Person search or Ask access to raw
meeting snapshots; those read surfaces remain separate capabilities.

### Identity, evidence, representations and authority

The common contracts are deliberately separate:

| Contract | Meaning |
| --- | --- |
| `SourceItemV1` | Schema version, stable `source_id`, adapter identity and `external_id`. Stable identity excludes adapter version. |
| `SourceRevisionV1` | Source/revision IDs, capture timestamp, typed-content digest, artifact and representation references, optional previous revision and accepted contributor principal/membership provenance. |
| `SourceEnvelopeV1<TContent>` | Item, revision and typed domain content or an artifact descriptor. No invented meeting fields for documents. |
| `SourceAdmissionScopeV1` | Authority-resolved organization, custody reference, access-policy reference and analysis policy. Supplied outside adapter content. |
| `SourceAdmissionStoreV1` | Durable admission; immutable conflicts cannot be silently overwritten. |

Adapter credentials, participant lists, source titles and provider-specific
payloads are not permission facts in the shared source record. The Person
contributor comes from the accepted authenticated command. A contributor is
not necessarily the document author, and meeting participants remain typed
meeting content. Current Authority membership and audience rules govern reads;
stored provenance never grants continuing access.

V8 stores stable identity and custody in `authority_sources_v1`, captured
revision manifests and provenance in `authority_source_revisions_v1`, typed
content in `authority_source_contents_v1`, and append-only derived content in
`authority_source_representations_v1`. All are organization-scoped. Documents
keep original bytes in their original BLOB table; their generic source content
is a descriptor referencing that artifact. These internal tables are not new
unauthenticated or generic raw-content read APIs.

Meeting observation time moves to `revision.captured_at` in the generic
envelope and is restored before the existing meeting processor. Reobserving
the same provider revision therefore does not change its content digest.
Canonical meeting content is retained inline in `authority_source_contents_v1`
with its normalizer provenance; the bridge emits no reference to an unstored
derived representation. A
richer extraction of the same original creates a new representation tied to
that input revision and processor version. Changed original evidence requires
a new revision. Database immutability guards preserve earlier evidence.

Production meeting admission rechecks the configured source identity and its
current admitted owner membership inside the transaction retaining the source.
Revocation during an awaited provider pull cannot leave newly admitted content
behind. This ingress fence is distinct from the project document rule below:
accepted shared documents have already entered organization/project custody.

### Shared document custody survives departure

Accepted `team` and `project` document originals and pending deterministic
processing belong to Authority custody. A contributor leaving the organization
or audience project cannot cancel that accepted work or remove its original,
representations or index. Shared context remains readable to current audience
members; new project members receive historical context only through current
grants. Removed members lose their content access.

`only_me` remains private, including when associated with a project. Its
processing eligibility retains the private contributor-tenure rule. Association
never changes an audience, processing authority or custody. Existing legacy
note enrichment policy is not widened by this document-processing extension.

### Client and recovery contracts

The new file family is `/v1/person/documents`, supporting UTF-8 text/Markdown,
PDF and `.docx` up to 25 MiB. Binary custody, deterministic extraction and
bounded text retrieval are the extension to ADR-0013's original text-only
scope. Legacy `.doc`, OCR, links and video processing are not implemented.
The contract leaves room for those forms under the same Person source
capability; it does not claim they work today.

Upload replay and status can return `PersonDocumentSavedV1` after the uploader
loses project content access. This minimal receipt contains the request and
document IDs, original receipt time and saved state, with schema/kind fields.
It reveals no filename, title, audience, project coordinate or original bytes.
The exact organization membership tenure must still be active and own the
request. Request IDs share the Person mutation namespace; cross-operation reuse
conflicts. Document search uses a query/account-bound keyset continuation;
concurrent insertion cannot shift an offset and repeat the previous page.

Post-upload `associate` and `dissociate` commands preserve ADR-0013's uploader,
readability and project-lead rules. A source has zero or one association; moving
it requires explicit removal first. Audience and project selection are separate
native controls. A retained exact request supports uncertain-outcome retries.

The CLI retains a bounded account-scoped immutable upload snapshot until a
matching receipt resolves it or the user explicitly abandons local recovery.
`documents pending`, `retry --request-id` and `abandon --request-id` expose that
lifecycle. Retry does not depend on the original pathname surviving. Abandon
removes local retry material only and cannot cancel or delete a server save.
Clients preserve current account/session fences and distinguish known
rejections from unknown mutation outcomes.

## Compatibility, rollout and proof

Fresh V8 bootstrap is the staging target. The optional offline V7-to-V8 copier
remains available for intentionally retained data but is not a prerequisite for
this disposable staging exercise. No ordinary startup resets data, and no
production endpoint, schema replacement or host activation is authorized by
this ADR. Release uses the existing operator lane and matched client/Authority
artifacts.

The existing `/v1/person/updates` and `/v2/person/updates` note contracts remain
strict and unchanged. Server pull bridges accepted text-note inbox entries to
the same Person source capability, with typed `person-text` content alongside
`person-document` descriptors. This admission requires no model. Existing note
read indexes and optional search-hint enrichment remain compatible; search
hints are derived metadata, not decision/action proposals. Common ingestion
does not require merging all format storage or changing the meeting approval
policy.

Required proof covers common Person/meeting admission, immutable conflict and
replay, revocation during meeting pull, departure before and during shared
document extraction, new-member history and removed-member denial, private
association, minimal receipts, keyset pagination, request namespace conflicts,
exact-byte download, parser bounds, cancellation/restart and client recovery.
Document discovery/read/download must also pass the SCOUT four-account live
exercise on the exact released candidate. Layer 4 Ask and approved-record
retrieval remain unchanged; passing source ingestion tests does not qualify
document answers or cross-document semantic analysis.
