# Project settings V1

The project title menu provides Jira project, Rename, Archive/Unarchive, and Leave. Existing
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
the setting after an unconfirmed save. The existing staging profile's fixed Jira
project remains the maximum allowed scope.

The equivalent CLI is `person tools project --tool jira --echo-project <id>`.
A write also supplies `--jira-project <key>` (or `--clear`),
`--mapping-revision <revision>` (`none` for a new setting), and a fresh UUID in
`--mapping-request <uuid>`. See [ADR-0026](../decisions/ADR-0026-jira-person-live-evidence-nango.md)
for the connection, scope and persistence contract.
