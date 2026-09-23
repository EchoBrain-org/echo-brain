# Upload projects and sharing

Status: implementation candidate; exact release acceptance is separate.

## User flow

The upload composer has two pages. The first contains text or one attached file
and a single optional **Projects** selector. No selection means the original is
outside project context. One or several selections link the same original to
those projects. Opening upload inside a project preselects it; opening from Home
starts with no projects. The picker has its own paginated project list.

**Next: Sharing** opens the second page without submitting anything. Sharing
starts at **Only me** on every new upload. The other choices are **Members of
selected projects**, available when projects are selected, and **Everyone in
organization**. The page summarizes the selected scope before **Upload** saves it.
Back preserves text, attachment, selected projects and sharing. Existing discard
confirmation and in-flight mutation protection apply to both pages.

## Scope and access

Projects and sharing are separate concepts with separate storage. A private
original may be linked to several projects. Those links do not grant access.
The owner can use that context in each selected project's Ask, subject to current
membership. Other members cannot read it unless its audience also grants access.

Sharing with selected projects grants access to the union of their current
members. A reader who leaves one audience project retains access if another
audience project still grants it. New members can read retained history. A
contributor's departure does not delete shared originals or project context.
Organization sharing follows current organization access. Only-me material stays
bound to the contributor's membership tenure.

Global Ask retrieves authorized context across scopes. Project Ask additionally
requires current project membership and an explicit association with that
project. It does not fall back to global context. Association changes do not
change the immutable audience, and an association need not equal an audience
project. The first upload screen uses the same selected set for both only when
the person chooses to share with those projects on the second screen.

## Admission and recovery

One upload creates one original, one source identity and one extraction task,
regardless of the number of selected projects. Admission validates every selected
project and commits the original, links, audience grants and receipt atomically.
There is no sequence of per-project uploads or partially completed link updates.

The request retains canonical, sorted, unique initial association and audience
sets. Idempotent replay binds those sets and the original bytes. Status and full
upload receipts report the initial association set; metadata reads report current
authorized associations. A later association change cannot invalidate the
original, its source provenance, or its original receipt.

After a lost response, retry uses the same request, content and choices. A
minimal saved proof can reconcile an admitted file after content access is
lost without disclosing its title, filename, audience or project IDs. Account
changes conceal content and cannot retarget a pending upload. File retry snapshots
survive a client restart. Editor text remains in memory; after a restart, its
retained receipt locator supports status checks but cannot resubmit lost text.

## Contracts and limits

New editor uploads use `/v3/person/updates`; new file uploads use
`/v2/person/documents`. `association_project_ids` is a canonical array of zero to
20 project IDs. The new `projects` audience contains a canonical `project_ids`
array of one to 20 IDs. Existing only-me, organization and single-project
audiences retain their meaning. Legacy request versions remain supported.

The CLI exposes `person updates submit-v3|status-v3|read-v3|search-v3` and
`person documents upload-v2|status-v2|read-v2|search-v2|download-v2`.
Project content uses `person projects feed-v2|search-v2|read-context-v2`. New admission commands accept
`--association-project-ids-json`; a projects audience also uses
`--audience-project-ids-json`. Document retry selects the retained snapshot's
version automatically. Only the final Upload action submits the request.

Existing capacity limits remain **100 retained originals per membership** and
**1,000 per organization**, shared by notes and files. Linking one original to
several projects counts it once. Files remain bounded at 25 MiB; document byte
quotas, supported formats and extraction limits are documented in
[Project documents V1](project-documents-v1.md). Editor notes retain their current
8 KiB UTF-8 bound. Link/video capture, OCR, changing an accepted audience and
automatic decision/action extraction are outside this change.

## Storage and staging

Authority V9 adds immutable initial association/audience snapshots, audience
project joins and multiple current association rows. Source custody uses immutable
audience policy; mutable associations are not part of its identity. Historical
V8 SQL remains unchanged. Runtime lineage and admission checks require the exact
V9 baseline.

The explicit offline V8-to-V9 copier validates exact V8 source custody and creates
a separate V9 snapshot, preserving original bytes, legacy payload hashes, source
identities and existing associations. Current staging uses the reviewed
`stage-v8-to-v9` lane with the host stopped for conversion and verification.
Ordinary stage does not silently migrate data. Rollback restores the retained V8
snapshot before its matching image. Follow the
[Authority operator playbook](../operations/PB-OPERATIONS-001-authority-operator-lane.md)
for the candidate's exact release approval and checks.
