---
schema_version: 1
id: QMAT-PERSON-CLIENT-FOUNDATION-V1-001
kind: qualification-matrix
title: Person-client minimum lean V1 auth and packaging foundation matrix
component_ids:
  - CMP-IDENTITY-ACCESS
  - CMP-OPERATIONS-RELEASE
created_at: 2026-08-19
reviewed_at: 2026-08-19
reviewed_ref: 70062802fc938441151af0e9bf4dfbc09fbb1eda
matrix_version: 1
assertion_ids:
  - PCFV1-001
  - PCFV1-002
  - PCFV1-003
  - PCFV1-004
  - PCFV1-005
  - PCFV1-006
  - PCFV1-007
  - PCFV1-008
qualification_ids:
  - QUAL-20260819-193536-001
---

# Person-client minimum lean V1 auth and packaging foundation matrix

## Scope and non-claims

This matrix qualifies the thin Person-authenticated machine package and its
live identity foundation. It deliberately stops before real meeting batches,
default-product cutover, background-service activation, or client-live
release.

| Assertion ID | Assertion |
| --- | --- |
| `PCFV1-001` | The Person client is one checked workspace and imports only the three public protocol/API workspaces, never Authority implementation. |
| `PCFV1-002` | One clean committed build embeds the exact source SHA and emits one outer SHA-256-pinned tarball. |
| `PCFV1-003` | The archive contains the client and exactly three bundled public workspaces, with no server code, internal symlinks, or TypeScript build metadata. |
| `PCFV1-004` | The exact tarball installs offline outside the repository and passes version, dispatch, and invalid-session no-write probes. |
| `PCFV1-005` | The Authority image builds from the same monorepo while excluding the Person client and development tooling from its production dependency closure. |
| `PCFV1-006` | A content-addressed side-by-side install leaves the default product and its rollback artifact byte-identical. |
| `PCFV1-007` | The packaged candidate refreshes the existing live Person session without exposing tokens and preserves the private session-store modes. |
| `PCFV1-008` | No legacy product LaunchAgent or meeting processor is started by qualification. |
