---
schema_version: 1
id: ADR-0026
kind: decision
status: proposed
title: Person-bound Jira live evidence with Nango custody
component_ids:
  - CMP-IDENTITY-ACCESS
  - CMP-PERMISSIONS
  - CMP-ORGANIZATION-AUTHORITY
  - CMP-PERSON-CLIENT
created_at: 2026-10-01
reviewed_at: 2026-10-01
reviewed_ref: b350962a2917dadb4b96f6144aa23e10a6ca361f
supersedes: []
superseded_by: []
updates:
  - ADR-0019
  - ADR-0024
---

# ADR-0026: Person-bound Jira live evidence with Nango custody

This is a proposal awaiting founder acceptance. Fixture implementation is allowed;
the new Authority composition is opt-in and disabled by default. Acceptance must
explicitly extend INV-PERMISSIONS-015's enforcement scope before live enablement.
It does not claim a qualified live account, deployment, or permission migration.

## Decision proposed before implementation

Support Jira Cloud OAuth 2.0 (3LO) for one server-configured cloud ID. Nango owns
OAuth authorization, encrypted credential storage, refresh and reconnect. Configure
only `offline_access read:jira-work read:jira-user`; ECHO issues no Jira writes.
Data Center, Basic/API-token auth, service accounts, syncs and actions are excluded.

Use Nango Connect sessions with server-supplied organization/person/membership and
an unpredictable attempt tag. Authenticated completion verifies the connection's
integration and tags through Nango, then independently verifies accessible resources,
site URL and `/myself`. Client-provided connection IDs are locators, never grants.
Reconnect revokes the prior grant, deletes the prior Nango connection and creates
a fresh Connect session with a new server-owned attempt tag. Completion pins the
previously verified Jira account and requires the new tag. This replacement flow
avoids treating an in-place connection's `updated_at` as completed consent: ordinary
Nango refresh also advances that timestamp. Initial and replacement completion can
discover their connection by server-owned tags. Each completed consent creates a
new stable grant version. Ordinary Nango access-token refresh preserves that
version. Disconnect first revokes locally,
then deletes the remote connection; failed deletion cannot restore ECHO access.

Fetch current credentials immediately before each Jira request. Access tokens exist
only in the adapter's request memory. Refresh tokens are not requested. Jira fetches
use the existing direct `JiraCloudAuthenticatedFetchV1` port, fixed Atlassian origin,
redirect rejection, abort propagation, timeout and streamed response bound. Nango
proxy is supported by Nango, but its remote response buffering, redirect policy and
cancellation are not qualified as equivalent to this port. No Nango actions/syncs
or SDK dependency is necessary.

Persist a compact provider-owned SQLite binding plus expiring connection attempts.
Bind to the exact ECHO membership tenure, verified Jira account/site, opaque Nango
reference, active/revoked state and immutable grant commitment. Current session and
membership authorization is rechecked before and after reads and audit commit.
Membership loss, disconnect, reconnect and grant replacement discard in-flight
results. Provider identity never creates an ECHO membership or canonical record grant.

The audited wrapper delegates citation parsing and tenant coordinates to adapters.
It checks actor/grant/bounds/exact text digest and commits coordinates and digests to
the existing immutable Authority read-decision audit table before model release.
A separate normalized-value digest commits labels, attributes and inventory
metadata without retaining their bytes.
Bodies, labels, credentials, Nango references and provider cursors are absent from
that audit. All released citations, including inventory and subsequently omitted
items, remain request-owned and are revalidated before subsequent model calls and
final response. Audit failure releases no evidence.

Add a ticket-capable Ask response V5 and Evidence Desk V2 behind a separate HTTP
route. Existing V4 remains strict and retains its route. A thin neutral dispatcher
adds the server-selected ticket source to the existing desk; Jira rules stay inside
its provider. Only global Ask includes Jira. Mine and unmapped ECHO project scopes
exclude it, and explicit ticket lists in those scopes fail closed. Ticket citations
link to the verified Jira URL directly; there is no durable ticket-open endpoint.

## Primary documentation checked 2026-10-01

- [Nango auth guide](https://nango.dev/docs/guides/auth/auth-guide): Connect sessions and token custody.
- [Nango Jira integration](https://nango.dev/docs/api-integrations/jira): Jira OAuth support; configure read scopes explicitly.
- [Nango proxy requests](https://nango.dev/docs/guides/platform/proxy-requests): proxy is an alternative transport, not the selected one.
- [Create Connect session](https://nango.dev/docs/reference/backend/http-api/connect/sessions/create): tags and allowed integrations.
- [Reconnect](https://nango.dev/docs/reference/backend/http-api/connect/sessions/reconnect): supports an existing reference; this slice instead uses fresh Connect consent.
- [Get credentials](https://nango.dev/docs/reference/backend/http-api/connections/get): refresh-on-fetch; refresh-token return defaults off.
- [Refresh implementation](https://github.com/NangoHQ/nango/blob/master/packages/shared/lib/services/connections/credentials/refresh.ts): ordinary refresh updates `updated_at`, so it cannot establish completed reconnect consent.

## Required acceptance and qualification

Founder review must accept the Nango custody boundary and the additional Person
release path, including audit retention and exact membership fences. A human must
configure the Nango Jira integration/OAuth application, allowed callback and scopes,
server cloud ID and runtime credential injection. Live qualification must exercise
consent, refreshed reads, reconnect, revoke, denied tickets, site/account mismatch
and cancellation without putting credentials or ticket bodies in durable logs.
The Slack lane owns its provider and composition changes; this lane adds optional
composition seams without importing Slack provider-private code.
