---
schema_version: 1
id: ADR-0016
kind: decision
title: Organization people directory for any active member
component_ids:
  - CMP-PERMISSIONS
  - CMP-PERSON-CLIENT
  - CMP-ORGANIZATION-AUTHORITY
created_at: 2026-09-25
reviewed_at: 2026-09-25
reviewed_ref: daec2fe0d0bb605a69a5b336751fb5c0fa1158dd
status: accepted
supersedes: []
superseded_by: []
updates:
  - ADR-0013
  - ADR-0015
---

# ADR-0016: Organization people directory for any active member

## Context and options

The founder asked on 2026-09-25 for the desktop app's New project page to hold
the name, optional people and optional files on one page, instead of Create
first and people and files after. Picking people on that page needs a people
search before the project exists.

The only people search was the project directory
(`POST /v1/person/projects/directory`, ADR-0015). It returns every active
member of the organization, but it requires a lead grant on an existing
project; the project ID is used only for authorization.

- **Keep two steps.** Create the project, then search its directory. This keeps
  the extra layer the founder asked to remove.
- **Create the project early.** Create it when the page opens or the name is
  typed, then use the project directory. The Authority would create a project
  the person never chose to create, and a cancelled page leaves it behind.
- **Organization directory.** Add a people search that any active member may
  use with no project. The founder chose this ("Proper server change").

## Decision and consequences

`POST /v1/person/directory` returns `echo-organization-directory-v1`: at most
ten `{ membership_id, display_name }` rows for active members of the caller's
own organization, ordered by display name, and `next_cursor`. The request body
is only an optional `query`, `limit` (1-10, default 10) and opaque `cursor`,
with the project directory's rules. It names no project, organization or
person; the Authority takes the organization from the session. The Person
client command is `person directory [--query] [--limit] [--cursor]`.

Authorization is an active membership in that organization. No project grant
or lead role is needed. Revoked, signed-out and other-organization sessions are
refused as `unauthorized` before any row is read. The read uses the project
application's authorization snapshot, final session recheck and minimized read
audit (operation `organization_directory`), which records the caller, digests
and a count, never names or the query.

Exposure: the project directory already shows every active member to any lead
of any project, and any active member can become a lead by creating a project.
No name becomes reachable that an active member could not already reach. What
changes is that a member who leads no project, whether they have no project yet
or are a plain project member, can search without creating one first. Rows carry
names and membership IDs only: no email, role, membership type, or revoked
person. The response has no hidden counts or global state, as ADR-0012 requires.

The cursor binds the operation, query, limit, organization and requesting
membership tenure. It cannot be replayed by another person, with another query
or limit, or on a project directory, and a project directory cursor cannot be
used here.

The lead-only project directory is unchanged. The organization directory grants
nothing: adding a person to a project still requires that project's lead grant.

## Migration, rollback, and evidence

There is no schema or state change; the read-audit table stores the new
operation name as data. An Authority without this route answers `404
not_found`, like an absent capability. A client must not show that as an empty
directory. Rolling back the Authority removes the route; audit rows already
written stay valid.

Contract validators and tests are in
[`packages/organization-api/`](../../packages/organization-api); the route,
application, adapter and tests are in
[`services/organization-authority/`](../../services/organization-authority);
the command and tests are in [`src/product/person-client/`](../../src/product/person-client)
and [`tests/person-client/`](../../tests/person-client). The frozen example is
`person-directory` in
[`tests/fixtures/project-context-v1/`](../../tests/fixtures/project-context-v1).
This record claims source-tested behavior at `reviewed_ref` only. Deployment to
a live Authority is a separate release decision.
