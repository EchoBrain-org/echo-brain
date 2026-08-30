---
schema_version: 1
id: FP-RUNTIME-001
kind: failure-pattern
title: Durable provider resolution is not followed by a fresh bounded sweep
component_ids:
  - CMP-PERSON-CLIENT
  - CMP-ORGANIZATION-AUTHORITY
created_at: 2026-08-13
reviewed_at: 2026-08-13
reviewed_ref: a132c35aa9399876cc633c727d2c820af506bcf4
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
regression_test_refs:
  - tests/product/organization-record-sweep-wiring.test.ts@a132c35aa9399876cc633c727d2c820af506bcf4
  - tests/machine/organization-cli.test.ts@a132c35aa9399876cc633c727d2c820af506bcf4
---

# FP-RUNTIME-001: Durable provider resolution is not followed by a fresh bounded sweep

## Plain-English summary

A human approval became durable after the current source cycle's organization
record sweep had already run. Reusing that old sweep meant the approved item
could remain pending centrally until another unrelated cycle occurred.

## Boundary, trigger, and symptom

Human approval latency and central record latency were coupled accidentally.
The callback knew work had become durable but did not schedule lifecycle-owned
follow-up with clear shutdown behavior.

## Risk and root cause

Durable local work can be stranded, duplicated by competing runtimes, or leak
into a maintenance window if background work is not owned and drained.

## Tempting but unsafe response

Do not block the human approval callback on remote record submission, and do
not run a full source cycle merely to flush one durable record.

## Required behavior, recovery, and regression

Schedule one coalesced bounded follow-up, keep the callback synchronous and
nonblocking, abort and drain during shutdown, and provide a record-only
recovery command. Tests cover scheduling, timeout, shutdown, concurrency, and
no unrelated adapter construction. The indexed live evidence records successful
recovery; the exact implementation and test scope is fixed by the refs above.
