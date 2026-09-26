# Project settings V1

The project title menu provides Rename, Archive/Unarchive, and Leave. Existing
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
