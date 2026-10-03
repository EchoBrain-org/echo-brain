---
schema_version: 1
id: CMP-CATALOG
kind: component-index
title: Component catalog
owners:
  - unassigned
component_ids:
  - CMP-MEETING-PROCESSING-CORE
  - CMP-PROCESSING-ADAPTERS
  - CMP-PERSON-CLIENT
  - CMP-IDENTITY-ACCESS
  - CMP-ORGANIZATION-AUTHORITY
  - CMP-PERMISSIONS
  - CMP-PROTOCOLS-CRYPTO
  - CMP-OPERATIONS-RELEASE
created_at: 2026-08-13
reviewed_at: 2026-09-27
reviewed_ref: 83c8eb63aed78ba760678294ecf7fef863743e06
---

# Component catalog

Components are the primary navigation layer. They map responsibilities and
data authority to source code, interfaces, cross-cutting records, operations,
and qualification proof.

| Component | Primary source | Responsibility |
| --- | --- | --- |
| [Meeting processing core](meeting-processing-core.md) | `packages/organization-processing/src/core/` | Provider-neutral meeting processing rules and ports |
| [Processing adapters](processing-adapters.md) | `providers/` | Provider-specific sources, processors, approval surfaces, and identity links |
| [Person client](person-client.md) | `src/product/person-client/` | Thin Person CLI and private session state |
| [Identity and access](identity-access.md) | Person client plus Authority | Person sessions, membership, and revocation state |
| [Organization Authority](organization-authority.md) | `services/organization-authority/`; `packages/organization-{control-plane,record,retrieval}/` | Organization identity, policy, record, retrieval, and API authority |
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
is the machine-readable inventory for package, service, and Person-client
workspaces. `npm run check:docs` requires every registered workspace to remain
reachable from this catalog.

## Provider and inward workspaces

The shared implementation packages are `packages/organization-processing` and
`packages/organization-authority-kernel`. Provider ownership is physical:

| Workspace | Scope |
| --- | --- |
| `providers/openai` | OpenAI transport and processor factory |
| `providers/anthropic` | Anthropic transport and processor factory |
| `providers/ollama` | Ollama transport and processor factory |
| `providers/openrouter` | OpenRouter processing, generation and model vocabulary |
| `providers/granola` | Granola source, custody, admission and setup proofs |
| `providers/jira` | Person-bound Jira Nango connection store and HTTP application, gated live reader and context source; [authentication and support boundary](../../providers/jira/README.md) |
| `providers/jira/client` | Jira connection wire contracts and shared Person tool commands; no server dependencies |
| `providers/synthetic-demo` | Fixed synthetic source and its evaluation/setup proofs |
| `providers/slack/client` | Client contracts and Person commands |
| `providers/slack/server` | Server identity, approval, historical codec/projector, connection/setup, fixed-channel context pointer source and assets |
