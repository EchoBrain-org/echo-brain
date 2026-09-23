# SCOUT document upload acceptance

Status: planned acceptance for the larger-document implementation. These checks have not been run against an updated installed client or Authority.

The PM must be able to upload ordinary project documents without shortening their contents to fit the earlier 8 KiB text carrier. The target document path accepts supported originals up to 25 MiB and retains their original bytes. PDF and Word `.docx` extraction produces a separate searchable representation.

## Source artifacts

Use the full [MRD v0.1](SCOUT-MRD-v0.1.md) and [PRD v0.1](SCOUT-PRD-v0.1.md) as regression inputs, as well as the current [MRD v0.2](SCOUT-MRD-v0.2.md) and [PRD v0.2](SCOUT-PRD-v0.2.md). The original v0.1 PRD exceeds 8 KiB and must not require shortening or splitting. Any PDF or DOCX export must preserve the source version, requirement IDs and planning qualifications.

The v0.2 files remain a fallback for the currently installed text-only client; their smaller size is not evidence that larger documents are supported.

## Acceptance matrix

| Step | Expected evidence |
| --- | --- |
| Create SCOUT and add Hardware, Software and QA | Four distinct authenticated participants; PM can identify the project and its members. |
| PM uploads the full Markdown PRD | One saved-original receipt, exact size and digest; no silent shortening. |
| PM uploads a PDF and a DOCX with actual requirement content | Each original is saved once; detected format and extraction status are visible. |
| Agents independently discover the project documents | Each role retrieves through its own account and cites the original identity and source version. |
| Search for a requirement near the end of each document | An authorized result links to the correct original and extraction location; a prefix-only summary must not masquerade as full-document search. |
| Read extracted text | Page or paragraph anchors, bounded pagination and any incomplete-extraction warning are preserved. |
| Download each original | Downloaded byte count and SHA-256 equal the uploaded file. |
| Retry a submission whose result was unknown | Exact replay yields the same original; changed bytes or metadata under the same request ID conflict. |
| Upload a scanned or encrypted PDF | Original availability and extraction limitation are reported separately; no invented searchable content. |
| Remove an actor's project membership | Fresh access to project-audience original, extraction and download is denied; project association does not widen another audience. |
| Upload a file at the documented maximum and one byte above | Exact-limit valid input follows the supported path; over-limit input is rejected clearly without a saved phantom original. |
| Restart processing during an extraction | Receipt and original remain stable; extraction resumes or reports a recoverable failure without duplicate admission. |

## PM checkpoint

Once the document path passes, post the [kickoff message](KICKOFF.md) with the actual references. Hardware, Software and QA return requirements reviews, dependencies and questions. They stop for the PM's decisions before producing engineering drafts.

Record source SHA, installed client identity, Authority identity, file digests, access outcomes and extraction outcomes with the run. Source tests, an offline render or a Cloud implementation alone do not prove that this Mac can use the new document path.
