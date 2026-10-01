# Jira person live reader

Support and transport decision recorded on 2026-10-01, before implementation.
This isolated slice implements the existing ticket reader contract; it does
not connect an account or admit Jira to Ask.

## Initial support boundary

Support Jira Cloud's platform REST API v3 on a standard single-subdomain
`https://<site>.atlassian.net` site, using a human's OAuth 2.0 authorization
code (3LO) grant. One reader is constructed for one request and one trusted
ECHO organization/person/membership, Jira cloudid/accountId and read-grant
commitment. A multi-site token never permits choosing a different tenant.

Cloud and Data Center are different deployments and authentication protocols.
Data Center has an instance-local OAuth provider and uppercase `READ` scope;
it is excluded here, as are legacy Server, custom domains, government cloud,
API-token/basic auth, service accounts, Forge/Connect app identities and
anonymous reads. Server support ended on 2024-02-15.
Sources: [Cloud 3LO](https://developer.atlassian.com/cloud/jira/platform/oauth-2-3lo-apps/),
[Data Center OAuth](https://confluence.atlassian.com/adminjiraserver/jira-oauth-2-0-provider-api-1115659070.html),
[Server support](https://www.atlassian.com/licensing/server-end-of-support).

## Authentication and authorization

The minimum **classic** read scopes for these endpoints are `read:jira-work`
(issues, enhanced JQL search, projects) and `read:jira-user` (`myself`). This is
not a claim that classic scopes are narrower than every granular alternative.
Request `offline_access` separately when durable refresh is required; it is
not an issue-read permission. Do not request write/admin scopes. Consent uses
one distributable ECHO 3LO app, a validated unpredictable session-bound state
and exact callback URL; this slice does not implement onboarding.
Sources: [search scopes and issue security](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-search/#api-rest-api-3-search-jql-post),
[current-user scopes](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-myself/#api-rest-api-3-myself-get),
[issue read](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/#api-rest-api-3-issue-issueidorkey-get),
[projects](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-projects/#api-rest-api-3-project-projectidorkey-get),
[OAuth consent and refresh](https://developer.atlassian.com/cloud/jira/platform/oauth-2-3lo-apps/).

Before reads, after reads and during revalidation, the adapter calls
`/oauth/token/accessible-resources`, selects exactly the bound cloudid's Jira
resource with both classic scopes, validates its site URL, and calls
`/ex/jira/{cloudid}/rest/api/3/myself`. It requires the exact accountId, an active
human Atlassian account, and an unchanged site origin. An email match, Nango
connection metadata, HTTP 200, or a usable token alone is insufficient.
Atlassian notes that resource ids can occur across products and that
accessible-resources does not prove user permissions; Jira scope selection
and exact authenticated issue reads remain necessary.
Source: [site access and API routing](https://developer.atlassian.com/cloud/jira/platform/oauth-2-3lo-apps/#4--check-site-access-for-the-app).

Jira checks Browse Projects, issue security and app access policy under the
current user. Search results may lag, so every selected ticket is fetched by
its immutable numeric issue id before release. List resolves a project by id
or key through Jira, and verifies the returned tickets belong to that project.
Revalidation fetches every previously released issue, including inventory and
earlier text revisions, by id; a 401/403/404 or binding drift stops the request.
It checks current visibility, not equality with the latest ticket text.
ECHO membership, identity and exact grant authorization still belong to the
shared authoritative authorization port. Display visibility is `only_me` and
does not describe Jira's full audience or authorize sharing.

## Transport choice and Nango

Choose direct HTTPS calls to `https://api.atlassian.com`, with a trusted,
person/grant-bound authenticated-fetch port. Composition must select the
connection from authoritative ECHO state and attach its current 3LO bearer
authorization inside that port. There is no token argument, token retrieval,
environment credential lookup or connection selector in reader methods.
The adapter owns fixed endpoints, redirect refusal, timeout, cancellation,
streamed response byte limits, status mapping and JSON interpretation.

Nango supports Cloud `jira` OAuth, token refresh and distinct Data Center
providers. Its `jira` default scope is `offline_access`; configure both read
scopes explicitly. Its Proxy can inject authorization, override the base URL and
retry (default zero); it returns provider status/headers/body. Neither Proxy
nor sync is necessary for the shared contract. Direct requests were selected
to control redirects, streaming bounds and abort behavior locally without a
new SDK. A later composition can supply Nango-managed authorization; do not
use a sync or retained issue copy for this live reader.
Sources: [Nango Jira](https://nango.dev/api-integrations/jira/),
[provider configuration](https://github.com/NangoHQ/nango/blob/master/packages/providers/providers.yaml),
[Proxy guide](https://nango.dev/docs/guides/platform/proxy-requests),
[Proxy API](https://nango.dev/docs/reference/backend/http-api/proxy/get).

The authenticated-fetch port is trusted server composition, not an untrusted
plugin boundary. It must preserve the supplied URL, method, redirect mode and
abort signal, never retry anonymously or log credentials/evidence, and bind
token refresh to the same immutable ECHO grant. No real credential or account
validation is authorized by this worktree.

## Reader behavior and bounds

`createJiraPersonLiveEvidenceReaderV1` asynchronously verifies a trusted binding
and returns `PersonLiveEvidenceReaderV1<PersonTicketCitationV1>`. Supply a
matching `JiraCloudTransportV1`, or construct the direct transport with
`createJiraCloudTransportV1` and the trusted authenticated-fetch port. Compose
the reader with `createAuditedPersonLiveEvidenceSourceV1`; the reader alone is
not a Layer 3 release endpoint. Construct both afresh for each request.

Search treats query text as a literal phrase (or an exact issue key), never
caller-authored JQL. Open accepts only a handle minted by that reader. List
accepts a Jira project key/id, or no project for the caller's visible inventory.
Dates are inclusive UTC **creation** days, applied after exact reads; JQL date
literals use the Jira account's timezone. A filtered page can be empty with an
advancing continuation. This is a live walk, not a pinned Jira snapshot.
Repeated issue ids or continuation tokens within a walk fail closed. There is
no search continuation in the shared contract.

To stay inside the shared 64 KiB result bound, full-text pages contain at most
5 tickets and inventory pages at most 20, also respecting the requested limit
(1-50). Labels are NFC and at most 256 UTF-8 bytes; text is NFC and at most
3,072 bytes, cut at code-point boundaries before hashing. `truncated` reports
provider continuation or shortened text/labels. Inventory omits text and uses
SHA-256 of the empty string. Numeric issue ids are stable citation identities;
the verified current key determines the tenant's `/browse/<key>` display link.
Returned `self` links are validated against the tenant/API cloudid and issue
or project coordinates, and are never followed.

Text is the issue key, summary and supported ADF description. Formatting marks
are not rendered; supported blocks include paragraphs, headings, lists,
quotes, code, tables and panels, plus text, breaks, mentions, emoji and status.
Unsupported nodes (including media/cards), malformed fields and control bytes
fail closed. Comments, attachments, custom fields, email addresses and user ids
are not released. Null description, assignee and due date are supported.
Optional metadata is limited to assignee display name, status and due date.

Each direct request has a 15-second timeout and a 1 MiB streamed JSON-body
limit. There are no retries. HTTP 401/403 deny access, 404 refuses the exact
read, 429 reports rate limiting and other failures report unavailability;
errors never include raw bodies or causes. Cancellation reaches transport and
prevents release. Request memory stores only opaque handles, citation digests,
issue ids and continuation state, with a 512-entry bound; it creates no durable
ticket index or evidence cache.

The focused suites in `test/` use synthetic transport and response fixtures.
They exercise the shared audit boundary and prove authentication drift,
permission loss, malformed payload refusal, pagination ownership, cancellation,
exact text digests and audit failure. Workspace/build/source ownership and the
component catalog are registration changes only; no shared provider branches,
contracts or Authority composition are changed.

## Remaining integration before Ask

The shared lane must supply authoritative grants/current membership, durable
audit, read-status endpoints, Evidence Desk registration, a versioned ticket
answer/evidence schema, Authority composition and project-scope mapping.
It also owns correction of the shared wrapper's existing Slack-specific
branch. `mine` must exclude external Jira reads. Each model call and final
response must revalidate all released evidence; model content capture must
remain off. Person OAuth onboarding and separately authorized live account
qualification remain necessary. Existing Ask V4 does not admit tickets.
