---
schema_version: 1
id: CMP-ADAPTERS
kind: component
title: Adapters
owners:
  - unassigned
component_ids:
  - CMP-ADAPTERS
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

# Adapters

## Responsibility

`src/adapters/` translates between core ports and external capabilities:

- meeting sources;
- decision processors, including LLM providers;
- approval surfaces;
- delivery surfaces; and
- shared provider clients such as Slack.

An adapter owns provider transport and canonicalization. It must not redefine
core evidence, identity, authorization, or approval semantics.

## Trust boundary

Provider acknowledgements, stored provider objects, provider identities, and
local durable state are distinct evidence. Any adapter that causes an external
effect requires explicit retry, crash, concurrency, and reconciliation
semantics.

## Current references

- [Core and adapters](../architecture/core-and-adapters.md)
- Source: [`src/adapters/`](../../src/adapters)
- Adapter tests: [`tests/adapters/`](../../tests/adapters)
- [Failure-pattern registry](../failure-patterns/README.md)
- [Qualification](../qualification/README.md)

The private founder-live adapter ledger will seed sanitized failure-pattern
records and a reusable qualification matrix in a later checkpoint. Raw
provider payloads and private receipts will not be copied here.
