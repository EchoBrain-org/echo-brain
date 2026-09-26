# SCOUT: group-chat kickoff

First complete the [document upload acceptance checks](DOCUMENT-UPLOAD-ACCEPTANCE.md) on the intended client and Authority. The currently installed text-only path cannot accept the full PRD, and larger-document support has not yet passed this checkpoint.

In the ECHO desktop app on this Mac, confirm the staging environment and PM account. Choose **New project**, name it **SCOUT**, and add the Hardware, Software and QA participants using their individual accounts. On the same page, choose **Add files…** and select `SCOUT-MRD-v0.1.md` and `SCOUT-PRD-v0.1.md`, or verified PDF/Word exports of those versions, then choose **Create**.

Each file added there is saved to SCOUT for its members, which supplies both project audience and project association. Verify both originals were actually saved with the expected contents and that their text is available for agent retrieval. Then replace the project and two original references below with values from those successful uploads. Native Ask is not assumed to read these originals.

If the agents do not yet have individual ECHO access, keep that as an explicit setup blocker. Posting the files directly in chat can support a document-review rehearsal, but does not demonstrate cross-person retrieval through ECHO.

Copy the following message once the references are available:

```text
SCOUT kickoff: Phase 1, Checkpoint A only.

I am the human PM. Keep your existing Hardware Lead, Software Lead and QA Lead assignments.

Project: [insert ECHO project reference]
MRD: SCOUT-MRD v0.1 — [insert uploaded original reference]
PRD: SCOUT-PRD v0.1 — [insert uploaded original reference]

SCOUT is a small AI-assisted courier robot. A person loads an item at the PM desk, confirms delivery to the hardware bench or QA station, and SCOUT carries it there. Someone confirms collection, then SCOUT returns HOME.

These documents are my proposed kickoff brief. Numeric targets are proposals for feasibility review. You may challenge them with reasons. Do not treat missing engineering details as permission to invent approved requirements.

Each role: use your own authorized ECHO identity to retrieve and read both originals through supported project search/read tools. Identify the document versions and original references you actually read. If access fails, report the failure and stop your dependent review. Do not use another participant's identity or claim that reading this message substitutes for reading the documents.

Return one concise requirements review containing:
1. Relevant PRD IDs, your interpretation, and proposed ownership.
2. Dependencies on the other teams, naming who needs to supply what.
3. Missing or conflicting requirements and why they matter.
4. Proposed assumptions or options, clearly labeled as proposals.
5. Verification concerns and the evidence you expect to need.

Tag each question as “PM decision needed before drafting” or “can remain open in the draft.” End with your three highest-priority questions, or fewer if that is sufficient. Cite source IDs or sections.

Hardware: focus on physical feasibility, payload, movement, power and observable hardware signals.
Software: focus on request interpretation, mission lifecycle, interfaces, command priority and interrupted operation.
QA: focus on measurable acceptance, missing criteria, state transitions and how each claim could be verified.

Address team-specific questions to the relevant role. Each role may provide one brief clarification reply after the initial reviews; proposals remain proposals until recorded otherwise.

For this checkpoint, produce the reviews and clarification replies only. Then pause for my decisions. Do not proceed to engineering drafts, implementation, physical tests or the next checkpoint until I explicitly authorize it.
```
