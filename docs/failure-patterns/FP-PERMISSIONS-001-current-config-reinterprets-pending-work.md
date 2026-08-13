---
schema_version: 1
id: FP-PERMISSIONS-001
kind: failure-pattern
title: Current configuration reinterprets frozen pending work
owners:
  - unassigned
component_ids:
  - CMP-ADAPTERS
  - CMP-LOCAL-RUNTIME
  - CMP-PERMISSIONS
created_at: 2026-08-13
reviewed_at: 2026-08-13
reviewed_ref: 4b505021b03255c870695e0fba56a2b74879d86a
origin: live
evidence_status: observed-live
status: mitigating
severity: high
first_observed: 2026-08-12
invariant_ids:
  - INV-PERMISSIONS-013
  - INV-12
decision_ids: []
failure_pattern_ids: []
runbook_ids: []
qualification_ids: []
issue_urls: []
evidence_ids:
  - EVID-JOB-AB-LEDGER-001
implementation_refs:
  - commit:4b505021b03255c870695e0fba56a2b74879d86a
  - commit:2fab8152abd441f3e4927babe3d6d6d909f22450
regression_test_refs:
  - tests/machine/operator-lifecycle-cli.test.ts@4b50502
  - tests/product/slack-reviewer-publication.test.ts@8d61eda
risk_decision_id: null
residual_risk: null
next_review_at: null
---

# FP-PERMISSIONS-001: Current configuration reinterprets frozen pending work

## Plain-English summary

Pending approval work must keep the identity, channel, reaction mapping,
permission mode, presentation bytes, adapter version, and credential identity
under which it was created. Runtime or diagnostic composition from today's
settings can falsely report rotation or resolve the old work differently.

## Boundary, trigger, and symptom

The live `doctor` path initially constructed the Slack surface without the same
organization authorizer and renderer as runtime. It reported credential
rotation even though current, frozen, and backup fingerprints agreed.

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
authorization readiness. The diagnostic repair is reviewed on the hardening
branch and remains outside this branch's source baseline.
