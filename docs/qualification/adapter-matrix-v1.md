---
schema_version: 1
id: QMAT-ADAPTERS-001
kind: qualification-matrix
title: Provider adapter adversarial qualification matrix
owners:
  - unassigned
component_ids:
  - CMP-ADAPTERS
  - CMP-CORE-PIPELINE
  - CMP-IDENTITY-ACCESS
  - CMP-LOCAL-RUNTIME
  - CMP-PERMISSIONS
created_at: 2026-08-13
reviewed_at: 2026-08-13
reviewed_ref: 5aa7a37de94b8431c8fcb40cdee15ed34c4ba69a
matrix_version: 1
invariant_ids:
  - INV-ADAPTERS-001
  - INV-ADAPTERS-002
  - INV-ADAPTERS-003
  - INV-ADAPTERS-004
  - INV-IDENTITY-001
  - INV-IDENTITY-002
  - INV-IDENTITY-003
  - INV-IDENTITY-004
  - INV-RUNTIME-001
  - INV-PERMISSIONS-013
  - INV-PERMISSIONS-014
decision_ids: []
failure_pattern_ids:
  - FP-ADAPTERS-001
  - FP-ADAPTERS-002
  - FP-ADAPTERS-003
  - FP-ADAPTERS-004
  - FP-IDENTITY-001
  - FP-IDENTITY-002
  - FP-IDENTITY-003
  - FP-IDENTITY-004
  - FP-RUNTIME-001
  - FP-PERMISSIONS-001
  - FP-RELEASE-001
  - FP-OPERATIONS-001
runbook_ids: []
qualification_ids: []
issue_urls: []
---

# Provider adapter adversarial qualification matrix V1

This is the reusable minimum matrix for a new provider adapter or a material
change to an existing adapter. Mark a case `not-applicable` only with a written
boundary explanation. Fakes prove deterministic behavior; at least the
sanitized happy path and provider-specific canonicalization assumptions require
a real-provider probe before founder-live qualification.

| Case | Boundary to exercise | Required result or proof |
| --- | --- | --- |
| `ADP-T01` | Exact real-provider happy path | Exact artifact, configuration identity, provider object, and sanitized receipt |
| `ADP-T02` | Wrong HTTP method or parameter encoding | Closed failure; no evidence or side effect accepted |
| `ADP-T03` | Success envelope missing or malforming the requested object | Closed bounded error, never generic success |
| `ADP-T04` | Redirect, credential placement, oversized response | Redirect refused, credentials remain header-only, response bounded |
| `ADP-T05` | Timeout, rate limit, outage | Classified retry/containment without widening or duplicate effect |
| `ADP-I01` | Each identity field missing, malformed, or mismatched | Closed failure naming an internal sanitized mismatch stage |
| `ADP-I02` | Authoritative endpoints disagree | No activation or authorization-grade evidence |
| `ADP-I03` | Wrong tenant, app, bot, user, revoked credential, or missing scope | Closed failure before consequential action |
| `ADP-I04` | Legacy incomplete identity | Fresh owner-authorized proof and atomic audited promotion; no blind backfill |
| `ADP-E01` | Acknowledgement differs from stored provider object | Reference persisted, stored object verified, no repost |
| `ADP-E02` | Response lost before a provider reference is known | Provider-specific reconciliation or explicit unknown outcome; no blind retry |
| `ADP-E03` | Crash after reference acquisition and before verification | Restart reads the same object and finalizes once |
| `ADP-E04` | Two concurrent contenders for one idempotency key | One durable winner; loser rereads and verifies it |
| `ADP-F01` | Restart with changed channel, actor, mode, reactions, adapter, or credential | Refuse before provider I/O; preserve frozen work |
| `ADP-A01` | Wrong human, wrong installation, inactive membership, or revocation during provider I/O | No allow; current authority rechecked before commitment |
| `ADP-A02` | Conflicting or incomplete provider action evidence | Remain pending or deny; absence is not inferred from unknown evidence |
| `ADP-M01` | Empty, thinking-only, truncated, and invalid-schema model output | Distinct classified outcomes with bounded retry policy |
| `ADP-M02` | Mixed valid and invalid grounding, then all-invalid grounding | Keep only valid references; all-invalid nonempty output fails retryably |
| `ADP-L01` | Old client with new lease request/state version | Legacy bound preserved; incompatible head never silently accepted |
| `ADP-L02` | Central revocation and disconnected local lease | Both enforcement windows measured and reported separately |
| `ADP-R01` | Durable resolution after current cycle sweep | One lifecycle-owned follow-up or durable work for successor |
| `ADP-R02` | Shutdown during follow-up | Abort and drain before runtime lock release |
| `ADP-B01` | Packaging from a second clean worktree | Embedded identity equals claimed source and exact artifact receipt |
| `ADP-B02` | Migration, backup, restore, and rollback | Code, configuration, complete state, and external transition form one compatible tuple |
| `ADP-B03` | Restart of a dependency sharing a runtime namespace | Dependents restart, process identity changes, private and public probes pass |

## Qualification output

Every run records the matrix ID and version, exact source and artifact,
sanitized configuration and state identities, per-case outcome, evidence ID,
deviation, and unresolved issue. Passing a subset never implies the entire
matrix passed.
