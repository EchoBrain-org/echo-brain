---
schema_version: 1
id: INV-OPERATIONS-001
kind: invariant
title: Components sharing a runtime namespace share lifecycle qualification
component_ids:
  - CMP-CENTRAL-ORGANIZATION
  - CMP-OPERATIONS-RELEASE
created_at: 2026-08-13
reviewed_at: 2026-08-13
reviewed_ref: 5aa7a37de94b8431c8fcb40cdee15ed34c4ba69a
normative: MUST
enforcement_status: partial
enforcement_scope: Explicit Authority Compose restart
failure_pattern_ids:
  - FP-OPERATIONS-001
---

# INV-OPERATIONS-001: Components sharing a runtime namespace share lifecycle qualification

## Statement

When one component joins another component's runtime namespace, restart and
qualification MUST treat that namespace as a shared lifecycle resource.
Application health and externally served reachability MUST be proved
independently after restart.

## Scope and failure behavior

An explicit dependency restart propagates to namespace dependents and proves
the new process and route. Engine-initiated crash restart remains a separately
stated residual until the topology or supervisor closes it.

## Enforcement and verification

The reviewed Compose change and CI smoke cover explicit Authority restart and
proxy replacement. Externally served reachability remains a separate exact-run
qualification assertion.
