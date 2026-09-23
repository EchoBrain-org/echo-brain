# Project documents V1

Status: implementation candidate. Not deployed or accepted on an installed client. This feature adds file custody and retrieval; it does not add project documents to Ask or approve their contents as decisions. The accepted extension to the earlier text-only scope is [ADR-0014](../decisions/ADR-0014-unified-source-ingestion-and-document-custody.md).

## User behavior

Attach UTF-8 text/Markdown, PDF or Word `.docx` files up to **25 MiB (26,214,400 bytes)**. The app retains an immutable file snapshot for submission and retries. Notes continue to use the existing text editor. Legacy Word `.doc` and OLE-encrypted Word containers are unsupported. File extension and detected container must agree.

An upload receipt means the original was saved with its filename, title, byte count and SHA-256. Text extraction is a separate state: extracting, ready, partial, no text, encrypted, malformed, limit exceeded, timed out, unsupported or unavailable. Failed extraction leaves the original downloadable. Scanned PDFs need OCR, which this version does not provide.

Hardware, Software and QA participants can discover authorized documents in their project, search extracted text, read bounded pages with page/paragraph anchors, and download the original. A new extraction status refreshes the same document. The reader reconciles a bounded extraction-state change between metadata and text requests while preserving exact original identity and account fences.

Audience and project association have separate controls. An uploader who can read the document and belongs to a target project may link it after upload. An uploader or current project lead who can read it may remove that link. A second project association conflicts: remove the existing link before linking another project. Association changes never edit the original or its audience, and an uncertain mutation retains its exact request for retry. Metadata reports the current association; the immutable full upload receipt retains the initial association. Recovery must not mistake a valid later link change for a changed original.

## Permissions and custody

Only me, organization (`team`) and project audiences remain independent of project association. Reads opened inside a project require both a current project grant and association with that project, in addition to the audience check. Global retrieval follows the audience independently. Current authorization is rechecked and a minimized audit committed before response release. Request replay is scoped to the uploader's exact organization membership tenure and commits the entire immutable payload. Request IDs share the Person mutation namespace, so reusing an ID for another operation conflicts.

Accepted shared documents remain in Authority custody. A contributor's departure does not cancel pending `team` or `project` extraction, delete shared originals or remove derived context. New authorized project members can read associated historical material; removed members cannot. Private `only_me` processing retains its contributor-tenure eligibility and association does not change that policy.

After losing project access, the uploader's still-active original membership may recover a minimal `echo-person-document-saved-v1` receipt. It contains schema/kind, request ID, document ID, receipt time and saved state, without title, filename, audience, project IDs or bytes. Status and an exact upload replay can return that proof without restoring content access.

V8 separates immutable metadata, original BLOBs, extracted chunks, work state, associations, receipts and audits. Lists and searches never load original BLOBs. Original admission, quota accounting, receipt and initial extraction work commit together. Count and byte quotas cover both legacy text uploads and documents: **100 originals / 250 MiB per membership**, **1,000 originals / 25 GiB per organization**.

Document search uses an opaque continuation bound to its account and query with the last returned sort key. New uploads do not shift an offset and repeat earlier results. Text pages use bounded chunk ordinals tied to the original and extractor. Continuation never grants access; each page applies current authorization again.

## Shared source processing

One `PersonSourceAdapterV1` pulls accepted documents from the Authority inbox through `SourceAdapterV1<TContent>`. The same `pullAndAdmitSourceBatchV1()` boundary also admits meeting content through `MeetingSourceBridgeV1`. Format-specific parsers sit behind the Person adapter; they are not separate source identities.

Shared metadata is split across `authority_sources_v1` (organization-scoped identity and custody), `authority_source_revisions_v1` (immutable capture/provenance and hashes), `authority_source_contents_v1` (typed domain content) and `authority_source_representations_v1` (versioned derived output). The document source contains a descriptor referencing its retained original; byte custody stays in the document original table. Contributor principal and membership are provenance, not ongoing processing credentials. Authority supplies custody and access-policy references separately from source content.

The worker automatically extracts supported text and populates authorized document search. Its source policy is `on_request`: it does not automatically infer decisions/actions, send source text to a decision model or create approval cards. This version does not provide a new request-driven analysis endpoint. The existing meeting workflow retains its explicit automatic analysis policy, and original/Ask read paths remain distinct.

Admission replay is separate from processing completion. A worker can resume an accepted revision after interruption without creating a second source. Derived output references the exact original revision and extractor version; richer future extraction must create a new representation instead of replacing evidence. Existing note-editor `/v1/person/updates` and `/v2/person/updates` contracts remain compatible: accepted notes also enter the shared Person source through server pull without a model, while their existing read indexes and optional search-hint enrichment remain available.

## Extraction and transfer limits

Word container identification at admission accepts at most 2,000 archive entries. Extraction uses an isolated, serialized worker with a 30-second deadline. It retains up to 2 MiB of UTF-8 text, processes up to 500 PDF pages, and bounds DOCX archives to 2,000 entries and 128 MiB expanded data before XML parsing. Text chunks carry original/extractor provenance and one-based page or paragraph anchors. Partial output identifies the limit reached. External relationships, scripts and network fetching are disabled.

Transient `unavailable` and `timed_out` results retry automatically after one second and then two seconds, with at most three claims in total. Expired leases consume the same attempt budget. The final failed result remains explicit and the original remains available to authorized readers. Terminal evidence is not rewritten, and this version has no manual re-extraction command.

Binary upload/download use dedicated routes, never base64 bodies or CLI stdout. Upload metadata is canonical JSON encoded as base64url in `x-echo-document-metadata`; the original is a streamed `application/octet-stream` body with exact Content-Length and SHA-256. At most two upload transfers stage concurrently. At most two original downloads may retain output buffers until completion or disconnection. Both directions have a 120-second transfer deadline. Metadata/search responses remain at most 32 KiB; extracted-text responses at most 24 KiB. Existing V1/V2 note and unrelated request limits remain unchanged.

## CLI and local recovery

The CLI uses `echo-brain person documents`:

| Command | Behavior |
| --- | --- |
| `upload --file …` | Captures and submits an immutable original with selected audience and association. |
| `status --request-id …` | Returns current authorized metadata or the minimal saved proof. |
| `read --document-id …`, `search` | Returns authorized bounded content; project context is selected with `--project-id`. |
| `download --document-id … --out …` | Verifies bytes/hash and atomically installs a file without overwriting an existing destination. |
| `associate --document-id … --project-id … --request-id …` | Adds a project link without changing audience. |
| `dissociate --document-id … --project-id … --request-id …` | Removes the specified link without deleting the original. |
| `pending` | Lists this account's retained local upload requests without a network call or exposing original filesystem paths. |
| `retry --request-id …` | Resends the exact retained bytes and metadata, including after restart or original file deletion. |
| `abandon --request-id …` | Explicitly removes local retry material only; the Authority outcome is unchanged. |

Unknown upload outcomes retain the bounded account-scoped immutable request snapshot. Matching full or minimal saved receipts reconcile it. Abandoning local recovery cannot cancel a server save; retain the request ID and check status or search before starting a new upload. Native recovery exposes status/retry and explicit abandonment when starting another upload. Known input/quota/snapshot rejections remain distinct from an unknown mutation outcome.

Native document actions expose linking and unlinking, with a retained exact request for retry after restart. Dismissing a local reminder does not cancel a possibly completed server mutation. Every retry remains bound to the captured Authority/account; session changes conceal stale content and cannot retarget a queued request.

## Staging and validation

Historical V7 SQL remains unchanged. New bootstrap uses a pinned additive V8 baseline. The founder confirmed the staging data is disposable and there are no live users, so retaining or migrating its old data is not a prerequisite for SCOUT qualification. A fresh exact V8 environment is the target through the existing operator lane; ordinary startup must never reset state implicitly.

The optional offline V7-to-V8 copier validates source schema and lineage, preserves retained rows, sessions, sealed values and audits, and creates a separate validated V8 snapshot. It does not activate that snapshot on a host and is not a blocker for fresh staging. Exact candidate release, matched client/Authority installation and a bounded live rehearsal remain required.

Focused proofs cover larger Markdown, exact-limit rejection, real PDF/DOCX extraction, byte-exact download, immutable retry, shared-custody departure, new-member history, private association, minimal receipt recovery, keyset continuation, cross-operation request conflicts, project scope, bounded extraction, restart leases and interrupted transfer. The SCOUT kickoff acceptance must additionally run with four separate accounts on the installed client and target Authority before declaring the simulation ready. Link/video capture, OCR, legacy `.doc`, document Ask and cross-document semantic analysis remain outside this release.
