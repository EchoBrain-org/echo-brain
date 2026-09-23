# SCOUT simulation: Phase 1 kickoff pack

SCOUT is a fictional AI-assisted indoor courier robot used to exercise coordination among a human PM and Hardware, Software and QA agents. This pack is a proposed product brief, not an ECHO product roadmap or an account of TDK procedures.

## Files

- [Live-test readiness](LIVE-READINESS.md): agreed architecture, open implementation gates and the exact initial live exercise.
- [MRD v0.1](SCOUT-MRD-v0.1.md): full user needs, first scope and proposed planning targets.
- [PRD v0.1](SCOUT-PRD-v0.1.md): full product behavior, requirement IDs, open decisions and planned verification scenarios.
- [Kickoff message](KICKOFF.md): participant instructions and upload-reference placeholders.
- [Document upload acceptance](DOCUMENT-UPLOAD-ACCEPTANCE.md): checks for larger originals, PDF and Word support.

Use the full v0.1 pair for the document-capable kickoff. The current text-only path rejects the 11,284-byte PRD because it exceeds 8,192 bytes. Larger-document support is being implemented and has not yet been accepted on this Mac or Authority. Complete the document upload acceptance checks before following the kickoff steps below.

The [MRD v0.2](SCOUT-MRD-v0.2.md) and [PRD v0.2](SCOUT-PRD-v0.2.md) are condensed alternatives prepared for the old limit. They retain the scope and requirement IDs, but are not a substitute for proving full-document support. Record the actual chosen version consistently if using them for an interim rehearsal.

## Start in the refined ECHO app on this Mac

1. The human PM reads the MRD and PRD and makes any desired changes before uploading them.
2. Confirm the app is connected to the intended staging environment and PM account. Choose **New project**, name it **SCOUT**, and add the Hardware, Software and QA participants using their individual accounts.
3. In SCOUT, choose **Add files** and select `SCOUT-MRD-v0.1.md` and `SCOUT-PRD-v0.1.md`, or verified PDF/Word exports of those same versions. Confirm **To: SCOUT**: this establishes both project audience and project association, making them eligible for project retrieval by its members.
4. Verify both files were actually saved to SCOUT with the expected filenames and contents; a selected attachment alone is not proof of saving. Capture the successful project and original references.
5. Add those references to the kickoff message, then post it to the existing group chat. Each agent verifies retrieval using its own account before reviewing.
6. Collect one requirements review per role and any brief cross-team clarification replies. Record access or service failures separately from review quality.
7. The PM resolves blocking questions or requests revisions. Drafting starts only after an explicit PM instruction.

The files have been prepared locally. No project, account, upload, group-chat message or simulation run is created by this pack.

## Evaluation boundary

For this first checkpoint, examine whether each agent actually retrieves the correct originals, cites their requirements accurately, identifies useful dependencies and preserves uncertainty. There is no hidden preferred component selection or architecture.

Separate identities are necessary to exercise cross-person permissions. Multiple personas sharing one account can rehearse the conversation, but do not establish access isolation. The group chat itself is shared context.

ECHO stores and retrieves the source material; the role agents perform the review. Native Ask is not assumed to read project originals. Record chat-only document delivery as a different exercise if ECHO access is unavailable.

Version future updates explicitly and retain the original artifacts. A new upload or a newer timestamp does not automatically approve a proposed requirement change. Record the PM's decision and the applicable document version.
