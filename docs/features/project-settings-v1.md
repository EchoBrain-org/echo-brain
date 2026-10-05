# Project settings V1

The project title menu provides Jira project, Confluence spaces, Rename, Archive/Unarchive, and Leave. Existing
People controls continue to manage membership and Lead/Member roles.

Only leads can rename or archive a project. Any member may leave unless they
are its last lead; appoint another lead first. Leaving ends access through that
project, while other sharing paths remain effective.

Archived projects move out of the active list into Archived. Members can still
browse, search, and Ask about retained content under its existing permissions.
People management stays available so access can still be changed. Archived
projects cannot receive new uploads, new meeting approvals, or new file
associations. A lead can
unarchive the project to resume contributions.

An upload accepted before archive remains saved and may finish processing.
Removing a file from a project still changes only its filing, not its audience.
Archive neither deletes files nor frees retained storage. There is no project
deletion or upload withdrawal in this version.

The [accepted contract](../decisions/ADR-0018-project-settings-v1.md) defines
the API, authorization, and compatibility boundaries. These settings share one
fresh V10 Authority schema with project meeting approval. Existing development
data is disposable; the combined version requires fresh databases and a matching
runtime. Startup does not automatically migrate or reset older state. Release actions follow the
[Authority operator playbook](../operations/PB-OPERATIONS-001-authority-operator-lane.md).


## Jira project mapping

Open a project’s menu, choose **Jira project**, enter a Jira project key (for example
`KAN`), and save. Project leads can set or remove the mapping; members can read it.
The lead needs a connected Jira account to verify a new mapping. Removal does not
require Jira access. One ECHO project maps to one Jira project on the configured site.

Ask inside that ECHO project, for example **What is the status of Project A?**
The server reads its mapped Jira project live using the asker's own connected
account. It combines those tickets with the ECHO content already visible in the
project, with ticket citations. No Jira ticket content is retained. An unmapped
project or an asker without a connection gets no Jira evidence, with no fallback
to a wider search. Mine excludes Jira, and project scope excludes live Slack.

The mapping is provider configuration in the existing Jira sidecar; it requires
no Authority schema reset. A saved stable Jira project ID bounds searches and exact
reads even if the Jira key changes. Concurrent edits conflict, and the app reloads
the setting after an unconfirmed save. Global Ask can discover tickets across all
projects visible to the asker's connected Jira account. Project Ask applies the
saved mapping before discovery; there is no additional staging project allowlist.

The equivalent CLI is `person tools project --tool jira --echo-project <id>`.
A write also supplies `--jira-project <key>` (or `--clear`),
`--mapping-revision <revision>` (`none` for a new setting), and a fresh UUID in
`--mapping-request <uuid>`. See [ADR-0026](../decisions/ADR-0026-jira-person-live-evidence-nango.md)
for the connection, scope and persistence contract.

## Confluence space mapping

Open a project's menu and choose **Confluence spaces**. A lead can select up to
20 spaces by name and key from their connected account, load more spaces, and
save or remove the setting. Members can read the saved setting without connecting
Confluence. Removing a setting does not require a working provider connection.
If a save conflicts or its response is lost, reload the setting before another
write; reloading never repeats the write.

The setting retains stable numeric space IDs on the configured Confluence Cloud
site. Space renames preserve the mapping. Project Ask lists within those spaces
under the asker's own connection, then opens selected pages. It never widens an
unmapped project to global Confluence. Global Ask lists pages the connected
person can access, including personal spaces, without an ECHO space allowlist.
Mine excludes live tools. Page text stays request-local and citations open the
original Confluence page.

The CLI equivalent is `person tools project --tool confluence --echo-project <id>`.
Use `--spaces` without `--echo-project` to list visible spaces, then
`--space-cursor <cursor>` with `--spaces` to continue. A mapping write supplies
`--space-ids <comma-separated-ids>` (or `--clear`), `--mapping-revision <revision>`
(`none` for a new setting), and `--mapping-request <fresh-uuid>`.
See the [Confluence provider](../../providers/confluence/README.md) for connection
and content support.
