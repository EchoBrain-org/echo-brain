# SCOUT live-test readiness

Updated: 2026-09-23. This records the conversation's decisions and the proposed closure plan. It does not implement them, authorize deployment, or certify a live environment.

## Current position

SCOUT is not ready for the intended document-capable live kickoff. PR #206 implements the source-ingestion and document/client changes described below. The original reviewed candidate was `6d90a187221258bba37a8b7a052c12f3911dc002`; its earlier passing checks did not cover subsequently discovered defects. Final code-check evidence belongs in the PR. Installed-client and live readiness still require separate qualification.

This readiness assessment refers to the reviewed candidate. Installed client and serving Authority identities must be verified during release qualification; this document does not assert their current versions.

## Decisions to preserve

1. Start with one project, SCOUT, an AI-assisted indoor courier robot. The user is the human PM using the refined ECHO app on this Mac. Hardware, Software and QA use their own authenticated ECHO accounts. Four distinct accounts are the initial working team; the earlier 10–20-person ambition is a later scale step.
2. Project-shared context has a project lifecycle. Removing a contributor revokes that person's access without removing shared history or stopping already accepted project-owned processing. A new authorized member can retrieve shared historical context. Personal-only content is not silently shared.
3. One Person source adapter handles different submission forms. Text, PDF, DOCX, links and video are formats/capabilities, not separate source identities. Text/Markdown, PDF and DOCX are the initial implementation scope; link capture and video processing can follow.
4. Context source adapters converge on one versioned source port and common admission/lifecycle rules inside Authority. Processing, approval and delivery remain separate typed capabilities. Shared rules do not require one global queue or a single serial worker.
5. A Person client submits to an authenticated, durable Authority inbox. The core pulls from the Person source adapter backed by that inbox. Retained context and subsequent work must not depend on the contributor's computer or active session.
6. Separate stable source identity, immutable captured revisions, versioned content representations and workflow state. Enriching the same original creates a new representation; changed source evidence creates a new revision. Preserve the evidence that prior answers or approved records cite.
7. The shared source contract carries core-useful identity, provenance and custody/policy references. Typed meeting/document/media content stays separate. Adapter claims cannot grant access; project association remains distinct from audience. Exact fields, contract names and physical table layout still need an implementation design.
8. SCOUT phase one automatically saves, decodes supported material and indexes it. Semantic decision/action analysis runs only when explicitly requested. Finding no proposals completes analysis without an approval task; a processing failure is a different outcome. Publishing approved records still requires human approval.

## Closure gates before Checkpoint A

The PR contains the code and regression coverage for gates 1–5. Final repository/CI results are recorded in the PR; installed-client and staging acceptance remain open. Gate 6 is a separate operator release step. The table specifies the required proof rather than claiming a live run has happened.

| Gate | Required implementation or closure | Evidence that closes it |
| --- | --- | --- |
| 1. Shared ingestion contract | Record the architecture/ADR changes; define source identity, revisions, representations, custody and typed ports. Route Person documents through common pull/admission and bridge the existing meeting source onto those mechanics without inventing meeting fields for documents. Keep current meeting workflow policy explicit and preserve unrelated configured behavior. | Contract and architecture checks; Person and meeting-source fixtures exercise the shared lifecycle; SCOUT uploads do not automatically enter decision extraction or approval. |
| 2. Durable project ownership | Replace uploader-membership-dependent eligibility for accepted project-shared work with project-custody eligibility. Keep private audiences separate. | Remove the uploader while extraction is pending: processing completes for the project; remaining members retain access; a newly admitted member reads history; the removed member is denied fresh reads. |
| 3. Correct content and recovery | Preserve exact originals; correct CR-only text loss and PDF style-run word splitting; make partial/unsupported/failed states precise; provide bounded retry/reprocessing for recoverable extraction failures without rewriting original evidence. | Full MRD/PRD plus real PDF and DOCX fixtures; requirement near the end is searchable; original download hashes match; restart/reprocessing yields traceable results without duplicate admission. |
| 4. Consistent admission and client behavior | Close receipt recovery, cross-operation request-ID conflict, unstable pagination, native error decoding, metadata/text progress races and abandoned snapshot cleanup. Complete the project association/audience controls required by the supported UI contract. | Focused regressions reproduce each former defect and pass after fixes; native and CLI checks cover known failure versus unknown outcome, exact replay, cleanup, insertion during pagination and extraction progress during reads. |
| 5. Access isolation and usable retrieval | Provide supported project discovery, search, original/text read and download through each role's own account. Authorize metadata, originals, derived content and citations consistently using current grants. | Four-account access matrix for only-me/team/project audiences; association does not widen audience; cross-person privacy is exercised; full document reference and version can be cited by each role. |
| 6. Release and operational qualification | Use the reviewed operator lane for an explicitly selected fresh V8 staging setup; build matched Authority/Mac/Linux artifacts; run required checks; release through the exact-candidate human decision. The user confirmed all staging data is disposable and there are no live users, so retained-data migration is not a launch gate. | Identify installed/serving versions, verify restart recovery within the new setup, then run the document acceptance matrix against those artifacts. Capture receipts, hashes, identities and failures. |

The 25 MiB maximum is the current candidate target. Document and verify the final supported limit, format set, extraction bounds and quota behavior. Do not describe PDF/DOCX support as support for every possible document; scanned/encrypted inputs need accurate extraction outcomes. Validate bounded processing on representative large inputs.

The earlier stress report's cross-person privacy result was NOT RUN and therefore remains open. Its isolated Ask 503 remains an unresolved Ask reliability finding. If Ask is exercised in a later checkpoint, reproduce or characterize that failure and validate source access/citations before making an Ask reliability claim. Do not hide failed operations with retries or treat the old stress score as qualification for a new candidate.

## Exact initial live exercise

1. Verify the intended environment, serving Authority identity and installed clients. Use four separate participants: PM, Hardware, Software and QA.
2. PM creates SCOUT and uploads the full matching MRD/PRD v0.1 pair, or verified PDF/DOCX exports of those versions. The condensed v0.2 pair is not proof of larger-document support.
3. Record saved source/original references, source versions, digests, project association, audience and processing status. Wait for usable extraction or report its limitation explicitly.
4. Each role independently discovers and reads both documents through ECHO using its own account. Group-chat descriptions are not a substitute for retrieval evidence.
5. On the PM's explicit kickoff instruction, each role returns a requirements review with citations, proposed ownership, cross-team dependencies, verification concerns and unresolved questions. These reviews are proposals, not approved decisions.
6. Pause for PM decisions. Only then proceed to hardware concept, software architecture, QA verification plan and a shared hardware–software interface draft.

Checkpoint A closes when access and content evidence are correct and all three reviews accurately identify the source versions, cite relevant requirements and expose unresolved dependencies. Functional failures and review quality are recorded separately.

## Later capabilities, outside Checkpoint A

- Native Ask integration with uploaded originals and cross-document synthesis. The current kickoff uses supported search/read plus explicitly requested role-agent reviews; it does not assume native Ask can read these uploads.
- A native/server interface for explicitly requested decision/action extraction, if that workflow is exercised. Before using it, bind proposals to exact source revisions, preserve human approval and distinguish source evidence from approved records in retrieval. The agreed requested-only SCOUT policy applies from the first upload regardless of when this interface ships.
- Link capture, video transcription, OCR and legacy `.doc` support. They must reuse the same source/lifecycle contracts when added.
- Automatic decision/action analysis, multi-project simulation and 10–20-person scale. Automatic analysis would require a later explicit policy decision.

## Related materials

- [Kickoff pack](README.md)
- [Document acceptance matrix](DOCUMENT-UPLOAD-ACCEPTANCE.md)
- [Group-chat kickoff](KICKOFF.md)
- [PR #206](https://github.com/EchoBrain-org/echo-brain/pull/206)

This document records the decisions and acceptance criteria in the repository. Implementation evidence and remaining release limits are recorded in PR #206; no staging state is reset by this document or by ordinary startup.
