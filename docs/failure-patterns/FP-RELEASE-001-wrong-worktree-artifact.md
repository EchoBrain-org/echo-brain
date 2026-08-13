---
schema_version: 1
id: FP-RELEASE-001
kind: failure-pattern
title: Packaging command builds a different worktree than the claimed source
owners:
  - unassigned
component_ids:
  - CMP-OPERATIONS-RELEASE
created_at: 2026-08-13
reviewed_at: 2026-08-13
reviewed_ref: 5aa7a37de94b8431c8fcb40cdee15ed34c4ba69a
origin: live
evidence_status: observed-live
status: observed
severity: critical
first_observed: 2026-08-12
invariant_ids:
  - INV-RELEASE-001
decision_ids: []
failure_pattern_ids: []
runbook_ids: []
qualification_ids: []
issue_urls: []
evidence_ids:
  - EVID-CANDIDATE-IDENTITY-001
  - EVID-JOB-AB-LEDGER-001
implementation_refs: []
regression_test_refs: []
risk_decision_id: null
residual_risk: null
next_review_at: null
---

# FP-RELEASE-001: Packaging command builds a different worktree than the claimed source

## Plain-English summary

A command appeared to target the clean candidate worktree, but `npm pack`
packaged the shell's current worktree. The archive was internally consistent
while its embedded source SHA disagreed with the external build claim.

## Boundary, trigger, and symptom

The operator relied on `npm --prefix` as though it changed the package target
and working directory. Inherited Git environment and lifecycle scripts made
the actual source context ambiguous.

## Risk and root cause

Tests, receipts, and deployment can all refer to different code while each
individual artifact looks valid. This breaks provenance at the exact-artifact
boundary.

## Tempting but unsafe response

Do not relabel the archive, edit its manifest, or continue because its checksum
is stable. A checksum only identifies the wrong bytes consistently.

## Required behavior, recovery, and regression

Quarantine mismatched bytes, run packaging with the process working directory
bound to the clean worktree, sanitize inherited Git identity, and verify the
embedded SHA before install or publication. The live artifact was safely
rebuilt, but a systemic repository guard and issue remain missing.
