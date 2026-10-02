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
reviewed_at: 2026-09-27
reviewed_ref: 83c8eb63aed78ba760678294ecf7fef863743e06
decision_ids:
  - ADR-0003
  - ADR-0004
  - ADR-0006
  - ADR-0007
  - ADR-0022
  - ADR-0025
  - ADR-0027
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

Selecting composition bundles own external capabilities; provider-neutral
runtime receives only their ports and canonical contracts. Scope and ownership
are defined by [INV-ADAPTERS-005](../invariants/INV-ADAPTERS-005-provider-semantics-at-boundary.md).

An adapter owns provider transport and canonicalization. It must not redefine
core evidence, identity, authorization, or approval semantics.

The current meeting composition has one organization-owned Granola
export/admission bridge. Its credential and owner binding are selected by the
Authority and stay out of Person clients; admitted revisions then use the
provider-neutral meeting-source and approval contracts.

The Granola HTTP client bounds each streamed JSON body before parsing and the
total assembled transcript across pages. Oversized inline transcripts use the
paged fallback; bounds reject excess without truncation. These transport bounds
are separate from representation-specific capture limits. Jira's server-only
capture handoff derives its transport and current-grant fences from an
authenticated Person connection. Both changes have synthetic-provider source
proof; see the [capture integration scope](../product/2026-10-01-connector-context-integration-v1.md)
for the remaining live profile and qualification work.

Jira discovers a server-tagged Nango connection on zero-based page 0 with a
two-item limit. `providers/jira/test/jira-nango-v1.test.ts` source-tests that
one matching connection is found and multiple matches are refused; live
qualification remains pending.

## Trust boundary

Provider acknowledgements, stored provider objects, provider identities, and
local durable state are distinct evidence. Any adapter that causes an external
effect requires explicit retry, crash, concurrency, and reconciliation
semantics.

For the private Slack approval surface, Authority completes terminal and V4
materialization before startup readiness. Terminal-card redraw is a separate,
bounded presentation reconciliation, requested immediately after approval
publication and by periodic recovery. Each writer turn attempts one pending
card; confirmed progress requests another turn, while uncertain outcomes and
failures wait for a new wake. Cards rotate fairly, and the worker cancellation
signal is passed to Slack. A card becomes rendered only after the provider
confirms its replacement update.

Slack reconnect completion requires the existing Nango connection to report the
current attempt, organization and owner membership tags, followed by fresh Slack
identity and permission checks. A connection's `updated_at` is not authorization
completion evidence: it can stay unchanged after a successful reconnect. Focused
source tests cover this case, stale or foreign tags, and preservation of existing
approval cards and person links. The repaired completion path still requires a
live rehearsal after deployment.

## Current references

- [Meeting processing core and adapters](../architecture/meeting-processing-core-and-adapters.md)
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
