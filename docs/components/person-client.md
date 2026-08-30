---
schema_version: 1
id: CMP-PERSON-CLIENT
kind: component
title: Person client
owners:
  - unassigned
component_ids:
  - CMP-PERSON-CLIENT
created_at: 2026-08-13
reviewed_at: 2026-08-13
reviewed_ref: 808ac89eaf3e8eba529b356bd80d4509b9a2a293
decision_ids:
  - ADR-0001
  - ADR-0002
invariant_ids:
  - INV-ADAPTERS-002
  - INV-RUNTIME-001
  - INV-PERMISSIONS-013
failure_pattern_ids:
  - FP-ADAPTERS-002
  - FP-RUNTIME-001
  - FP-PERMISSIONS-001
qualification_ids:
  - QMAT-ADAPTERS-001
---

# Person client

## Responsibility

`src/product/person-client/` owns the machine-installed Person CLI and API
client plus its private rotating session store. It dispatches Person commands
and sends Authority HTTP requests. It has no daemon, local processing core,
provider adapter, product database, installation key, access lease, or
internal update runner. Other machine-installed surfaces may wrap this client
without becoming part of its responsibility.

## Data authority

The Person client owns only its private Person session and the Authority
descriptor verified while installing that session. The server owns source
custody, processing state, pending approvals, organization membership,
integration policy, and the organization record.

## Current references

- [Person client architecture](../architecture/person-client-architecture.md)
- [Identity and onboarding](../architecture/identity-and-onboarding.md)
- Source: [`src/product/person-client/`](../../src/product/person-client)
- Tests: [`tests/person-client/`](../../tests/person-client)

Client status and failed requests must not create session state, print tokens,
or imply that server-side provider processing is ready. See
`INV-PERMISSIONS-013` and `FP-PERMISSIONS-001`.
