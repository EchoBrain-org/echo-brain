---
schema_version: 1
id: ADR-0037
kind: decision
title: Research model calls skip measured bad hosts, run at temperature 0 and record the serving host
component_ids:
  - CMP-PROCESSING-ADAPTERS
created_at: 2026-10-16
reviewed_at: 2026-10-16
reviewed_ref: 17e967cde9abc730ca3cb04d03350a319d3965e6
status: proposed
supersedes: []
superseded_by: []
updates:
  - ADR-0022
---

# ADR-0037: Research model calls skip measured bad hosts, run at temperature 0 and record the serving host

## Context and options

Every research call (planner, judge and writer) goes through the OpenRouter
structured-generation adapter. [ADR-0022](ADR-0022-agentic-ask-only.md) set
`provider.sort: "throughput"` beside `require_parameters: true` and
`data_collection: "deny"`. The adapter set no temperature, excluded no host,
and recorded only `openrouter` as the provider.

Two findings show the cost of that.

- **Garbled output from some hosts.** On 2026-09-30, Ask answers with garbled
  dates ("September68") were traced to the model output itself. The same
  DeepSeek V3.2 request was replayed against each upstream host. Friendli
  garbled 11 of 40 answers even at temperature 0, and AtlasCloud 2 of 5.
  Alibaba garbled 12 of 51 at the default temperature and 0 of 49 at
  temperature 0 or 0.3. SiliconFlow, Venice, Google, DeepInfra, Baidu and
  Phala were clean. Throughput sorting probably raised exposure, because
  Friendli is often the fastest host.
- **No record of the host.** The 2026-10-16 trace audit of `echo-staging` saw
  latency vary from about 25 to 70 output tokens per second for the same input
  size, and cached input drop to zero between calls with a byte-identical
  system prompt. Prefix caches are per host. Neither effect can be tied to a
  host, because no call records which host served it.

The OpenRouter provider-routing documentation and its OpenAPI description
(both read on 2026-10-16) give these controls:

- `provider.ignore` takes provider slugs. A base slug covers all of that
  provider's endpoints, and the list is merged with account-wide ignores.
- `provider.order` tries providers in sequence, and `allow_fallbacks: false`
  forbids leaving the list.
- `provider.sort` disables load balancing and tries qualifying providers in
  sorted order.
- The `X-OpenRouter-Metadata: enabled` request header adds an
  `openrouter_metadata` object to the response. Its `endpoints.available`
  list marks the endpoint that served the call with `selected: true`. The
  response `id` is the generation id. A top-level `provider` name also appears
  in responses but is not in the published response schema.
- Sticky routing sends later requests to the host that cached earlier ones.
  It applies only when that host's cache reads cost less than its prompt
  tokens. The key is a hash of the first system message and the first
  non-system message, or an explicit `session_id`. An explicit
  `provider.order` turns it off. The documentation says nothing about how it
  combines with `sort` or `ignore`, so we cannot confirm that it survives
  throughput sorting. The research loop's first user message changes on every
  step, so the derived key would differ from step to step anyway.

The options were:

1. Pin an ordered list of clean hosts, with or without fallbacks.
2. Keep throughput sorting and ignore only the hosts measured as bad.
3. Leave routing alone and only record the host.

A pinned order needs latency and quality data per host, which nobody has
measured yet. It also gives up throughput sorting, which ADR-0022 needed to
fit the 90-second deadline.

## Decision and consequences

**Ignore the measured bad hosts, per model.** For `deepseek/deepseek-v3.2`,
the adapter sends `provider.ignore: ["friendli", "atlas-cloud"]`. The list is
kept per model because the evidence is per model; a model with no
measurements ignores nothing. Throughput sorting, `require_parameters` and
`data_collection: "deny"` stay. No provider order is pinned. On 2026-10-16,
OpenRouter listed ten other DeepSeek V3.2 hosts, seven of which support the
structured output these calls require.

**Temperature 0.** Every structured call sends `temperature: 0`. The output
is a protocol object, not prose, so sampling adds only variance, and
temperature 0 removed the Alibaba failure. Every DeepSeek V3.2 host supports
the parameter, so `require_parameters` removes none of them. GPT-4.1 mini fell
into repetition loops at temperature 0 in the same 2026-09-30 evaluation. A
model change must therefore re-check this setting.

**Record the serving host and the generation id.** The adapter asks for the
routing metadata. It reads the host from the selected endpoint and falls back
to the top-level `provider` name. It records the host as `upstream_provider`
and the generation id as `generation_id`. Both appear beside
`provider_latency_ms` in the successful call's observation and in the
failure's `generation_observation`. The host name passes through a closed list
of the hosts OpenRouter lists, or has listed, for the routed model. Any other
name becomes `other`, so a response cannot add labels. Exporting these fields to traces is
separate work. The generation-id pattern now also accepts OpenRouter's current
`gen-<digits>-<token>` form, which the earlier pattern rejected.

**Prompt caching is not fixed here.** Caching across steps would need either
an explicit `session_id` per research run, which means passing the run's id
through the structured-generation port, or a prompt layout whose first user
message stays the same. Either is a separate change. Its effect on cache hits
should be measured with the newly recorded host.

## Migration, rollback, and evidence

Nothing is stored or migrated. A rollback is a revert of the adapter change.
The routing settings live in one constant and the request body in
`providers/openrouter/src/adapters/answer-composition/openrouter/openrouter-structured-generation-adapter.ts`.
That adapter's test pins the request body, the per-model ignore list and the
parsing of the host and generation id. The per-host replay evidence is in the
2026-09-30 garbled-dates investigation, kept outside the repository. Revisit
the ignore list when the model changes, or when recorded hosts show a newly
garbling or slow host.
