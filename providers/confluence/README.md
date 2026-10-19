# Confluence provider

This package connects one ECHO person to one verified Confluence Cloud site through Nango and reads only pages that person can view when an Ask request runs. It never captures, indexes, or retains provider content, and it never follows a provider-supplied URL.

The reader uses Confluence REST v2 pages and spaces plus CQL search. Global discovery is permission-scoped to every documented page-list status the connected person can view: current, archived, deleted, and trashed pages, including personal spaces. The list API does not return drafts; an exact page read may accept its documented draft status when a provider result identifies it. A project mapping stores stable numeric Confluence space IDs, never a mutable space key. Before project CQL search, the reader resolves each selected ID to its current key; a renamed space therefore remains mapped. The picker returns only spaces visible to the connected person and accepts keys such as `~personal-space` as provider text.

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
Desktop Ask selects the additive `/v7/person/ask` route with a strict V8 response
([ADR-0042](../../docs/decisions/ADR-0042-research-tool-contract.md)), then
`/v6/person/ask` with a strict V7 response
([ADR-0040](../../docs/decisions/ADR-0040-follow-ups-as-ask-evidence.md)) on an
Authority without `/v7`, and `/v5/person/ask` with a strict V6 response on one
without `/v6`.
The CLI uses `echo-brain person ask --live --question '<question>'`, optionally
with `--project <id>`. Older ticket-only and local-context response contracts remain
unchanged; an older Authority that has no new route receives the ticket-capable
fallback. Permission failures never trigger that fallback.

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
container source `confluence_spaces`
([ADR-0042](../../docs/decisions/ADR-0042-research-tool-contract.md)),
registered over the same runtime as the page source and bound only for the V8
answer. `createConfluencePersonLiveContainerReaderV1` reads through the
asker's own connection and the same audited boundary. List pages the REST v2
spaces list, at most 25 a call, carrying only its opaque cursor. Confluence
has no space search, so a search looks through at most four pages of 250
spaces and says when it was cut short, then matches every word against each
space's key, name and the names of the ECHO projects mapped to it. Open is an
exact read by the space's stable ID. Each item is labeled by the space's name,
carries its key and tool, cites the space with its `/wiki/spaces/<key>` link
(a personal space's key encoded), and names the mapped ECHO projects the asker
can see by whole name: ten, or as many as fit, then how many more. A space row
that fails validation, such as a blank or non-NFC name or an unexpected key
shape, is left out and never shown, and the result's notice says some spaces
could not be shown, so the list or search never reads as complete. A project
Ask reads only the spaces its ECHO project maps that the asker can view, paged
by the limit asked for; a space the asker cannot view (404) is left out,
Confluence refusing the credentials (401 or 403) fails the read, and an
unmapped project reads none. A date window is refused before any provider
read. Checks re-read every distinct release of a space and refuse one whose
name, key, link or named ECHO projects changed.
