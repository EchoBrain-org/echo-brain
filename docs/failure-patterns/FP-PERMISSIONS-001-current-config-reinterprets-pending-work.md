---
schema_version: 1
id: FP-PERMISSIONS-001
kind: failure-pattern
title: Current configuration reinterprets frozen pending work
component_ids:
  - CMP-PROCESSING-ADAPTERS
  - CMP-PERSON-CLIENT
  - CMP-PERMISSIONS
created_at: 2026-08-13
reviewed_at: 2026-09-27
reviewed_ref: 83c8eb63aed78ba760678294ecf7fef863743e06
origin: live
evidence_status: observed-live
status: mitigating
severity: high
first_observed: 2026-08-12
invariant_ids:
  - INV-PERMISSIONS-013
  - INV-12
evidence_ids:
  - EVID-JOB-AB-LEDGER-001
implementation_refs:
  - commit:4b505021b03255c870695e0fba56a2b74879d86a
  - commit:2fab8152abd441f3e4927babe3d6d6d909f22450
regression_test_refs:
  - tests/machine/operator-lifecycle-cli.test.ts@4b505021b03255c870695e0fba56a2b74879d86a
  - tests/product/slack-reviewer-publication.test.ts@8d61edada1cf994678aa7c2201c47ff08753ea08
  - providers/slack/server/test/private-approval/private-slack-dm-approval-stager-v2.test.ts@83c8eb63aed78ba760678294ecf7fef863743e06
  - providers/slack/server/test/private-approval/sqlite-private-slack-approval-assignment-state-v1.test.ts@83c8eb63aed78ba760678294ecf7fef863743e06
  - providers/slack/server/test/private-approval/sqlite-stable-private-approval-authority-fence-v1.test.ts@83c8eb63aed78ba760678294ecf7fef863743e06
  - providers/slack/server/test/private-approval/sqlite-private-slack-approval-terminal-authority-v1.test.ts@83c8eb63aed78ba760678294ecf7fef863743e06
---

# FP-PERMISSIONS-001: Current configuration reinterprets frozen pending work

## Plain-English summary

Pending approval work must keep the identity, channel, action mapping,
permission mode, presentation bytes, adapter version, and credential identity
under which it was created. Runtime or diagnostic composition from today's
settings can falsely report rotation or resolve the old work differently.

## Boundary, trigger, and symptom

The live `doctor` path on the Mac runtime initially constructed the Slack
surface without the same organization authorizer and renderer as runtime. It
reported credential rotation even though current, frozen, and backup
fingerprints agreed.

That `doctor` path was deleted with the Mac runtime in `a254232c`. Pending
approval work now lives in the Organization Authority's private Slack approval
path. There, a retry, a tap, or a terminal resolution could be judged against
current project, recipient, or connection state instead of the frozen
contract.

## Risk and root cause

Diagnostics and runtime can disagree, operators can be pushed toward deleting
valid frozen state, or an old approval can be reinterpreted under a new policy.

## Tempting but unsafe response

Do not delete, restore, repost, or bypass the fingerprint check. Do not inject
dummy authorization components and then report complete runtime health.

## Required behavior, recovery, and regression

Resolve pending work only from the persisted contract. Compose diagnostics
with equivalent authorization semantics, but inspect real state through a
side-effect-free read-only path. Distinguish provider reachability from
authorization readiness.

The `4b505021` and `2fab8152` implementation refs pin the original `doctor`
parity repair. The `4b505021` and `8d61edad` regression refs pin its tests and
the stored Slack approval card check. Both tests were deleted in `a254232c`.

At the reviewed ref, frozen private Slack approval resolution was
source-tested by the four `private-approval` regression refs above. They were
removed with the Slack approval internals on 2026-10-07 (Slack approvals are
paused until the approval core's Slack plug-in), so they remain readable only
at that ref:

- `private-slack-dm-approval-stager-v2.test.ts`
  freezes the pending contract before Slack I/O, resolves a retry from it
  after current project state changes, and refuses recipient drift or a
  missing retained source before provider I/O;
- `sqlite-private-slack-approval-assignment-state-v1.test.ts`
  keeps the frozen delivery and assignment immutable across restart and
  completes a terminal from the frozen tuple after supersession;
- `sqlite-stable-private-approval-authority-fence-v1.test.ts`
  fails closed at tap time on a card binding that differs from the stored
  one, a stale candidate, or a revoked owner membership; and
- `sqlite-private-slack-approval-terminal-authority-v1.test.ts`
  rejects a missing commitment or a presentation spliced from another frozen
  tuple before V4.

No current diagnostic evaluates pending approval work, so the diagnostic half
of this pattern has no enforcement point. A future diagnostic over pending
work must meet it with new proof. The pattern stays `mitigating` because that
half is unproven and no linked qualification or live evidence covers the
current approval path.
