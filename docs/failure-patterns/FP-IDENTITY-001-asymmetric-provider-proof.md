---
schema_version: 1
id: FP-IDENTITY-001
kind: failure-pattern
title: Enrollment and authorization derive different provider identities
owners:
  - unassigned
component_ids:
  - CMP-ADAPTERS
  - CMP-IDENTITY-ACCESS
  - CMP-CENTRAL-ORGANIZATION
created_at: 2026-08-13
reviewed_at: 2026-08-13
reviewed_ref: 77b7744b46a912b9154c218b3a036e8552d7180e
origin: live
evidence_status: observed-live
status: mitigating
severity: high
first_observed: 2026-08-12
invariant_ids:
  - INV-IDENTITY-001
  - INV-IDENTITY-004
decision_ids: []
failure_pattern_ids:
  - FP-ADAPTERS-001
  - FP-IDENTITY-004
runbook_ids: []
qualification_ids: []
issue_urls: []
evidence_ids:
  - EVID-JOB-AB-LEDGER-001
implementation_refs:
  - commit:77b7744b46a912b9154c218b3a036e8552d7180e
regression_test_refs:
  - tests/adapters/slack-web-api-client.test.ts@77b7744b46a912b9154c218b3a036e8552d7180e
  - services/organization-control-plane/test/slack-integration-provider.test.ts@77b7744b46a912b9154c218b3a036e8552d7180e
risk_decision_id: null
residual_risk: null
next_review_at: null
---

# FP-IDENTITY-001: Enrollment and authorization derive different provider identities

## Plain-English summary

Enrollment accepted a missing Slack app ID because `auth.test` may omit it.
Later, the approval path correctly required a concrete app ID. A legitimate
founder reaction therefore failed with a generic identity mismatch.

## Boundary, trigger, and symptom

Local product and central Authority implemented related identity checks
independently. The tuple required at action time was stricter than the tuple
proved and persisted at enrollment.

## Risk and root cause

An incomplete or asymmetric identity contract creates unusable enrollments,
ambiguous diagnostics, and pressure to weaken downstream authorization.

## Tempting but unsafe response

Do not trust token possession, message fields, caller-supplied app identity, or
a nullable stored field. Do not relax the action-time equality check.

## Required behavior, recovery, and regression

Define every tuple component and authoritative endpoint. Correlate Slack
`auth.test` and `bots.info` on both sides, reject missing or conflicting proof,
and repair legacy state only through fresh owner-authorized verification. Tests
remove and mismatch each component independently. The repair was live-tested
on the hardening branch but is not merged into this branch's source baseline.
