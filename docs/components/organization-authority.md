---
schema_version: 1
id: CMP-ORGANIZATION-AUTHORITY
kind: component
title: Organization Authority
owners:
  - unassigned
component_ids:
  - CMP-ORGANIZATION-AUTHORITY
created_at: 2026-08-13
reviewed_at: 2026-08-26
reviewed_ref: d5b3b13c29e161c5d93f14ce3efdc9b0b818e5dc
decision_ids:
  - ADR-0001
  - ADR-0002
  - ADR-0003
  - ADR-0004
  - ADR-0006
  - ADR-0007
  - ADR-0008
  - ADR-0010
invariant_ids:
  - INV-IDENTITY-001
  - INV-IDENTITY-002
  - INV-IDENTITY-003
  - INV-IDENTITY-004
  - INV-IDENTITY-005
  - INV-RUNTIME-001
  - INV-OPERATIONS-001
  - INV-PERMISSIONS-015
failure_pattern_ids:
  - FP-IDENTITY-001
  - FP-IDENTITY-002
  - FP-IDENTITY-003
  - FP-IDENTITY-004
  - FP-RUNTIME-001
  - FP-OPERATIONS-001
qualification_ids:
  - QMAT-JOB-A-STOPPED-001
  - QUAL-20260813-174902-001
  - QMAT-JOB-B-ACTIVE-MEMBER-001
  - QUAL-20260814-050326-001
  - QMAT-READABLE-SEARCH-MINIMUM-V1-001
  - QUAL-20260814-194049-001
---

# Organization Authority

## Responsibility

The single-organization Authority process composes four central workspaces.
Its hosting account and operator are selected under
[ADR-0008](../decisions/ADR-0008-echo-hosted-authority-by-default.md):

| Workspace                    | Owns                                                                         |
| ---------------------------- | ---------------------------------------------------------------------------- |
| `organization-authority`     | Organization identity, access, HTTP boundary, and composition                |
| `organization-control-plane` | Provider connection, identity links, bindings, grants, and integration audit |
| `organization-record`        | Append-only approved record and deterministic append-side projections        |
| `organization-retrieval`     | Rebuildable permission-aware retrieval generations                           |

Only `organization-authority` is a process entry point. The other three are
libraries linked into the Authority runtime. The deployment also includes a
separate reverse proxy.

## Data authority

Central state is authoritative for organization membership and access,
provider integration policy, the append-only organization record, and
centrally served retrieval generations. Under an active organization-recording
policy it may also hold governed pre-record meeting data from an exactly bound
member identity and organization-owned source credential. That data remains in
the pending approval boundary: it is not an organization record, retrieval
input, or delivery payload until an audited resolution admits it. Central state
must not accept unrestricted provider payloads or bypass that pending-only
boundary.

## Provider identity-link composition

The current Slack Person identity-link capability is intentionally split at the
concrete Authority provider edge, `composition/providers/slack/person-identity/`:
`slack-person-identity-link-workflow-v1` owns the authenticated challenge and
proof workflow, while `sqlite-slack-person-identity-link-repository-v1` owns the SQLite-backed
repository and its factory. The workflow remains in composition rather than
`application/` because it coordinates the Slack provider, organization secret,
and persistence port; moving those dependencies inward would weaken the
Authority boundary.

## Current references

- [One-organization workspace boundaries](../architecture/organization-workspace-boundaries.md)
- [Organization control plane](../architecture/organization-control-plane.md)
- [Permission release-boundary invariant](../invariants/INV-PERMISSIONS-015-layer-3-person-release-boundary.md)
- [`services/organization-authority/`](../../services/organization-authority)
- [`packages/organization-control-plane/`](../../packages/organization-control-plane)
- [`packages/organization-record/`](../../packages/organization-record)
- [`packages/organization-retrieval/`](../../packages/organization-retrieval)

Deployment, backup, migration, and rollback must treat the Authority image and
its complete compatible state generation as one qualification boundary.
