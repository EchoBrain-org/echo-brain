# Research loop evaluation

Measures ECHO's research loop stage by stage on the THERM world in staging:
did the planner ask the right questions, did the tools find and read the
evidence, did research reach the right verdicts, and did the writer use what
it was given. Design: [`docs/product/2026-10-06-research-loop-eval-v1.md`](../../../docs/product/2026-10-06-research-loop-eval-v1.md).

Two triggers run the same loop:

- **Ask**: a typed question, live budget (90 s), graded on the research result
  and the answer.
- **Approved record** (replaces Check): an approved meeting record, background
  budget (5 min), graded on the research result and the impact card.

Sweeps were retired on 2026-11-08
([open items and Home v1](../../../docs/product/2026-10-08-open-items-and-home-v1.md),
section 6). Their cases, the S1 world state, `--state`, the sweep grading and
the export bindings only they used went with them; every case now runs at S0.

**Which Ask it runs.** The Ask trigger here runs Ask as
`POST /v7/person/ask` runs it, as desktops and `person ask` ask it: V8
answers on the full catalog, which may also cite ECHO's shared follow-ups
([ADR-0040](../../../docs/decisions/ADR-0040-follow-ups-as-ask-evidence.md)),
the asker's projects, people and tools, and the Jira projects and Confluence
spaces of the tools they connected
([ADR-0042](../../../docs/decisions/ADR-0042-research-tool-contract.md)). To see
a run's exact prompts, replies and tool calls, read its staging LangSmith trace
([LangSmith staging tracing](../../../deploy/organization-authority/README.md#langsmith-staging-tracing)).

The report keeps the loop and the renderers apart. **Research loop**: every
trigger, graded on its research result (needs, found, read, handed,
established). **Renderers**: Ask's writer on its answer; and the impact card
on affected items listed, relations and owners correct (of the listed items),
invented items or people, and gaps reported. Approved-record keys carry a
relation and an owner per affected item (`world/README.md`).

**List parts ([ADR-0041](../../../docs/decisions/ADR-0041-complete-lists-as-ask-evidence.md)).**
A part of type `list` asks which items exist ("Which Confluence pages were
created on October 4, 2026?"), and its evidence names every member of the list,
each a whole item. It scores on the whole list, never item by item: found when
research came across every member, read when a complete list research read
holds every member, cited when the plan cites every member or a found
`which_items` need cites, by id, a list holding it (a need saved without a kind
is content, whose list ids mean nothing), handed over when the writer saw
every member, and correct in the answer only when the answer names every
member. The response does not say which statements code wrote, so a statement
names a member only when it cites one of the member's items and its text names
the member as code writes names: the member's title on one line, cut to 120
characters (a cut title by code's cut name, ellipsis and all, or by its whole
title), ignoring case, as a phrase of its own, never inside a longer word or a
longer name the text holds. Members sharing a label share the one name code
gives them, unless the statement cites some that record another status, owner
or due date: code keeps those apart and writes the facts that differ after
each label, so the text names such a member only with its own complete detail,
including the owner or due prefix. A value inside another value ("open" in
"not open") does not count. Details use the renderer's character limits:
60 for status, 80 for owner and 40 for due, including a truncation ellipsis;
calendar due dates use the renderer's written date. Citing
a row never names it alone, whether a sentence cites it beside its text for the
row's facts, its list id brings it, or the row carries text, as a follow-up's
does. Every answer names every selected member
([ADR-0051](../../../docs/decisions/ADR-0051-ask-answer-layout-v2.md), amended),
so no count stands in for a name. Where the research result lacks the name
code writes, the check errs toward not named: a meeting record is titled there
by its meeting's label, while code names it by a line of its own text, which
the result does not carry, so a member the key names by its meeting is never
named. Naming 4 of 8 earns nothing,
whatever the judge says. "Lists
named in full" is that last check, made by code, so it is reported without a
judge too, and a run whose answer misses a member is never complete and
supported. An answer may cite the row of a member of a list research read,
which counts as research evidence like an item read in full.

Every Ask run reports `kinds`, its final plan's needs by declared kind
(`which_items`, `which_say` and `content`, a need without one counting as
content), and the report shows them beside each Ask case. A case's `expected_kinds`
is scored by code as `declared_kinds`, beside each run's `kinds`: it passes when
the set of kinds the final plan declares, a need without a kind counting as
content, is exactly the case's ("need kinds as the case expects"). A failed run
of such a case scores zero on it. It is a score of its own, never part of
complete and supported. Every held-out Ask case names its kinds, so the score
also measures the step prompt's kind rule on questions tuning never sees, and
its examples name nothing any case asks about
(`tests/architecture/ask-kind-examples-eval-independence.test.ts`), so the
score never measures recall of an example. Only Ask cases have list parts: impact
cards record no lists. The judge sees research's lists as rows
(filter, completeness, members' titles, dates and details, never text), and
for any part may take a member's own title, dates, status or owner from its
row, never what the item says.

Ask's writer now also sees every list research read as rows without text. A
row hands over a date, owner or status part, never other content, and rows
count as neither noise nor distractors handed, so those numbers keep their
meaning across ADR-0041. The writer answers such a part by selecting the
member, and code states its row facts, citing the row: Ask leaves out a
writer's sentence that cites only rows or list ids.

**The `trace` command's retirement (2026-11-09).** `trace`, which saved one
ordinary Ask's or run's exact payloads from a one-use diagnostic capture
(`POST /v1/person/diagnostics`), is retired with those captures. A staging run's
exact prompts, replies and tool calls live in its
[LangSmith trace](../../../deploy/organization-authority/README.md#langsmith-staging-tracing),
which `release-check` already reads. Runs, grading and reports are unchanged, so
baselines stay comparable.

**Baselines across always-on gap details (2026-11-09).** The eval endpoint's
Ask now carries typed `gap_details` on a part with a typed gap, as the
desktop's Ask already did
([ADR-0048](../../../docs/decisions/ADR-0048-retire-older-person-routes.md),
update of 2026-11-09). Research, the writer, the answer's other fields and
grading are unchanged (the judge never reads `gap_details`), so earlier Ask
baselines stay comparable. Approved-record runs are unchanged. The same day,
`bindings` stopped using the retired evidence search: it reads the THERM list
and each meeting's record (step 4). A `bindings.json` written before stays
valid; one written after may start the M3 and M4 record cases from another of
their decisions (the record's first, where the search ranked them), so compare
approved-record runs under one `bindings.json`.

**Baselines across the sweeps' retirement (2026-11-08).** The Sweep cases and
the S1 world state went, and the judge's prompt and the report no longer
cover sweep results or verdicts. The dataset and the judge prompt changed, so
a report taken before then is not comparable on its cross-case aggregates:
compare case by case, and regrade an earlier Ask or approved-record baseline
with the current `grade` first. Ask research changed only where it reads
follow-ups, which no longer carry a latest check
([ADR-0040](../../../docs/decisions/ADR-0040-follow-ups-as-ask-evidence.md));
approved-record runs are unchanged.

**Baselines across the plain answer's retirement (2026-11-05).** The eval
endpoint's Ask asked for no answer layout, so until then it got the plain
writer and its answer. It now gets the writer desktops get and its answer in
blocks ([ADR-0051](../../../docs/decisions/ADR-0051-ask-answer-layout-v2.md),
amended): the writer's answer first, then code's list statements, which name
every member in statements of at most 40 citations, with no count of
statements. Research itself is unchanged, but the writer is handed less
evidence, to make room for the block catalog and its longer reply. Take Ask
baselines again on an endpoint built after it before comparing writer
numbers; grading no longer credits the "and N more" count that only answers
from before it could end a list statement with. Approved-record runs are
unchanged.

**Baselines across ADR-0041 (2026-10-17).** Ask's research and writer changed:
a complete list is evidence, and code names its members. Ask baselines taken
before it measure the old loop, and their saved runs carry no lists, so a list
part in them is never read. Take Ask baselines again on an endpoint built
after ADR-0041, and regrade any earlier one with the current `grade` before
comparing it. Approved-record runs are unchanged.

**Baselines across the research trigger contract.** Ask is byte-identical
across that change, so an Ask baseline taken before or after it measures the
same thing. Grading changed, though: the judge's prompt now covers the impact
card, and the summary's Ask-writer `gaps_reported` now averages Ask cases only
(the card's gaps have their own row). Regrade an older Ask baseline with the
current `grade` before comparing it. Approved-record baselines must be taken
after the change: their task text changed, and approved-record runs now return
the impact card (a saved approved-record run without one is graded as
failed). A run graded as failed for a missing result is still scanned for
restricted leaks, so regrading an older approved-record run without its card
can report a leak that grading used to hide (it counts in "runs with
restricted leaks").

A case whose start request cannot be built (a meeting not bound, or a
citation of a kind that cannot start research) is saved as a
`case_not_startable` error and the run goes on; the report counts it in its
first line as not started.

The evaluation workflow is founder-run and starts research runs on staging as
the signed-in person. It does not edit Jira or Confluence.

## Open-ended family

The [research tool contract](../../../docs/product/2026-10-19-research-tool-contract-v1.md)
("Testing open-ended questions") adds questions that name no subject, source or
date: the open items and who owns them, which meeting each is from and who was
in it, how long since each was assigned, the current projects and their leads,
what happened yesterday, the link to a project's Jira space, a question only
Jira answers and one only Confluence answers, plus time, own-work, structure
and desktop-screen questions. A case of the family has `family: open_ended`,
a `category` (`goal`, `time`, `own_work`, `structure`, `reach`, `tools`) and a
`reach` key: the collections holding part of its answer (`meetings`,
`documents`, `follow_ups`, `projects`, `people`, `tools`, `tickets`, `pages`,
`jira_projects`, `confluence_spaces`; an entry that lists several is met by any
of them) and an optional time `window`
(`yesterday`, `this_week`, `last_week`). Its parts name workspace items as
`world/README.md` ("Reading the keys") says. A case whose answer the world
cannot fix in advance ("What happened yesterday?") has no parts.

Every case of the family is graded on reach and cost, never on wording, by code
reading the research result its run saves:

- **Looked at**: every collection holding part of the answer was looked at: a
  search or list naming it, unless refused (it read nothing), or an item from
  it that research came across. With a window, only calls whose `since` and
  `until` hold the window count, on the day asked in UTC (an evaluation's Ask
  sends no time zone) or in the time zone its lists were read in.
- **No repeated refusal**: no refused call was sent again. A refusal is a
  result naming a `refused` filter (one outcome per filter), or one carrying an
  error, the form refusals took before the contract; the same refusal on the
  same collection (or, for `open`, the same id) is a repeat, however its date
  arguments were reshaped. A notice that left a list unavailable is not a
  refusal.
- **Unchecked items stated**: every list the answer uses (one the plan relied
  on, or one it cites a member of) whose `unchecked` count is above zero has
  that count in the answer's text. When the answer used no such list, nothing
  needed stating: the check is unknown and leaves the run out of its rate (—
  when no run counts), but it does not stop the run meeting reach and cost or
  passing the release check. A failed run is left out of this rate too; it
  meets nothing.
- **Within rounds**: research stopped `finished` within 4 rounds.

Every completed run of any case also reports what its trace counts: rounds,
calls per round, collections looked at, refused calls, repeated refusals,
unchecked items, notices and rejected replies. The report's "Reach and cost"
section shows them per case, with each check's rate over the case's runs (a
failed run meets none). A failing case is a regression. The judge is told when
each question was asked (`case.asked_at`), since these keys word time relative
to it.
Run the family alone with `run --family open_ended`; it needs the workspace
seeded (`world/README.md`, "Workspace").

`release-check` checks the staging release's open-ended Asks
(`release-check.json` names the development cases it asks) from their
LangSmith traces. For the current release trial, it requires the same source
coverage, no repeated refusal, unchecked-item disclosure, and a `finished`
research stop, but imposes no round-count limit. Its report keeps the round
counts and records `max_rounds: null`. The evaluation's four-round cost
benchmark above and the live request's time and usage budgets are unchanged.
See
[the release guide](../../../deploy/release/README.md#open-ended-ask-check).

## What is where

| Path | What it is |
| --- | --- |
| `world/` | The THERM additions to seed by hand (see `world/README.md`). |
| `cases/development.json` | Cases used while improving the loop. |
| `cases/holdout.json` | Held-out cases. Open them only for the final check. No other file quotes their questions, names them or gives their keys. |
| `release-check.json` | The development cases the staging release check asks after its canary. |
| `cli.mjs` | `validate`, `bindings`, `run`, `grade`, `report`, `calibrate`, `release-check`. |
| `lib/` | Reference matching, code checks, reach and cost, judge, report, calibration, the release check. |

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
4. **Bind citations** (the approved meeting records found on staging):

   ```bash
   npm run eval:research-loop -- bindings --project-id prj_… --test-person "Your Name" --out ~/.local/state/echo-research-loop-eval-20261006
   ```

   It lists the THERM project as `person list --project` does, and reads each
   approved meeting whose title carries a dataset meeting's as
   `person records --record-sha256 <digest> --brief` does: every decision,
   action and rationale, in the record's order (newest record first), each
   with the atom id and policy its citation needs. An approved-record case
   starts from its meeting's first decision. If a meeting is reported as not
   found, add its approved-record citations to `bindings.json` by hand. Only
   meetings listed in THERM are found, so a meeting it cannot find may belong
   to no project (see "Approved-record scope").
5. **Baseline at S0** (Ask and approved record, three runs each, plus one
   background-budget run of every live Ask):

   ```bash
   npm run eval:research-loop -- run --run --model <loop-model-id> --split development --trials 3 --background-diagnostic --out ~/.local/state/echo-research-loop-eval-20261006
   ```

   `--model` is the operator-declared identifier for the configured loop model;
   it is recorded with every run and must be identical before a report is made.
   Each run also records the commit it ran from; a report needs one commit, so
   use a fresh `--out` directory after changing the code.

6. **Grade.** With a judge (a Claude model through OpenRouter, never the loop's
   model):

   ```bash
   npm run eval:research-loop -- grade --judge-model <openrouter-claude-slug> --judge-credential-file ~/.config/echo/openrouter.credential --out ~/.local/state/echo-research-loop-eval-20261006
   ```

   `--no-judge` grades code checks only, and the report then withholds every
   judge measure: expected and invented needs, parts established, parts correct
   in the answer, unsupported claims, false abstentions, gaps reported (Ask's
   and the card's) and must-not violations.
   Complete and supported stays unknown unless the run failed or a code check
   fails it: a leak, a citation of something research did not read, an
   invented card item or person, or a list not named in full. The code checks
   remain: found, read, handed over, need kinds, lists named, the card's items,
   relations and owners, leaks, noise, reach and cost.
7. **Calibrate the judge for this grading pass.** `calibrate sheet` requires 15
   judged runs and writes a blind sheet; answer every check `true` or `false`
   without opening `graded.json`, then `calibrate score`. The result is bound to
   that exact `graded.json`. Judge numbers count only when every sheet answer is
   present and founder agreement is at least 90%.
8. **Report.** `report` writes `report.md` and `report.json` beside the runs.
   It withholds judge-derived metrics unless the current grading pass has a
   trusted calibration result; code-check metrics remain available. It refuses
   if any run was added, removed or rewritten since `grade`; grade again.
9. **Holdout** runs only for the final check of a loop change: `--split holdout`.

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

Runs contain released text from Jira, Confluence and approved meetings. A
saved run keeps the research result (the trimmed bundle) and Ask's answer or
the impact card, never server records such as receipts or model-call
fingerprints. Runs are written only to `--out`, which must be an absolute
directory outside this repository; directories are `0700` and files `0600`.
The judge receives the answer key, the items research read and the run's
answer or card, and nothing else. Delete the output directory when the
evaluation is finished.

Evaluation runs execute on staging, so while an operator has enabled
[LangSmith tracing](../../../deploy/organization-authority/README.md#langsmith-staging-tracing),
the server also uploads each run's research, including prompts, tool results
and released source text, to the chosen LangSmith project. If that is not
wanted, disable it on the host with
`sudo ./onboard-clean-v1.sh langsmith-tracing --disable`; disabling does not
delete traces already uploaded.

## Limits to keep in mind

- Every THERM item carries a "SYNTHETIC MOCK" banner; the baseline measures how
  much hedging it causes.
- The global cross-project cases meet the ECHO distractors only if the test
  person can reach Jira project ECHO or page 589865 through a mapped project.
- `confluence-pages-created-on-october-4-global` keys the 8 pages the founder's
  October 4 list returned on staging on 2026-10-17 (trace `ee2f0973`), page
  589865 among them, outside the THERM space. Its key holds only while the test
  person can read those 8 pages and no other page created that day. The
  evaluation's Ask sends no time zone, so it reads dates in UTC; all 8 were
  created on October 4 in UTC as well as in the trace's Los Angeles time.
- History-only facts (when a ticket moved to Done) are expected to be not
  found: Ask cannot read Jira history today.
- Questions over 240 characters are rejected at ingress, as in the product;
  the report counts them as rejected rather than skipping them.
