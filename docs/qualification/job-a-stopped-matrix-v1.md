---
schema_version: 1
id: QMAT-JOB-A-STOPPED-001
kind: qualification-matrix
title: Job A stopped-state proof matrix
owners:
  - unassigned
component_ids:
  - CMP-CENTRAL-ORGANIZATION
  - CMP-PERMISSIONS
  - CMP-OPERATIONS-RELEASE
created_at: 2026-08-13
reviewed_at: 2026-08-13
reviewed_ref: 4b505021b03255c870695e0fba56a2b74879d86a
matrix_version: 1
assertion_ids:
  - JOB-A-STOP-001
  - JOB-A-STOP-002
  - JOB-A-STOP-003
  - JOB-A-STOP-004
  - JOB-A-STOP-005
  - JOB-A-STOP-006
invariant_ids: []
decision_ids: []
failure_pattern_ids: []
runbook_ids: []
qualification_ids:
  - QUAL-20260813-174902-001
issue_urls: []
---

# Job A stopped-state proof matrix V1

This matrix describes only the assertions carried by the immutable stopped
proof. It is not the complete founder-live plan and not the provider adapter
matrix.

| Assertion ID | Assertion |
| --- | --- |
| `JOB-A-STOP-001` | The expected rejection and reviewer-approval record acts are present at the named record head. |
| `JOB-A-STOP-002` | Reviewer query audit contains the intended allow and bounded negative results. |
| `JOB-A-STOP-003` | Readable-search generation and manifest are bound to the exact record head. |
| `JOB-A-STOP-004` | Required stopped recovery archives and snapshots are recorded. |
| `JOB-A-STOP-005` | After restart, Authority identity, health, loopback binding, proxy namespace, and public descriptor checks pass. |
| `JOB-A-STOP-006` | Public cache behavior is no-store and the proof authorizes neither release nor a version bump. |
