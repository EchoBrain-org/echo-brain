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
reviewed_at: 2026-09-27
reviewed_ref: 83c8eb63aed78ba760678294ecf7fef863743e06
decision_ids:
  - ADR-0001
  - ADR-0002
  - ADR-0013
  - ADR-0014
  - ADR-0015
  - ADR-0016
  - ADR-0017
  - ADR-0018
  - ADR-0020
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
background update runner. The opt-in foreground
[client updater](../features/client-updates-v1.md) owns bounded release discovery
and platform installation before Person command dispatch. Other machine-installed surfaces may wrap this client
without becoming part of its responsibility; the Electron desktop app in
`product/echo-desktop` is one, and runs this client in process.

## Data authority

The Person client's authorization state is its private Person session and the
Authority descriptor verified while installing that session. Bounded,
account-scoped immutable document snapshots support explicit local retry and
abandonment; they grant no access and are not server source custody. The server owns source
custody, processing state, pending approvals, organization membership,
integration policy, and the organization record.

## Current references

- [Person client architecture](../architecture/person-client-architecture.md)
- [Identity and onboarding](../architecture/identity-and-onboarding.md)
- [Project context V1 contract](../decisions/ADR-0013-project-context-v1-contract.md)
- Source: [`src/product/person-client/`](../../src/product/person-client)
- Tests: [`tests/person-client/`](../../tests/person-client)

Client status and failed requests must not create session state, print tokens,
or imply that server-side provider processing is ready. `status` reads only
the local session: it makes no Authority request, prints no token or private
path, and reports a session written by an older release as signed out
([`person-client.test.ts`](../../tests/person-client/person-client.test.ts)).
`INV-PERMISSIONS-013` does not govern this output. The Person client holds no
pending approval work, and that invariant's diagnostic clause has no current
enforcement point.

The `person updates` commands submit, inspect, search, and read original text
uploads. `submit --visibility only-me|team|project` selects access at upload
(`project` requires `--audience-project-id`); `submit-v3 --audience` also
accepts `projects`. Only me is the default. No Slack approval, provider code,
background upload, or local queue is required. Search and exact reads return
only authorized originals; submit/status remain content-free. The carrier and
optional metadata do not settle the final context shape. See the
[Person upload scope](../product/2026-09-21-person-update-inbox-v1.md).
