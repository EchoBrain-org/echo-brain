# Answer coverage evaluation sprint V1

Status: implementation handoff. Baseline: `main` at `db5153e` (PR #152).
Worktree: `.worktrees/answer-coverage-112`; branch: `test/answer-coverage-112`.
Tracking: `Refs #112`; issue #112 remains open because runtime prompt and
validation decisions remain separate.

## Goal

Make the fixed Northstar rehearsal reject an answer that covers only part of a
multi-part question. An answered capture must cover each required conclusion and
condition group with the source meeting that supports it. A capture may instead
say that a particular group has insufficient accessible evidence when the case
expectation permits that outcome.

This evaluation-only sprint creates a failing baseline for a later Layer 4
change. A fabricated passing fixture does not prove product answer quality.

## Exact scope

Extend the existing external-only rehearsal contract in these files:

| File | Change |
| --- | --- |
| `demo/expectations.json` | Define the complete case inventory, material conclusion/condition groups, permitted insufficient-evidence groups, per-group provenance, and paraphrase-to-primary mapping. |
| `demo/evaluate-rehearsal.mjs` | Validate captured results against that oracle and fail closed on malformed or incomplete coverage evidence. |
| `demo/test/rehearsal-evaluator.test.mjs` | Add focused positive and synthetic negative captured-result tests for the extended evaluator. |
| `.github/workflows/ci.yml` | Run that existing Node test command in the required `check` job; no new workflow or test runner. |

Keep the captured-result CLI and its external-only oracle boundary. Do not create
another harness, directory, executable evaluator, model judge, or provider call.
The golden fixture and `expectations.json` stay evaluator input only and never
enter extraction, retrieval, answer composition, runtime configuration, or staging.

Read [AGENTS.md](../../AGENTS.md). Implement and verify offline, then commit,
push and open a PR using the [existing template](../../.github/pull_request_template.md).
No private staging files, credentials, live provider/AWS calls, login, deployment
or merge are needed. The separate operator session owns live acceptance.

## Case inventory

Retain each existing primary case and require one capture for each:

| Primary case | Expected result | Required groups |
| --- | --- | --- |
| Before-approval rollout | Neutral insufficient answer | No disclosure, citation, retrieval, or hint of hidden records. |
| Team rollout | Answered | Promise limit; first-10 conditional window; production prerequisites and September 12 readiness; four-week adoption gate. |
| Team private price | Neutral insufficient answer | No price, scope, term, pricing follow-on, citation, retrieval, or existence hint. |
| Exact approver private price | Answered | Price; first-10-only scope; 30-day evaluation; standard-pricing/Finance follow-on. |

Add supporting answered cases for safe commitment, first-10 prerequisites,
remaining work and dates, and the expansion rule. Add an unauthorized or
pre-approval neutral case only when approved-record state makes it unsafe; a
question premise never makes inaccessible information answerable.

For core answered questions, add two or three meaning-preserving paraphrases.
Vary name aliases, date formats, and wording such as “go live,” “commit,” “initial locations,”
and “what still has to happen,” while preserving the primary case's principal,
authorization, actual dates/entities, groups, outcome, and forbidden disclosures. Each maps to one
primary semantic case, not a new conversation mode.

## Oracle and capture shape

Each case has a stable ID, primary-case ID (or itself), question, principal,
approval state, expected outcome, and ordered material groups. Every group declares:

- a stable group ID and category (`conclusion` or `condition`);
- the required phrases or other deterministic textual checks;
- one or more allowed source meeting IDs; and
- whether the group must be answered or can be reported as insufficient.

The capture maps one observed answer span to every answered group and lists its
source meeting IDs. The span must occur in the answer; provenance must be allowed
and present in answer-level citations, which equal the expected visible meeting set.

Use precise deterministic checks, not a semantic-model score. Keep output
content-free apart from the already captured answer evidence; do not add live
answer text to telemetry or logs.

## Failure rules

Reject a result when expected and captured case-ID sets differ: missing,
duplicate, or unexpected. Also reject duplicate/unknown/unmapped groups,
duplicate mappings, absent required groups, an absent span or phrase, invalid
provenance, or a case-wide citation substituted for group evidence.

Preserve permission checks: inaccessible/pre-approval cases require the neutral
insufficient-accessible-evidence outcome, empty citations/retrieval IDs, and
existing forbidden-text checks. A wrong premise about accessible Team facts
should instead be corrected with evidence (for example, a claimed confirmed
28-location launch). Neutral wording must preserve the intended distinctions;
neither neutral wording nor a wrong premise automatically requires refusal.

## Repeatability and availability evidence

For every answered primary case and paraphrase, record trials against the exact
`record_generation_id` and release/head. Compare outcome, text, groups, citations,
and record IDs only within that unchanged pair.

Record availability separately: trial, success, unavailable, and 503/reason
counts. A deterministic subset does not erase unavailable attempts. Reuse existing
telemetry/captured outcomes; do not infer absent context versus omitted answer
without content-free evidence that distinguishes them.

## Test evidence

Use synthetic captured responses to prove the evaluator rejects bad evidence:

- a hero answer missing one conclusion or one prerequisite;
- a repeated group or a duplicated, missing, or unexpected case;
- a paraphrase whose required group or source provenance differs from primary;
- an inaccessible-record answer with a citation, retrieval, disclosure, or
  existence hint; a supported wrong-premise question answered with false assent
  or unnecessary refusal; and
- a repeat with a changed generation/head or separately recorded unavailability.

One structurally complete synthetic pass exercises the contract only, not live
runtime, retrieval, provider behavior, product quality, or readiness.

## Source map and execution boundary

| Work | Source map | Local proof |
| --- | --- | --- |
| Oracle and evaluator contract | `demo/expectations.json`, `demo/evaluate-rehearsal.mjs` | `node --test demo/test/rehearsal-evaluator.test.mjs` |
| Contract regressions | `demo/test/rehearsal-evaluator.test.mjs` | `node --test demo/test/rehearsal-evaluator.test.mjs` |
| Documentation | this handoff | `npm run check:docs` |

Start from `db5153e` after `npm ci --no-audit --no-fund`. Proofs use local
fixtures only and do not authorize live AWS/provider, staging, credentials,
login, merge, or release actions.

First demonstrate an evaluator gap with a failing synthetic negative test.
After the fix, run the focused tests and `npm run check` before opening the PR.
The Vitest include list currently excludes `demo/test/*.mjs`; a green existing
CI run therefore does not prove these tests ran. Wire their explicit Node command
into the existing required job and verify that a failed evaluator test fails CI.

Avoid `tools/evals/`, any BM25 evaluator path, and scheduler files. BM25 and
scheduler progress belongs to other worktrees. Do not alter runtime prompts,
Layer 3 boundaries, canonical fields or schema, ranking, citation UI, telemetry
schema, or product surfaces in this evaluation-only change.

## Handoff acceptance

Ready for review: focused test and documentation check pass; the diff is limited
to the evaluation files, their existing CI job and this handoff; it uses `Refs #112`, not
`Closes #112`. A later runtime proposal must independently demonstrate its change.

Preparation baseline: independent dependencies installed; **10 existing evaluator
tests passed** and `npm run check:docs` passed. No workspace build was needed for
these source-only tests. This baseline does not establish live answer quality.
