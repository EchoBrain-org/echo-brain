---
schema_version: 1
id: INV-IDENTITY-002
kind: invariant
title: Access duration changes are versioned compatibility changes
component_ids:
  - CMP-IDENTITY-ACCESS
  - CMP-PROTOCOLS-CRYPTO
  - CMP-CENTRAL-ORGANIZATION
created_at: 2026-08-13
reviewed_at: 2026-08-13
reviewed_ref: 280db80479a39ba51708b5923cc4b3eb3cfcd7ef
normative: MUST
enforcement_status: partial
enforcement_scope: Signed V1 and opt-in V2 organization access leases
failure_pattern_ids:
  - FP-IDENTITY-002
---

# INV-IDENTITY-002: Access duration changes are versioned compatibility changes

## Statement

Changing an access lease duration MUST use an explicitly signed protocol
version or capability request. Legacy clients retain their accepted bound, and
historical verification uses a stable protocol ceiling rather than today's
issuance policy.

## Scope and failure behavior

Request freshness, clock-skew tolerance, lease lifetime, and offline
revocation latency are separate controls. Deployment and rollback order must
prevent an old client from encountering a central head it cannot validate.

## Enforcement and verification

The reviewed V2 opt-in preserves V1 five-minute behavior and permits a bounded
longer request. Live issuance requires its own exact qualification.
