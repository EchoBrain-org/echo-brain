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
  - ADR-0019
  - ADR-0020
  - ADR-0021
  - ADR-0022
  - ADR-0023
  - ADR-0024
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

The `person updates` commands submit, inspect and search original text
uploads, and `person open --ref note:<context-id>` reads one.
`submit-v3 --audience only-me|team|project|projects` selects access at upload
(`project` requires `--audience-project-id`, `projects` requires
`--audience-project-ids-json`); `status-v3` reports the saved receipt. Only me
is the default. No Slack approval, provider code, background upload, or local
queue is required. Search and exact reads return only authorized originals;
submit-v3/status-v3 remain content-free. The carrier and
optional metadata do not settle the final context shape. See the
[Person upload scope](../product/2026-09-21-person-update-inbox-v1.md).

Agentic Ask V1 is specified by [ADR-0019](../decisions/ADR-0019-agentic-ask-v1.md)
and [RFC-0002](../rfcs/RFC-0002-agentic-ask-v1.md). Its V3 route and shared evidence
desk are capability-gated; implementation and live qualification are separate.

`person list [--project <project-id> | --mine] [--cursor <next_cursor>]` and
`person open --ref <ref> [--cursor <next_cursor>]` read the Authority's
[ADR-0024](../decisions/ADR-0024-person-list-open-and-mine-scope.md) routes and
print one JSON line. List rows carry a ref, title, time, who can read it and
the caller's projects it is filed in, never text; open pages a note, document,
approved meeting or shared transcript by that ref. `person ask --mine` narrows
Ask to what the caller added or approved, and every citation that carries a
`ref` opens with `person open`. `--project` and `--mine` are exclusive, and
the request is validated before any session or network use
([`person-list-cli.test.ts`](../../tests/person-client/person-list-cli.test.ts)).
