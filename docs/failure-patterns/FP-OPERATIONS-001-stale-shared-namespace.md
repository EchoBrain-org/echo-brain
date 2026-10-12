---
schema_version: 1
id: FP-OPERATIONS-001
kind: failure-pattern
title: Dependency restart leaves a proxy in a stale shared namespace
component_ids:
  - CMP-ORGANIZATION-AUTHORITY
  - CMP-OPERATIONS-RELEASE
created_at: 2026-08-13
reviewed_at: 2026-10-11
reviewed_ref: 3aea847cca4fa44cfa1ab28dbf44b1b707590b8b
origin: live
evidence_status: observed-live
status: mitigating
severity: high
first_observed: 2026-08-13
invariant_ids:
  - INV-OPERATIONS-001
evidence_ids:
  - EVID-AUTHORITY-RESTART-001
  - EVID-JOB-AB-LEDGER-001
implementation_refs:
  - commit:5aa7a37de94b8431c8fcb40cdee15ed34c4ba69a
regression_test_refs:
  - .github/workflows/ci.yml@5aa7a37de94b8431c8fcb40cdee15ed34c4ba69a
  - tests/architecture/authority-backup-maintenance.test.ts@3aea847cca4fa44cfa1ab28dbf44b1b707590b8b
  - tests/architecture/organization-authority-release-record.test.ts@3aea847cca4fa44cfa1ab28dbf44b1b707590b8b
residual_risk: Engine-initiated dependency crash restart is not covered by explicit Compose restart propagation
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

The CI smoke from the reviewed fix was removed in `e75250d`. The current
regression proof is the explicit `compose restart proxy` that the update,
backup-maintenance and tracing paths run after starting the Authority, asserted
by the tests named above; other onboarding starts rely on Compose propagation alone
([INV-OPERATIONS-001](../invariants/INV-OPERATIONS-001-shared-namespace-lifecycle.md)).
