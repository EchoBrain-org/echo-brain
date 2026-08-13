---
schema_version: 1
id: CMP-LOCAL-RUNTIME
kind: component
title: Local runtime
owners:
  - unassigned
component_ids:
  - CMP-LOCAL-RUNTIME
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

# Local runtime

## Responsibility

`src/product/` composes the Mac product around the core. It owns CLI and
service lifecycle, local configuration, frozen approval state, local product
state, organization-client coordination, and the internal update runner.
`src/infrastructure/` supplies concrete filesystem, SQLite, migration, and
locking primitives.

## Data authority

The Mac owns local source custody, product state, frozen pending work,
installation private material, verified Authority pins, and accepted access
state. It does not own central organization membership, integration policy, or
the organization record.

## Current references

- [Product runtime](../architecture/product-runtime.md)
- [Identity and onboarding](../architecture/identity-and-onboarding.md)
- Source: [`src/product/`](../../src/product)
- Infrastructure: [`src/infrastructure/`](../../src/infrastructure)
- Product and machine tests: [`tests/product/`](../../tests/product) and
  [`tests/machine/`](../../tests/machine)

Diagnostics must distinguish provider reachability from complete runtime
readiness and must not mutate production state merely to inspect it. This rule
will receive a stable invariant and failure-pattern link when the registry is
seeded.
