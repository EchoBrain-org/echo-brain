---
schema_version: 1
id: INV-IDENTITY-001
kind: invariant
title: Provider identity proof is complete and symmetric
component_ids:
  - CMP-ADAPTERS
  - CMP-IDENTITY-ACCESS
  - CMP-CENTRAL-ORGANIZATION
created_at: 2026-08-13
reviewed_at: 2026-08-13
reviewed_ref: 77b7744b46a912b9154c218b3a036e8552d7180e
normative: MUST
enforcement_status: partial
enforcement_scope: Slack product and Authority identity paths
failure_pattern_ids:
  - FP-IDENTITY-001
---

# INV-IDENTITY-001: Provider identity proof is complete and symmetric

## Statement

Every component that signs or verifies provider identity MUST derive the same
complete tuple from the same authoritative provider endpoints and cross-check
overlapping claims.

## Scope and failure behavior

The identity specification names each tuple component, authoritative endpoint,
nullability, required scope, deletion or revocation state, and correlation
rule. A field accepted as optional during enrollment cannot silently become
mandatory during use. Missing or disagreeing proof fails closed.

## Enforcement and verification

The reviewed Slack path correlates `auth.test` with `bots.info`. This is a
bounded implementation, not proof for every future provider.
