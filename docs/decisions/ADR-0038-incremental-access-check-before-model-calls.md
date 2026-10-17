---
schema_version: 1
id: ADR-0038
kind: decision
title: The access check before a model call re-reads only new evidence
component_ids:
  - CMP-ORGANIZATION-AUTHORITY
  - CMP-PERMISSIONS
created_at: 2026-10-16
reviewed_at: 2026-10-16
reviewed_ref: 17e967cde9abc730ca3cb04d03350a319d3965e6
status: accepted
supersedes: []
superseded_by: []
updates:
  - ADR-0019
  - ADR-0022
  - ADR-0026
  - ADR-0034
---

# ADR-0038: The access check before a model call re-reads only new evidence

The founder accepted this on 2026-10-16, after a LangSmith audit of 42
`echo-staging` research traces from 2026-10-11 to 2026-10-16. Acceptance does
not mean the change is deployed or qualified.

## Context and options

ADR-0019 requires every model call and the final response to revalidate all
releases. ADR-0022 repeats this for every attempt, and ADR-0026 and ADR-0034
apply it to Jira and Confluence. As built, the check before each model call,
repairs included, re-read everything the request had released:

- **The base desk** re-read every released original item twice per check,
  once before and once after the live sources.
- **Jira** verified the connection, bulk-fetched every released ticket, then
  verified the connection again.
- **Confluence** verified the connection, fetched metadata for every listed
  page, re-read the whole body of every opened page, then verified again.

With a live source bound, each check took 0.75 to 1.8 s. In the approved-record
traces, 90 checks took 110.7 s, 13% of wall time. A repair carries no new
evidence, but it paid the full check as well. Much of the Confluence reader's
per-request cap of 160 HTTP requests went to these checks, so a long run could
fail after research had finished. One transient failure of a check also lost a
whole run: trace 6e674653 discarded 118 s of finished research.

Options:

1. **Keep the full check before every call.** Strongest, and the cost grows
   with every item released.
2. **Reuse a full check for a short time.** This still re-reads everything
   once the time runs out, and it skips checking new items while it lasts.
3. **Re-read only new evidence before each call, and keep the full check at
   release.**

## Decision and consequences

Option 3.

- **Before each model call**, including a repair, the gate asks the desk for
  an incremental check. Every layer re-reads only the releases and items it
  made since its own last successful check: items about to enter a prompt for
  the first time are always among them. The same check still verifies, on
  every call, the session, membership tenure, ECHO grants and authorization
  revision, each live connection's binding, account and site, and the record
  snapshot pin. A live connection is verified once, after the new reads,
  instead of before and after them.
- **At release** the full cumulative check is unchanged. It runs before the
  audit and, where the route requires it, after the audit. A revoked item
  therefore never reaches a released answer.
- **State is local.** What counts as already checked lives in that request's
  desk and source instances. It is never shared across requests or kept after
  one. A layer whose check fails marks nothing as checked, and the call fails
  exactly as it would after a failed full check. A layer that cannot check
  incrementally runs a full check.
- **A transient failure is retried once.** A check that fails with
  `unavailable` or `rate_limited`, before a model call or at release, runs once
  more after 400 ms, inside the request's deadline and abort signal.
  Authorization, stale-access and not-found failures are never retried.

**Security trade-off.** An item that passed a check stays in the request's
working set for the rest of that run. If the person loses access to that one
item mid-run, without losing their session, membership, grant or connection,
later model calls in the same run may still see it. The final check refuses
the answer, so nothing built on it is released. This exposes the item only to
the model, inside the same request and Person scope the item was released
under. ADR-0019's per-call check prevented this exposure; the founder accepted
it in exchange for the time and request savings.

This record updates the per-call wording of ADR-0019, ADR-0022, ADR-0026 and
ADR-0034, and it is the rule
[INV-PERMISSIONS-015](../invariants/INV-PERMISSIONS-015-layer-3-person-release-boundary.md)
now states. Nothing else in those records changes.

## Migration, rollback, and evidence

There is no data or schema change. The check mode is a request-local
argument, so rollback is a code revert.

Tests cover each layer:

- an incremental check skips items already checked, re-reads new ones, and
  still verifies the session, grant and connection on each call;
- the release check is full and refuses an answer when evidence an earlier
  check passed is revoked mid-run;
- a repair with no new evidence re-reads no item;
- one transient failure is retried, and other failures are not.

The tests are in
`packages/organization-authority-kernel/test/answer-composition/agentic-model-gate-v1.test.ts`,
`agentic-ask-v1-finalization.test.ts`, `agentic-release-v1.test.ts`,
`packages/organization-authority-kernel/test/shared/audited-person-live-evidence-v1.test.ts`,
the Jira and Confluence reader tests, and the Authority desk tests
`person-evidence-desk-records.test.ts`, `person-live-evidence-desk-v2.test.ts`
and `person-meeting-runtime-v1.test.ts`. The time saved in staging is still to
be measured with the same LangSmith export.
