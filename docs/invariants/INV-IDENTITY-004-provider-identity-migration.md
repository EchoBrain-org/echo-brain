---
schema_version: 1
id: INV-IDENTITY-004
kind: invariant
title: Incomplete provider identity is repaired by fresh atomic proof
component_ids:
  - CMP-IDENTITY-ACCESS
  - CMP-ORGANIZATION-AUTHORITY
  - CMP-OPERATIONS-RELEASE
created_at: 2026-08-13
reviewed_at: 2026-08-13
reviewed_ref: 77b7744b46a912b9154c218b3a036e8552d7180e
normative: MUST
enforcement_status: partial
enforcement_scope: Legacy Slack app-identity promotion
failure_pattern_ids:
  - FP-IDENTITY-004
---

# INV-IDENTITY-004: Incomplete provider identity is repaired by fresh atomic proof

## Statement

A newly required provider identity field MUST NOT be invented or blindly
backfilled. Repair requires fresh authoritative provider proof and one audited,
atomic transition across every affected connection, binding, grant, and
evidence digest while preserving stable identities where the protocol allows.

## Scope and failure behavior

Partial promotion, caller-supplied identity, or startup fallback fails closed.
Migration and rollback evidence include the code, database state, external
provider transition, and compatible prior tuple.

## Enforcement and verification

The reviewed Slack migration and owner-authorized re-onboarding path implement
this rule for historical null app IDs. It is not a generic migration engine.
