---
schema_version: 1
id: CMP-CORE-PIPELINE
kind: component
title: Core pipeline
owners:
  - unassigned
component_ids:
  - CMP-CORE-PIPELINE
created_at: 2026-08-13
reviewed_at: 2026-08-29
reviewed_ref: b9a9891209dfa2841fb9273671fdb93c540b201f
decision_ids:
  - ADR-0001
  - ADR-0003
  - ADR-0004
  - ADR-0006
invariant_ids:
  - INV-ADAPTERS-003
  - INV-ADAPTERS-004
  - INV-ADAPTERS-005
  - INV-IDENTITY-005
failure_pattern_ids:
  - FP-ADAPTERS-003
  - FP-ADAPTERS-004
  - FP-ADAPTERS-005
qualification_ids:
  - QMAT-ADAPTERS-001
---

# Core pipeline

## Responsibility

`services/organization-authority/src/processing/core/` owns the
provider-neutral decision pipeline, domain contracts, ports, processing rules,
approval state, delivery contracts, and storage interfaces.

It does not own provider HTTP behavior, operating-system lifecycle,
organization deployment, or concrete persistence.

## Data and dependency boundary

The core operates on bounded domain values. It reaches sources, processors,
approval surfaces, delivery surfaces, and storage only through ports. Concrete
provider and infrastructure code depends inward on the core; the core must not
depend outward on them. Provider selection belongs in explicit composition
bundles for source, processor, Layer 4 generation, approval/interaction, and
Person external identity. Shared flow retains only opaque presentation
references and approved-record policy projectors.

## Current references

- [Core and adapters](../architecture/core-and-adapters.md)
- Source: [`services/organization-authority/src/processing/core/`](../../services/organization-authority/src/processing/core)
- Core tests: [`services/organization-authority/test/processing/core/`](../../services/organization-authority/test/processing/core)

## Durable records

- [Invariants](../invariants/README.md)
- [Architecture decisions](../decisions/README.md)
- [Failure patterns](../failure-patterns/README.md)

Current links cover the LLM execution and source-grounding boundaries. Other
core invariants remain indexed in the existing permission registry until
incrementally migrated.
