# Research loop evaluation v1

Status: implemented on branch `feat/research-loop-eval` (base main `b108ad3`,
which includes #280, #281 and #282). Founder steps remain: deploy staging with
the switch on, seed the THERM additions, run the baseline and calibrate the
judge (`tools/evals/research-loop/README.md`).

## Goal

Optimize the research loop: the planner should ask the right questions, have
the tools to gather all the evidence, and hand its consumer everything it needs.
Ask is one trigger of that loop, not the loop itself. An approved record
(Check) and a project sweep (Verify) are the next two triggers; a changed
ticket comes later.

We cannot improve the loop without measuring it, and we cannot measure it
today. Round one therefore separates the loop from Ask, makes its result
visible on staging, and builds a rubric and dataset that grade each stage. Loop
changes come after the baseline.

## Why the loop cannot be measured today

- Research and the Ask writer are one function,
  `createAgenticAskCore` in
  `packages/organization-authority-kernel/src/answer-composition/agentic-ask-v1.ts`.
  Only a typed question can start it and only one paragraph comes out. The
  plan, need statuses, items read and stop reason are discarded at the end of
  the request; the audit keeps counts and hashes only.
- Staging telemetry is content-free by design, so a missing fact cannot be
  traced to the planner, the tools, or the writer.
- There is no graded question set. The synthetic evaluator in
  `tools/evals/agentic-ask` has nine process checks. The Answer Lab
  (`~/Desktop/echo-answer-lab`, last run 2026-09-25) measured an older loop
  over uploaded documents only. RFC-0003 planned a multi-source test set that
  was never built.

Known gaps the baseline is expected to show (verified at `b108ad3`):

| Gap | Where |
| --- | --- |
| Questions over 240 code points or 32 distinct terms are rejected before research | `packages/organization-api/src/person-query.ts:24`, desktop `ask.tsx:94` |
| Round 1 sees no item counts, keys or labels; wrong needs can only be retired as `not_found` after two searches | `agentic-ask-v1.ts:1018`, `agentic-ask-research-state-v1.ts:34` |
| Ticket and page search/list return metadata only; each body needs its own `open`, four actions per round | `agentic-ask-v1-model-protocol.ts:15` |
| A Jira open returns summary and description up to 3 KB: no comments, history, links or updated date | `providers/jira/src/jira-payload-v1.ts:65` |
| `list` status and owner filters apply to meeting actions only | `agentic-ask-v1.ts:403` |
| Items without released text never reach the writer | `agentic-ask-v1.ts:1117` |
| The writer gets no plan; the answer is one part of at most ten sentences | `agentic-ask-v1.ts:1144` |

## Round one

1. Split the loop out of Ask with no change in Ask behavior, and prove it.
2. Add a staging-only research endpoint that runs any trigger.
3. Build the dataset, answer keys, grader and runner.
4. Take the baseline for Ask, Record approved and Project sweep.

Out of scope: any loop improvement (prompts, limits, tools, a `conflict`
status), writers for the change card and drift report, the server-held read
grant that background triggers need to run without a live session (it needs
its own ADR), the ticket-changed trigger, and sources Ask cannot read (Slack,
SharePoint, Teams, email).

## 1. Splitting the loop

Research and writing share state today: released items, a request-wide budget
of 24 model calls, the deadline, and the access recheck before every model
call. The split has three parts.

**Request session (shared).** Owns the deadline and cancellation, the
model-call budget, the access recheck before each call, retry and repair, and
generation observations. Research and writer both call the model through it,
so one call budget still covers the whole request.

**Research loop.** One implementation for every trigger: planner, lookups,
finish gate, stop rules and request-local evidence ids.

- In: the acting person and scope (the request-bound evidence desk, as today),
  the goal (kind and text), starting evidence, and a budget.
- Out: the research result (section 2).

**Ask as a trigger.** Builds the inputs from the question (acts as the asker,
no starting evidence, today's limits), runs research, then today's writer,
response layout, final revalidation and audit, unchanged.

**Proof that Ask is unchanged.**

- Every existing test stays green and `npm run check` passes.
- A replay test drives scripted model replies with pinned `now_ms` and
  `today`, covering finish, each stop reason, a repair, a writer fallback and
  a live-source request. Golden values of the audit's existing `prompt_sha256`
  (all invocations) and `response_sha256` are recorded from `b108ad3` before
  the split; the split must reproduce them exactly.

## 2. The research result

Everything the loop knows when it stops. The loop builds it, the trigger's
consumer reads it, and the staging endpoint returns it.

1. **Goal**: trigger kind, goal text, budget.
2. **Plan**: parts and needs; each need has text, status (`open`, `found`,
   `not_found`) and evidence ids; each part keeps its notes.
3. **Items**: every item released to research, with short id, source, kind,
   title, citation, date and date meaning, attributes, text when released,
   and flags: read in full, opened, preloaded, cited by the plan.
4. **Rounds**: per round, the plan after it, the actions (tool and normalized
   arguments), what each returned (item ids, notes, errors), rejected replies
   and the validation reason, and time spent.
5. **Coverage**: reads, unread inventories and notices, as the writer gets
   them today.
6. **Stop**: reason (`finished`, `empty_catalog`, `no_progress`,
   `step_limit`, `budget`, `unusable_step`) and whether research completed.
7. **Cost**: rounds, model calls, repairs, tokens, model time, desk time.
8. **Receipts**: for the audit.

Rounds and item flags are new bookkeeping. They never enter a prompt.

Two views:

- **Server view**: the full result with desk ids and refs. Never stored;
  discarded when the trigger's consumer finishes.
- **Eval view**: the same without desk ids, refs and receipts. Every item in
  it was already released to the person running the trigger.

Ask also returns its writer input (which items fit the writer budget, in
order) and its answer beside the eval view, so "handed to the writer" can be
graded. Answer keys match items by citation (Jira key, page id, record,
document), never by short id.

## 3. Trigger inputs

| | Ask | Record approved (Check) | Project sweep (Verify) |
| --- | --- | --- | --- |
| Acts as | the asker | the approver | the PM running it |
| Scope | as requested | the record's project | the project |
| Goal | the question | check this record against the project | recheck earlier findings |
| Starting evidence | none | the approved record | items cited by earlier findings, re-read fresh |
| Budget | live | background | background |

**Planner framing.** Ask keeps today's prompt and request payload exactly.
Check and Sweep share the same rules and tools and add one task paragraph and
their own request fields in place of `question`. Draft wording, kept
organization-neutral:

- Check: "An approved record is already read as E1. Split it into its
  decisions, requirements and actions. For each, find what in the project
  agrees with it, conflicts with it, or must change: other approved
  decisions, tickets, pages and documents. For each, find the owner and any
  date it puts at risk against a stated milestone."
- Sweep: "Each earlier finding names what was expected to change and the
  items cited then. Re-read the current items and find their current state.
  Never treat a finding as resolved without reading the current item."

**Starting evidence** loads through the normal access-checked desk path as
preloaded, read items, like today's small-scope preload. The evidence open
route (`/v3/person/evidence/open`) already opens meeting records and documents
by citation; tickets and pages need the same through their exact-read paths.
A sweep never reuses earlier text.

**Budgets.**

- Live (Ask): 90 s deadline, 10 rounds, 24 model calls, 4 reads per round,
  25 s writer reserve.
- Background (Check, Sweep): initial values 5 minutes, 20 rounds, 48 model
  calls; other limits unchanged.
- Diagnostic: Ask cases also run once at the background budget, to separate
  budget limits from loop limits.

Round one grades Check and Sweep on the research result only. Statuses stay
`open`, `found` and `not_found`; the grader decides "conflicts" and "landed"
from the cited evidence.

## 4. Dataset and answer keys

**A closed world.** The keys can only grade "not found" if every relevant item
in the world is known. The world is the existing **THERM** mock project on
`echobrain.atlassian.net`, plus a small set of additions written together with
the keys. Situations follow design-partner PM interviews (2026-09-28 to 10-04)
and the agreed DVT gate demo flow; no names, numbers or text from those
interviews enter the fixtures.

**S0 inventory (existing).** The founder's export of 2026-10-06
(`~/Desktop/ECHO-Atlassian-Export-2026-10-06`, hash-bound `manifest.json`) is
the record of S0. It is local and never committed.

- Jira project THERM (id `10003`), 54 issues: three requirement threads
  (MRD-01 accuracy, MRD-02 visible reading, MRD-03 phone sync), each with a
  hardware story, a firmware story, subtasks, an interface agreement and a
  bring-up task; EVT, DVT and PVT test cases as tasks; BUG-412 (39.0 °C
  observed versus 37.2 °C expected under load); TRACE-01; DVT-R2; gate tickets
  (EVT pass, DVT hold, PVT not started); MRD/PRD reviews; an open-decisions
  register. 234 history entries. No assignees, due dates or comments; owners
  appear as roles in descriptions.
- Confluence space THERM (id `1015812`), 7 pages: MRD, PRD (requirement table
  with trace and verification status), verification plan with every test
  procedure, traceability with a BUG-412 walkthrough, gate reviews, and
  "Assumptions and decisions — source facts versus proposals".
- Distractors already present: Jira ECHO and the founder's personal space use
  the same EVT/DVT language about a different product; SAM1 and MDP add noise.
- Every THERM item carries a "SYNTHETIC MOCK" banner. The baseline keeps it and
  measures hedging and false abstention it causes; stripping it is a founder
  decision because the demo uses the same content.

**Additions (seeded, shown for founder approval before any write).**

- An ECHO project "THERM" mapped to Jira `10003` and Confluence `1015812`.
- Due dates on about five tickets (BUG-412, SW-14c, TRACE-01, DVT-R2,
  GATE-DVT) and a DVT review date, for the fix-date-versus-gate case.
- About four tickets assigned to the test person's Jira account, for "what do
  I owe".
- Four to six meetings through the normal intake and approval path: a customer
  meeting that approves a two-decimal display on MRD-02 (T1); a DVT review
  that sets the DVT-R2 date (T2); a failure review that decides BUG-412's
  likely cause (T3); a sync whose transcript only discusses when samples
  arrive.
- Restricted access: one THERM-related approved record in an ECHO project the
  test person does not belong to. ECHO enforces that boundary; one Atlassian
  user cannot exercise Atlassian restrictions.
- S1 for Sweeps: a few status and page edits, for example SW-22b updated for
  two decimals while its test case stays stale, and BUG-412 set Done while
  DVT-R2 has not run. The seeding tool applies and reverts S1.

Meetings enter through the normal intake and approval path, never by writing
to the database. The THERM world stays frozen during runs; any edit outside
the seeding tool invalidates the keys.

**Situations mapped to THERM.**

| # | Situation | Kind | THERM thread |
| --- | --- | --- | --- |
| 1 | Bug fix dates against the DVT review date | cross-check | added due dates and review date |
| 2 | What is blocking the DVT gate | status | GATE-DVT hold: TC-D-03 fail, BUG-412 open |
| 3 | DVT readiness item by item | cross-check | GATE-DVT exit criteria |
| 4 | A failed test traced to requirement and tickets | multi-hop lookup | TC-D-03 → BUG-412 → MRD-01 → HW-11 / SW-14; TRACE-01 unconfirmed link |
| 5 | A requirement change that did not reach QA | cross-check | T1 meeting, PRD, SW-22b, TC-D-06 |
| 6 | Who approved that change, and when | lookup | T1 approved record versus discussion |
| 7 | Which build QA is testing | honest gap | DVT-R2: candidate not identified |
| 8 | Test coverage of PRD requirements | cross-check | PRD rows without tests |
| 9 | What the asker owes for the gate | status | added assignments |
| 10 | When DVT samples arrive | honest gap | sync transcript only |
| 11 | When a test case moved to Done | honest gap | Jira history Ask cannot read today |

Trigger scenarios: T1 a customer meeting approves a two-decimal display; T2 a
DVT review sets the DVT-R2 date; T3 a failure review decides BUG-412's likely
cause.

**World states.** S0 is the start; all Ask cases and Checks run there. S1
applies partial fixes for the Sweeps.

**Cases.** About 30: about 20 Ask questions (the eleven situations and
single-fact variants), 3 Checks, 3 Sweeps. Three runs each. A third are held
out in a separate file that tuning sessions do not open; that is a working
rule, not access control.

**Answer key per case** (the Answer Lab format, extended):

- id, trigger, state, scope, signed-in person, question or record, budget;
- expected outcome: answerable, partial or not found;
- parts: each fact to establish (fact, date, owner, status, conflict or
  change) with every acceptable supporting item by citation and section;
- expected needs: the questions a good plan contains, matched by meaning;
- gaps: facts that must be reported as not found or unconfirmed;
- must not: claims that fail the run;
- never appears: restricted items;
- distractors: items that count as noise if handed to the writer;
- Sweep only: the expected verdict per earlier finding (landed, not landed,
  no evidence) and the item that proves it.

Claude drafts the world and keys; the founder reviews the keys.

## 5. Grader and staging runner

**Location.** `tools/evals/research-loop/`, beside the synthetic evaluator.
Results go to a private local directory (`0700`, files `0600`), never the
repository.

**Staging research endpoint.**

- Off by default; enabled by a staging setting; production configuration
  refuses it.
- Authenticated as the person, with Ask's permissions.
- Start a run with trigger and inputs, then collect the result, so background
  budgets can outlast Cloudflare's 100 s limit.
- Results live in memory until fetched or 15 minutes pass. Never written to
  disk or telemetry; content capture stays off.
- One run at a time per person. A provider 429 is a recorded run failure,
  never a silent retry.

**Runner.**

1. Seed: create the world, apply and revert S1. Jira and Confluence writes are
   shown for founder approval before they run.
2. Run each case and repetition; save the eval view, Ask's writer input and the
   answer.
3. Grade and report.

**Grader.**

- Code checks: for each required item, found, read in full, cited by the plan,
  handed to the writer; any restricted item anywhere fails the run;
  distractors handed over; answer citations outside what research read; stop
  reason, cost and time.
- Judge (a Claude model, not the loop's model): needs against expected needs
  by meaning; whether cited text establishes each part; Sweep verdicts;
  must-not claims in answer or notes; Ask answer correctness and support per
  part.
- Calibration: the founder blind-grades about 15 runs; the judge must agree
  on at least 90% of checks before its numbers are used. Disagreements change
  the judge prompt or the key.

**Report.** Per case and stage: planner (expected needs covered, needs
invented), tools (required items found, read, handed over), verdicts, writer
(parts correct, unsupported claims, false abstentions), safety (restricted
leaks), cost (time, rounds, calls, stop reason). Cases weigh equally, runs are
averaged within a case, spread is shown. Each report names the source commit,
model and world state.

**Improvement rule.** Before any loop change, write down which numbers it must
raise and which must not regress, for example required items handed over and
complete-and-supported cases up, with no rise in unsupported claims, no leaks,
and within budget.

## Acceptance for round one

- The split passes the replay equivalence test and `npm run check`.
- The endpoint is off by default, refused in production configuration, and
  covered by permission and no-storage tests.
- The judge meets the calibration bar.
- A baseline report exists for S0 (Ask live and background budgets, Checks)
  and S1 (Sweeps), three runs per development case.

## Open items

1. Whether to strip the "SYNTHETIC MOCK" banners after the baseline.
2. Jira assignees must be real users of the staging site: add test users, or
   name owners in ticket text where users run out.
3. Background budget values are starting points.
4. The judge's exact model and the seeding credential path are settled in the
   implementation plan.

## Implementation notes

- The request session is the shared request closure in
  `packages/organization-authority-kernel/src/answer-composition/agentic-ask-v1.ts`:
  it owns the deadline, call budget, fences and audit, and runs research as
  its own phase before Ask's writer. `createAgenticResearchV1` exposes
  `answerWithResearch` (Ask with its research result) and `research` (Check,
  Sweep). Types and budgets live in `agentic-research-v1.ts`.
- The golden replay (`agentic-ask-golden.test.ts`) covers every stop reason,
  a repair, a writer fallback, an owner-filtered list, the small-scope preload
  and a live ticket-and-page request; all twelve digests were recorded from the
  `b108ad3` core and are reproduced exactly.
- Starting evidence opens through `openCitation` on the evidence desk: ECHO
  citations through the existing desk path, Jira and Confluence through new
  reader methods that re-read the current item with the project or space pin.
- Research-only audits carry `trigger` and use background limits (20 rounds,
  48 calls); Ask audits are unchanged.
- The endpoint is `POST /v1/person/research-eval/start` and `/read`, composed
  only for the staging origin with `ECHO_STAGING_RESEARCH_EVAL_V1=true`. Ask
  requests through it keep the product's 240-character question limit, so the
  over-long case is measured as an ingress rejection.
- The dataset has 29 cases: 19 development and 10 held out.

