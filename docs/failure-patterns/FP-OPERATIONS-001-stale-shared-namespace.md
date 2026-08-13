---
schema_version: 1
id: FP-OPERATIONS-001
kind: failure-pattern
title: Dependency restart leaves a proxy in a stale shared namespace
owners:
  - unassigned
component_ids:
  - CMP-CENTRAL-ORGANIZATION
  - CMP-OPERATIONS-RELEASE
created_at: 2026-08-13
reviewed_at: 2026-08-13
reviewed_ref: 5aa7a37de94b8431c8fcb40cdee15ed34c4ba69a
origin: live
evidence_status: observed-live
status: mitigating
severity: high
first_observed: 2026-08-13
invariant_ids:
  - INV-OPERATIONS-001
decision_ids: []
failure_pattern_ids: []
runbook_ids: []
qualification_ids: []
issue_urls: []
evidence_ids:
  - EVID-AUTHORITY-RESTART-001
  - EVID-JOB-AB-LEDGER-001
implementation_refs:
  - commit:5aa7a37de94b8431c8fcb40cdee15ed34c4ba69a
regression_test_refs:
  - .github/workflows/ci.yml@5aa7a37
risk_decision_id: null
residual_risk: Engine-initiated dependency crash restart is not covered by explicit Compose restart propagation
next_review_at: null
---

# FP-OPERATIONS-001: Dependency restart leaves a proxy in a stale shared namespace

## Plain-English summary

The proxy shares the Authority container's network namespace. Restarting only
the Authority can replace that namespace while the old proxy process remains
apparently healthy but disconnected from the live service.

## Boundary, trigger, and symptom

Container health and public reachability were treated as the same signal.
`network_mode: service:authority` was understood as addressing configuration,
not shared lifecycle state.

## Risk and root cause

The Authority can be healthy on loopback while public access remains broken.
An operator may repeatedly restart the wrong component or misdiagnose a tunnel
failure.

## Tempting but unsafe response

Do not rely on application health alone or assume dependency declarations
propagate every kind of restart.

## Required behavior, recovery, and regression

Restart the stack as one unit, prove the proxy process was replaced, verify it
targets the current Authority namespace, and test both private health and
public descriptor/no-store behavior. The reviewed fix covers explicit Compose
restart. Engine-initiated crash restart remains an explicit residual.
