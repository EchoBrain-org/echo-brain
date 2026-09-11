---
schema_version: 1
id: INV-ADAPTERS-005
kind: invariant
title: Provider semantics terminate at the adapter boundary
component_ids:
  - CMP-PROCESSING-ADAPTERS
  - CMP-MEETING-PROCESSING-CORE
created_at: 2026-08-29
reviewed_at: 2026-09-07
reviewed_ref: 52652d26dab3d753333ce489f866e1e7d0d1f4aa
normative: MUST
enforcement_status: partial
enforcement_scope: Every source file under the Authority service and workspace package source roots is provider-neutral unless a declared provider root, selecting entrypoint, or reasoned exception owns it
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
root across workspaces, including selecting composition, ingress, identity,
approval/delivery, control-plane persistence and contracts, public API
modules, record projectors, and the active synthetic-demo source and
evaluator as well as processing adapters. One provider may own several
explicit roots. Coverage is neutral by default: every source file under
`services/organization-authority/src` and `packages/*/src` is checked for
provider identifiers and for direct or transitive reach into a declared root
unless the manifest owns it as a provider root, lists it as a thin
provider-selecting entrypoint, or records it as a provider-coupled exception
with a reason. An exception that no longer names or reaches a provider fails
the gate until it is removed, and a listed entrypoint or exception that names
no source file fails as stale. A capability-family root such as the generic
LLM decision processor may be marked `provider_identifier: false` so neutral
modules may still use that word. The gate rejects an unlisted adapter
implementation or a source file under the adapter tree. The typed
`LLM_PROVIDER_IDS` source is checked against the registered transport-provider
set; provider-client declarations not represented there fail, while the
separately registered `deepseek` model namespace remains lexical evidence for
the fixed OpenRouter answer-composition model selection. Stale evidence and
identifier leaks also fail the gate. Architecture tests include a bland
three-hop composition bridge.
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
- `services/organization-authority/test/admitted-meeting-source-baseline-v3.test.ts`;
- `services/organization-authority/test/processing/admitted-meeting-processing/meeting-processing-cycle-v1.test.ts`;
- `services/organization-authority/test/organization-authority-private-approval-runtime.test.ts`;
- `services/organization-authority/test/composition/providers/openrouter/openrouter-decision-processor-bundle-v1.test.ts`;
- `services/organization-authority/test/composition/providers/openrouter/openrouter-answer-composition-generation-bundle-v1.test.ts`;
- `packages/organization-record/test/record-log-v4-append.test.ts`;
- `services/organization-authority/test/processing/adapters/meeting-sources/synthetic-demo/synthetic-demo-meeting-source-v1.test.ts`; and
- `services/organization-authority/test/composition/providers/synthetic-demo/synthetic-demo-pre-slack-evaluator-v1.test.ts`.

The Phase-1 replay corpus, quality CLI and its adapter/evaluator tests are
retired. Their former corpus-validation behavior is no longer claimed as
enforcement. Exact source tombstones reject those removed files, and the
workspace boundary test rejects replacement files under `src/quality/`
because that directory no longer has a layer rule.

The active synthetic-demo lane remains separate. Its source adapter and
pre-Slack evaluator use canonical meeting documents and the production
processing port; their tests cover the four-meeting fixture and extraction
defect classes without live provider calls. The external `demo/` rehearsal
graders and deterministic core-runtime checkpoint remain available.

Enforcement remains partial and this record does not claim full provider
qualification. Static checks catch names and dependency edges but cannot prove
that a generically named shared abstraction does not encode one provider's
semantics. A newly added shared file no longer needs registration to be
checked; the recorded exceptions are the telemetry dimension allowlists and
the current-only V4 record envelope, each with the follow-up that retires it. Initial-owner
onboarding and the compatibility CLI intentionally select a concrete
Granola, OpenRouter, and Slack product profile; source admission is supplied by
that profile rather than one universal onboarding command. Any change that
moves a provider fact into a neutral layer requires an explicit invariant
review and, when it changes a canonical contract, a versioned design decision.
