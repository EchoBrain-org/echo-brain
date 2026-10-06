---
schema_version: 1
id: ADR-0030
kind: decision
title: Personal Granola custody and shared in-app meeting review
component_ids:
  - CMP-ORGANIZATION-AUTHORITY
  - CMP-MEETING-PROCESSING-CORE
  - CMP-PERMISSIONS
created_at: 2026-10-06
reviewed_at: 2026-10-06
reviewed_ref: b108ad31ff3b7e92145acedaab1e41b26971fcd8
status: accepted
supersedes: []
superseded_by: []
updates:
  - ADR-0001
  - ADR-0014
  - ADR-0017
  - ADR-0024
---

# ADR-0030: Personal Granola custody and shared in-app meeting review

## Context and decision

The founder approved the [personal Granola sprint](../product/2026-10-05-personal-granola-sprint-v1.md),
including automatic entry from one folder into a project, personal/project
review, and imported context in Ask. This records that scope; acceptance does
not mean live qualification is complete. ADR-0001's organization-owned Granola
key and founder intake are historical. Its Authority processing and custody
responsibilities remain in force.

Use personal OAuth through Nango and the existing connection lifecycle. Verify
the email and active workspace returned by Granola before binding consent and
again around reads. Email is the observed account coordinate, not an invented
immutable subject ID. Workspace/account drift invalidates the grant; reconnect
cannot silently move the same importer to another account. Nango holds OAuth
credentials and refreshes them. ECHO persists connection references, attempts
and verified grant metadata only.

Connecting or browsing retains no meeting body. An explicit import authorizes
one meeting into private or project custody. A folder-to-project watch authorizes
future new, moved-in and edited meetings in that exact folder. Establish a hash
baseline before committing the watch; do not retain its history. Changing the
mapping establishes another baseline. Removing a folder, losing its access,
disconnecting, or losing current membership/project access stops new intake.
An in-flight read cannot cross a changed ECHO grant or mapping at custody commit.
An inaccessible queued explicit import remains pending until access returns or
the person cancels it; a failed read is not deletion evidence.

The current MCP contract has no update cursor or pagination. Use bounded content
comparison through the personal grant; API-key webhooks neither cover all moves
nor establish OAuth read authority. Folder enumeration must match its advertised
count. Fail closed above 50 meetings, above 200 folder entries, on incomplete
responses, or on provider plan restrictions. No partial baseline is accepted.
Idle watches are checked about every five minutes; changed items drain one at
a time on the existing worker's subsequent turns. Errors wait at least one
minute. Cursor and immutable revision state survive restart; polling timestamps
are observational and may be lost. Each HTTP exchange has a 15-second bound.
A full unchanged 50-meeting scan can require 62 sequential MCP calls, so the
five-minute interval is not an end-to-end latency guarantee.

## Custody, approval and release

Reuse `authority_sources_v1`, immutable revisions/content, extraction attempts,
candidates, outbox, and signed append. Authority V11 removes the admission and
progress singleton and adds metadata-only personal settings plus durable human
review actions/receipts. Source keys and admission digests are bound together.
The existing serialized worker owns intake and publication; there is no desktop
importer, second body store, new processing queue, or provider-specific Ask path.

The initiating person reviews the existing frozen brief in ECHO. An exact
snapshot and command identify the human act. Audience and transcript choices
are reauthorized atomically before saving it. The native human-act codec uses
the shared meeting event, policy projection and signed envelope/receipt
factories also used by Slack. Retrying or recovering an accepted act produces
one signed record, even after disconnect. Recovery precedes startup search
readiness. Slack consent is not required.

Imported notes and provider summaries enter the existing original-context
list/open/Ask/citation boundary with the explicit `imported_meeting` kind and
an unapproved label. They do not become signed decisions. Private imports are
readable only by their importing person; project imports by current project
members. Mine additionally requires the importing person. Exact citations pin
an immutable source revision; every release rechecks current authorization and
uses the existing read audit and content-integrity checks. This reader does not
activate the separate proposed V2 general capture contracts.

Imported transcripts are excluded from this reader. Approval starts with
transcript sharing off; an explicit choice creates the existing ADR-0017
transcript grant for the approved audience. Choosing a private approval does
not remove the project audience already authorized for imported notes.
Disconnect stops future acquisition, but does not erase retained originals or
change an approved record's recorded audience. Project access remains current
at every read. The original-context corpus fails closed above 1,000 accessible
imported revisions per lookup rather than silently omitting evidence.

## Migration, rollback and evidence

V11 is fresh-state only. There is no V10 migration. Existing staging cannot run
this candidate until a separately authorized no-live-user reset, or a future
reviewed migration. Matching clients understand the new imported-meeting kind;
old clients are not a compatibility target for this fresh rehearsal. Signed
historical Slack record codecs and bytes remain readable.

Authenticated MCP identity, folder, note and transcript response contracts were
checked on 2026-10-06 with a Nango test connection. That connection is not an
ECHO Person grant. Production adapter and fixture proofs cover closed parsing,
changed revisions, custody fences, deduplication, durable approval, and imported
read access. Full local regression and live deployment qualification are tracked
in the sprint brief. No live folder watch has been enabled by this decision.
