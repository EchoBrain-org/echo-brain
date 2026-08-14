---
schema_version: 1
id: INV-ADAPTERS-003
kind: invariant
title: Model execution controls are explicit processing identity
component_ids:
  - CMP-ADAPTERS
  - CMP-CORE-PIPELINE
created_at: 2026-08-13
reviewed_at: 2026-08-13
reviewed_ref: fd762a45e8745eebf27f346317e97038be69de44
normative: MUST
enforcement_status: partial
enforcement_scope: Qwen 3 through the Ollama adapter on the founder-live hardening branch
failure_pattern_ids:
  - FP-ADAPTERS-003
---

# INV-ADAPTERS-003: Model execution controls are explicit processing identity

## Statement

Provider and model options that can change reasoning channels, visible output,
structured-output behavior, truncation, or token use MUST be explicit, tested,
and included in processing identity.

## Scope and failure behavior

Empty, thinking-only, truncated, invalid-schema, and valid-empty responses are
distinct outcomes. The adapter must not silently turn incompatible provider
behavior into a successful empty extraction.

## Enforcement and verification

The reviewed Ollama Qwen path disables the incompatible thinking channel and
pins the wire request in tests. Every new model/provider pair needs its own
conformance probe.
