---
schema_version: 1
id: ADR-0032
kind: decision
title: Stored trigger runs keep pointers and judgments, not outside text
component_ids:
  - CMP-ORGANIZATION-AUTHORITY
  - CMP-PERMISSIONS
  - CMP-PERSON-CLIENT
created_at: 2026-10-07
reviewed_at: 2026-10-08
reviewed_ref: bfcf3a6bf21456eea506247f724ca3272bd7e966
status: accepted
supersedes: []
superseded_by: []
updates:
  - ADR-0031
---

# ADR-0032: Stored trigger runs keep pointers and judgments, not outside text

**Amended 2026-11-08 (the Authority starts a run on check-in).** The founder
removed the desktop's own start loop (lean-down DSK-1). Until then the
renderer's runs driver read the approver's runs, every 5 seconds while a run
was queued or running, and started the oldest queued one itself. Now the
desktop checks in (`runs` `next`) after each change check that reaches the
Authority and on a failed run's Try again, and the Authority starts the
approver's oldest queued run with that request's token. Approve asks for a
change check at once. The pace is the change check's
([ADR-0036](ADR-0036-person-change-check.md)): 15 seconds while one of the
approver's runs is queued or running or one of their approvals is publishing,
60 otherwise. A run still acts as the approver and needs their token, so
nothing starts after the app quits. `start` by run id stays for the CLI.

## Context and options

The approved-record trigger (research trigger contract v1) produces an impact
card, but its result was only held in memory by a staging evaluation endpoint.
Showing the card next to an approved meeting needs somewhere to keep it, and
the run takes up to five minutes, longer than a request.

RFC-0003 keeps Slack text only in the memory of the request that read it,
because Slack's API terms forbid persistent copies. The connector integration
design keeps no Jira excerpts. An impact card contains model summaries of
those items, their owners and their titles.

Options considered:

1. **Store the card as rendered.** Simplest, but stores derived Slack, Jira
   and Confluence text.
2. **Store nothing; re-run research on every view.** Honest but slow (minutes)
   and expensive per view.
3. **Store pointers and ECHO's own judgments; rebuild outside parts from fresh
   reads on every view (chosen).**

## Decision and consequences

Adopt option 3, as specified in
[runs store and impact card v1](../product/2026-10-07-runs-store-and-impact-card-v1.md):

- `authority_trigger_runs_v1` holds background trigger runs (Ask stays
  unstored). The after-record hook from ADR-0031 enqueues one run per approved
  record.
- A run acts as the approver and uses the approver's access token, so it
  starts only while the approver is signed in to the desktop: the Authority
  starts the approver's oldest queued run when that desktop checks in (after
  each change check, ADR-0036, and on Try again; amended 2026-11-08). Only the
  approver can list, start or view it.
- The stored card keeps what was decided (ECHO's record), each item's relation
  and date, ECHO-local item text, and citation pointers. It never keeps text,
  labels or names read from Slack, Jira or Confluence.
- Every view re-opens each citation as the viewer, hides what the viewer can
  no longer open, and rebuilds outside text and owners from the current items.

Consequences: views cost one live read per cited item (at most 32). Card
quality is not yet measured; the founder's approved-record evaluation still
has to run.

## Migration, rollback, and evidence

- The table ships in Authority baseline V12 with ADR-0031's reset.
- Rollback: older images cannot read V12 state; no data outlives the reset.
- Evidence: tests that only the approver reaches a run, that the stored row
  holds no seeded outside text, that a view hides lost items and drops dates
  an item no longer states, plus the desktop end-to-end test.
