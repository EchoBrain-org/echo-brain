---
schema_version: 1
id: FP-IDENTITY-002
kind: failure-pattern
title: Lease duration changes without protocol negotiation
component_ids:
  - CMP-IDENTITY-ACCESS
  - CMP-PROTOCOLS-CRYPTO
  - CMP-ORGANIZATION-AUTHORITY
created_at: 2026-08-13
reviewed_at: 2026-08-13
reviewed_ref: 280db80479a39ba51708b5923cc4b3eb3cfcd7ef
origin: review
evidence_status: reproduced
status: mitigating
severity: high
first_observed: 2026-08-12
invariant_ids:
  - INV-IDENTITY-002
failure_pattern_ids:
  - FP-IDENTITY-003
evidence_ids:
  - EVID-CANDIDATE-IDENTITY-001
  - EVID-JOB-AB-LEDGER-001
implementation_refs:
  - commit:280db80479a39ba51708b5923cc4b3eb3cfcd7ef
regression_test_refs:
  - packages/organization-api/test/access-lease-request.test.ts@280db80479a39ba51708b5923cc4b3eb3cfcd7ef
  - tests/product/local-organization-coordinator.test.ts@280db80479a39ba51708b5923cc4b3eb3cfcd7ef
---

# FP-IDENTITY-002: Lease duration changes without protocol negotiation

## Plain-English summary

Raising the Authority's lease duration globally from five to thirty minutes
would cause older Macs to reject the new central access head. It could also
make previously valid signed history appear invalid if today's issuance policy
were reused as the verification ceiling.

## Boundary, trigger, and symptom

Server issuance, client acceptance, historical verification, and rollback were
treated as one configurable number rather than separate protocol rules.

## Risk and root cause

Mixed versions can enter a permanent fail-closed stale-head loop. Rolling back
only code can leave signed state the older image cannot validate.

## Tempting but unsafe response

Do not raise one global TTL or change clock skew and lease lifetime together.
Do not bind a short signed request to an unrelated longer state.

## Required behavior, recovery, and regression

Use signed versioned opt-in, preserve V1 behavior, verify history against a
stable protocol maximum, and deploy the Authority before opting in clients.
Tests cover old clients, request binding, policy lowering, and rollback. V2
passed local and CI checks but was not issued in the stopped Job A proof.
