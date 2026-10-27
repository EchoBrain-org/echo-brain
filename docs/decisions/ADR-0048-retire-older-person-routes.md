---
schema_version: 1
id: ADR-0048
kind: decision
title: Retire the older Person routes and fallbacks kept only for compatibility
component_ids:
  - CMP-ORGANIZATION-AUTHORITY
  - CMP-PERSON-CLIENT
  - CMP-PERMISSIONS
created_at: 2026-10-25
reviewed_at: 2026-10-27
reviewed_ref: aa79d90c81dbcf8f0147ecb66bfbbe4edbf2c2ff
status: proposed
supersedes: []
superseded_by: []
updates:
  - ADR-0013
  - ADR-0014
  - ADR-0036
  - ADR-0047
---

# ADR-0048: Retire the older Person routes and fallbacks kept only for compatibility

The founder decided on 2026-10-25 that there are no older servers to stay
compatible with, and that clients update themselves
([ADR-0035](ADR-0035-desktop-updates-from-the-signed-feed.md)). Code that
exists only so an older server or an older client keeps working should go.
This record covers the Person routes outside Ask. The older Ask routes and the
Ask client's fallbacks are retired separately. This record is proposed until
the founder confirms the release.

## Context and options

Several Person families still served an older version beside the newer one,
and the client still covered for an Authority that lacked a newer read:

- **Projects.** The V1 reads: `GET /v1/person/projects`,
  `GET /v1/person/projects/{project_id}`,
  `GET /v1/person/projects/{project_id}/context/{context_id}`, and
  `POST /v1/person/projects/context/feed` and `/context/search`
  ([ADR-0013](ADR-0013-project-context-v1-contract.md)). The V2 reads return
  everything they did. The CLI retired its V1 read commands on 2026-09-30.
- **Notes.** `POST /v2/person/updates`, `GET /v2/person/updates/{request_id}`
  and `GET /v2/person/updates/content/{context_id}`. Clients write and check
  notes with V3, and `person open` reads a note whichever version stored it.
- **Documents.** Every `/v1/person/documents` route
  ([ADR-0014](ADR-0014-unified-source-ingestion-and-document-custody.md)). The
  V2 routes read every stored document, whichever version uploaded it. The
  client still sent associate and dissociate to `/v1`, and re-sent a V1 upload
  snapshot that a client from before 2026-09-23 left behind.
- **Tools.** `GET /v3/person/tools`, and the `GET /v2/person/tools` that the
  Slack identity bundle still mounted. Clients read `/v4/person/tools`.
- **Missing-read fallbacks.** The person client turned a 404 from the change
  check ([ADR-0036](ADR-0036-person-change-check.md)) or from project activity
  ([ADR-0047](ADR-0047-ask-timeline.md)) into `not_supported`. On the first,
  the desktop scanned only what you sent or own every five minutes, listed
  Follow-ups as what you sent or own, and logged `changes unsupported`
  ([desktop refresh and notifications v1](../product/2026-10-15-desktop-refresh-and-notifications-v1.md),
  R8). On the second, it showed no project dots until the next sign-in.

Keeping them costs a set of codecs, routes and tests per family, plus client
branches that no current Authority triggers. The alternative is to retire them
the way the V1 note route was retired: delete the routes and whatever only they
use, keep every read of stored data, and keep the retired paths reserved.

## Decision and consequences

Retire them, and keep what reads stored data.

**Retired:**

- The project V1 reads, the V2 note write, status and content read, every V1
  document route, `GET /v3/person/tools` and Slack's `GET /v2/person/tools`.
  Each now answers the ordinary 404, as any unknown path does.
- The codecs, application methods, store methods and authorization scopes that
  only those routes used: the `project_read`, `feed`, `search`,
  `context_read`, `upload_status` and `upload_read` reads, and the
  `upload_submit` mutation.
- The client's `not_supported` for the change check and project activity. A
  404 from either is `not_found`, as from any other read.
- The desktop's older-Authority mode (R8), its `changes unsupported` log line,
  and its stop on project activity after one `not_supported`.
- The client's re-send of a V1 upload snapshot. Such a snapshot is listed as
  unreadable, and `documents abandon` removes it.

**Kept:**

- `POST /v2/person/updates/search`. It is the only search of notes stored as
  V2, which no V3 read returns, and the desktop's search uses it.
- The V2 note submit and receipt codecs. Custody re-verifies each stored V2
  note against them.
- Every stored note, document and receipt. A stored V2 note keeps its
  `upload_submit` receipt, and a new command under that request ID conflicts,
  as before.
- The V1 project routes that have no V2: create, rename, archive, unarchive,
  leave, members, directory, member add, set and remove, associate and
  dissociate, and `POST /v1/person/directory`. The `project_list` scope stays,
  because record project scope and workspace evidence capture it.
- Slack's in-process tools read and its V2 shape, which its disconnect reply
  and the V4 list use.
- The retired paths stay in the provider-collision list, so no provider
  adapter can mount one.

**Consequences:**

- The newest version of each family behaves exactly as before.
- When the change check fails, the desktop does what it already did for a
  failed check: it backs off, and a return reads the sidebar again. When
  project activity fails, the dots stay as they were, and the next check that
  expects the read tries it again.
- Not covered here: the older Ask routes and the Ask client's fallbacks, the
  Ask source check's `not_supported` and the desktop's handling of it, and
  `/v3/person/capabilities`.

## Migration, rollback, and evidence

- **Release order:** the Authority first, then the clients, the order the Ask
  timeline release this ships with needs
  ([ADR-0047](ADR-0047-ask-timeline.md)). A desktop that has not updated yet
  keeps working, except for document associate and dissociate. It still sends
  those to `/v1`, reads the 404 as `not_found`, and says the document is no
  longer available, until it updates itself. Shipped on its own, this change
  would be safe clients first, because the Authority it builds on already
  serves the `/v2` document routes. This gap was accepted on 2026-10-25 in
  place of keeping the V1 association routes for one more release. A client
  that has not updated also gets that 404 when it resends a V1 upload snapshot
  left from before 2026-09-23.
- **Data:** no migration. No table, column or stored row changes.
- **Rollback:** revert the change. Nothing stored changed, so the older routes
  return as they were.
- **Evidence:**
  - The server tests answer every retired path with 404, except V1 document
    dissociate, which no test sends:
    `organization-authority-api-runtime.test.ts`,
    `project-context-http.test.ts`, `person-documents-http-v1.test.ts` and
    `slack-person-identity-link-http-v1.test.ts`.
  - Stored V2 notes and V1 documents, seeded as their old routes wrote them,
    still read, search, associate, reach Ask, hold their request IDs and count
    toward quotas through the current routes: `project-context-sqlite.test.ts`,
    `person-original-items-v1.test.ts`,
    `person-original-context-adversarial.test.ts`,
    `person-documents-v1.test.ts`, `person-document-associations-v1.test.ts`
    and `person-upload-audience-disclosure.test.ts`.
  - The retired V2 and V3 tools lists stay reserved against provider adapters
    (`person-tools-http-application.test.ts`).
  - The client tests cover the plain 404 (`person-changes.test.ts`,
    `person-project-activity.test.ts`) and the unreadable V1 snapshot
    (`person-document-cli.test.ts`).
  - The desktop tests cover the failed reads (`freshness.test.ts`,
    `ask-timeline.test.ts`).
