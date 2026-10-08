---
schema_version: 1
id: INV-PERMISSIONS-013
kind: invariant
title: Pending consequential work resolves under its frozen contract
component_ids:
  - CMP-PROCESSING-ADAPTERS
  - CMP-PERSON-CLIENT
  - CMP-PERMISSIONS
created_at: 2026-08-13
reviewed_at: 2026-09-27
reviewed_ref: 83c8eb63aed78ba760678294ecf7fef863743e06
normative: MUST
enforcement_status: partial
enforcement_scope: Frozen private Slack approval delivery, tap-time fence, and terminal resolution
invariant_ids:
  - INV-12
failure_pattern_ids:
  - FP-PERMISSIONS-001
---

# INV-PERMISSIONS-013: Pending consequential work resolves under its frozen contract

## Statement

Pending consequential work MUST resolve from its persisted provider,
destination, actor, action mapping, adapter version, presentation bytes,
permission mode, and credential identity rather than current configuration.

## Scope and failure behavior

A changed or incomplete contract refuses before provider I/O. Diagnostics that
evaluate the same work must compose the same authorization-aware context as
runtime while inspecting production state without creating or migrating it.

## Enforcement and verification

The approval core now carries this rule for every surface. A proposal's snapshot
and suggested projects are frozen once, when it is staged
(`services/organization-authority/test/approval-core-v1.test.ts`); one decision
row per proposal is immutable and filled with its receipt once
(`approval-decision-schema.test.ts`); the Slack presenter posts only from the
frozen proposal and checks its stored target before every provider call
(`providers/slack/server/test/private-approval/slack-approval-presenter-v1.test.ts`);
and a Slack click is checked against the posted row and the current identity
link when the decision is written (`slack-approval-click-v1.test.ts`).

Frozen private Slack approval state was first implemented for the bounded
owner-review path. These tests, at the reviewed ref, proved it; they were
removed with the Slack approval internals on 2026-10-07:

- `private-slack-dm-approval-stager-v2.test.ts`:
  the V2 pending contract is frozen before Slack I/O, a retry resolves from it
  after current project state changes, and recipient drift or a missing
  retained source refuses before provider I/O;
- `sqlite-private-slack-approval-assignment-state-v1.test.ts`:
  the frozen delivery and assignment are immutable, replay exactly after
  restart, and complete a terminal from the frozen tuple after supersession,
  while corrupted frozen evidence refuses;
- `sqlite-stable-private-approval-authority-fence-v1.test.ts`:
  the tap-time fence rejects a pending contract or card binding that differs
  from the stored one; and
- `sqlite-private-slack-approval-terminal-authority-v1.test.ts`:
  a missing card or snapshot commitment, or a presentation spliced from
  another frozen tuple, is rejected before V4.

The diagnostic clause has no current enforcement point. The `doctor` path and
its parity tests were deleted with the Mac runtime in `a254232c`, and no
current diagnostic evaluates pending approval work. Broader approval paths
remain outside this bounded enforcement scope.
