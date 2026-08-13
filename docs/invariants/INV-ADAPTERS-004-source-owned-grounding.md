---
schema_version: 1
id: INV-ADAPTERS-004
kind: invariant
title: Models select source-owned evidence references
owners:
  - unassigned
component_ids:
  - CMP-ADAPTERS
  - CMP-CORE-PIPELINE
created_at: 2026-08-13
reviewed_at: 2026-08-13
reviewed_ref: fd762a45e8745eebf27f346317e97038be69de44
normative: MUST
enforcement_status: partial
enforcement_scope: Shared LLM decision processor on the founder-live hardening branch
invariant_ids:
  - INV-08
decision_ids: []
failure_pattern_ids:
  - FP-ADAPTERS-004
runbook_ids: []
qualification_ids: []
issue_urls: []
---

# INV-ADAPTERS-004: Models select source-owned evidence references

## Statement

A model MUST select bounded identifiers for source material supplied in the
same request. Deterministic application code MUST resolve those identifiers to
canonical source evidence. A model MUST NOT author the evidence bytes stored
as provenance.

## Scope and failure behavior

A declared empty result may be valid. A nonempty result whose every reference
is invalid fails retryably rather than becoming a successful empty extraction.
Invalid individual references cannot widen or invent evidence.

## Enforcement and verification

Request-local aliases and canonical block resolution are implemented and
tested at the reviewed ref. Human review still determines whether a grounded
claim is semantically supported; an identifier proves origin, not entailment.
