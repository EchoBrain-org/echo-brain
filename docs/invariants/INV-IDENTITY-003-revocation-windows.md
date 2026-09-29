---
schema_version: 1
id: INV-IDENTITY-003
kind: invariant
title: Central and offline revocation windows are separate claims
component_ids:
  - CMP-IDENTITY-ACCESS
  - CMP-PERMISSIONS
  - CMP-ORGANIZATION-AUTHORITY
created_at: 2026-08-13
reviewed_at: 2026-09-27
reviewed_ref: 83c8eb63aed78ba760678294ecf7fef863743e06
normative: MUST
enforcement_status: retired
enforcement_scope: None; no client holds a cached access lease
invariant_ids:
  - INV-05
  - INV-06
failure_pattern_ids:
  - FP-IDENTITY-003
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

Retired with organization access leases. The lease protocol was deleted in
`9f181e15` (lean: delete retired machine protocol), and the Mac runtime that
cached leases was deleted in `a254232c`. No client now authorizes work from a
cached signed grant, so there is no separate offline window to state. Every
Person request is authorized centrally against current Authority credential,
session, identity-binding, and membership state in
[`person-identity-sessions.ts`](../../services/organization-authority/src/application/person-identity-sessions.ts).
The statement and scope above are kept as the historical rule. Reintroducing
client-held authorization reinstates it with new enforcement and proof.
