# ECHO documentation

Code and schemas define exact behavior. This index records the contracts that
must survive code changes: system boundaries, invariants, decisions, reusable
failures, operations, and proof for exact runs.

## Start here

- New to ECHO: start with the [system overview](architecture/overview.md). It
  goes from the whole system down to components and links the maps below. Then
  read the [workspace boundaries](architecture/organization-workspace-boundaries.md),
  [component catalog](components/README.md), and
  [component naming taxonomy](architecture/component-naming-taxonomy.md).
- Working on the desktop app: start with the
  [desktop app architecture](architecture/desktop-app.md) and the
  [desktop README](../product/echo-desktop/README.md).
- Working on the Person client or CLI: start with the
  [Person client architecture](architecture/person-client-architecture.md).
- Working on Ask, research or impact checks: start with
  [Ask and research](architecture/ask-and-research.md) and
  [impact checks and open items](architecture/impact-checks-and-open-items.md).
- Working on releases: the [client update feed](features/client-updates-v1.md)
  and the [operations index](operations/README.md).
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
historical context. Start from the system maps and operation index above;
follow a dated document only when a current record links to it for rationale or
exact evidence.

Components are the navigation layer. Cross-cutting records are written once,
linked by stable ID, and not copied between component pages.

## System maps

- [System overview](architecture/overview.md)
- [Desktop app](architecture/desktop-app.md)
- [Ask and research](architecture/ask-and-research.md)
- [Impact checks and open items](architecture/impact-checks-and-open-items.md)
- [Workspace boundaries](architecture/organization-workspace-boundaries.md)
- [Meeting processing core and adapters](architecture/meeting-processing-core-and-adapters.md)
- [Person client architecture](architecture/person-client-architecture.md)
- [Identity and onboarding](architecture/identity-and-onboarding.md)
- [Organization control plane](architecture/organization-control-plane.md)
- [Shared connector contracts](architecture/connector-contracts.md)
- [Scaling decision guide](architecture/scaling-decision-guide.md)
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

## Evidence boundaries

Use code and schemas for implementation, invariants for required safety, ADRs
for rationale, tests for repeatable behavior, qualification reports for one
exact artifact and configuration, private receipts for raw bounded evidence,
and issues for unresolved work. Keep useful history; do not make it the default
operator route.
