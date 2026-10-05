# Confluence provider

This package connects one ECHO person to one verified Confluence Cloud site through Nango and reads only pages that person can view when an Ask request runs. It never captures, indexes, or retains provider content, and it never follows a provider-supplied URL.

The reader uses Confluence REST v2 pages and spaces plus CQL search. Global discovery is permission-scoped to every documented page-list status the connected person can view: current, archived, deleted, and trashed pages, including personal spaces. The list API does not return drafts; an exact page read may accept its documented draft status when a provider result identifies it. A project mapping stores stable numeric Confluence space IDs, never a mutable space key. Before project CQL search, the reader resolves each selected ID to its current key; a renamed space therefore remains mapped. The picker returns only spaces visible to the connected person and accepts keys such as `~personal-space` as provider text.

A long page becomes request-owned bounded section handles. Opening an inventory releases a bounded batch of up to eight items, each text section at most 3 KiB, with a request-local continuation for later sections. Revalidation requires the same currently visible page, version, and text digest. The supported source is page body text: comments and attachments are not queried. Common text macros, headings, lists, tables, dates, and code are supported; remote images and unsupported embeds are omitted with an explicit notice.

Required OAuth scopes are `offline_access`, `read:page:confluence`, `read:space:confluence`, `search:confluence`, and `read:confluence-user`. The provider verifies the exact cloud resource, these scopes, the pinned site origin, and the authenticated Atlassian account before provider reads. Atlassian grants are app/account-scoped and may cover more than one Atlassian product. Disconnecting Confluence therefore deletes only ECHO's selected Nango connection and revokes its local Confluence binding; it does not revoke an Atlassian app grant or mutate a Jira connection.

Atlassian documents the relevant APIs and grant behavior: [pages](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-page/), [spaces](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-space/), [CQL](https://developer.atlassian.com/cloud/confluence/advanced-searching-using-cql/), and [OAuth 2.0 3LO](https://developer.atlassian.com/cloud/confluence/oauth-2-3lo-apps/).

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
Desktop Ask selects the additive `/v5/person/ask` route with a strict V6 response.
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
