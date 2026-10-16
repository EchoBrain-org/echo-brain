---
schema_version: 1
id: ADR-0036
kind: decision
title: A Person change check tells the desktop what moved in their own view
component_ids:
  - CMP-ORGANIZATION-AUTHORITY
  - CMP-PERMISSIONS
  - CMP-PERSON-CLIENT
created_at: 2026-10-15
reviewed_at: 2026-10-15
reviewed_ref: 25bff4b3535957ac692bfd27b9ce8be17118c7ef
status: accepted
supersedes: []
superseded_by: []
updates:
  - ADR-0033
---

# ADR-0036: A Person change check tells the desktop what moved in their own view

The founder accepted this on 2026-10-15 as Tier 2 of
[desktop refresh and notifications v1](../product/2026-10-15-desktop-refresh-and-notifications-v1.md).
Acceptance does not mean the change is implemented or qualified.

## Context

The desktop learns of other people's changes only from window lifecycle and a
five-minute scan of open follow-ups. The Authority has no push channel and no
change signal a Person may read.

- **Global counters are off limits.** The organization's authorization
  revision moves with activity the caller cannot see. ADR-0012 forbids
  returning it, or any substitute for it.
- **Re-reading the project list is not free.** Each read takes a write lock
  and appends an audit row, so polling it would grow the audit table without
  bound.

## Options

1. **Poll the existing reads.** This is cheap for follow-ups (rows only). For
   projects it costs an audit row and a write lock per poll.
2. **A per-person change check.** The response carries fingerprints of the
   caller's own view and no content.
3. **A stream or long-poll with an event journal.** This needs new tables (a
   data reset), a persistent connection, and a way to hand over the connection
   when the sign-in token renews.

## Decision

Option 2.

- **Route.** `GET /v1/person/changes` returns `echo-person-changes-v1`. It
  carries one SHA-256 fingerprint for each of `projects`, `follow_ups` and
  `reviews`, plus `check_again_after_seconds`.
- **Fingerprints.** Each one is built only from rows the caller may read,
  under the same policy as the matching read. It moves only with activity the
  caller can see.
- **The `involved` scope.** `runs` `items` gains `involved`: the caller's
  `mine` items plus the items they last handed on, that they may read.
  `changed_since` narrows a `mine` or `involved` list to what was sent, handed
  on or set since a time.
- **Read path.**
  - The check is database-only, in one Authority read transaction, with no
    live reads. The record check reads the separate record log through its
    own connection, as every record read does.
  - It writes **no audit row**, because it returns no content.
  - The content reads it triggers stay audited as today.
- **Pace.** The Authority answers 60 s today. The field lets a later
  Authority ask for longer, and clients honour any value in 15..3600 s.
- **Compatibility.** An Authority without the route answers 404. The person
  client reports that as `not_supported`, and the desktop keeps its previous
  behaviour.

## Consequences

- **Freshness.** The desktop learns of a change in its person's view within
  one check (about a minute) without polling audited reads.
- **Privacy.** ADR-0012 is unchanged. Tests show that a change the caller
  cannot read leaves every one of their fingerprints unchanged.
- **Deployment.** The Authority is deployed with or before the desktop release
  that uses the check. There is no schema change and no data reset.
- **Cost.** Involvement through `owner_set_by` scans the organization's items
  until an index arrives with the next planned schema reset.
- **Deferred.** Seconds-level delivery, a full hand-on chain, and notifications
  for changes made while ECHO was closed would need option 3, or a server-side
  inbox, which needs new tables.
