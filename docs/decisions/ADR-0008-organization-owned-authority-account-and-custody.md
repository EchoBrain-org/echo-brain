---
schema_version: 1
id: ADR-0008
kind: decision
title: Organization-owned Authority account and custody
component_ids:
  - CMP-CENTRAL-ORGANIZATION
  - CMP-OPERATIONS-RELEASE
created_at: 2026-08-25
reviewed_at: 2026-08-25
reviewed_ref: 35875e49817c841ac1f8aa3abf669d6e9a636a83
status: proposed
supersedes: []
superseded_by: []
updates: []
---

# ADR-0008: Organization-owned Authority account and custody

## Context and options

[ADR-0001](ADR-0001-organization-operated-server-core.md) accepts an
organization-operated Authority specifically because the organization owns
operations, database, backups, ingress, logs, and keys, while ECHO has no
credential, key, shell, or audit visibility. The current single founder
Authority does not yet make the account-level boundary explicit. Before
shipping repeatable per-organization infrastructure, the party that operates
each Authority and controls its cloud account must be chosen.

Two operational models are available:

| Option                        | Account and day-to-day operator                                                                                                                                                    | Custody consequence                                                                                    |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| A. Organization-owned account | The organization controls the AWS account and the Authority's operational credentials. ECHO ships reviewed infrastructure and application artifacts for the organization to apply. | Preserves ADR-0001's custody boundary.                                                                 |
| B. ECHO-owned account         | ECHO runs the Authority and its AWS resources for the organization.                                                                                                                | ECHO controls operations, storage, backup, ingress, logs, and keys, so it spends the custody boundary. |

## Candidate decision and consequences

**Candidate recommendation: option A.** Each organization's Authority runs in
an AWS account controlled by that organization. That account owns the
Authority instance, data volume, backup vault and recovery points, instance
role, log groups, secrets containers, network and tunnel resources, and the
operational credentials used to administer them. The organization performs or
authorizes deployment, backup, restore, ingress, and incident operations.

ECHO's role is to ship versioned infrastructure modules, host-configuration
material, digest-pinned application artifacts, documentation, and
support. It does not retain AWS, host, backup, tunnel, provider, or log-access
credentials for an organization Authority, and it does not gain routine shell
or audit visibility through that delivery role. An image registry or source
repository operated by ECHO may distribute a public or organization-pullable
artifact; that distribution channel must not provide ECHO access to
organization state or runtime logs.

This candidate does not decide the organization's internal administrator model,
the exact support escalation process, the identity of an initial founder-run
organization, or which account supplies shared artifact distribution. Those
must be stated explicitly when this ADR is accepted, without granting ECHO
standing access to organization state.

Option B is a valid future business model, but not a deployment-only variant
of option A. It contradicts the custody clause of ADR-0001. Adopting it would
require a new accepted ADR that explicitly supersedes ADR-0001's claim that
the organization owns operations, database, backups, ingress, logs, and keys,
and that ECHO has no credential, key, shell, or audit visibility. This ADR
does not authorize that supersession.

## Migration, rollback, and evidence

This is a proposed boundary decision, not an implementation or qualification
claim. It authorizes no cloud account, infrastructure module, credentials,
data transfer, or production deployment while its status remains `proposed`.

Before accepting the candidate, the founder must confirm all of the following:

1. the organization, rather than ECHO, is the account holder and routine
   operator for every organization Authority;
2. organization administrators control the credentials and recovery authority
   for the AWS account, data volume, backup vault, DNS/tunnel resources, logs,
   and provider secret containers; and
3. any ECHO support access is either absent or an organization-authorized,
   time-bounded break-glass process that does not become standing custody.

If the founder chooses option B, leave this ADR `rejected` and create the
required superseding custody decision before building a module under that
model. If option A is accepted, later infrastructure and recovery evidence
must demonstrate its account and credential boundary; acceptance alone is not
such evidence.
