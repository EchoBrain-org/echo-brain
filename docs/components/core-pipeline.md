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
reviewed_at: 2026-08-13
reviewed_ref: 808ac89eaf3e8eba529b356bd80d4509b9a2a293
invariant_ids: []
decision_ids: []
failure_pattern_ids: []
runbook_ids: []
qualification_ids: []
issue_urls: []
---

# Core pipeline

## Responsibility

`src/core/` owns the provider-neutral decision pipeline, domain contracts,
ports, processing rules, approval state, delivery contracts, and storage
interfaces.

It does not own provider HTTP behavior, operating-system lifecycle,
organization deployment, or concrete persistence.

## Data and dependency boundary

The core operates on bounded domain values. It reaches sources, processors,
approval surfaces, delivery surfaces, and storage only through ports. Concrete
provider and infrastructure code depends inward on the core; the core must not
depend outward on them.

## Current references

- [Core and adapters](../architecture/core-and-adapters.md)
- Source: [`src/core/`](../../src/core)
- Core tests: [`tests/core/`](../../tests/core)

## Durable records

- [Invariants](../invariants/README.md)
- [Architecture decisions](../decisions/README.md)
- [Failure patterns](../failure-patterns/README.md)

The component-specific record index has not yet been seeded.
