---
schema_version: 1
id: INV-ADAPTERS-003
kind: invariant
title: Model execution controls are explicit processing identity
component_ids:
  - CMP-PROCESSING-ADAPTERS
  - CMP-MEETING-PROCESSING-CORE
created_at: 2026-08-13
reviewed_at: 2026-10-11
reviewed_ref: 3aea847cca4fa44cfa1ab28dbf44b1b707590b8b
normative: MUST
enforcement_status: partial
enforcement_scope: OpenRouter decision-processor and Ask structured-generation adapters
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

The reviewed Ollama Qwen path that disabled the incompatible thinking channel
([FP-ADAPTERS-003](../failure-patterns/FP-ADAPTERS-003-model-execution-channel.md))
was removed with the Ollama provider in `6b87c73b` (2026-10-06). OpenRouter is
the only current model provider:

- The decision processor's client
  (`providers/openrouter/src/llm/openrouter-client.ts`) sends a strict
  `json_schema` response format, `max_tokens` and
  `provider.require_parameters`, and maps `finish_reason: length` to a
  retryable truncation error.
  `providers/openrouter/test/llm/openrouter-client.test.ts` pins the request
  and each finish reason.
- The Ask structured-generation adapter sends the same controls plus
  `provider.data_collection: "deny"`;
  `providers/openrouter/test/adapters/answer-composition/openrouter/openrouter-structured-generation-adapter.test.ts`
  pins its request.
- The processor's model, maximum output tokens and adapter, prompt and schema
  versions feed its processing identity (`llmProcessingVersion`). The
  hard-coded wire controls enter that identity only through a manual
  `LLM_DECISION_PROCESSOR_ADAPTER_VERSION` bump.

The Ask adapter pins one thinking control: reasoning effort `medium`, sent in
its request body on every call. Its model, Claude Sonnet 5.5, takes no
temperature, so the adapter sends none. The decision processor pins none, so
every new model/provider pair still needs its own conformance probe.
