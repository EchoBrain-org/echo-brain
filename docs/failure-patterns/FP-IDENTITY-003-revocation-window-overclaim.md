---
schema_version: 1
id: FP-IDENTITY-003
kind: failure-pattern
title: Central revocation is described as immediate on an offline Mac
component_ids:
  - CMP-IDENTITY-ACCESS
  - CMP-PERMISSIONS
  - CMP-ORGANIZATION-AUTHORITY
created_at: 2026-08-13
reviewed_at: 2026-08-13
reviewed_ref: 280db80479a39ba51708b5923cc4b3eb3cfcd7ef
origin: review
evidence_status: scenario-defined
status: mitigating
severity: high
first_observed: 2026-08-12
invariant_ids:
  - INV-IDENTITY-003
  - INV-05
  - INV-06
failure_pattern_ids:
  - FP-IDENTITY-002
evidence_ids:
  - EVID-JOB-AB-LEDGER-001
implementation_refs:
  - commit:280db80479a39ba51708b5923cc4b3eb3cfcd7ef
regression_test_refs:
  - tests/product/runtime-isolation.test.ts@280db80479a39ba51708b5923cc4b3eb3cfcd7ef
  - services/organization-authority/test/authority-runtime.test.ts@280db80479a39ba51708b5923cc4b3eb3cfcd7ef
---

# FP-IDENTITY-003: Central revocation is described as immediate on an offline Mac

## Plain-English summary

Central reads and writes can enforce revocation immediately, while a
disconnected Mac may continue local work until its last signed lease expires.
Extending the lease therefore extends one revocation window even if central
enforcement remains immediate.

## Boundary, trigger, and symptom

Documentation or qualification reports one generic revocation claim and hides
the distinction between online Authority enforcement and cached offline
authorization.

## Risk and root cause

Operators and customers receive an inaccurate security guarantee. A longer
lease can be approved without acknowledging its actual exposure.

## Tempting but unsafe response

Do not claim that all revocation remains immediate because central routes
recheck state. Do not silently disable offline work to make the prose true.

## Required behavior, detection, and regression

State and test both windows explicitly. Central actions re-read current state
at their consistency boundary; local work expires at the signed lease bound.
Any changed duration updates threat analysis, qualification, and release
communication. The longer V2 window remains unqualified live.
