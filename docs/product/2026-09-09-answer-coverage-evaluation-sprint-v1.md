# Answer coverage evaluation sprint V1

Status: implemented; review and live qualification pending. Original baseline:
`main` at `db5153e` (PR #152). Integrated with `c67fcd3` (PRs #154 and #155).
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
| Team rollout | Answered | Promise limit; first-10 conditional window; production prerequisites and September 12 readiness; outstanding work and its six deadlines; four-week adoption gate and later expansion review. |
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

## Implemented capture contract

The external oracle now has 21 cases: the four original cases, four supporting
questions, one supported false-premise question, and two paraphrases for each of
six core answered questions, varying Echo/Northstar aliases, date formats and
wording. `answer_groups` declares each group's category,
text checks, allowed source meetings and `allow_insufficient` policy once.
Each case supplies an ordered `material_group_ids` list and a direct
`primary_case_id`; paraphrases must retain their primary's access context,
groups, citation set, outcome and forbidden text. All groups in this fixed,
approved-record scenario require answers. The evaluator also tests an explicitly
permitted group-level insufficiency using a modified synthetic oracle.

The hero and both paraphrases ask what work remains and when it is due. Their
required groups therefore include the six work deadlines and the later expansion
review, even though a separate supporting question also tests that information.
An independent regression rejects the earlier six-group answer that omitted this
clause. The 180-word hero limit is retained.

The captured-result CLI is unchanged. Existing captures must be extended with
all cases and the following evidence before they can pass:

- Each answer includes its exact `principal` and `approval_state`, plus
  `record_generation_id` and `release_head` for answered cases. `release_head`
  is the exact release/source-head identifier used for that capture, not the
  evaluator's current checkout.
- The existing `claims` array now uses stable `group_id` mappings instead of
  positional `fact_index`. Each mapping includes `outcome`, `observed_text`,
  and `citation_meeting_ids`. An answered span must appear in the answer,
  contain every required phrase and cite only allowed sources also present
  in answer-level citations. A permitted insufficient mapping uses the oracle's
  exact `insufficient_answer` and has no group citations. Answer-level citations
  still equal the case's expected visible meeting set.
- Every answered case has one `determinism` entry bound to its capture's exact
  generation/head, with distinct `trial_id` values. Successful trials contain
  the same evidence fields as answers. At least two successful trials must agree
  with that case's capture in outcome, text, groups, citations and record IDs.
  The hero additionally needs six consecutive successful trials. Different
  cases and different generation/head pairs are never compared for equality.
- An unavailable trial records `outcome: "unavailable"`, the same generation/head,
  `trial_id`, `http_status`, and `reason_code`, without answer evidence. Reasons
  use the existing public `unavailable` code or content-free Layer 4 failure
  classes such as `adapter_timeout`; provider messages are rejected. The report
  retains total, success, unavailable, HTTP 503 and per-reason counts. The 503
  rate is `status_503_count / trial_count`. An unavailable attempt interrupts the
  consecutive hero sequence even when successful outputs are stable.
- Optional `retrieval.released_atom_count` and `retrieval.context_atom_count`
  are copied from existing content-free answer-composition evidence. Coverage
  reports distinguish `empty`, `nonempty` and `not_captured` context alongside
  missing group IDs. Nonempty context does not prove that a particular omitted
  group's source reached composition; record IDs alone do not prove that either.

CLI reports contain check results, static case/group IDs, bounded reason codes
and counts. They do not print captured answer spans, provider messages or parse
error excerpts. No runtime or telemetry schema is changed.

The original failing baseline was a duplicate captured hero case: the existing
10 tests passed, while the new rejection test failed with `true !== false` and
Node exit status 1. The required `check` CI job now runs
`node --test demo/test/rehearsal-evaluator.test.mjs` directly, without a failure
mask; its result feeds the existing `CI required checks` aggregate.

Synthetic positives prove this evaluator contract only. Deterministic phrase
checks are deliberately narrow and cannot establish semantic truth, catch every
possible contradiction, verify capture authenticity or measure live product
quality. Runtime changes and live qualification remain separate under `Refs #112`.
