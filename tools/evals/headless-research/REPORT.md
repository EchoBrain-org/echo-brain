# Claude research-loop feasibility trial

The SDK can research ECHO-shaped evidence and hand a usable bundle to the
existing Ask and sweep renderers. This is a promising synthetic prototype,
not a staged replacement or proof of live permission equivalence.

Base: `819a9efac47b6e53355f6227936c7c6c68ddfbb8`. Model:
`claude-sonnet-5-5`. Claude Agent SDK `0.3.305`; installed CLI `2.1.302`.
All data is invented. No Authority endpoints, AWS actions or live user records
were used. Production code, triggers, renderers and release feeds are unchanged.

## Observed results

One run per engine/case, including the existing renderer:

| Case | Existing loop in trial | SDK loop | Result |
| --- | --- | --- | --- |
| Active projects and leads | 11.8 s, answered | 6.9 s, answered | Both named the two projects and their respective leads with project citations. |
| Yesterday across sources | 15.9 s, partial | 10.8 s, answered | SDK opened all four bodies after listing; existing loop stopped at metadata. |
| Open items across 105 tickets | 28.6 s, partial | 26.7 s, partial | Both finished pagination. SDK found the six open tickets and the meeting action's text; the existing writer still declared a gap. |
| Sweep of an existing item | 2.0 s, answered | 1.9 s, answered | Both preserved the no-planner path and existing `still_open` sweep output. |

These are observations, not a speed claim. The existing loop uses a fresh
headless query for each structured decision instead of its deployed OpenRouter
transport. The SDK retains one research session. Prompt caching, extra structured
output calls, model variation and instant fixture reads affect timing and cost.
The live server's earlier timeout was not reproduced here: both engines finished
the synthetic ticket scan within budget.

## What the SDK changed

For yesterday, both saw the same three sources and the same date window in
America/Los_Angeles. The current loop returned a complete inventory but did not
open its four records. Its writer correctly reported that the record bodies were
missing. The SDK listed those same sources, opened the decision, action, ticket
and page, then returned evidence and notes that the unchanged writer could use.

For open items, the SDK retrieved all 105 tickets across five pages without a
Jira status filter. It identified the six open tickets, including DEMO-102 on the
last page, and their owners. Its final answer contained those six tickets and
the meeting action, but was still `partial`.

The remaining gap was downstream: ECHO's current writer receives at most 100
members of a list (`AGENTIC_LIST_WRITER_MEMBERS_MAX_V1`). The writer reported the
five omitted rows as a gap even though research had finished, the notes named
the last open ticket, and the deterministic list renderer selected all six open
tickets from the complete bundle. Changing research alone does not remove this
handoff limitation. No renderer change is included in this experiment.

## Validation and evidence

- 15 focused adapter/assessment tests passed, covering scope, source availability,
  pagination, metadata/body distinctions, citation ids, revocation, cancellation,
  starting evidence and trigger options.
- `npm run check` passed: 366 test files; 5,841 tests passed, two expected
  failures and two skipped. Architecture, documentation, lint, build and TypeScript
  checks passed in that run. The experiment's 15 focused tests passed separately.
  [Validation record](validation.json) records the commands and source hashes.
- Eight real model trials completed. Revised smoke checks pass three SDK cases
  and two current-loop cases. The partial cases remain failures.
- An additional real SDK probe revoked fixture access during its first read.
  It stopped without returning a bundle in 4.7 seconds. This proves that observed
  loss stops the prototype, not the full per-model-request authorization fence.
- [Trial evidence](trial-results.json) contains model metrics, research plans,
  read counts, list completeness, cited outputs and hashes of raw local results.
- [Reproduction and integration limits](README.md) describes the synthetic fixture
  boundary and production requirements.

The initial smoke checker required the asker's literal name, so it falsely failed
the correct statement “You lead Atlas.” It also did not reject a `partial` final
outcome. The corrected checker accepts the requester pronoun and requires an
answered result. The saved outputs were re-evaluated without changing or rerunning
them; original and corrected checks are retained in the evidence.

## Next integration gate

Before any live-data comparison, prove ECHO's access check runs before **every**
outbound SDK model request, including retries, repairs and compaction. Tool hooks
alone do not establish that. Then integrate the shared audit/progress lifecycle
and exercise real provider and trigger contracts. The current prototype keeps
those requirements explicit and cannot be selected by the live Authority.
