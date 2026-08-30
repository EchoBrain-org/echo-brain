---
schema_version: 1
id: INV-RUNTIME-001
kind: invariant
title: Durable side-effect follow-up belongs to the runtime lifecycle
component_ids:
  - CMP-PERSON-CLIENT
  - CMP-ORGANIZATION-AUTHORITY
created_at: 2026-08-13
reviewed_at: 2026-08-13
reviewed_ref: a132c35aa9399876cc633c727d2c820af506bcf4
normative: MUST
enforcement_status: partial
enforcement_scope: Organization record follow-up and record-only recovery
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
runtime lock only after no side effect can escape into a successor runtime or
maintenance window. A recovery command composes only the capability required
for recovery and must not advance unrelated source or adapter cursors.

## Enforcement and verification

The reviewed record-sweep coordinator and record-only flush command implement
this bounded path. The invariant must be applied separately to future durable
effects.
