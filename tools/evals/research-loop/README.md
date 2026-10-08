# Research loop evaluation

Measures ECHO's research loop stage by stage on the THERM world in staging:
did the planner ask the right questions, did the tools find and read the
evidence, did research reach the right verdicts, and did the writer use what
it was given. Design: [`docs/product/2026-10-06-research-loop-eval-v1.md`](../../../docs/product/2026-10-06-research-loop-eval-v1.md).

Three triggers run the same loop:

- **Ask**: a typed question, live budget (90 s), graded on the research result
  and the answer.
- **Approved record** (replaces Check): an approved meeting record, background
  budget (5 min), graded on the research result and the impact card.
- **Sweep**: earlier findings re-read after partial fixes (world state S1),
  background budget, graded on the research result and each finding's verdict.

The report keeps the loop and the renderers apart. **Research loop**: every
trigger, graded on its research result (needs, found, read, handed,
established, verdicts). **Renderers**: Ask's writer on its answer, and the
impact card on affected items listed, relations and owners correct (of the
listed items), invented items or people, and gaps reported. Approved-record
keys carry a relation and an owner per affected item (`world/README.md`).

**Baselines across the research trigger contract.** Ask is byte-identical
across that change, so an Ask baseline taken before or after it measures the
same thing. Grading changed, though: the judge's prompt now covers the impact
card, and the summary's Ask-writer `gaps_reported` now averages Ask cases only
(the card's gaps and Sweep's plan gaps have their own rows). Regrade an older
Ask baseline with the current `grade` before comparing it. Approved-record and
Sweep baselines must be taken after the change: their task text changed, and
approved-record runs now return the impact card (a saved approved-record run
without one is graded as failed).

A case whose start request cannot be built (a meeting not bound, or a finding
that cites only a transcript, which cannot start research in v1) is saved as a
`case_not_startable` error and the run goes on; the report counts it in its
first line as not started.

The evaluation workflow is founder-run and starts research runs on staging as
the signed-in person. It does not edit Jira or Confluence. The separate
`trace` command below captures ordinary product requests in production or
staging; an approved-record capture can start an existing pending ECHO run.

## What is where

| Path | What it is |
| --- | --- |
| `world/` | The THERM additions and S1 edits to seed by hand (see `world/README.md`). |
| `cases/development.json` | Cases used while improving the loop. |
| `cases/holdout.json` | Held-out cases. Open them only for the final check. |
| `cli.mjs` | `validate`, `bindings`, `run`, `grade`, `report`, `calibrate`, `trace`. |
| `lib/` | Reference matching, code checks, judge, report, calibration. |

## Founder steps, in order

1. **Deploy staging with the endpoint on.** Release a build that contains this
   evaluation through the operator playbook with the fixed staging connector
   rehearsal profile selected. Its release-bound EC2 Compose sets
   `ECHO_STAGING_RESEARCH_EVAL_V1=true` from that existing selection; do not edit
   the host environment. Without the profile the endpoint stays off. The CLI
   refuses the switch on any other Authority origin.
2. **Seed the THERM world** by hand, following `world/README.md`: the ECHO
   project `THERM` and its Jira/Confluence mapping, due dates and assignments,
   the DVT review paragraph, meetings M1–M6 through intake and approval, and
   the restricted project for M6.
3. **Build and sign in locally.** `npm ci && npm run build`, then sign the ECHO
   CLI in to staging as the test person. The runner reuses that session.
4. **Bind citations** (Jira ids from your export, approved meeting records from
   staging):

   ```bash
   npm run eval:research-loop -- bindings --export ~/Desktop/ECHO-Atlassian-Export-2026-10-06 --project-id prj_… --test-person "Your Name" --out ~/.local/state/echo-research-loop-eval-20261006
   ```

   If a meeting is reported as not found, add its approved-record citations to
   `bindings.json` by hand. The search runs inside the THERM project, so a
   meeting it cannot find may belong to no project (see "Approved-record
   scope").
5. **Baseline at S0** (Ask and approved record, three runs each, plus one
   background-budget run of every live Ask):

   ```bash
   npm run eval:research-loop -- run --run --model <loop-model-id> --split development --state S0 --trials 3 --background-diagnostic --out ~/.local/state/echo-research-loop-eval-20261006
   ```

   `--model` is the operator-declared identifier for the configured loop model;
   it is recorded with every run and must be identical before a report is made.
   Each run also records the commit it ran from; a report needs one commit, so
   use a fresh `--out` directory after changing the code.

6. **Sweeps at S1.** Apply `world/s1.json` `apply` by hand, run
   `--state S1` with the same explicit `--model`, then apply `revert` and
   confirm S0 is restored.
7. **Grade.** With a judge (a Claude model through OpenRouter, never the loop's
   model):

   ```bash
   npm run eval:research-loop -- grade --judge-model <openrouter-claude-slug> --judge-credential-file ~/.config/echo/openrouter.credential --out ~/.local/state/echo-research-loop-eval-20261006
   ```

   `--no-judge` grades code checks only (found, read, handed over, leaks, cost).
8. **Calibrate the judge for this grading pass.** `calibrate sheet` requires 15
   judged runs and writes a blind sheet; answer every check `true` or `false`
   without opening `graded.json`, then `calibrate score`. The result is bound to
   that exact `graded.json`. Judge numbers count only when every sheet answer is
   present and founder agreement is at least 90%.
9. **Report.** `report` writes `report.md` and `report.json` beside the runs.
   It withholds judge-derived metrics unless the current grading pass has a
   trusted calibration result; code-check metrics remain available. It refuses
   if any run was added, removed or rewritten since `grade`; grade again.
10. **Holdout** runs only for the final check of a loop change: `--split holdout`.

Before any loop change, write down which report numbers it must raise and
which must not get worse (spec section 5).

## Approved-record scope

An approved-record request names no project: the run reads where its record
is. When the test person can read exactly one project the record belongs to,
the run reads that project; when the record is in no project, in several, or
only in projects they cannot read, it reads everything they can read (still
access-checked). So if the THERM meeting records belong to no project on
staging, approved-record runs search everything the test person can read, and
wider results are not a bug. To check, run
`echo-brain person list --project <THERM project id>`: M1 to M5 appear only if
their records belong to THERM. Linking the records to THERM during seeding
(choose THERM as each meeting's project when approving it) narrows the runs to
THERM.

## Privacy

### One ordinary-request diagnostic trace

After deploying a capture-enabled server and building its matching Person
client, capture one project-scoped Ask through the **ordinary live Ask route**:

```bash
npm run eval:research-loop -- trace --run --question "Why is Thermo DVT on hold and what must happen before PVT starts?" --project-id prj_… --out ~/.local/state/echo-thermo-diagnostic-<run>
```

This works in production and staging. It does not start an evaluation or need
the staging evaluation switch. The client first prepares an actor-bound capture
through `/v1/person/diagnostics`, saves its server-generated `capture_id` in
`receipt.json`, and only then sends the ordinary Ask with that capture attached.
The capture id is correlation, not authorization: every read authenticates the
same person and revalidates access to retained source evidence, including when
the product request failed. The runner never retries execution automatically.

The export includes exact model-port inputs (system/user prompts, schema, model
and limits), structured model responses including repair attempts, model-facing
tool requests/results, and lifecycle events surrounding research and output.
These are the model's exposed decisions, not hidden reasoning or raw provider
HTTP/authentication traffic. Related-item references can be inspected in the
exact subsequent prompt's `opened` and `seen` fields.

| Saved path | Contents |
| --- | --- |
| `request.json` | The selected operation, local start time and source revision. |
| `receipt.json` | The prepared capture receipt, saved before product execution. |
| `execution-request.json` | The exact ordinary Ask or run-start request. |
| `product-response.json` | The successful product response, when received. |
| `product-error.json` | A sanitized product failure, when execution fails. |
| `result.json` | The exact authenticated diagnostic response, including its retained events. |
| `events/` | One JSON file per exact event, in sequence order. |
| `models/` | Exact model requests and system/user prompt text, plus readable JSON copies of JSON user prompts. |
| `inventory.json` | An index of captured calls and events for inspection. |
| `transcript.md` | A readable view of the captured execution. |
| `summary.json` | Capture completeness and request/terminal-event pairing checks. |

**Capture completeness and product success are separate.** A failed Ask can
have a complete trace; a successful answer can have an incomplete trace. A
truncated, missing or incomplete capture is saved and reported as incomplete.
Capture is bounded to 8 MiB and 512 events per run. Exact payloads stay in
bounded server memory; CloudWatch and Journey Explorer retain separate,
content-free operational metadata.

If execution or polling is interrupted, use the saved capture id to resume
**reading only**, including when the ordinary Ask response was lost:

```bash
npm run eval:research-loop -- trace --capture-id cap_… --out ~/.local/state/echo-thermo-diagnostic-<run>
```

A prepared capture expires after 15 minutes if unused. A terminal capture
expires after 15 minutes, shortened to a 60-second reread window after its first
successful terminal read. Expiry or a server restart makes the in-memory
payload unavailable; durable operational metadata does not reconstruct it.
Do not start another product request to recover the same capture.

To capture an existing **pending, already approved** record run instead of an
Ask, use its durable run id:

```bash
npm run eval:research-loop -- trace --run --trigger-run-id run_… --out ~/.local/state/echo-approved-record-diagnostic-<run>
```

This prepares a capture bound to that run and calls the ordinary `runs:start`
operation once. It does not approve a meeting or retry a failed run.

An existing completed export is never overwritten. Keep all trace files
outside the repository as private source content; output directories are
`0700` and files are `0600`.

### Evaluation-run privacy

Runs contain released text from Jira, Confluence and approved meetings. A
saved run keeps the research result (the trimmed bundle) and Ask's answer or
the impact card, never server records such as receipts or model-call
fingerprints. Runs are written only to `--out`, which must be an absolute
directory outside this repository; directories are `0700` and files `0600`.
The judge receives the answer key, the items research read and the run's
answer or card, and nothing else. Delete the output directory when the
evaluation is finished.

## Limits to keep in mind

- Every THERM item carries a "SYNTHETIC MOCK" banner; the baseline measures how
  much hedging it causes.
- The global cross-project cases meet the ECHO distractors only if the test
  person can reach Jira project ECHO or page 589865 through a mapped project.
- History-only facts (when a ticket moved to Done) are expected to be not
  found: Ask cannot read Jira history today.
- Questions over 240 characters are rejected at ingress, as in the product;
  the report counts them as rejected rather than skipping them.
