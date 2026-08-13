# ECHO documentation

This is the entry point for understanding and safely changing ECHO.

Code and schemas are authoritative for exact behavior and wire shapes. These
documents explain the current system, the rules that must remain true, why
important decisions were made, known ways the system can fail, and the proof
required before a change is qualified.

## Choose a path

- **New to ECHO:** read the
  [one-organization system map](architecture/organization-workspace-boundaries.md),
  then the [component catalog](components/README.md).
- **Changing a component:** open its page in the
  [component catalog](components/README.md), then read the linked invariants,
  decisions, active failure patterns, and qualification tests.
- **Investigating a problem:** start with
  [failure patterns](failure-patterns/README.md), then use the linked playbook
  or runbook.
- **Making a durable design choice:** follow the
  [decision record process](decisions/README.md). Use an RFC first when the
  choice is still proposed or requires coordinated protocol migration.
- **Claiming a capability is ready:** follow
  [qualification and evidence](qualification/README.md). A source commit,
  deployment, and qualification are separate claims.

## How the documentation is organized

ECHO uses two complementary axes:

1. **Components are the navigation layer.** They answer where a behavior is
   implemented, who owns its data, and what it depends on.
2. **Cross-cutting records are the durable knowledge layer.** Invariants,
   decisions, failure patterns, operations, and qualification evidence are
   recorded once and linked from every affected component.

Do not copy an invariant or failure pattern into several component pages.
Link to its stable ID instead.

## Architecture and components

- [One-organization workspace boundaries](architecture/organization-workspace-boundaries.md)
- [Core and adapters](architecture/core-and-adapters.md)
- [Product runtime](architecture/product-runtime.md)
- [Identity and onboarding](architecture/identity-and-onboarding.md)
- [Organization control plane](architecture/organization-control-plane.md)
- [Component catalog](components/README.md)

The architecture pages describe the current system. Component pages are the
short landing pages that connect architecture to source, contracts,
invariants, decisions, failure patterns, operations, and proof.

## Durable knowledge records

**Foundation status:** this branch establishes the structure and templates and
seeds the founder-live adapter invariants, 12 failure patterns, one expected
fail-closed control, the adversarial matrix, and one bounded stopped-state
qualification report. Standalone ADR
migration remains incremental; existing architecture and product contracts
remain linked as the source for decisions not yet extracted.

- [Invariants](invariants/README.md): rules that must or must not hold.
- [Architecture decisions](decisions/README.md): accepted choices, rationale,
  alternatives, consequences, and supersession history.
- [Failure patterns](failure-patterns/README.md): reusable ways a boundary can
  fail and the controls that prevent recurrence.
- [Operations](operations/README.md): investigative playbooks and
  outcome-oriented runbooks.
- [Qualification](qualification/README.md): reusable test matrices and
  immutable evidence indexes for exact runs.
- [RFCs](rfcs/README.md): proposed cross-component or protocol changes.

Read [contributing to documentation](contributing.md) before adding or
changing a durable record.

## Product direction and implementation contracts

Files in `docs/product/` contain direction, approved designs, and bounded
implementation contracts. Their status statements must distinguish design,
implementation, merge, deployment, founder-live qualification, client-live
qualification, and release.

Current indexes and contracts include:

- [Organization brain direction](product/org-brain-direction.md)
- [Organization permission architecture](product/2026-08-09-organization-permission-architecture.md)
- [Permission pilot V1 contract](product/2026-08-10-permission-pilot-v1-contract.md)
- [Architecture invariant registry](product/2026-08-11-architecture-invariant-registry.md)
- [Reviewer permission V1](product/2026-08-11-reviewer-permission-v1-log-facts-design.md)
- [Permission-aware searchable Layer 2](product/2026-08-11-trusted-permission-aware-searchable-layer-2-design.md)

These long-form documents remain available while their durable decisions,
invariants, failure patterns, and qualification rules are progressively
extracted into the indexed records above. Do not delete history merely to
shorten the active tree.

## Truth and evidence hierarchy

Use each artifact for its intended claim:

1. Code and schemas define exact implemented behavior.
2. Invariants define the required safety properties.
3. Accepted decision records preserve why a design was chosen.
4. Tests prove repeatable behavior in their declared environment.
5. Qualification reports prove an exact artifact and configuration passed an
   exact matrix.
6. Private receipts preserve raw bounded evidence; they are not the only
   explanation of a reusable lesson.
7. GitHub issues track unresolved work and may close. They are not the
   permanent architecture or failure record.

Historical material can remain in Git when it has no continuing operational
or architectural value. Any decision, invariant, known failure mode, or
recovery knowledge that still governs current development must remain
discoverable from this index.
