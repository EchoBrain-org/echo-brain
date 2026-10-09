# Research trigger contract v1

Status: written spec approved on 2026-10-06. Implementation plan:
`docs/superpowers/plans/2026-10-06-research-trigger-contract.md`. Stacked on
PR [#284](https://github.com/EchoBrain-org/echo-brain/pull/284) (research loop
evaluation v1, branch `feat/research-loop-eval`).

## Goal

Make it easy to add a new trigger to the research loop without changing the
loop. Every trigger hands the loop the same input and gets the same output
back. What each trigger produces for a person is built outside the loop and
can be improved without touching it.

The research loop's job is to gather all the evidence a trigger needs, as raw
material. It does not answer, conclude, decide who hears about it, or release
anything.

## Product rules this design follows

- **ECHO never writes into Jira or Confluence.** ECHO solves coordination and
  human communication, not execution. Trigger results are for people: what
  changed, what it affects, who owns it, which dates are at risk. They never
  contain drafted edits or write-backs.
- **Same in, same out.** One brief shape in, one evidence bundle shape out,
  for every trigger.
- **Ask does not change.** Ask's prompts, answers and audit records stay
  byte-identical. The golden replay (12 scenarios recorded on `b108ad3`) must
  pass after every phase.
- **No loop behaviour changes in this round.** The nine open loop problems
  (research loop evaluation v1, "Still open on main") wait for a calibrated
  baseline.

## The shape

```
trigger adapter  →  brief  →  research loop  →  evidence bundle  →  renderer  →  release
 (per trigger)               (shared, fixed)                       (per trigger)  (shared)
```

Plain English: a researcher (the loop) gets a brief and hands back a folder (the
bundle). A writer for each trigger (the renderer) turns the folder into
something for a person. A shared front desk (release) checks access, writes the
log, and hands it over.

## 1. The brief (what goes in)

Every trigger gives the loop the same five things:

1. **Goal**, in one of two forms:
   - **a question from a person** (Ask), passed through exactly as today;
   - **a task written by ECHO** (every other trigger), from a fixed, reviewed
     template in the trigger definition, filled with the ids of its starting
     items.
2. **Starting evidence**: zero or more citations, re-read fresh through the
   access-checked desk before round one.
3. **Budget**: a profile (live 90 s or background 5 min) including the time
   held back for the renderer.
4. **Who and where**: the person the run acts as and the scope (one project,
   mine, or everything). The server binds these from the event before the loop
   starts. A trigger never chooses credentials; the model never sees connection
   details.
5. **Options**: for now only the small-scope preload ("if the readable scope
   is small, open it all before round one"), on for Ask.

**One shared task rule.** Check and Sweep each append their own paragraph to
the planner prompt today. They are replaced by one shared paragraph for every
task-form goal: "There is no question from a person; the task below replaces
it." Everything specific to a trigger lives in its task text, which is data.
Adding a trigger never changes the loop's prompt. Ask's prompt is unchanged
because Ask uses the question form.

**Unreadable starting items.** Default: the run stops (fail closed), as today.
A trigger may mark its starting items "report if unreadable" instead; the loop
then continues and the bundle lists them. Sweep uses this, because a deleted or
now-hidden ticket is news.

**A trigger definition** holds: its name (a label for audit and evaluation; the
loop never branches on it), how to turn its event into a brief and what makes
the event invalid, its budget profile, its renderer, who it acts as, and who may
receive its result. The audit's and the staging API's lists of allowed triggers
are generated from the definitions instead of being written out by hand.

## 2. The evidence bundle (what comes out)

Every trigger gets the same bundle back, in two forms.

**Full bundle** (server only; passed to the renderer and the release step):

1. The goal it worked on.
2. The checklist: parts and their needs, each marked found, not found or open,
   with the item ids behind each mark. These are research notes, not proof.
3. Every item it came across, including items only seen in a list: id (E1…),
   source, kind, title, citation, date and what the date means, details
   (status, assignee, due date, action owner), text if the person was allowed
   to read it, flags (starting, opened, read in full, cited by the checklist),
   and when it was last used (the Ask writer orders evidence by recency).
4. Starting items it could not read, when the trigger asked for that.
5. Coverage: every read and its result, every list (size, cut short or not),
   source notices.
6. Why it stopped, and whether research is complete.
7. Cost: rounds, model calls, tokens, time.
8. Who it was gathered for: the person, the scope, when access was last checked.
9. Server records: per-item receipts and desk handles, privacy flags, model-call
   fingerprints and usage. Never shown to a model, never saved by the
   evaluation.

**Trimmed bundle**: the same without item 9. It replaces today's
`AgenticResearchResultV1` (the evaluation's saved view).

**What counts as proof.** An item's text proves what it says. An item's details
prove themselves (a ticket listed as "In progress, assignee X, due Oct 20"
proves exactly that, even unopened). Checklist marks prove nothing.

**Gap 7 for new renderers.** The bundle carries every item, so a renderer can
use items research only saw in a list. Ask's writer keeps today's selection
exactly; changing it is a later, measured loop-adjacent change.

**Visibility.** The bundle was gathered with one person's access. Showing any of
it to anyone else needs the release step's per-recipient check. A renderer
never hands it to another person.

The bundle never contains an answer, a conclusion, or a decision about who
should hear about it.

## 3. Renderers and the shared model gate

A renderer takes the full bundle plus the trigger's own input and produces the
trigger's result in a fixed, code-validated shape: Ask's answer (today's V6
response), the approved record's impact card (section 5), and, later, Sweep's
verdicts.

Rules for every renderer:

1. **No new reads.** No search, no open; only the bundle. A renderer that needs
   more is a research miss, fixed in the brief or the loop and caught by the
   evaluation.
2. **Cites only bundle items.** Code checks every citation and drops the rest.
3. **Calls models only through the shared gate.** The gate is the one the loop
   uses today (`agentic-ask-v1.ts`, `call`): before each call it revalidates
   the person's access, enforces the request's call and time budget, records
   the call's fingerprint and usage for the audit, and allows one repair of a
   malformed reply.
4. **Has a fallback that needs no model.** A request always ends with an
   honest result.

A renderer returns its result, the items it cited, and its model-call records.

Because a renderer only sees the bundle, the evaluation can grade it on its own
(given this bundle, did it state facts correctly, cite properly, report gaps),
separately from the loop (did research find, read and gather what was needed).

## 4. The release step

Shared by every trigger, in this order (today's Ask sequence, moved to one
place and no longer duplicated in the research-only branch):

1. Final access check: the person can still see everything the result cites;
   otherwise nothing is released.
2. One content-free audit record for the whole request: trigger, budget
   profile, outcome, receipts of everything released, rounds, calls, repairs,
   fallbacks, fingerprints of every model call (research and renderer) and of
   the result, token usage. Ask's record stays identical; other triggers add
   their name, as Check and Sweep do now.
3. A second access check after the audit write.
4. Hand over.

On timeout, cancel or error, release still writes a `timed_out` or `cancelled`
record and releases nothing.

**Recipients in this round:** only the person the run acted as. Sending a
result to others (for example, ticket owners) needs a per-recipient,
per-item check and a policy for items a recipient cannot see. That belongs in
this step and comes later.

Out of scope for this round: where results are shown (inbox, Slack) and storing
results. Ask answers are not stored today; the impact card follows the same
rule.

## 5. The approved-record trigger and its impact card

**Trigger** (replaces Check; its evaluation cases carry over):

- Fires when a person approves a record. Meeting cards now; any approved record
  kind later without new work.
- Starting item: the approved record (fail closed).
- Acts as: the approver.
- Scope: the record's project. A record in no project uses everything the
  approver can read.
- Budget: background (5 min).
- Task: "A PM just approved record E1. Find every ticket, PRD section and
  document in this project that it confirms, conflicts with or changes. For
  each, record what it says now, who owns it, and any date it affects."

**Impact card** (one result shape, validated by code):

1. **What was decided**: the record's decisions, requirements and actions, one
   line each, cited to the record.
2. **Affected items**: each ticket, PRD section or document, with what it says
   now (cited), its relation (confirms, conflicts, needs updating), its owner,
   and any date at risk with the milestone it is measured against.
3. **Couldn't confirm**: facts research did not find, plus coverage notes
   ("the ticket list was cut short at 50", "page X could not be read").
4. **People to tell**: owners and assignees of affected items, without repeats.

Split of work: one model call (through the gate) writes the one-line
summaries and each item's relation. Code builds the layout, citations and the
people list. Names come only from item details (Jira assignee, meeting action
owner), never from the model.

It never contains drafted ticket text, suggested edits or "change X in Jira".

**Fallback without a model:** the items research cited, with their details and
owners, under "Possibly affected, not yet assessed", plus the "Couldn't
confirm" notes.

## 6. Evaluation

- The loop is graded on the bundle for every trigger, as today.
- Renderers get their own grading. For Ask, today's writer metrics carry over.
  For the impact card: affected items listed and related correctly, owners
  correct, no invented items or people, gaps reported.
- The approved-record cases (today's three Check cases) gain a relation and an
  owner per affected item in their answer keys.
- The staging endpoint accepts the approved-record trigger and returns the
  rendered card with the trimmed bundle. Sweep stays research-only.
- The report shows loop and renderer numbers separately.

Ask is byte-identical, so an Ask baseline taken before or after this change
measures the same thing. Approved-record and Sweep task text changes, so their
baseline is taken after this change.

## Build order

One commit per phase. The golden replay and `npm run check` pass after each.

1. Shared model gate and the full and trimmed bundles, extracted from the
   request closure. No behaviour change.
2. Shared release step; the research-only branch's duplicate fence and audit
   removed. Ask's audit records identical.
3. Ask renderer: writer input, evidence selection, writer call, layout and
   fallback moved out of the loop. Ask's prompts and responses identical.
4. Brief and trigger definitions: two goal forms, the shared task rule, task
   templates, "report if unreadable", generated allowlists. Check and Sweep
   task text changes.
5. Approved-record trigger (replaces Check), the no-project scope rule, the
   impact card renderer and its fallback, with new golden scenarios.
6. Evaluation: endpoint, answer keys, renderer grading, report section.

## Acceptance

- The 12 Ask golden scenarios reproduce their `b108ad3` digests after every
  phase.
- Adding a trigger needs one definition, one renderer (or none, for
  research-only use in the evaluation) and its cases. No edits to the loop, the
  gate, the release step, the audit adapter or the API validators.
- The loop has no reference to a trigger name.
- Every renderer model call goes through the gate; an architecture test pins it.
- The impact card is validated by code, cites only bundle items, and its people
  list comes only from item details.
- `npm run check` passes.

## Not in this round

- Firing the approved-record trigger from real approvals in the product (only
  the staging evaluation starts it until the evaluation shows the card is
  right).
- Sending results to anyone other than the person the run acted as.
- Showing results in the inbox or Slack; storing results.
- A Sweep renderer.
- Any of the nine loop problems.

## Implementation notes

- Today's single request closure is `createAgenticAskCore` in
  `packages/organization-authority-kernel/src/answer-composition/agentic-ask-v1.ts`.
  The loop is the `research()` phase; the writer is the "final answer" and
  "layout" blocks; the release sequence appears twice (research-only branch and
  Ask branch). The model gate is the `call` and `withRepair` helpers.
- The research types live in `agentic-research-v1.ts`; the Check and Sweep
  paragraphs in `agentic-ask-v1-model-protocol.ts`; the audit allowlist in
  `services/organization-authority/src/adapters/persistence/sqlite/person-agentic-ask-audit-v1.ts`;
  the staging request validator in
  `packages/organization-api/src/person-research-eval-v1.ts`; the endpoint in
  `services/organization-authority/src/composition/person-research-eval-v1.ts`.
- Keep the kernel's architecture boundaries: renderers and trigger definitions
  are kernel answer-composition code; the service composes them.
- "No edits to the API validators" (Acceptance) holds for a trigger with no
  renderer, which needs no API change. A trigger with a renderer adds its
  result type and validator to `organization-api` and to the research
  evaluation's read response, as the impact card did
  (`rendered?: PersonImpactCardV1`). The endpoint's dispatch to a renderer is
  service code, not an API validator.
- Approved-record scope fallbacks: one readable linked project scopes the run
  to it; no project, several readable projects, or only unreadable linked
  projects mean everything the approver can read (the desk is still
  access-checked). Graders should not read wider results as a bug.
- Implementation note, 2026-10-08: the approved-record trigger now fires from
  real approvals, and its results are stored. The after-record hook enqueues one
  run per approved record in `authority_trigger_runs_v1`; the runs API
  (`POST /v1/person/runs`) starts, retries and views it as the approver, and a
  stored run keeps pointers and ECHO's own judgments only, re-released through
  a fresh desk on every view
  ([runs store spec](2026-10-07-runs-store-and-impact-card-v1.md),
  [ADR-0032](../decisions/ADR-0032-stored-trigger-runs.md)). "Not in this round"
  above describes this round only.
- Implementation note, 2026-10-08: Sweep now has a renderer
  (`SWEEP_RENDERER_V1`). For each finding it gives a verdict (`landed`,
  `still_open`, `changed` or `unreadable`) and one ECHO line, under the impact
  card's screens. A finding's own items are its first citation and any further
  Jira, Confluence or Slack item it cites. A finding is judged only when all its
  own items are in what the model is shown; otherwise it stays not assessed
  (no verdict). A finding whose own item could not be read is `unreadable`
  without a model call. The staging endpoint returns the sweep result, line
  included. The product stores no line: a sweep run keeps only its counts by
  verdict, and each open item keeps only its latest verdict as a shared last
  check ([open items and Home v1](2026-10-08-open-items-and-home-v1.md),
  section 6). Results reach owners through Send: the approver sends each open
  item to its owner's Home, and everyone who sees the item sees its last check
  ([ADR-0033](../decisions/ADR-0033-shared-open-items.md)). "Not in this
  round" above describes this round only.
