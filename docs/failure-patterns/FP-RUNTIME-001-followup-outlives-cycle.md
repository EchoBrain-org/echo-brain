---
schema_version: 1
id: FP-RUNTIME-001
kind: failure-pattern
title: Durable provider resolution is not followed by a fresh bounded sweep
component_ids:
  - CMP-PERSON-CLIENT
  - CMP-ORGANIZATION-AUTHORITY
created_at: 2026-08-13
reviewed_at: 2026-09-27
reviewed_ref: 83c8eb63aed78ba760678294ecf7fef863743e06
origin: live
evidence_status: observed-live
status: mitigating
severity: high
first_observed: 2026-08-13
invariant_ids:
  - INV-RUNTIME-001
evidence_ids:
  - EVID-JOB-AB-LEDGER-001
implementation_refs:
  - commit:a132c35aa9399876cc633c727d2c820af506bcf4
  - commit:20bb63d2668985e2207764e40f834efbeabb2fb4
regression_test_refs:
  - tests/product/organization-record-sweep-wiring.test.ts@a132c35aa9399876cc633c727d2c820af506bcf4
  - tests/machine/organization-cli.test.ts@a132c35aa9399876cc633c727d2c820af506bcf4
  - services/organization-authority/test/organization-authority-service-lifecycle.test.ts@83c8eb63aed78ba760678294ecf7fef863743e06
  - providers/slack/server/test/private-approval/private-slack-approval-interaction-handler-v1.test.ts@83c8eb63aed78ba760678294ecf7fef863743e06
---

# FP-RUNTIME-001: Durable provider resolution is not followed by a fresh bounded sweep

## Plain-English summary

On the retired Mac runtime, a human approval became durable after the current
source cycle's organization record sweep had already run. Reusing that old
sweep meant the approved item could remain pending centrally until another
unrelated cycle occurred.

## Boundary, trigger, and symptom

Human approval latency and central record latency were coupled accidentally.
The callback knew work had become durable but did not schedule lifecycle-owned
follow-up with clear shutdown behavior.

The Mac record-sweep coordinator and its record-only flush command were
deleted with the Mac runtime in `a254232c`. The boundary now sits in the
Organization Authority. A private Slack approval tap durably queues a terminal
receipt; finalizing it and appending the approved record to V4 are later side
effects owned by the Authority service lifecycle.

## Risk and root cause

Durable local work can be stranded, duplicated by competing runtimes, or leak
into a maintenance window if background work is not owned and drained.

## Tempting but unsafe response

Do not block the human approval callback on remote record submission, and do
not run a full source cycle merely to flush one durable record.

## Required behavior, recovery, and regression

Schedule one coalesced bounded follow-up, keep the callback synchronous and
nonblocking, abort and drain during shutdown, and recover durable work without
consuming new source input.

The `a132c35a` refs pin the original Mac repair and its tests, which covered
scheduling, timeout, shutdown, concurrency, and no unrelated adapter
construction. The indexed live evidence records that repair's successful
recovery. Both tests were deleted in `a254232c`.

At the reviewed ref,
[`organization-authority-service-lifecycle.ts`](../../services/organization-authority/src/composition/organization-authority-service-lifecycle.ts)
implements the behavior; `20bb63d2` added the approval follow-up. After the
terminal receipt is durable, the Slack interaction handler signals the
lifecycle. The lifecycle runs one coalesced publication pass of only finalize
and append, schedules exactly one follow-up for a request made
mid-publication, and leaves anything missed to the next periodic cycle.
Startup and every periodic cycle first replay finalized actions not yet
appended to V4, before any new source input. Close cancels a deferred pass,
aborts and drains worker and search work, and only then closes the API
handles.
[`organization-authority-service-lifecycle.test.ts`](../../services/organization-authority/test/organization-authority-service-lifecycle.test.ts)
proves coalescing, the single follow-up, no source intake on publication,
recovery before new source input, and cancel-then-drain shutdown.
[`private-slack-approval-interaction-handler-v1.test.ts`](../../providers/slack/server/test/private-approval/private-slack-approval-interaction-handler-v1.test.ts)
proves the handler signals only after the receipt is durable, writes the HTTP
acknowledgement before publication starts, and keeps an accepted tap when the
signal fails.

The pattern stays `mitigating`. The current repair is source-tested, but no
linked qualification or live evidence yet covers the Authority path.
