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
reviewed_at: 2026-09-27
reviewed_ref: 83c8eb63aed78ba760678294ecf7fef863743e06
decision_ids:
  - ADR-0026
  - ADR-0012
  - ADR-0001
  - ADR-0002
  - ADR-0003
  - ADR-0004
  - ADR-0006
  - ADR-0007
  - ADR-0008
  - ADR-0010
  - ADR-0011
  - ADR-0013
  - ADR-0014
  - ADR-0015
  - ADR-0016
  - ADR-0017
  - ADR-0018
  - ADR-0019
  - ADR-0020
  - ADR-0021
  - ADR-0022
  - ADR-0023
  - ADR-0024
  - ADR-0025
  - ADR-0027
  - ADR-0028
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

The single-organization Authority process runs the workspace dependency closure
that [`deploy/organization-authority/Dockerfile`](../../deploy/organization-authority/Dockerfile)
copies into its runtime stage. Its hosting account and operator are selected
under
[ADR-0008](../decisions/ADR-0008-echo-hosted-authority-by-default.md):

| Workspace                       | Owns                                                                                  |
| ------------------------------- | ------------------------------------------------------------------------------------- |
| `organization-authority`        | Organization identity, access, HTTP boundary, and composition                         |
| `organization-authority-kernel` | Authority SQL baselines, persistence adapters, and state lineage                      |
| `organization-processing`       | Provider-neutral meeting processing and admitted-meeting workflow                     |
| `organization-control-plane`    | Verified provider connection, Person identity links, and private approval persistence |
| `organization-record`           | Append-only approved record and deterministic append-side projections                 |
| `organization-retrieval`        | Rebuildable permission-aware retrieval generations                                    |

The rest of the closure is the shared `federation-protocol`,
`organization-protocol` and `organization-api` contracts plus the composed
providers: `providers/granola`, `providers/jira`, `providers/jira/client`,
`providers/openrouter`, `providers/synthetic-demo`, `providers/slack/server`
and `providers/slack/client`. Only `organization-authority` is a process entry
point; the others are libraries linked into the Authority runtime. The
deployment also includes a separate reverse proxy.

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

Central state also holds immutable source custody under
[ADR-0014](../decisions/ADR-0014-unified-source-ingestion-and-document-custody.md):
Person originals and admitted source revisions, including opt-in retained
context captures, which the proposed
[ADR-0028](../decisions/ADR-0028-broadened-layer-1-source-captures.md) names
Layer 1 source captures. Custody grants no read access. The
[persistence ownership](../architecture/organization-workspace-boundaries.md#persistence-ownership)
map lists the databases, including the gated Jira connection sidecar.

## Provider identity-link composition

The current Slack Person identity-link capability is intentionally split at the
concrete Slack provider edge, `providers/slack/server/src/person-identity/`:
`slack-person-identity-link-workflow-v1` owns the authenticated challenge and
proof workflow, while `sqlite-slack-person-identity-link-repository-v1` owns the SQLite-backed
repository and its factory. The workflow stays in the provider workspace rather
than the Authority `application/` because it coordinates the Slack provider,
organization secret, and persistence port; moving those dependencies inward
would weaken the Authority boundary.

## Current references

An opt-in [connector capture composition](../product/2026-10-01-connector-context-integration-v1.md)
binds provider-neutral capture envelopes to explicit Authority disposition,
organization, read authorization and atomic retention checks. It is not installed
in the production root and grants no retrieval or release authority; only the
staging connector rehearsal composes it, and it retains Jira and Slack
pointers.

- [One-organization workspace boundaries](../architecture/organization-workspace-boundaries.md)
- [Organization control plane](../architecture/organization-control-plane.md)
- [Permission release-boundary invariant](../invariants/INV-PERMISSIONS-015-layer-3-person-release-boundary.md)
- [Project context V1 contract](../decisions/ADR-0013-project-context-v1-contract.md)
- [`services/organization-authority/`](../../services/organization-authority)
- [`packages/organization-control-plane/`](../../packages/organization-control-plane)
- [`packages/organization-record/`](../../packages/organization-record)
- [`packages/organization-retrieval/`](../../packages/organization-retrieval)

Deployment, backup, migration, and rollback must treat the Authority image and
its complete compatible state generation as one qualification boundary.

## Original Person upload custody

Authority retains authenticated original text notes and document files with
their selected audience and an immutable receipt. Upload-specific read/search verifies the
current reader, enforces that audience, and audits before release. Optional
search enrichment cannot change permissions or source text. The V1 upload
route is retired; V1 originals already retained keep their Only me/Team
visibility and remain citable by Ask. Uploads remain in
protected Authority custody/backups; they are not appended as approved decision
records. See the [Person upload scope](../product/2026-09-21-person-update-inbox-v1.md)
for provisional transport limits, indefinite retention, and the offline V5 copy.
The [PC-01 persistence handoff](../product/2026-09-21-project-context-pc01-persistence.md)
describes the original V7 project storage. The current Authority is V10, which
accepts only fresh state, and its project routes and client operations are live.

Ask is specified by [ADR-0019](../decisions/ADR-0019-agentic-ask-v1.md) as
updated by [ADR-0022](../decisions/ADR-0022-agentic-ask-only.md): the V3 route
and shared evidence desk are composed whenever an answer model is configured,
with no capability switch. Live qualification is separate.

The desk owns Person authorization, the pinned retrieval snapshot and release
audits. Record coordinates are resolved through that authorized snapshot before
raw-record metadata is added. Its required ports expose the complete desk
contract; legacy Ask contracts remain separate.

The answer kernel owns request-local orchestration and budgets. Pure model
protocol and response helpers handle parsing and canonical V4 validation, while
the route binds the Person, desk, model and request audit. It receives no storage
handle or provider-specific implementation. Architecture tests traverse its
entire import closure to enforce that separation.

Person list and open by ref are specified in
[ADR-0024](../decisions/ADR-0024-person-list-open-and-mine-scope.md).
`POST /v1/person/list` returns the newest notes, documents and approved
meetings the caller can read, 25 per page under an opaque cursor, in global,
joined-project or mine scope; `POST /v1/person/open` reads one of them, or a
shared transcript, by its ref. Both are model-free and served outside the
answer-model gate. The originals store lists custody rows under the evidence
desk's access rule, and the records route lists meetings from the pinned search
generation and opens them through the Layer 1 exact read; neither returns the
envelope. Mine is the caller's own notes and uploads plus meetings they
finally approved, and Ask accepts the same `mine` scope. Each store audits its
released rows before the route revalidates and writes one page audit.
