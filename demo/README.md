# ECHO customer-value demo

This is a synthetic, production-shaped proof of ECHO's approved organizational
knowledge flow. The customer sees two surfaces: the owner's approval card (on
the desktop, or its Slack DM copy) and Ask ECHO before and after approval. Ingestion, extraction, V4 publication,
permission filtering, retrieval, and answer composition use the normal runtime
paths.

## Current qualification status

The integrated extraction-to-Slack path passed live staging on 2026-09-01:

- four real private approval cards reached the meeting owner;
- three Team records and one Only-me record reconciled at V4 head position `4`;
- pre-approval Ask ECHO disclosed nothing; and
- the team-member identity could not access the restricted commercial record.

The customer rehearsal is not yet qualified. The exact hero question produced a
complete answer in 3 of 6 trials, and the exact approver's private-price answer
omitted required scope and follow-on pricing conditions. Those are Layer-4
retrieval and answer-composition gaps; the approved records already contain the
required facts. See [RUNBOOK.md](RUNBOOK.md) for the pass gate.

Implementation note, 2026-10-08: unified meeting approval replaced the Team
audience with projects, and the four fixtures now reach the owner through the
staging synthetic personal source. The results above describe the earlier
organization-source run.

Claude Sonnet 4.6 remains the accepted pre-Slack extraction baseline. Ordinary
recall variation is deferred unless a run introduces a hard fact, status, date,
privacy, schema, or grounding failure.

## Scenario

Echo wants all 28 locations live on September 16. Four meetings settle
different parts of the answer; no single meeting contains the complete truth.

| Meeting | Approved knowledge | Policy |
| --- | --- | --- |
| Revenue signal calibration | Start with 10 locations; expansion requires four weeks of adoption evidence. | Shared project |
| Data handling review | Production requires a revised DPA and verified security contact. | Shared project |
| Implementation capacity triage | September 16 is conditional onboarding for 10, not an all-28 launch. | Shared project |
| Commercial exception review | The first 10 receive a private, time-bounded price exception. | Only me |

Audrey, a team member who attended none of the meetings, asks the hero
question. Zhen is the canonical meeting owner and reviews the proposals on the
desktop or in the Slack DM copy. The authenticated human who approves a record is preserved as
its V4 `final_approver`; ECHO does not infer a decision maker or action assignee
from transcript speakers.

## Repository structure

```text
demo/
├── README.md                 # entry point and current status
├── RUNBOOK.md                # operator sequence and pass/fail gate
├── QUERIES.md                # exact customer questions
├── SCHEMA.md                 # canonical fixture-authoring contract
├── expectations.json         # external evaluation oracle; never runtime input
├── evaluate-pre-slack.mjs    # fast, no-write extraction gate
├── meetings/                 # four canonical MeetingDocument fixtures
└── staging/                  # owner-specific fixture preparer for staging
```

Runtime code stays in the normal provider and service layers rather than
creating a parallel demo application:

```text
providers/synthetic-demo/src/
├── source/synthetic-demo-meeting-source-v1.ts
├── staging-synthetic-personal-meeting-provider-v1.ts
└── synthetic-demo-pre-slack-evaluator-v1.ts

services/organization-authority/src/composition/
├── staging/staging-synthetic-meeting-source-selection-v1.ts
└── synthetic-demo-pre-slack-evaluator-cli-v1.ts
```

Tests mirror those paths. The synthetic source changes the input
and composition, not the product pipeline, extraction configuration, or Slack
presentation.

## Evaluation

Build once, then run the no-write extraction gate against the four fixtures:

```sh
npm run build:workspaces
node demo/evaluate-pre-slack.mjs \
  --llm-credential-file /absolute/path/to/openrouter-credential
```

An optional `--model author/model-slug` compares another model without changing
the prompt, schema, fixtures, or oracle. The evaluator never sends Slack, writes
Authority state, publishes V4 records, or calls retrieval.

For a live rehearsal, follow
[Fresh four-meeting staging rehearsal](../deploy/organization-authority/README.md#fresh-four-meeting-staging-rehearsal),
then the customer sequence in [RUNBOOK.md](RUNBOOK.md), and judge the result
with its [pass/fail gate](RUNBOOK.md#passfail-gate). The captured-rehearsal
evaluator was retired on 2026-10-11 because it could only grade the retired
V3 answer.

The runtime receives only the four meeting files. `expectations.json` is applied
afterward by the pre-Slack evaluator and is never available to extraction,
retrieval, or answer composition.

## Fixture boundary

Each meeting is a complete canonical `MeetingDocument` v1, described in
[SCHEMA.md](SCHEMA.md). Before staging, copy the fixtures and replace only
`owner@example.test` with the lowercase email of the linked staging owner. Keep
the separate team-member identity outside the meeting documents. Do not hard-code
a Slack user or channel ID.

Actions carry text and optional canonical due dates only. Downstream PM tools,
which are outside this demo, assign approved work.
