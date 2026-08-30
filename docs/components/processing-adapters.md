---
schema_version: 1
id: CMP-PROCESSING-ADAPTERS
kind: component
title: Processing adapters
owners:
  - unassigned
component_ids:
  - CMP-PROCESSING-ADAPTERS
created_at: 2026-08-13
reviewed_at: 2026-08-29
reviewed_ref: b9a9891209dfa2841fb9273671fdb93c540b201f
decision_ids:
  - ADR-0003
  - ADR-0004
  - ADR-0006
  - ADR-0007
invariant_ids:
  - INV-ADAPTERS-001
  - INV-ADAPTERS-002
  - INV-ADAPTERS-003
  - INV-ADAPTERS-004
  - INV-ADAPTERS-005
  - INV-IDENTITY-001
  - INV-IDENTITY-005
  - INV-PERMISSIONS-013
  - INV-PERMISSIONS-014
failure_pattern_ids:
  - FP-ADAPTERS-001
  - FP-ADAPTERS-002
  - FP-ADAPTERS-003
  - FP-ADAPTERS-004
  - FP-ADAPTERS-005
  - FP-IDENTITY-001
  - FP-PERMISSIONS-001
qualification_ids:
  - QMAT-ADAPTERS-001
---

# Processing adapters

## Responsibility

`services/organization-authority/src/processing/adapters/` translates between
processing ports and external capabilities:

- meeting sources;
- decision processors, including LLM providers;
- approval surfaces;
- delivery surfaces; and
- shared provider clients such as Slack.

Selecting composition bundles own external capabilities; provider-neutral
runtime receives only their ports and canonical contracts. Scope and exceptions
are defined by [INV-ADAPTERS-005](../invariants/INV-ADAPTERS-005-provider-semantics-at-boundary.md).

An adapter owns provider transport and canonicalization. It must not redefine
core evidence, identity, authorization, or approval semantics.

## Trust boundary

Provider acknowledgements, stored provider objects, provider identities, and
local durable state are distinct evidence. Any adapter that causes an external
effect requires explicit retry, crash, concurrency, and reconciliation
semantics.

## Current references

- [Meeting processing core and adapters](../architecture/meeting-processing-core-and-adapters.md)
- [Active-provider boundary invariant](../invariants/INV-ADAPTERS-005-provider-semantics-at-boundary.md)
- [First-provider architecture failure pattern](../failure-patterns/FP-ADAPTERS-005-first-provider-becomes-architecture.md)
- Source: [`services/organization-authority/src/processing/adapters/`](../../services/organization-authority/src/processing/adapters)
- Adapter tests: [`services/organization-authority/test/processing/adapters/`](../../services/organization-authority/test/processing/adapters)
- [Failure-pattern registry](../failure-patterns/README.md)
- [Qualification](../qualification/README.md)

The founder-live ledger has been converted into the linked sanitized
[failure-pattern records](../failure-patterns/README.md) and the
[provider adapter matrix](../qualification/adapter-matrix-v1.md). Raw provider
payloads and private receipt locators were not copied.
