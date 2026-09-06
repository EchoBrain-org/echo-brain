# ECHO customer-value demo

This is a synthetic, production-shaped proof of ECHO's approved organizational
knowledge flow. The customer sees two surfaces: a private Slack approval card
and Ask ECHO before and after approval. Ingestion, extraction, V4 publication,
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

Claude Sonnet 4.6 remains the accepted pre-Slack extraction baseline. Ordinary
recall variation is deferred unless a run introduces a hard fact, status, date,
privacy, schema, or grounding failure.

## Scenario

Echo wants all 28 locations live on September 16. Four meetings settle
different parts of the answer; no single meeting contains the complete truth.

| Meeting | Approved knowledge | Policy |
| --- | --- | --- |
| Revenue signal calibration | Start with 10 locations; expansion requires four weeks of adoption evidence. | Team |
| Data handling review | Production requires a revised DPA and verified security contact. | Team |
| Implementation capacity triage | September 16 is conditional onboarding for 10, not an all-28 launch. | Team |
| Commercial exception review | The first 10 receive a private, time-bounded price exception. | Only me |

Audrey, a team member who attended none of the meetings, asks the hero
question. Zhen is the canonical meeting owner and receives the private
approval cards. The authenticated human who approves a record is preserved as
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
├── evaluate-rehearsal.mjs    # captured end-to-end rehearsal gate
├── meetings/                 # four canonical MeetingDocument fixtures
├── staging/                  # isolated same-host staging and cached card preview
└── test/                     # demo harness tests
```

Runtime code stays in the normal service layers rather than creating a parallel
demo application:

```text
services/organization-authority/src/
├── processing/adapters/meeting-sources/synthetic-demo/
│   └── synthetic-demo-meeting-source-v1.ts
├── composition/providers/synthetic-demo/
│   ├── synthetic-demo-admitted-meeting-source-cursor-policy-v1.ts
│   ├── synthetic-demo-meeting-source-admission.ts
│   ├── synthetic-demo-meeting-source-bundle-v1.ts
│   └── synthetic-demo-pre-slack-evaluator-v1.ts
├── composition/synthetic-demo-organization-authority-cli.ts
├── composition/synthetic-demo-organization-authority-composition-root-v1.ts
└── synthetic-demo-main.ts
```

Tests mirror those service-layer paths. The synthetic source changes the input
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

For a live rehearsal in an isolated operator environment, follow the customer
sequence in [RUNBOOK.md](RUNBOOK.md). Evaluate the captured result with:

```sh
node demo/evaluate-rehearsal.mjs \
  --result path/to/rehearsal-result.json \
  --meetings-dir path/to/personalized-meetings
```

The runtime receives only the four meeting files. `expectations.json` is applied
afterward by the evaluator and is never available to extraction, retrieval, or
answer composition.

## Fixture boundary

Each meeting is a complete canonical `MeetingDocument` v1, described in
[SCHEMA.md](SCHEMA.md). Before staging, copy the fixtures and replace only
`owner@example.test` with the lowercase email of the linked staging owner. Keep
the separate team-member identity outside the meeting documents. Do not hard-code
a Slack user or channel ID.

Actions carry text and optional canonical due dates only. Downstream PM tools,
which are outside this demo, assign approved work.
