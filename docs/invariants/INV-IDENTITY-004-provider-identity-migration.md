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
reviewed_at: 2026-09-27
reviewed_ref: 83c8eb63aed78ba760678294ecf7fef863743e06
normative: MUST
enforcement_status: retired
enforcement_scope: None; the legacy Slack app-identity promotion was deleted
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

Retired. The Slack app-identity promotion migration, its integrations
repository and re-onboarding path, and their tests were deleted with the
retired server lineage in `59ee182b` (lean: delete retired server lineage).
The clean control-plane baseline opens without a migration ledger, and the
current Slack tool-connection contract requires `provider_app_id`, so no
historical null app ID remains to repair and nothing current enforces this
rule. The statement and scope above are kept as the historical rule. A future
required identity field over existing connections reinstates it with new
enforcement and proof.
