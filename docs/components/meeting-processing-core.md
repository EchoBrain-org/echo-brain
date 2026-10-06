---
schema_version: 1
id: CMP-MEETING-PROCESSING-CORE
kind: component
title: Meeting processing core
owners:
  - unassigned
component_ids:
  - CMP-MEETING-PROCESSING-CORE
created_at: 2026-08-13
reviewed_at: 2026-09-27
reviewed_ref: 83c8eb63aed78ba760678294ecf7fef863743e06
decision_ids:
  - ADR-0030
  - ADR-0001
  - ADR-0003
  - ADR-0004
  - ADR-0006
  - ADR-0014
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

# Meeting processing core

## Responsibility

`packages/organization-processing/src/core/` owns the
provider-neutral source admission, meeting-source bridge, and decision-brief
compilation, plus their canonical contracts, validators, and ports.

It does not own the processing cycle or approval workflow state (in
`packages/organization-processing/src/admitted-meeting-processing/`), provider
HTTP behavior, operating-system lifecycle, organization deployment, or concrete
persistence.

## Data and dependency boundary

The core operates on bounded domain values. It reaches sources, decision
processors, and source-admission storage only through ports. It owns the
context-capture contract; the Authority owns the intake that admits captures.
Concrete
provider and infrastructure code depends inward on the core; the core must not
depend outward on them. Provider selection belongs only in the selecting
modules that
[INV-ADAPTERS-005](../invariants/INV-ADAPTERS-005-provider-semantics-at-boundary.md)
allows. Shared flow retains only opaque presentation references and
approved-record policy projectors.

## Current references

- [Meeting processing core and adapters](../architecture/meeting-processing-core-and-adapters.md)
- Source: [`packages/organization-processing/src/core/`](../../packages/organization-processing/src/core)
- Core tests: [`packages/organization-processing/test/core/`](../../packages/organization-processing/test/core)

## Durable records

- [Invariants](../invariants/README.md)
- [Architecture decisions](../decisions/README.md)
- [Failure patterns](../failure-patterns/README.md)

Current links cover the LLM execution and source-grounding boundaries. Other
core invariants remain indexed in the existing permission registry until
incrementally migrated.
