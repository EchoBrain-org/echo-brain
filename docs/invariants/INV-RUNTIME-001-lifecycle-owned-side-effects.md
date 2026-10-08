---
schema_version: 1
id: INV-RUNTIME-001
kind: invariant
title: Durable side-effect follow-up belongs to the runtime lifecycle
component_ids:
  - CMP-PERSON-CLIENT
  - CMP-ORGANIZATION-AUTHORITY
created_at: 2026-08-13
reviewed_at: 2026-09-27
reviewed_ref: 83c8eb63aed78ba760678294ecf7fef863743e06
normative: MUST
enforcement_status: partial
enforcement_scope: Organization Authority approval publication follow-up and V4 append recovery
failure_pattern_ids:
  - FP-RUNTIME-001
---

# INV-RUNTIME-001: Durable side-effect follow-up belongs to the runtime lifecycle

## Statement

When a local durable transition requires a later external side effect, the
runtime lifecycle MUST own bounded scheduling, coalescing, cancellation,
draining, and recovery until the work is durably terminal or safely left for a
successor.

## Scope and failure behavior

Shutdown prevents new passes, aborts and drains active work, and releases the
runtime's lock or state handles only after no side effect can escape into a
successor runtime or maintenance window. A recovery or follow-up pass composes
only the capability it requires and must not advance unrelated source or
adapter cursors.

## Enforcement and verification

The Organization Authority service lifecycle in
[`organization-authority-service-lifecycle.ts`](../../services/organization-authority/src/composition/organization-authority-service-lifecycle.ts)
implements this bounded path. A durably recorded approval decision requests one
coalesced publication pass that runs only the publisher (record append, receipt
and after-record hooks); every periodic cycle first replays decided approvals
whose record was not yet appended to V4. Close cancels a
deferred pass, aborts and drains worker and search work, and only then closes
the API handles.
[`organization-authority-service-lifecycle.test.ts`](../../services/organization-authority/test/organization-authority-service-lifecycle.test.ts)
proves coalescing, exactly one follow-up, no source intake on publication,
recovery before new source input, and cancel-then-drain shutdown. The former
record-sweep coordinator and record-only flush command were deleted with the
Mac runtime in `a254232c`. The invariant must be applied separately to future
durable effects.
