---
schema_version: 1
id: INV-ADAPTERS-002
kind: invariant
title: External object identity is durable before verification
component_ids:
  - CMP-PROCESSING-ADAPTERS
  - CMP-PERSON-CLIENT
  - CMP-PERMISSIONS
created_at: 2026-08-13
reviewed_at: 2026-08-13
reviewed_ref: 8d61edada1cf994678aa7c2201c47ff08753ea08
normative: MUST
enforcement_status: partial
enforcement_scope: Exact Slack reviewer and organization-member publication
failure_pattern_ids:
  - FP-ADAPTERS-002
---

# INV-ADAPTERS-002: External object identity is durable before verification

## Statement

After a provider identifies a successful external write, ECHO MUST durably
retain that provider object identity before further verification. Verification
MUST read the authoritative stored object. A retry with an acquired reference
MUST reconcile that same object and MUST NOT create another.

## Scope and failure behavior

A response lost before any reference is acquired remains an explicit unknown
outcome governed by provider-specific idempotency, lookup, or operator
reconciliation. Exact-once delivery must not be claimed across that boundary
without provider support.

## Enforcement and verification

The reviewed Slack approval path implements identified-post persistence,
stored-card readback, restart recovery, and concurrent-winner verification.
Legacy generic delivery retains a narrower at-least-once boundary.
