# Jira provider

The package has two roles for one Jira Cloud site:

- **Person connection lifecycle:** Nango-managed 3LO grants behind the shared
  `person tools` commands.
- **Request-scoped live reader:** `PersonLiveEvidenceReaderV1<PersonTicketCitationV1>`
  for the ticket-capable Ask path.

Ticket content is never captured or stored. ECHO reads tickets live at question
time and keeps only the read audit.

[ADR-0026](../../docs/decisions/ADR-0026-jira-person-live-evidence-nango.md)
is accepted; runtime selection stays explicit (see
[Remaining human inputs and live qualification](#remaining-human-inputs-and-live-qualification)).

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
and exact callback URL managed by Nango Connect; ECHO binds each attempt to
its authenticated Person on the server.
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

Within a request, simultaneous connection checks with the same abort signal
share a verification only while it is queued, before its remote requests begin.
A check arriving after verification starts performs a new verification. There
is no retained verification result: each caller still checks its local binding
and cancellation, and post-read checks cannot reuse a pre-read result.

Jira checks Browse Projects, issue security and app access policy under the
current user. Search results may lag, so every selected ticket is read again by
its immutable numeric issue id before release: one bulk issue read per page,
which applies current permissions, and an exact read for any hit it omits, so a
hidden or deleted hit still stops the page. Search and list release only
summaries (title, status, owner and due date); open fetches a selected ticket's
body through its request-owned handle. List resolves a project by id
or key through Jira, and verifies the returned tickets belong to that project.
Revalidation fetches every previously released issue, including inventory and
earlier text revisions, by id in batches of at most 50 through Jira's
[bulk issue read](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/#api-rest-api-3-issue-bulkfetch-post).
Each batch must return every requested ID exactly once under the same person's
current permissions; omitted, duplicated, unexpected or moved issues stop release.
This avoids one credential lookup per ticket at every model and release fence.
Credentials remain fresh before each Jira request; a 401/403/404 or binding drift
stops the request, and Nango HTTP 429 remains `rate_limited` without automatic retry.
It checks current visibility, not equality with the latest ticket text.
ECHO membership, identity and exact grant authorization still belong to the
shared authoritative authorization port. Display visibility is `only_me` and
does not describe Jira's full audience or authorize sharing.

## Transport choice and Nango

Ask uses the shared search/list/open contract and request-owned evidence handles.
It does not choose Jira endpoints, author JQL, recognize Jira key formats or
prescribe a provider-specific research order. This adapter owns query translation,
payload decoding and permission-read batching. Exact identifiers pass through
the shared planner unchanged, just as they do for other evidence sources.

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
new SDK. The selecting Jira composition now supplies Nango-managed authorization. It
fetches a fresh token just before each request without requesting refresh tokens;
do not use a sync or retained issue copy for this live reader.
Sources: [Nango Jira](https://nango.dev/docs/api-integrations/jira),
[provider configuration](https://github.com/NangoHQ/nango/blob/master/packages/providers/providers.yaml),
[Proxy guide](https://nango.dev/docs/guides/platform/proxy-requests),
[Proxy API](https://nango.dev/docs/reference/backend/http-api/proxy/get).

The authenticated-fetch port is trusted server composition, not an untrusted
plugin boundary. It must preserve the supplied URL, method, redirect mode and
abort signal, never retry anonymously or log credentials/evidence, and bind
token refresh to the same immutable ECHO grant.

## Reader behavior and bounds

`createJiraPersonLiveEvidenceReaderV1` verifies a trusted binding over a
`JiraCloudTransportV1`; the selecting composition wraps it afresh for each
request in `createAuditedPersonLiveEvidenceSourceV1`, because the reader alone
is not a Layer 3 release endpoint.

Search matches all supplied literal keywords independently, never
caller-authored JQL. It accepts at most 32 distinct keywords and preserves
identifier punctuation through the Ask protocol. The provider compiles each
keyword to an escaped literal text clause and joins them with `AND`; it does
not require the words to form one adjacent phrase. Issue keys among the
keywords (case-insensitive, ignoring surrounding punctuation, at most the
result limit) also match that ticket exactly, ahead of text matches, so a
query means `key in (...) OR` every keyword; a query of only keys is a key
lookup. Keys are read through the bulk issue read, not JQL, because Jira
refuses a whole JQL query that names one missing or hidden key; such a key is
simply no match. When nothing matches, there are at least two keywords and
one to six of them are words rather than keys, the search retries once with
every keyword but one word (an `OR` of each word dropped in turn; a plain `OR`
for two words). A named key stays in every clause, so a key nothing matched
narrows the retry to tickets that mention it; with one word, the retry is the
key's own clause.
Ask can select `source: "tickets"` for a targeted search, or omit the source to
search all available evidence. Every selection keeps the current Person and
project boundary. Open accepts only a handle minted by that reader. List
accepts a Jira project key/id, or no project for the caller's visible inventory.
Search and list accept inclusive calendar bounds and `date_field` of `created`
(the default), `updated`, `due`, or `any`
([ADR-0042](../../docs/decisions/ADR-0042-research-tool-contract.md)): a
window on any of the three, sent as one JQL OR, beside which a site-wide read
keeps a created restriction, since Jira refuses an unbounded query. The
registry declares these dates as the source's capabilities, and Ask sends
`any` for a window with no field. Timestamps use the request's time zone (UTC
when absent); date-only deadlines keep their calendar date. JQL literals use
the provider account's zone, so discovery bounds include a margin and exact
filtering runs on the current permission-checked values. The client-zone path
uses two days of margin to cover differences between client and provider zones.
A filtered page can be empty with an advancing continuation; lists sort by the
selected field and stop once the oldest value precedes `since`. A list on any
date never stops early, since no single date orders its pages. Keyword
searches retain date filters on the relaxed retry and exact-key lookup.
This is a live walk, not a pinned Jira snapshot.
Repeated issue ids or continuation tokens within a walk fail closed. There is
no search continuation in the shared contract.

To stay inside the shared 64 KiB result bound, search pages contain at most
5 ticket summaries and list pages at most 25, also respecting the requested limit
(1-50). Twenty-five worst-case summaries fit the bound; fifty would not. Labels are NFC and at most 256 UTF-8 bytes; text is NFC and at most
3,072 bytes, cut at code-point boundaries before hashing. `truncated` reports
provider continuation or shortened text/labels. Inventory omits text and uses
SHA-256 of the empty string. Numeric issue ids are stable citation identities;
the verified current key determines the tenant's `/browse/<key>` display link.
Returned `self` links are validated against the tenant/API cloudid and issue
or project coordinates, and are never followed.

Opening a ticket also discovers up to four directly linked ticket summaries,
within the requested result limit. Jira's `issuelinks` contributes only numeric
issue IDs; each selected target is exact-read under the same person and project
boundary before its metadata is released. A target Jira does not find for the
asker (404: deleted, or hidden from them) or outside the pinned project is
omitted, and the open reports `truncated` with the ticket's own text whole.
Jira refusing the credentials on a target (401 or 403) fails the open rather
than omit a link the asker may see. The planner must use a normal `open`
on the returned handle to read a linked body. Missing optional link data does
not block the anchor, and refreshing a stored citation reads only that anchor.
Source: [Jira issue links](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-links/).

Text is the issue key, summary and supported ADF description. Formatting marks
are not rendered; supported blocks include paragraphs, headings, lists,
quotes, code, tables and panels, plus text, breaks, mentions, emoji and status.
Checklist `taskList` and `taskItem` nodes preserve TODO as `[ ]` and DONE as
`[x]`, including nested lists; an unknown or missing completion state is refused.
URL-backed inline link cards contribute their URL as plain text; their target
and metadata are never fetched. Unsupported nodes (including media and
data-backed cards), malformed fields and control bytes
fail closed. Comments, attachments, custom fields, email addresses and user ids
are not released. Null description, assignee and due date are supported.
Optional metadata includes assignee display name, status, due date, creation and current update timestamps.

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
exact text digests and audit failure. The shared audited wrapper consumes
adapter-validated citations and neutral coordinates without provider branches.

## Connection to Ask flow

All commands reuse the authenticated ECHO Person session. There is no actor,
organization, grant or site selector in model arguments or connection commands.

1. `echo-brain person tools connect --tool jira` calls
   `POST /v1/person/tools/jira/connect` with `{schema_version:1}`. ECHO records
   an expiring attempt before Nango creates the limited Jira Connect session.
   The command opens the private consent page without printing its URL, then
   polls for up to 30 minutes. `--no-wait` returns the attempt ID after opening
   the browser.
2. Complete browser consent. Authenticated `POST /v1/person/tools/jira/status`
   with `{schema_version:1,attempt}` discovers the connection by server tags
   and completes the grant. Nango integration, organization, Person, tenure and
   ownership tags must match. Accessible resources, configured cloud ID, standard
   site URL, read scopes and active human `/myself` account must pass independently.
   `echo-brain person tools status --tool jira --attempt-id <id>` resumes this
   check; `person tools cancel --tool jira --attempt-id <id>` cancels locally
   before best-effort remote cleanup. Status is a connection workflow operation
   that may finish authorization, not a read of ticket content. There is no
   client-selected Nango locator or separate completion command.
3. `echo-brain person ask --tickets --question 'What is blocking launch?'` uses
   `POST /v4/person/ask`, the existing schema-3 request and strict V5 response.
   The server creates a new Jira reader and audited source for this request.
   Generic desk search/open/list keep item IDs and cursors in request memory.
   Every release commits current Person/grant, ticket coordinates and exact
   released-text digest and normalized-value digest (including inventory metadata)
   to the immutable Authority read-decision table before
   reaching a model. Before every subsequent model call, revalidation rechecks
   the evidence released since the previous successful check, plus the session,
   grant and connection; before and after the terminal audit it rechecks all
   released evidence, including inventory, earlier revisions and evidence
   omitted from the answer
   ([ADR-0038](../../docs/decisions/ADR-0038-incremental-access-check-before-model-calls.md)).
   The desk rechecks its local snapshot after Jira I/O.
4. V5 citations open the adapter-verified Jira permalink directly. The
   desktop's global and project Ask call `person ask --live`
   (`POST /v7/person/ask`, strict V8 response,
   [ADR-0042](../../docs/decisions/ADR-0042-research-tool-contract.md)), which
   falls back on an older Authority down to the V5 ticket route
   (`/v4/person/ask`), as the
   [Person client architecture](../../docs/architecture/person-client-architecture.md#account-and-answer-sources)
   describes. The desktop validates V4 to V8 answers, with a safe direct-link
   opener. `--tickets` is kept for compatibility, and `person ask` with
   neither flag retains strict V4 behavior.
5. `echo-brain person tools disconnect --tool jira` calls
   `POST /v1/person/tools/jira/disconnect`. Local revocation is committed before
   remote deletion; a failed deletion cannot restore read access. Missing
   remote connections are an idempotent disconnect success.

Reconnect starts with the same connect command, immediately invalidates the old
ECHO grant, deletes its Nango connection and opens a fresh Nango Connect session.
Completion requires that session's new server-owned attempt tag and the previously
verified Jira account. An old connection cannot complete the new attempt, even if
token refresh advances its `updated_at`. This slice uses replacement authorization
rather than Nango's in-place reconnect endpoint because that endpoint's connection
timestamp does not prove completed consent. Successful completion creates a new
grant version; ordinary refresh preserves it. A connection after disconnect also
uses fresh consent and preserves the same-tenure account fence. Unfinished or
expired attempts never become grants.
Sources: [Connect sessions](https://nango.dev/docs/reference/backend/http-api/connect/sessions/create),
[refresh behavior](https://nango.dev/docs/reference/backend/http-api/connections/get),
[refresh implementation](https://github.com/NangoHQ/nango/blob/master/packages/shared/lib/services/connections/credentials/refresh.ts).

The client-only `providers/jira/client` workspace owns the wire contracts and
shared tool-command fragment. It uses the existing authenticated Person host;
Nango, SQLite and Authority dependencies stay in the server provider. The selecting
Authority composition mounts provider-owned connection routes through the generic
HTTP application port. No Jira command or route dispatcher remains in shared core.
When selected, it also contributes Jira to `person tools` and the desktop Tools
screen alongside Slack. The entry reports only the signed-in Person's local
connection status; listing tools makes no Jira or Nango request. Each Person can
connect their own account, including on staging.

The provider-owned SQLite file stores compact binding/attempt data and the latest
project mapping setting. It retains only the latest attempt per Person tenure, including terminal status,
so polling and cancellation survive an Authority restart. It keeps no credential,
consent URL, ticket body or provider cursor. Cancellation and expiry prevent a
late consent from creating an ECHO grant; remote connections created after cleanup
can still require operator cleanup. This slice adds no remote orphan sweeper. Release audit rows keep
neutral coordinates, digests, grant/session/tenure and request commitments; no
body, label, permalink, Nango reference or cursor is retained there.

Global Ask enables Jira under the asker's connection. Project Ask additionally
requires a saved mapping set by a current ECHO project lead. The desktop project's
**Jira project** setting verifies the key live and saves only the cloud ID, stable
Jira project ID and key. Members can read the setting; leads can change or remove
it. Each asker uses their own OAuth connection and Jira permissions. Global Ask
has no additional project allowlist; project Ask applies the saved mapping before
discovery and checks it again on open and revalidation. Mine and unmapped projects exclude Jira and
never fall back to global Jira; explicit ticket inventory in an unsupported scope
is refused. There is no persistent ticket-open API, sync or index. Jira capture
is disabled, including in the staging rehearsal. See
[project settings](../../docs/features/project-settings-v1.md#jira-project-mapping)
for the setting's CLI and revision checks.

## Jira projects as Ask evidence

The V8 Ask can also read the Jira projects the asker can browse, as the tool
container source `jira_projects`, through the shared container reader the
[connector contracts](../../docs/architecture/connector-contracts.md#source-capabilities-and-containers)
describe ([ADR-0042](../../docs/decisions/ADR-0042-research-tool-contract.md)).
`createJiraPersonLiveContainerReaderV1` lists Jira's project search, which
applies the asker's Browse projects permission, in key order; the transport
admits `project/search` with only its paging, keyword, order and browse
selectors. A search sends Jira's key-and-name match the longest significant
keyword, cut at a whole character to the 256 bytes the transport admits. Open
is an exact project read, and each project cites its `/browse/<key>` link.

## Remaining human inputs and live qualification

[ADR-0026](../../docs/decisions/ADR-0026-jira-person-live-evidence-nango.md) accepts
Nango custody and the person-bound live release path, now covered by
INV-PERMISSIONS-015. `JIRA_PERSON_LIVE_RELEASE_APPROVED_V1=true` opens the code gate;
runtime selection remains explicit. Modern Slack Nango wiring is preserved and
exercised with Jira in the same Authority composition proof.

Configure the Nango Cloud Jira integration and distributable
Atlassian OAuth application, callback, classic read scopes, allowed origin and one
server cloud ID. Supply the existing runtime Nango key through the reviewed custody
mechanism, with Connect-session write, connection list/read-credentials/delete
permissions. The narrow optional startup inputs are `--jira-cloud-id` and
`--jira-nango-integration` alongside modern Nango configuration; there are no
retired Slack credential/configuration fields in this path.

For the fixed staging connector profile, `ECHO_STAGING_JIRA_ASK_V1=true` selects
its cloud ID and integration. The EC2 Compose overlay supplies this flag only when
the connector profile is selected. Live Ask allows each Person's own connection;
the rehearsal's owner and fixed-project restrictions apply only to its diagnostic
reads. Existing connections in the sidecar survive restart; do not reconnect or
reset working state.

Live qualification must exercise actual consent, tag discovery, refreshed token
reads, fresh-consent reconnect, disconnect/reconnect, denied/changed issue visibility,
account/site mismatch and abort behavior. Synthetic fixtures prove implementation
behavior only. Follow the operator playbook for deployment and account consent.
Project mappings and the desktop connection UI use the same Person-bound path.
