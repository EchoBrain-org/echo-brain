---
schema_version: 1
id: INV-IDENTITY-002
kind: invariant
title: Access duration changes are versioned compatibility changes
component_ids:
  - CMP-IDENTITY-ACCESS
  - CMP-PROTOCOLS-CRYPTO
  - CMP-ORGANIZATION-AUTHORITY
created_at: 2026-08-13
reviewed_at: 2026-09-27
reviewed_ref: 83c8eb63aed78ba760678294ecf7fef863743e06
normative: MUST
enforcement_status: retired
enforcement_scope: None; organization access leases no longer exist
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

Retired. No current path issues, accepts, or verifies an access lease. The
signed lease request contract, its V2 opt-in, and their tests were deleted in
`9f181e15` (lean: delete retired machine protocol). The Authority issuance
path and the Mac coordinator that accepted leases were deleted earlier in the
same lean-down (`59ee182b`, `a254232c`). V2 was never qualified live. The
statement and scope above are kept as the historical rule. Reintroducing a
client-held access lifetime reinstates it with new enforcement and proof.
