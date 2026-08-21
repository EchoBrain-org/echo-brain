---
schema_version: 1
id: CMP-CENTRAL-ORGANIZATION
kind: component
title: Central organization
owners:
  - unassigned
component_ids:
  - CMP-CENTRAL-ORGANIZATION
created_at: 2026-08-13
reviewed_at: 2026-08-14
reviewed_ref: 83819a57fd8635384d14d3cc8d591e8f76ad1260
decision_ids:
  - ADR-0001
  - ADR-0002
  - ADR-0003
  - ADR-0004
invariant_ids:
  - INV-IDENTITY-001
  - INV-IDENTITY-002
  - INV-IDENTITY-003
  - INV-IDENTITY-004
  - INV-IDENTITY-005
  - INV-RUNTIME-001
  - INV-OPERATIONS-001
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

# Central organization

## Responsibility

The customer-hosted Authority process composes four central workspaces:

| Workspace | Owns |
| --- | --- |
| `organization-authority` | Organization identity, access, HTTP boundary, and composition |
| `organization-control-plane` | Provider connection, identity links, bindings, grants, and integration audit |
| `organization-record` | Append-only approved record and deterministic append-side projections |
| `organization-retrieval` | Rebuildable permission-aware retrieval generations |

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

## Current references

- [One-organization workspace boundaries](../architecture/organization-workspace-boundaries.md)
- [Organization control plane](../architecture/organization-control-plane.md)
- [Permission invariant registry](../product/2026-08-11-architecture-invariant-registry.md)
- [`services/organization-authority/`](../../services/organization-authority)
- [`services/organization-control-plane/`](../../services/organization-control-plane)
- [`services/organization-record/`](../../services/organization-record)
- [`services/organization-retrieval/`](../../services/organization-retrieval)

Deployment, backup, migration, and rollback must treat the Authority image and
its complete compatible state generation as one qualification boundary.
