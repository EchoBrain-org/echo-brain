---
schema_version: 1
id: ADR-0026
kind: decision
status: accepted
title: Person-bound Jira live evidence with Nango custody
component_ids:
  - CMP-IDENTITY-ACCESS
  - CMP-PERMISSIONS
  - CMP-ORGANIZATION-AUTHORITY
  - CMP-PERSON-CLIENT
created_at: 2026-10-01
reviewed_at: 2026-10-03
reviewed_ref: 254d5ddcbdbc1c7881e7a4ba541f5383ab19af59
supersedes: []
superseded_by: []
updates:
  - ADR-0019
  - ADR-0024
---

# ADR-0026: Person-bound Jira live evidence with Nango custody

Accepted under the founder's tools-are-read-live scope. The Authority composition
remains explicitly selected; INV-PERMISSIONS-015 includes its person-bound release
path. This decision permits live Jira Ask, not tool capture. Acceptance and fixture
proof do not establish live deployment or completion of the qualification matrix.

## Decision

Support Jira Cloud OAuth 2.0 (3LO) for one server-configured cloud ID. Nango owns
OAuth authorization, encrypted credential storage, refresh and reconnect. Configure
only `offline_access read:jira-work read:jira-user`; ECHO issues no Jira writes.
Data Center, Basic/API-token auth, service accounts, syncs and actions are excluded.

Use Nango Connect sessions with server-supplied organization/person/membership and
an unpredictable attempt tag. Authenticated completion verifies the connection's
integration and tags through Nango, then independently verifies accessible resources,
site URL and `/myself`. Public commands never accept a Nango connection locator.
The shared `person tools connect/status/cancel/disconnect --tool jira` dispatcher
selects a client-only Jira command fragment. Connect opens the private consent
page and polls authenticated status; status discovers the tagged connection and
finishes authorization. Provider-owned `/v1/person/tools/jira/*` routes mount via
the generic HTTP application port. Browser failure and polling timeout trigger
best-effort cancellation without printing the consent URL. Cancellation commits
locally before remote cleanup, so late consent cannot revive that attempt.
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

Persist a compact provider-owned SQLite binding plus the latest connection attempt
per Person tenure. Its expiry and terminal state survive restart; replaced attempts
cannot be reused. Remote consent completed after cancellation cleanup may still
leave an orphaned Nango connection; an orphan sweeper is outside this decision's
implemented connection slice.
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
its provider. Global Ask includes Jira; project Ask includes only the Jira project
mapped by a current ECHO project lead. Mine and unmapped ECHO project scopes exclude
it, and explicit ticket lists in those scopes fail closed. Ticket citations
link to the verified Jira URL directly; there is no durable ticket-open endpoint.

Project leads can read, set or remove one mapping in the desktop project settings
or `person tools project --tool jira --echo-project <project-id>`. Any current
project member can read the setting. The provider verifies a selected Jira key or
ID live using the lead's own connection, then retains only the configured cloud ID,
stable Jira project ID and display key. Each question still requires the asker's
own connection and current ECHO project membership; a mapping confers no Jira access.
Jira reads pin the stable project ID, including exact issue reads after search and
before final output. The server's fixed runtime project remains an upper bound.

The latest mapping and a fresh revision live in `jira_project_mapping_v1` in the
existing provider-owned sidecar. No immutable Authority schema migration, ticket
content, capture pointer or tool history is added. Writes compare the expected
revision atomically and retain only the latest command digest for exact retry.
After an intervening edit, an old retry conflicts; removal keeps a fresh revision
so remove/re-add cannot revive an in-flight reader. Session, exact project grant,
connection and mapping revision are checked across provider I/O and at final
release. The desktop reloads after an unconfirmed save before allowing another edit.
The model is told when Jira is unavailable and receives no provider selector.

## Primary documentation checked 2026-10-01

- [Nango auth guide](https://nango.dev/docs/guides/auth/auth-guide): Connect sessions and token custody.
- [Nango Jira integration](https://nango.dev/docs/api-integrations/jira): Jira OAuth support; configure read scopes explicitly.
- [Nango proxy requests](https://nango.dev/docs/guides/platform/proxy-requests): proxy is an alternative transport, not the selected one.
- [Create Connect session](https://nango.dev/docs/reference/backend/http-api/connect/sessions/create): tags and allowed integrations.
- [Reconnect](https://nango.dev/docs/reference/backend/http-api/connect/sessions/reconnect): supports an existing reference; this slice instead uses fresh Connect consent.
- [Get credentials](https://nango.dev/docs/reference/backend/http-api/connections/get): refresh-on-fetch; refresh-token return defaults off.
- [Refresh implementation](https://github.com/NangoHQ/nango/blob/master/packages/shared/lib/services/connections/credentials/refresh.ts): ordinary refresh updates `updated_at`, so it cannot establish completed reconnect consent.

## Runtime selection and live qualification

The accepted boundary includes Nango credential custody, minimized read-decision
audits and exact membership fences. Ordinary runtime selection requires both
`--jira-cloud-id` and `--jira-nango-integration`. Staging may instead select
`ECHO_STAGING_JIRA_ASK_V1=true` with its validated connector profile. That path reuses
the initial owner's existing profile-bound grant and fixed Jira project; it does
not create a second connection store or require a profile rewrite or state reset.
The EC2 runtime profile selects this switch only when a connector profile exists.

A human configures the Nango Jira integration/OAuth application, allowed callback
and scopes, server cloud ID and runtime credential injection. Reuse a working
connection rather than initiating replacement consent. Live qualification must exercise
consent, refreshed reads, reconnect, revoke, denied tickets, site/account mismatch
and cancellation without putting credentials or ticket bodies in durable logs.
The Slack lane owns its provider and composition changes; this lane adds optional
composition seams without importing Slack provider-private code.
