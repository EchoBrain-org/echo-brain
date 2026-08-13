---
schema_version: 1
id: CMP-CATALOG
kind: component-index
title: Component catalog
owners:
  - unassigned
component_ids:
  - CMP-CORE-PIPELINE
  - CMP-ADAPTERS
  - CMP-LOCAL-RUNTIME
  - CMP-IDENTITY-ACCESS
  - CMP-CENTRAL-ORGANIZATION
  - CMP-PERMISSIONS
  - CMP-PROTOCOLS-CRYPTO
  - CMP-OPERATIONS-RELEASE
created_at: 2026-08-13
reviewed_at: 2026-08-13
reviewed_ref: 808ac89eaf3e8eba529b356bd80d4509b9a2a293
---

# Component catalog

Components are the primary navigation layer. They map responsibilities and
data authority to source code, interfaces, cross-cutting records, operations,
and qualification proof.

| Component | Primary source | Responsibility |
| --- | --- | --- |
| [Core pipeline](core-pipeline.md) | `src/core/` | Provider-neutral decision pipeline and ports |
| [Adapters](adapters.md) | `src/adapters/` | Provider-specific sources, processors, approvals, and delivery |
| [Local runtime](local-runtime.md) | `src/product/`, `src/infrastructure/` | Mac composition, durable local state, lifecycle, and update control |
| [Identity and access](identity-access.md) | local organization code plus Authority | Installation, person, enrollment, lease, and revocation state |
| [Central organization](central-organization.md) | `services/organization-*` | Authority, integration policy, record, and retrieval ownership |
| [Permissions](permissions.md) | cross-cutting | Approval, admission, visibility, and read authorization |
| [Protocols and cryptography](protocols-crypto.md) | `packages/*` | Signed documents, canonicalization, identifiers, and HTTP contracts |
| [Operations and release](operations-release.md) | `deploy/`, `tools/`, `.github/` | Build, qualification, deployment, backup, restore, and release |

## Component page contract

Each component page records or links:

- purpose, non-goals, and owner;
- local-versus-central data authority;
- boundaries, dependencies, and trust crossings;
- authoritative contracts and interfaces;
- relevant invariants, decisions, and failure patterns;
- degraded behavior and operational procedures;
- regression tests and qualification evidence;
- deferred work and last verified source or release.

The checked source-boundary registry at
[`tools/workspace-source-boundaries.v1.json`](../../tools/workspace-source-boundaries.v1.json)
is the machine-readable inventory for package, service, and local-organization
workspaces. A later validation checkpoint in this branch will require each
registered workspace to remain reachable from this catalog.
