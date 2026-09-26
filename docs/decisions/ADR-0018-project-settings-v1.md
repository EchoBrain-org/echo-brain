---
schema_version: 1
id: ADR-0018
kind: decision
title: Minimum project settings with reversible archive
component_ids:
  - CMP-PERMISSIONS
  - CMP-PERSON-CLIENT
  - CMP-ORGANIZATION-AUTHORITY
created_at: 2026-09-26
reviewed_at: 2026-09-26
reviewed_ref: b22b18337c2fb388e62336a866553a18c1c32c46
status: accepted
supersedes: []
superseded_by: []
updates:
  - ADR-0013
  - ADR-0014
  - ADR-0015
---

# ADR-0018: Minimum project settings with reversible archive

## Context and acceptance

The founder accepted Rename, Leave, and Archive/Unarchive on 2026-09-26 and
requested implementation in an isolated worktree. Deleting a project could
remove the last audience path to retained originals. Withdrawal of an upload
would require a separate content lifecycle across reads, search, extraction,
citations, and Ask. Both deletion operations are outside this minimum.

This decision extends the existing project, membership, command-receipt, and
authorization machinery. It introduces no separate settings service, ownership
role, permission engine, scheduler, or content store. Acceptance records the
product scope; it does not claim a deployed or qualified release.

## Project behavior

Projects have an `active` or `archived` status. Creation produces an active
project. Any current lead may rename, archive, or unarchive it. The project ID,
creator, creation time, original custody, and historical command receipts retain
their meaning. Names use the existing create-name normalization and bounds.

An archived project is omitted from the default active list and capture
pickers, and remains discoverable to its current members through an Archived
list. Its existing feed, search, original reads, citations, and project Ask
remain available under the same current authorization as before archival.
Archival does not revoke membership, widen an audience, or change association
into permission. Global Ask remains governed by existing audience rules.

Archival blocks new uploads that name the project as an association or audience,
and blocks new associations into it. The server enforces this in the existing
write transaction, including legacy upload contracts. An accepted upload retry
returns its prior receipt without creating new work, even after archival.
Extraction and other already-admitted processing may complete. Archival does
not withdraw or mutate an original.

People management remains available, including adding people, changing roles,
and removing access. Current authorized users may remove an existing file
association. These operations preserve the existing distinction between filing
and sharing. Unarchiving restores admission of new uploads and associations.

## Leaving and leadership

Any active project member can leave their own project. The server derives the
target membership from the authenticated caller; the request cannot name another
person. Leaving revokes that project grant and its access paths. Other valid
audiences continue to grant access. Shared originals survive the contributor's
departure.

The last active lead cannot leave voluntarily. They must make another current
member a lead first. Existing organization-membership revocation still wins and
may leave a project without a lead; this decision adds no automatic promotion,
owner override, or recovery bypass. Archived projects obey the same rule.

Leaving clears the selected project and stale capture targets in the desktop.
A retry of the exact successful leave command can reconcile its own minimal
receipt after the grant has been revoked. It does not restore the membership or
permit any project content read.

## Contracts and persistence

Strict historical V1 project responses remain valid. V2 summary/list responses
add project status, and the list request selects active or archived projects.
Pagination binds the requested status and current authorized caller scope;
cursors cannot be exchanged between active and archived lists.

Rename, archive/unarchive, and leave use explicit validated commands and the
existing actor-scoped request-ID/digest replay discipline. Unknown outcomes
remain retryable with the same command. Reusing a request ID for another payload
conflicts. Lifecycle and membership effects commit with their receipts.

V10 preserves the pinned V9 baseline and admits only name/status mutation on
project metadata. Project identity, custody, audience facts, receipts, and audit
history remain protected. An explicit stopped-state V9-to-V10 transition copies
existing projects as active and preserves retained data. Startup does not
silently migrate or reset an older database. Activation and rollback remain in
the existing Authority operator lane with matching code and state.

## Invariant trace and verification

- `INV-01`, `INV-03`, and `INV-07`: filter lists to current project members before
  pagination. Missing and inaccessible projects retain the same public denial;
  no hidden project counts or global revision tokens are exposed.
- `INV-02` and `AD-03`: archive state is project metadata, not a rewrite of
  original audiences or a frozen reader list.
- `INV-05`, `INV-06`, and `INV-PERMISSIONS-015`: check current Person/project
  state within the existing transaction and release fence. Archive does not
  create a content-serving bypass, and leave invalidates affected access.
- `INV-10`: release audits stay minimized and command receipts preserve exact
  actor/request binding without becoming a second content disclosure surface.

Focused coverage must prove lead-only settings changes; last-lead rejection;
leave retry after self-revocation; active/archived cursor separation; retained
read and Ask access after archive; note/document admission and association
rejection on archived targets; accepted-upload replay and processing continuity;
and migration preservation. Desktop coverage must exercise settings actions,
Archived discovery, archived capture prevention, and navigation after leave.

## Explicit exclusions

Project deletion, upload withdrawal, permanent erasure, storage reclamation,
trash/restore, new role types, automatic lead succession, and changes to existing
sharing audiences are not included. Archive remains reversible through the
same project command path and does not reduce retained-storage usage.
