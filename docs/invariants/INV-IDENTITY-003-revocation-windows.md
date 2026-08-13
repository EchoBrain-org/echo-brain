---
schema_version: 1
id: INV-IDENTITY-003
kind: invariant
title: Central and offline revocation windows are separate claims
owners:
  - unassigned
component_ids:
  - CMP-IDENTITY-ACCESS
  - CMP-PERMISSIONS
  - CMP-CENTRAL-ORGANIZATION
created_at: 2026-08-13
reviewed_at: 2026-08-13
reviewed_ref: 280db80479a39ba51708b5923cc4b3eb3cfcd7ef
normative: MUST
enforcement_status: partial
enforcement_scope: Current central reads and writes plus locally cached organization access leases
invariant_ids:
  - INV-05
  - INV-06
decision_ids: []
failure_pattern_ids:
  - FP-IDENTITY-003
runbook_ids: []
qualification_ids: []
issue_urls: []
---

# INV-IDENTITY-003: Central and offline revocation windows are separate claims

## Statement

Documentation and qualification MUST state central revocation enforcement and
local offline lease expiry as separate windows. Extending a local lease MUST
NOT be described as leaving offline revocation latency unchanged.

## Scope and failure behavior

Central permission checks, reads, and record writes recheck current Authority
state at their consistency boundary. A disconnected Mac can continue locally
only until its accepted signed lease expires. Failure never widens beyond that
explicit bound.

## Enforcement and verification

Central rechecks and local lease expiry are implemented in bounded paths. The
longer V2 offline window remains a security tradeoff requiring explicit live
qualification and release communication.
