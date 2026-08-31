---
schema_version: 1
id: FP-ADAPTERS-004
kind: failure-pattern
title: Model is required to reproduce evidence bytes
component_ids:
  - CMP-PROCESSING-ADAPTERS
  - CMP-MEETING-PROCESSING-CORE
created_at: 2026-08-13
reviewed_at: 2026-08-13
reviewed_ref: fd762a45e8745eebf27f346317e97038be69de44
origin: live
evidence_status: observed-live
status: mitigating
severity: high
first_observed: 2026-08-12
invariant_ids:
  - INV-ADAPTERS-004
  - INV-08
failure_pattern_ids:
  - FP-ADAPTERS-003
evidence_ids:
  - EVID-LLM-GROUNDING-RETRY-001
  - EVID-JOB-AB-LEDGER-001
implementation_refs:
  - commit:fd762a45e8745eebf27f346317e97038be69de44
regression_test_refs:
  - tests/adapters/llm-decision-processor.test.ts@fd762a45e8745eebf27f346317e97038be69de44
---

# FP-ADAPTERS-004: Model is required to reproduce evidence bytes

## Plain-English summary

The model understood ordinary notes and found relevant signals, but paraphrased
the supporting text. ECHO required a byte-identical quote and discarded every
otherwise supported finding.

## Boundary, trigger, and symptom

Semantic extraction and exact byte reproduction were combined in one model
task. The application then used substring equality as its grounding gate.

## Risk and root cause

Useful findings disappear silently. Conversely, a model-written quote remains
model-authored evidence even when it happens to match source text.

## Tempting but unsafe response

Do not relax substring comparison or let the model invent an unbounded source
locator. A citation ID proves source selection, not semantic entailment.

## Required behavior, detection, and regression

Assign request-local aliases to canonical source blocks, let the model select
an alias, and resolve it locally. Valid empty and all-invalid output are
different outcomes. Tests cover supported paraphrase, mixed valid/invalid
references, and all-invalid retry. The exact implementation, regression, and
live evidence scope is fixed by the refs and evidence IDs above.
