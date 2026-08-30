---
schema_version: 1
id: INV-ADAPTERS-005
kind: invariant
title: Provider semantics terminate at the adapter boundary
component_ids:
  - CMP-ADAPTERS
  - CMP-CORE-PIPELINE
created_at: 2026-08-29
reviewed_at: 2026-08-29
reviewed_ref: b9a9891209dfa2841fb9273671fdb93c540b201f
normative: MUST
enforcement_status: partial
enforcement_scope: Active provider boundaries: processing core, neutral orchestration, and canonical durable contracts
failure_pattern_ids:
  - FP-ADAPTERS-005
---

# INV-ADAPTERS-005: Provider semantics terminate at the adapter boundary

## Rule, scope, and rationale

Provider-specific payloads, cursor grammar, credential and custody checks,
owner discovery, lifecycle rules, interaction signatures, transport metadata,
and presentation identifiers MUST terminate inside the provider adapter or its
selecting composition bundle. Provider-neutral processing, orchestration,
canonical durable contracts, approval policy, retrieval, answer composition,
and approved-record policy projection consume only canonical contracts,
immutable adapter commitments, and opaque provider references.

The allowed selecting composition bundles are explicit: meeting source,
decision processor, Layer 4 generation, approval/interaction surface, and
Person external identity. Those bundles may select Granola, OpenRouter, Slack,
or a future external-capability provider. The shared runtime must receive only
their ports, identity/configuration commitments, generic presentation
references, and approved-record policy projectors.

This invariant is about external-capability providers. The current local
platform still deliberately selects SQLite, file-backed keys, Node crypto and
clock implementations, and the OIDC protocol in Authority composition. An
OIDC issuer is configuration-swappable; a persistence engine, key-custody
scheme, runtime primitive, or non-OIDC authentication protocol is not claimed
to be bundle-swappable by this revision.

Adding or replacing any active provider must not require a provider branch in
the shared processing path, live worker, canonical state, approval policy,
retrieval, answer composition, or record-policy projector. A provider may add
its own adapter, provider-owned persistence, onboarding configuration,
composition bundle, and capability-level tests.

This rule does not prohibit a deliberate revision to a canonical contract when
a new source exposes a genuine domain capability. Such a revision must be
designed and tested as a provider-independent contract change rather than
introduced as a conditional for one vendor.

## Enforcement and failure behavior

The source-boundary manifest names every active provider-owned implementation
root, including selecting composition, ingress, identity, approval/delivery,
and synthetic-evaluation code as well as processing adapters. One provider may
own several explicit roots. The gate rejects an unlisted adapter implementation
or a source file under the adapter tree, and rejects a provider-neutral module
that directly or transitively reaches any declared root. The typed
`LLM_PROVIDER_IDS` source is checked against the registered transport-provider
set; provider-client declarations not represented there fail, while the
separately registered `deepseek` model namespace remains lexical evidence for
the fixed OpenRouter model selection. Stale evidence and identifier leaks also
fail the gate. Architecture tests include a bland three-hop composition bridge.
The source path stores generic source identity and opaque cursors,
and the shared runtime receives explicit source, processor, Layer 4, approval,
and external-identity bundles instead of selecting a provider.

A provider identity, runtime commitment, interaction, cursor, or presentation
reference that does not match its admitted boundary fails closed before it can
change canonical state. Shared state must not parse provider cursors, message
timestamps, signed interaction payloads, or provider-specific identity facts.

Changing an approval presentation surface is a controlled restart boundary.
Before work resumes, the selected surface MUST prove ownership of every
outstanding external presentation. It may adopt pristine queued work only.
The approved-record policy-projector registry is additive across such a
change: it MUST retain projectors for historical record protocols as well as
the selected surface's new protocol.

Provider bundles are trusted, reviewed composition code rather than an
independently installable plugin surface. The runtime enforces that the
ownership preflight runs before the bundle opens; review and qualification
must establish that a new bundle's proof is complete.

## Verification and change procedure

The reviewed source is covered by:

- `services/organization-authority/source-boundary.v1.json`;
- `product/source-boundary.v1.json`;
- `tests/architecture/workspace-boundaries.test.ts`;
- `services/organization-authority/test/authority-live-source-baseline-v3.test.ts`;
- `services/organization-authority/test/processing/clean-v1/live-only-source-cycle.test.ts`;
- `services/organization-authority/test/open-clean-live-runtime.test.ts`;
- `services/organization-authority/test/composition/openrouter-clean-live-processor-runtime.test.ts`;
- `services/organization-authority/test/composition/openrouter-clean-answer-composition-runtime.test.ts`;
- `services/organization-record/test/record-log-v4-append.test.ts`; and
- the synthetic meeting-source adapter and evaluator tests.

Before evaluation, the synthetic corpus validator rejects a non-exact top-level
shape, duplicate or empty fixture/atom/case IDs, unresolved required citations,
invalid status or answer expectations, and citation expectations for withheld
atoms. The evaluator no longer silently drops an unknown required atom ID.

Enforcement remains partial and this record does not claim full provider
qualification. Static checks catch names and dependency edges but cannot prove
that a generically named shared abstraction does not encode one provider's
semantics or that a newly added neutral file was registered. Initial-owner
onboarding and the compatibility CLI intentionally select a concrete
Granola, OpenRouter, and Slack product profile; source admission is supplied by
that profile rather than one universal onboarding command. Any change that
moves a provider fact into a neutral layer requires an explicit invariant
review and, when it changes a canonical contract, a versioned design decision.
