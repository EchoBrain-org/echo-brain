---
schema_version: 1
id: FP-ADAPTERS-005
kind: failure-pattern
title: The first provider becomes the architecture
component_ids:
  - CMP-PROCESSING-ADAPTERS
  - CMP-MEETING-PROCESSING-CORE
created_at: 2026-08-29
reviewed_at: 2026-08-29
reviewed_ref: b9a9891209dfa2841fb9273671fdb93c540b201f
origin: review
evidence_status: scenario-defined
status: mitigating
severity: high
first_observed: 2026-08-29
invariant_ids:
  - INV-ADAPTERS-005
evidence_ids:
  - EVID-JOB-AB-LEDGER-001
implementation_refs:
  - commit:b9a9891209dfa2841fb9273671fdb93c540b201f
regression_test_refs:
  - tests/architecture/workspace-boundaries.test.ts@b9a9891209dfa2841fb9273671fdb93c540b201f
  - services/organization-authority/test/authority-live-source-baseline-v3.test.ts@b9a9891209dfa2841fb9273671fdb93c540b201f
  - services/organization-authority/test/processing/clean-v1/live-only-source-cycle.test.ts@b9a9891209dfa2841fb9273671fdb93c540b201f
  - services/organization-authority/test/open-clean-live-runtime.test.ts@b9a9891209dfa2841fb9273671fdb93c540b201f
  - services/organization-authority/test/composition/openrouter-clean-live-processor-runtime.test.ts@b9a9891209dfa2841fb9273671fdb93c540b201f
  - services/organization-authority/test/composition/openrouter-clean-layer4-runtime.test.ts@b9a9891209dfa2841fb9273671fdb93c540b201f
  - services/organization-authority/test/quality/synthetic-meeting-evaluator.test.ts@b9a9891209dfa2841fb9273671fdb93c540b201f
  - services/organization-record/test/record-log-v4-append.test.ts@b9a9891209dfa2841fb9273671fdb93c540b201f
---

# FP-ADAPTERS-005: The first provider becomes the architecture

## Plain-English summary

The first active provider supplied more than its edge capability. Its cursor
format, model profile, interaction signature, ownership discovery, completion
rules, presentation identifier, or persistence names spread through shared
runtime and state. The next provider would therefore need core conditionals or
a parallel pipeline instead of one new adapter and selecting bundle.

## Boundary, trigger, and symptom

This pattern begins when provider facts cross the adapter or composition edge.
Common symptoms are provider names in neutral modules, vendor-named shared
tables, shared code parsing a provider cursor, message identifier, interaction
payload, or identity claim, `if provider` branches in the core, and a provider
swap that requires edits to approval policy, records, retrieval, answer
composition, or approved-record policy projection.

It can recur without a provider name. A generically named field such as
`completed_at`, `owner`, or `page_token` may still encode one provider's exact
meaning and quietly make that behavior universal.

## Risk and root cause

The first working integration is mistaken for the domain model. Subsequent
providers compound special cases across source intake, model generation,
approval interaction, identity, presentation, storage, and record projection.
Tests then validate the incumbent product profile rather than the portability
of the system, making later extraction expensive and risky.

## Tempting but unsafe response

Do not add a provider switch to the shared cycle, rename vendor fields to
generic words while preserving their semantics, or copy the existing provider
pipeline for the next integration. Do not weaken canonical validation merely
to accept a second provider payload.

## Required behavior, detection, and regression

Normalize provider data at the edge into canonical contracts. Keep provider
cursors, interaction payloads, identity claims, and presentation references
opaque to shared state. Construct meeting source, decision processor, Layer 4
generation, approval/interaction, and Person external identity through
explicit provider bundles. The shared path receives generic presentation
references and approved-record policy projectors, not a Slack card, an
OpenRouter response, or a provider identity object.

The reviewed repair introduces provider-neutral source state, processor and
Layer 4 bundles, generic approval and external-identity ingress, approved-record
policy projection, boundary-manifest rules, negative architecture probes, and
a synthetic source using the same core port. The pattern remains `mitigating`;
full provider qualification is still pending, static checks cannot detect every
semantic leak, and initial-owner onboarding plus the compatibility CLI still
intentionally select the concrete Granola, OpenRouter, and Slack product
profile.
