# ECHO documentation

Code and schemas define exact behavior. This index records the contracts that
must survive code changes: system boundaries, invariants, decisions, reusable
failures, operations, and proof for exact runs.

## Start here

- New to ECHO: read the [workspace boundaries](architecture/organization-workspace-boundaries.md),
  [component catalog](components/README.md), and
  [component naming taxonomy](architecture/component-naming-taxonomy.md).
- Working on the installed product: start with the
  [Person client architecture](architecture/person-client-architecture.md).
- Working on meeting intake or extraction: start with the
  [meeting processing core and adapters](architecture/meeting-processing-core-and-adapters.md).
- Working on identity or access: start with
  [identity and onboarding](architecture/identity-and-onboarding.md) and the
  [organization control plane](architecture/organization-control-plane.md).
- Operating or recovering the service: use the
  [operations index](operations/README.md).
- Investigating a known class of defect: use the
  [failure-pattern index](failure-patterns/README.md).
- Making a durable choice: use an [ADR](decisions/README.md); use an
  [RFC](rfcs/README.md) for a proposed coordinated change.
- Claiming readiness: use [qualification](qualification/README.md). Source,
  deployment, and qualification are separate claims.

Dated sprint, migration, and rollout documents under `docs/product/` are
historical context. They do not define the current navigation or component
names.

Components are the navigation layer. Cross-cutting records are written once,
linked by stable ID, and not copied between component pages.

## System maps

- [Workspace boundaries](architecture/organization-workspace-boundaries.md)
- [Meeting processing core and adapters](architecture/meeting-processing-core-and-adapters.md)
- [Person client architecture](architecture/person-client-architecture.md)
- [Identity and onboarding](architecture/identity-and-onboarding.md)
- [Organization control plane](architecture/organization-control-plane.md)
- [Component naming taxonomy](architecture/component-naming-taxonomy.md)
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
