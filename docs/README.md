# ECHO documentation

Code and schemas define exact behavior. This index records the contracts that
must survive code changes: system boundaries, invariants, decisions, reusable
failures, operations, and proof for exact runs.

## Start here

- New to ECHO: [system map](architecture/organization-workspace-boundaries.md), then the [component catalog](components/README.md).
- Changing behavior: start at the affected component, then follow its linked invariants, failure patterns, and qualification.
- Investigating: start with [failure patterns](failure-patterns/README.md), then its playbook or runbook.
- Making a durable choice: use an [ADR](decisions/README.md); use an [RFC](rfcs/README.md) for a proposed coordinated change.
- Claiming readiness: use [qualification](qualification/README.md). Source, deployment, and qualification are separate claims.

Components are the navigation layer. Cross-cutting records are written once,
linked by stable ID, and not copied between component pages.

## System maps

- [Workspace boundaries](architecture/organization-workspace-boundaries.md)
- [Core and adapters](architecture/core-and-adapters.md)
- [Product runtime](architecture/product-runtime.md)
- [Identity and onboarding](architecture/identity-and-onboarding.md)
- [Organization control plane](architecture/organization-control-plane.md)
- [Component catalog](components/README.md)

## Durable records

- [Invariants](invariants/README.md): rules that must hold.
- [Decisions](decisions/README.md): rationale and supersession history.
- [Failure patterns](failure-patterns/README.md): reusable boundary failures and controls.
- [Operations](operations/README.md): investigative playbooks and outcome runbooks.
- [Qualification](qualification/README.md): matrices, exact-run reports, and evidence indexes.
- [RFCs](rfcs/README.md): proposed cross-component changes.

Read [contributing](contributing.md) before changing a durable record.

## Product contracts and truth

`docs/product/` keeps direction and implementation contracts while their
durable decisions, invariants, failures, and proof are extracted. Do not
delete useful history merely to shorten the active tree.

Use each artifact for its own claim: code and schemas for implementation;
invariants for required safety; ADRs for why; tests for repeatable behavior;
qualification reports for one exact artifact and configuration; private
receipts for raw bounded evidence; and issues for unresolved work.
