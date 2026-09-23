# Project documents V1

Status: implementation candidate. Not deployed or accepted on an installed client. This feature adds file custody and retrieval; it does not add project documents to Ask or approve their contents as decisions.

## User behavior

Attach UTF-8 text/Markdown, PDF or Word `.docx` files up to **25 MiB (26,214,400 bytes)**. The app retains an immutable file snapshot for submission and retries. Notes continue to use the existing text editor. Legacy Word `.doc` and OLE-encrypted Word containers are unsupported. File extension and detected container must agree.

An upload receipt means the original was saved with its filename, title, byte count and SHA-256. Text extraction is a separate state: extracting, ready, partial, no text, encrypted, malformed, limit exceeded, timed out, unsupported or unavailable. Failed extraction leaves the original downloadable. Scanned PDFs need OCR, which this version does not provide.

Hardware, Software and QA participants can discover authorized documents in their project, search extracted text, read bounded pages with page/paragraph anchors, and download the original. A new extraction status refreshes the same document. Documents may be associated with a project at upload; changing that association after upload is not implemented in this version.

## Permissions and custody

Only me, organization and project audiences remain independent of project association. Reads opened inside a project require both a current project grant and association with that project, in addition to the audience check. Global retrieval follows the audience independently. Current authorization is rechecked and a minimized audit committed before response release. Request replay is scoped to the uploader's exact organization membership tenure and commits the entire immutable payload.

V8 separates immutable metadata, original BLOBs, extracted chunks, work state, associations, receipts and audits. Lists and searches never load original BLOBs. Original admission, quota accounting, receipt and initial extraction work commit together. Count and byte quotas cover both legacy text uploads and documents: **100 originals / 250 MiB per membership**, **1,000 originals / 25 GiB per organization**.

## Extraction and transfer limits

Word container identification at admission accepts at most 2,000 archive entries. Extraction uses an isolated, serialized worker with a 30-second deadline. It retains up to 2 MiB of UTF-8 text, processes up to 500 PDF pages, and bounds DOCX archives to 2,000 entries and 128 MiB expanded data before XML parsing. Text chunks carry original/extractor provenance and one-based page or paragraph anchors. Partial output identifies the limit reached. External relationships, scripts and network fetching are disabled.

Binary upload/download use dedicated routes, never base64 bodies or CLI stdout. Upload metadata is canonical JSON encoded as base64url in `x-echo-document-metadata`; the original is a streamed `application/octet-stream` body with exact Content-Length and SHA-256. At most two upload transfers stage concurrently. At most two original downloads may retain output buffers until completion or disconnection. Both directions have a 120-second transfer deadline. Metadata/search responses remain at most 32 KiB; extracted-text responses at most 24 KiB. Existing V1/V2 note and unrelated request limits remain unchanged.

The CLI uses `echo-brain person documents` with `upload`, `status`, `read`, `search` and `download` subcommands. Upload uses `--file`; download uses `--out` and atomically installs the verified file without overwriting an existing destination. Project-scoped reads/downloads pass `--project-id`. Unknown upload outcomes retain the immutable request snapshot for reconciliation.

## Migration and validation

Historical V7 SQL remains unchanged. New bootstrap uses a pinned additive V8 baseline. The offline V7-to-V8 copier validates the source schema and lineage, preserves legacy rows, sessions, sealed values and audits, and creates a separate validated V8 snapshot. It does not activate that snapshot on a live host. Deployment needs a reviewed host activation/migration path and the normal exact-candidate release decision.

Focused proofs cover larger Markdown, exact-limit rejection, real PDF/DOCX extraction, byte-exact download, immutable retry, permission revocation, project scope, bounded extraction, restart leases, interrupted transfer and state preservation. The SCOUT kickoff acceptance must additionally run on the installed client and target Authority before declaring the simulation ready.
