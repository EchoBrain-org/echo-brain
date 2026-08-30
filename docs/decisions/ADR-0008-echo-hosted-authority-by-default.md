---
schema_version: 1
id: ADR-0008
kind: decision
title: ECHO-hosted Authority by default
component_ids:
  - CMP-ORGANIZATION-AUTHORITY
  - CMP-OPERATIONS-RELEASE
created_at: 2026-08-25
reviewed_at: 2026-08-26
reviewed_ref: d5b3b13c29e161c5d93f14ce3efdc9b0b818e5dc
status: accepted
supersedes: []
superseded_by: []
updates:
  - ADR-0001
---

# ADR-0008: ECHO-hosted Authority by default

## Context and options

[ADR-0001](ADR-0001-organization-operated-server-core.md) established one
organization-scoped Authority as the processing and state boundary. It also
assumed that the organization would operate the server and that ECHO would
have no operational credentials or visibility. The first near-term customer
Authorities need a concrete account and operator default before reusable
infrastructure is built.

Three operating policies were considered:

| Option | Default operator | Customer-account consequence |
| --- | --- | --- |
| A. Organization-owned only | Every organization operates the Authority in its own cloud account. | Preserves ADR-0001's original custody boundary, but makes cloud operation a prerequisite for every customer. |
| B. ECHO-owned only | ECHO operates every Authority in ECHO's cloud account. | Simplifies initial operation, but provides no customer-controlled hosting path. |
| C. ECHO-hosted by default, organization-hosted on request | ECHO operates the default deployment; an organization may select its own account before provisioning. | Gives the near-term default one accountable operator while preserving an explicit customer-account option. |

## Decision and consequences

**The founder accepted option C on 2026-08-26.** By default, ECHO provisions
and operates one isolated, single-organization Authority in an AWS account
controlled by ECHO. ECHO holds the operational access needed to administer the
host, network and tunnel, data volume, backups, logs, encryption boundary,
secret storage, deployment, and incident recovery.

That access gives ECHO technical custody of Authority state, including the
private credential files stored on the host. The repository must not describe
the default deployment as customer-operated or claim that ECHO has no shell,
backup, log, key, or audit visibility. This is an explicit change to
ADR-0001's custody premise, not deployment-only housekeeping.

Before an Authority is provisioned, an organization may request deployment in
an organization-controlled AWS account. For that Authority, the organization
controls the account and routine operational credentials. ECHO ships reviewed
infrastructure, host configuration, application artifacts, and runbooks, and
has no standing operational access unless the organization separately grants
explicit, time-bounded support access.

The selected operating-account model must be recorded explicitly for each
organization before provisioning. It is never inferred from available
credentials, mixed across two accounts, or changed in place after onboarding.
A request to move an existing Authority to a different account is a separate
data, key, backup, secret, ingress, and recovery migration that requires its
own reviewed procedure and qualification.

Both models preserve one organization per Authority. ECHO-hosted does not mean
one shared application instance, a tenant registry, cross-organization state,
or multi-tenant queries. Application authorization, provider-account scope,
record semantics, and the one-organization workspace boundary do not change.

This decision updates only ADR-0001's operator and infrastructure-custody
claims and resolves its deferred ECHO-hosted option. ADR-0001 remains the
decision for server-core processing, organization scope, provider-source
rules, pre-record governance, and the Person-to-Authority product boundary.

The default has real costs. ECHO becomes responsible for operational security,
backup and restore, incident response, access governance, and the consequences
of host-level access to customer state. Future infrastructure must preserve
per-organization host, role, secret, log, backup, and state boundaries even
when several Authorities live in ECHO's account. The customer-account path may
delay onboarding until its portable infrastructure and support boundary have
been implemented and qualified; this decision does not claim that path is
already automated.

## Migration, rollback, and evidence

This decision establishes the operating default. It does not create an AWS
account, infrastructure module, customer Authority, credential, data transfer,
or production deployment.

Later provisioning work must:

1. take an explicit `echo-hosted` or `organization-hosted` choice for each
   organization, defaulting to `echo-hosted`;
2. keep one isolated Authority and organization-state boundary per
   organization under either model;
3. scope operational roles, secrets, logs, backups, encryption, tunnel, and
   recovery authority to the selected operating account and organization; and
4. stop before provisioning when an organization requests its own account but
   the customer-account deployment and support path are not yet qualified.

The existing founder Authority is an ECHO-hosted deployment and requires no
account migration merely to conform to this decision. A future change to the
default or to an already provisioned organization's operating account requires
a new dated decision or migration record; it must not be introduced as an
implementation detail.
