# Research loop evaluation

Measures ECHO's research loop stage by stage on the THERM world in staging:
did the planner ask the right questions, did the tools find and read the
evidence, did research reach the right verdicts, and did the writer use what
it was given. Design: [`docs/product/2026-10-06-research-loop-eval-v1.md`](../../../docs/product/2026-10-06-research-loop-eval-v1.md).

Three triggers run the same loop:

- **Ask**: a typed question, live budget (90 s), graded on the research result
  and the answer.
- **Check**: an approved meeting record, background budget (5 min), graded on
  the research result.
- **Sweep**: earlier findings re-read after partial fixes (world state S1),
  background budget, graded on the research result and each finding's verdict.

Everything here is founder-run. The tool never writes to Jira, Confluence or
ECHO; it only starts research runs on staging as the signed-in person and
reads their results.

## What is where

| Path | What it is |
| --- | --- |
| `world/` | The THERM additions and S1 edits to seed by hand (see `world/README.md`). |
| `cases/development.json` | Cases used while improving the loop. |
| `cases/holdout.json` | Held-out cases. Open them only for the final check. |
| `cli.mjs` | `validate`, `bindings`, `run`, `grade`, `report`, `calibrate`. |
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
   `bindings.json` by hand.
5. **Baseline at S0** (Ask and Check, three runs each, plus one background-budget
   run of every live Ask):

   ```bash
   npm run eval:research-loop -- run --run --model <loop-model-id> --split development --state S0 --trials 3 --background-diagnostic --out ~/.local/state/echo-research-loop-eval-20261006
   ```

   `--model` is the operator-declared identifier for the configured loop model;
   it is recorded with every run and must be identical before a report is made.

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
   trusted calibration result; code-check metrics remain available.
10. **Holdout** runs only for the final check of a loop change: `--split holdout`.

Before any loop change, write down which report numbers it must raise and
which must not get worse (spec section 5).

## Privacy

Runs contain released text from Jira, Confluence and approved meetings. They
are written only to `--out`, which must be an absolute directory outside this
repository; directories are `0700` and files `0600`. The judge receives the
answer key and the items research read, and nothing else. Delete the output
directory when the evaluation is finished.

## Limits to keep in mind

- Every THERM item carries a "SYNTHETIC MOCK" banner; the baseline measures how
  much hedging it causes.
- The global cross-project cases meet the ECHO distractors only if the test
  person can reach Jira project ECHO or page 589865 through a mapped project.
- History-only facts (when a ticket moved to Done) are expected to be not
  found: Ask cannot read Jira history today.
- Questions over 240 characters are rejected at ingress, as in the product;
  the report counts them as rejected rather than skipping them.
