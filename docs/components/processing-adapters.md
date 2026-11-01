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
reviewed_at: 2026-10-30
reviewed_ref: aa92138e4a7d8386b2ff51a95c7d2f82e86236be
decision_ids:
  - ADR-0003
  - ADR-0004
  - ADR-0006
  - ADR-0007
  - ADR-0022
  - ADR-0025
  - ADR-0027
  - ADR-0037
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

`providers/` translates between
processing ports and external capabilities:

- meeting sources;
- decision processors, including LLM providers;
- approval surfaces; and
- shared provider clients such as Slack.

Personal live-context adapters are a separate read capability. Confluence
discovers and opens pages as the authenticated person, while Jira reads tickets;
each also lists the person's Confluence spaces or Jira projects as tool
containers for Ask
([ADR-0042](../decisions/ADR-0042-research-tool-contract.md)). They share
bounded request-local evidence and audit contracts, but each provider owns its
OAuth verification, query syntax, permission checks, pagination, and body
parsing. Project mappings narrow discovery; global reads add no ECHO
container allowlist. Neither capability grants custody of provider content.

Selecting composition bundles own external capabilities; provider-neutral
runtime receives only their ports and canonical contracts. Scope and ownership
are defined by [INV-ADAPTERS-005](../invariants/INV-ADAPTERS-005-provider-semantics-at-boundary.md).

An adapter owns provider transport and canonicalization. It must not redefine
core evidence, identity, authorization, or approval semantics.

The organization Granola credential, owner admission, and REST polling path
have been removed. `providers/granola` now implements the personal Granola MCP
connection through the shared Nango lifecycle, folder enumeration, meeting
acquisition and normalization
([ADR-0030](../decisions/ADR-0030-personal-meeting-custody-and-review.md)). It owns transport and
canonicalization: a meeting's revision is a digest of its mapped content (a
folder move is no edit), and transcript audio labels stay verbatim text that
attributes no speaker. Custody, extraction and review stay in the Authority. The
[Personal Granola sprint](../product/2026-10-05-personal-granola-sprint-v1.md)
records its limits and live qualification.

Jira's server-only bulk ticket reads (the impact check's assignee lookup and
the Ask source check's ticket markers; Jira context capture is disabled) derive
their transport and current-grant fences from an authenticated Person
connection. Meeting processing, approval, revision custody and shared
connectors remain provider-neutral.

`providers/openrouter` also carries Ask's answer model and, for the staging
Authority only, the Claude Agent SDK research engine and the transport for one
member's own Claude account
([current composition](../architecture/meeting-processing-core-and-adapters.md#current-composition)).

## Trust boundary

Provider acknowledgements, stored provider objects, provider identities, and
local durable state are distinct evidence. Any adapter that causes an external
effect requires explicit retry, crash, concurrency, and reconciliation
semantics.

The Slack approval surface's publication and card-redraw ordering is
defined in [adapter responsibilities](../architecture/meeting-processing-core-and-adapters.md#adapter-responsibilities).

## Current references

- [Meeting processing core and adapters](../architecture/meeting-processing-core-and-adapters.md)
- [Shared connector contracts](../architecture/connector-contracts.md)
- [Active-provider boundary invariant](../invariants/INV-ADAPTERS-005-provider-semantics-at-boundary.md)
- [First-provider architecture failure pattern](../failure-patterns/FP-ADAPTERS-005-first-provider-becomes-architecture.md)
- Source: [`providers/`](../../providers)
- Provider tests: `providers/<provider>/test/` (Slack server/client tests use their respective workspace roots).
- [Failure-pattern registry](../failure-patterns/README.md)
- [Qualification](../qualification/README.md)

The prior live-evaluation ledger has been converted into the linked sanitized
[failure-pattern records](../failure-patterns/README.md) and the
[provider adapter matrix](../qualification/adapter-matrix-v1.md). Raw provider
payloads and private receipt locators were not copied.
