---
schema_version: 1
id: INV-PERMISSIONS-013
kind: invariant
title: Pending consequential work resolves under its frozen contract
component_ids:
  - CMP-PROCESSING-ADAPTERS
  - CMP-PERSON-CLIENT
  - CMP-PERMISSIONS
created_at: 2026-08-13
reviewed_at: 2026-08-13
reviewed_ref: 4b505021b03255c870695e0fba56a2b74879d86a
normative: MUST
enforcement_status: partial
enforcement_scope: Frozen Slack approval presentation and authorization-aware diagnostic composition
invariant_ids:
  - INV-12
failure_pattern_ids:
  - FP-PERMISSIONS-001
---

# INV-PERMISSIONS-013: Pending consequential work resolves under its frozen contract

## Statement

Pending consequential work MUST resolve from its persisted provider,
destination, actor, action mapping, adapter version, presentation bytes,
permission mode, and credential identity rather than current configuration.

## Scope and failure behavior

A changed or incomplete contract refuses before provider I/O. Diagnostics that
evaluate the same work must compose the same authorization-aware context as
runtime while inspecting production state without creating or migrating it.

## Enforcement and verification

Frozen Slack approval state is implemented for the bounded reviewer paths.
Diagnostic parity and read-only inspection are covered by the reviewed ref;
broader approval paths remain outside this bounded enforcement scope.
