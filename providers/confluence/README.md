# Confluence provider

This package connects one ECHO person to one verified Confluence Cloud site through Nango and reads only pages that person can view when an Ask request runs. It never captures, indexes, or retains provider content, and it never follows a provider-supplied URL.

The reader uses Confluence REST v2 pages and spaces plus CQL search. Global discovery is permission-scoped to every documented page-list status the connected person can view: current, archived, deleted, and trashed pages, including personal spaces. The list API does not return drafts; an exact page read may accept its documented draft status when a provider result identifies it. A project mapping stores stable numeric Confluence space IDs, never a mutable space key. Before project CQL search, the reader resolves each selected ID to its current key; a renamed space therefore remains mapped. A mapped space Confluence does not find for the asker (404: missing, or one they cannot view) is left out of that search, and every page of the result says so in its notice, so a project search or dated list that left one out never reads as complete. Confluence refusing the credentials on a space (401 or 403) fails the read. The picker returns only spaces visible to the connected person and accepts keys such as `~personal-space` as provider text.

A long page becomes request-owned bounded section handles. Opening an inventory releases a bounded batch of up to eight items, each text section at most 3 KiB, with a request-local continuation for later sections. Revalidation requires the same currently visible page, version, and text digest. The supported source is page body text: comments and attachments are not queried. The reader requests native `atlas_doc_format` and shares its text normalizer with Jira. Headings, lists, tables, dates, tasks, code, panels, and expand blocks are supported. Opaque legacy macro extensions, remote media, and unsupported embeds are omitted with an explicit incomplete notice; their parameters are never treated as page text.

The connection requests `offline_access`, `read:page:confluence`, `read:space:confluence`, and `read:content-details:confluence`. The last scope covers both [CQL search](https://developer.atlassian.com/cloud/confluence/rest/v1/api-group-search/) and [current-user verification](https://developer.atlassian.com/cloud/confluence/rest/v1/api-group-users/); existing grants may instead provide their classic scopes, `search:confluence` and `read:confluence-user`, respectively. The provider verifies these capabilities in the returned grant, the exact cloud resource, the pinned site origin, and the authenticated Atlassian account before provider reads. `offline_access` requests refresh support and need not appear in the returned product resource scopes. Atlassian grants are app/account-scoped and may cover more than one Atlassian product. Disconnecting Confluence therefore deletes only ECHO's selected Nango connection and revokes its local Confluence binding; it does not revoke an Atlassian app grant or mutate a Jira connection.

Atlassian documents the relevant APIs and grant behavior: [pages](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-page/), [spaces](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-space/), [CQL](https://developer.atlassian.com/cloud/confluence/advanced-searching-using-cql/), and [OAuth 2.0 3LO](https://developer.atlassian.com/cloud/confluence/oauth-2-3lo-apps/).

Within a request, simultaneous connection checks with the same abort signal
share a verification only while it is queued, before remote requests begin.
Checks arriving after it starts perform a new verification; no result is cached.
Each caller retains its local binding and cancellation checks. Post-read access
checks, current space-key resolution, and exact page revalidation remain fresh.

## Connection and Ask

The reviewed Authority runtime profile selects both `--confluence-cloud-id`
and `--confluence-nango-integration`. The staging EC2 overlay can instead select
the fixed rehearsal's Atlassian cloud ID and the separate Nango integration
`confluence`; it inherits no Jira project restriction or personal grant.
Configure the matching Nango Cloud Confluence OAuth integration and Atlassian
callback/read scopes through the existing operator lane. The generic local
deployment remains unconfigured.

The desktop **Tools** screen uses the same per-person connect, reconnect, cancel,
status, and disconnect flow as Jira. The equivalent initial connection is
`echo-brain person tools connect --tool confluence`; consent occurs in the browser.
Desktop Ask, and the CLI's `echo-brain person ask --question '<question>'`
(optionally with `--project <id>`), ask `/v7/person/ask`, the only Ask route,
with a strict V8 response
([ADR-0042](../../docs/decisions/ADR-0042-research-tool-contract.md)), as the
[Person client architecture](../../docs/architecture/person-client-architecture.md#account-and-answer-sources)
describes. A 404 from it is the Authority's own `not_found`; no failure falls
back to another route.

Project leads configure [Confluence spaces](../../docs/features/project-settings-v1.md#confluence-space-mapping)
independently of the asker's personal grant. Connection state and mappings store
no page content or credentials. Same-host restarts preserve this configuration;
the offline recovery verifier refuses an unqualified Confluence grant sidecar.
Follow the [operator playbook](../../docs/operations/PB-OPERATIONS-001-authority-operator-lane.md)
for a release and real-account qualification. Synthetic tests do not establish
that an account has connected or a release has been deployed.

Date-bounded search and list select `created`, `updated` (the current page
version's timestamp, the default), or `any`
([ADR-0042](../../docs/decisions/ADR-0042-research-tool-contract.md)): a
window on either, sent as one CQL OR on `created` and `lastmodified`. The
registry declares these dates as the source's capabilities, and Ask sends
`any` for a window with no field. CQL discovery uses coarse bounds because
its dates use the provider account's time zone; current page metadata is then
filtered exactly in the request's time zone (UTC when absent). Missing dates
are excluded rather than inferred. This reads current page versions, not a
historical activity log. Keyword searches can combine text with date bounds.

## Confluence spaces as Ask evidence

The V8 Ask can also read the Confluence spaces the asker can view, as the tool
container source `confluence_spaces`, through the shared container reader the
[connector contracts](../../docs/architecture/connector-contracts.md#source-capabilities-and-containers)
describe ([ADR-0042](../../docs/decisions/ADR-0042-research-tool-contract.md)).
`createConfluencePersonLiveContainerReaderV1` lists the REST v2 spaces list,
carrying only its opaque cursor, and opens a space by an exact read of its
stable ID. Confluence has no space search, so a search looks through at most
four pages of 250 spaces and says when it was cut short. Each space cites its
`/wiki/spaces/<key>` link (a personal space's key encoded).
