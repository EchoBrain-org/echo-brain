---
schema_version: 1
id: FP-ADAPTERS-003
kind: failure-pattern
title: Model spends the output budget outside the visible answer channel
owners:
  - unassigned
component_ids:
  - CMP-ADAPTERS
  - CMP-CORE-PIPELINE
created_at: 2026-08-13
reviewed_at: 2026-08-13
reviewed_ref: fd762a45e8745eebf27f346317e97038be69de44
origin: live
evidence_status: observed-live
status: mitigating
severity: high
first_observed: 2026-08-12
invariant_ids:
  - INV-ADAPTERS-003
decision_ids: []
failure_pattern_ids:
  - FP-ADAPTERS-004
runbook_ids: []
qualification_ids: []
issue_urls: []
evidence_ids:
  - EVID-QWEN-OUTPUT-GAP-001
  - EVID-JOB-AB-LEDGER-001
implementation_refs:
  - commit:fd762a45e8745eebf27f346317e97038be69de44
regression_test_refs:
  - tests/adapters/llm-provider-clients.test.ts@fd762a45e8745eebf27f346317e97038be69de44
risk_decision_id: null
residual_risk: null
next_review_at: null
---

# FP-ADAPTERS-003: Model spends the output budget outside the visible answer channel

## Plain-English summary

Qwen 3 used the available output budget for its thinking channel and returned
no final content. The adapter had assumed every structured-output model used
the same visible response behavior.

## Boundary, trigger, and symptom

The Ollama request omitted the provider/model-specific control disabling
thinking. Increasing the token limit merely delayed the same failure.

## Risk and root cause

Valid source material can be repeatedly treated as empty or failed, wasting
runtime and preventing progress. A silent empty-success path could advance a
cursor and lose work.

## Tempting but unsafe response

Do not globally increase limits or accept thinking-only responses as valid
empty decisions.

## Required behavior, detection, and regression

Pin execution controls per provider/model, include them in processing
identity, and test visible-empty, thinking-only, truncation, invalid schema,
and valid-empty outcomes. The Qwen repair passed live on the hardening branch
but is not part of this documentation branch's source baseline.
