---
schema_version: 1
id: FP-ADAPTERS-001
kind: failure-pattern
title: Provider success envelope hides a wire-contract mismatch
owners:
  - unassigned
component_ids:
  - CMP-ADAPTERS
  - CMP-IDENTITY-ACCESS
created_at: 2026-08-13
reviewed_at: 2026-08-13
reviewed_ref: 06811c29458b0bf3aac443baf35453d3a2eb27f3
origin: live
evidence_status: observed-live
status: mitigating
severity: high
first_observed: 2026-08-12
invariant_ids:
  - INV-ADAPTERS-001
decision_ids: []
failure_pattern_ids:
  - FP-IDENTITY-001
runbook_ids: []
qualification_ids: []
issue_urls: []
evidence_ids:
  - EVID-JOB-AB-LEDGER-001
implementation_refs:
  - commit:06811c29458b0bf3aac443baf35453d3a2eb27f3
regression_test_refs:
  - tests/adapters/slack-web-api-client.test.ts@06811c2
risk_decision_id: null
residual_risk: null
next_review_at: null
---

# FP-ADAPTERS-001: Provider success envelope hides a wire-contract mismatch

## Plain-English summary

ECHO called a real provider endpoint with the wrong HTTP method and parameter
location. The provider still returned a success-shaped response, but it did
not return the requested object. Treating `ok: true` as sufficient would have
created false identity evidence.

## Boundary, trigger, and symptom

Slack `bots.info` was sent as JSON POST while its contract required GET with
the bot identifier in the query. Product and central clients used different
encodings, so one side could appear healthy while the two identity proofs
diverged.

## Risk and root cause

The adapter modeled a provider family as one generic transport instead of
pinning each method's contract. Authorization can fail closed unexpectedly or,
for a less strict consumer, accept evidence for the wrong object.

## Tempting but unsafe response

Do not accept any success envelope or fall back to a weaker identity endpoint
to keep tests passing.

## Required behavior, detection, and regression

Assert verb, query/form/body placement, header-only credentials, redirect
refusal, bounded response shape, and presence of the exact requested object.
The regression sends the wrong transport and malformed successes and requires
closed failure. The repair exists on the founder-live hardening branch but is
not present at this documentation branch's `808ac89` source baseline.
