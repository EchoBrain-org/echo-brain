---
schema_version: 1
id: ADR-0034
kind: decision
title: Person-bound Confluence live page evidence with Nango custody
component_ids:
  - CMP-IDENTITY-ACCESS
  - CMP-PERMISSIONS
  - CMP-ORGANIZATION-AUTHORITY
  - CMP-PERSON-CLIENT
created_at: 2026-10-11
reviewed_at: 2026-10-11
reviewed_ref: 3aea847cca4fa44cfa1ab28dbf44b1b707590b8b
status: proposed
supersedes: []
superseded_by: []
updates:
  - ADR-0022
  - ADR-0026
---

# ADR-0034: Person-bound Confluence live page evidence with Nango custody

Proposed, not accepted. This record describes a release path that already runs:
Confluence page evidence in Ask shipped in `38ada9c` (2026-10-05) and the
staging overlay selects it, but no accepted decision covers it.
[INV-PERMISSIONS-015](../invariants/INV-PERMISSIONS-015-layer-3-person-release-boundary.md)
requires an accepted ADR for every new release path, and
[ADR-0026](ADR-0026-jira-person-live-evidence-nango.md) permits live Jira Ask
only. Acceptance is the founder's call; until then this path is outside that
invariant's accepted scope.

## Context and options

ADR-0026 made Jira tickets live, person-bound Ask evidence read through Nango
custody and the audited live-evidence path. Confluence pages were added on the
same path with a new answer version. The options are to accept that path as
built, or to turn it off. Turning it off is not a one-line change:
`deploy/organization-authority/compose.clean-v1.ec2.yaml` sets
`ECHO_STAGING_CONFLUENCE_ASK_V1` whenever the connector rehearsal profile is
present, and that switch or the `--confluence-*` selection flags select the
path; there is no separate code gate. Turning the path off means removing the
staging switch together with the `--confluence-*` selection flags.

## Decision and consequences

What runs today, and what acceptance would confirm:

- **Custody and scopes.** One Confluence Cloud site per Authority, connected
  per person through Nango with `offline_access`, `read:page:confluence`,
  `read:space:confluence` and `read:content-details:confluence` (existing
  grants may carry the classic `search:confluence` and `read:confluence-user`
  instead). Before any read the provider verifies those capabilities in the
  returned grant, the exact cloud resource, the pinned site origin and the
  authenticated Atlassian account. ECHO issues no Confluence writes.
  `person tools connect/status/cancel/disconnect --tool confluence` and the
  desktop Tools page use the same flow as Jira. Disconnect deletes only ECHO's
  Nango connection and revokes the local binding; it does not revoke an
  Atlassian app grant or touch a Jira connection.
- **Route and answer.** Page evidence is served on the additive
  `POST /v5/person/ask` with the strict V6 answer
  (`echo-clean-person-answer-v6`), which adds request-only page citations; the
  request shape is unchanged. `/v3` (V4 answers) and the ADR-0026 `/v4` route
  (V5 answers) keep their contracts. The client falls back to `/v4` only when
  an older Authority has no `/v5` route; permission failures never fall back.
- **Scope.** Global Ask lists pages the connected person can view, including
  personal spaces, with no ECHO space allowlist. Project Ask reads only the
  spaces a current project lead mapped (up to 20 stable numeric space IDs,
  each verified with the lead's own connection when saved and resolved to its
  current key before search), under the asker's own connection; an unmapped project gets no pages and never widens to global.
  Mine excludes live tools. A mapping confers no Confluence access and holds
  only coordinates, in the provider-owned connection sidecar with the same
  revision and conflict rules as the Jira mapping.
- **Request-only sections.** A page becomes request-owned, bounded section
  handles: opening an inventory releases at most eight items, each text
  section at most 3 KiB, with a request-local continuation. Only page body text is read;
  comments and attachments are not queried, unsupported embeds are omitted
  with an incomplete notice, and provider-supplied URLs are never followed.
  ECHO does not index page text or store it durably. Page text leaves request
  memory only through the selected diagnostic paths that
  [connector contracts](../architecture/connector-contracts.md#live-evidence)
  name: the person's own one-use capture, held in Authority memory, and the
  operator-selected, staging-only LangSmith exporter, which sends page text
  off-host where nothing revalidates or erases it.
- **Audit and revalidation.** Every release goes through the shared audited
  live-evidence path: coordinates and digests are committed to the
  Authority's read-decision audit before release, and a failed audit or a lost
  local grant releases nothing. Revalidation requires the same visible page,
  version and text digest, and refuses results outside the mapped spaces.
- **Runtime selection.** The ordinary runtime selects Confluence only with
  both `--confluence-cloud-id` and `--confluence-nango-integration` and Nango
  Cloud. Staging may instead set `ECHO_STAGING_CONFLUENCE_ASK_V1`, which uses
  the rehearsal profile's cloud site and the `confluence` Nango integration.

## Migration, rollback, and evidence

No Authority schema change: connection state and mappings live in the
provider sidecar, and the offline recovery verifier refuses an unqualified
Confluence grant sidecar. Rollback is the coordinated removal described above.

Evidence in source:
`providers/confluence/test/confluence-person-live-evidence-reader-v1.test.ts`
(mapped-space refusal, pages no longer visible, changed versions, audit and
grant before release, request-local handles),
`services/organization-authority/test/confluence-person-ask-integration.test.ts`
(connect, map, cite and disconnect through the V6 route),
`confluence-person-live-state-v1.test.ts` and
`confluence-person-response-bounds.test.ts`. Synthetic tests do not establish
that an account has connected or that a release has been deployed; live
qualification follows the
[operator playbook](../operations/PB-OPERATIONS-001-authority-operator-lane.md).

## Implementation note, 2026-10-17: page lists as evidence

[ADR-0041](ADR-0041-complete-lists-as-ask-evidence.md) lets a complete page
list answer which pages exist. A page's inventory row reaches Ask's writer as
a list member, with its title and dates and never text, and the answer cites
that row. What a page says still needs an open of its sections. No new page
data is read or released.
