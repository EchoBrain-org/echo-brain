# Personal Granola integration sprint

Status: scope approved on 2026-10-05; phase 1 cleanup is in progress in Codex
Cloud. Phase 2 has not started. Base: main `605ed5a`. The same-day scope update
requires one selected personal Granola folder mapped to an ECHO project, with
automatic intake when meetings enter that folder or meetings in it change.
Live verification target: Granola folder **ECHO**, with **ECHO** also treated as
the target project name. Resolve and verify their actual accessible identifiers
through the connected person's account before enabling the mapping.

Granola becomes a personal connection that follows an ECHO person across their
devices. Slack's bot remains the only connector with organization-level setup.
Authority identity, membership, signing, model configuration, and hosting remain
organization services; this sprint removes organization-level Granola setup.

The user flow is Tools → Granola → Connect → choose a Granola folder and a
permitted ECHO project → meetings entering that folder and updates to its
meetings automatically trigger intake and processing → review extracted
decisions. Browse and Add to ECHO remain available for selecting an existing
meeting. Connecting alone does not import the entire historical workspace or
grant anyone else access to its meetings. The explicit folder-to-project mapping
authorizes automatic intake under that project's audience rules; signed-record
approval remains a separate review step. Meeting imports and signed approved
decisions remain distinct. Jira and Confluence continue to supply live context
without tool capture.

## Phase 1 Remove organization Granola setup

An organization must be able to onboard and run without a Granola key, founder
email binding, source admission, or completed Granola setup. With no meeting
sources connected, meeting intake is idle and the rest of ECHO remains usable.
Phase 1 must work independently of phase 2.

Remove the active organization Granola path throughout the product:

- Required Granola credentials and owner-email inputs in Authority startup,
  setup, onboarding, readiness checks, environment configuration, and runtime
  profile validation.
- The founder-only Granola admission command, credential-file readers, setup
  proof, bundle construction, and `founder-granola-v1` selection.
- Organization Granola polling and rehearsal routes that depend on that
  credential or admission. Remove dedicated organization-only code and tests
  instead of leaving an unreachable fallback.
- Granola key/owner-email transfer, installation, reuse, and validation in host
  wrappers, deployment bundles, release tooling, examples, and current operator
  documentation. Preserve other providers' configuration and release checks.

Preserve code with a concrete phase 2 use:

- Provider-neutral meeting documents, source identity, immutable revisions,
  custody, admission, bounded processing, extraction, approval, and retrieval.
- Audience selection, project association, and separate transcript release.
- Granola content/transcript normalization and validation where they can operate
  without an organization key or founder identity. Separate reusable transforms
  from REST-specific acquisition and owner/cursor assumptions before reuse.
- Shared Nango connection lifecycle, provider registration, CLI verbs, desktop
  Tools UI, current-membership checks, revocation, and audit boundaries.
- Synthetic meeting sources and the release approval canary as explicit test
  infrastructure, independent of a real Granola connection.

Retain old immutable schema definitions or readers only when existing release
or record verification actually needs them. Do not retain an active legacy
connector for compatibility. Determine the required state/profile version
change from the cleanup; never mutate live state or silently migrate a pinned
baseline as part of a code change. Any later staging replacement uses the
existing operator playbook.

Phase 1 passes when:

1. A fresh organization reaches healthy runtime without Granola inputs or
   fabricated Granola setup evidence.
2. Missing Granola does not block personal Jira/Confluence connections, project
   settings, context reads, or Ask.
3. Slack bot setup and synthetic approval qualification still work.
4. Generic meeting processing, approved-record access, project audiences, and
   transcript-release tests remain valid.
5. No active startup, onboarding, credential transfer, or readiness path
   requires `granola_credential_file`, `granola_owner_email_file`, or
   `founder-granola-v1`.
6. Architecture, documentation, lint, build, type checks, and the full test suite
   pass. The removal/reuse inventory accounts for each surviving Granola module.

Phase 1 code owners are `providers/granola`, Authority composition/setup,
`tools`, and `deploy`. The cleanup worktree has the following removal/reuse
inventory; this is implementation progress, not a completed qualification:

| Area | Disposition |
| --- | --- |
| Organization Granola credentials, owner observation, admission, bundle and setup proof | Removed from the provider workspace and selecting composition. |
| Granola REST client, owner filtering, poll cursors and organization capture route | Removed; no compatibility connector remains. |
| [`granola-meeting-normalizer-v1.ts`](../../providers/granola/src/granola-meeting-normalizer-v1.ts) | Retained content transforms only. Input is transport-independent and is not claimed to be the MCP response contract. Mapping version stays stable for existing semantic revisions. |
| [`granola-context-source-v1.ts`](../../providers/granola/src/context/granola-context-source-v1.ts) | Retained shared capture mapping and injected source adapter. No credentials or active acquisition. |
| Host preparation and credential activation | Seven-file onboarding input, with no Granola key or owner-email file. LLM credential activation retains its stopped-state install, health checks and rollback. |
| Generic custody, processing, projects, approval and connectors | Retained. Synthetic approval tests no longer import Granola polling/cursor code. |

The [setup](../../services/organization-authority/src/composition/organization-authority-setup-cli.ts)
and [runtime composition](../../services/organization-authority/src/composition/organization-authority-composition-root.ts)
are under correction and integration testing. Pinned Authority baseline SQL is
unchanged. Full-suite verification and the final setup/rehearsal version
inventory are required before phase 1 is complete.

## Phase 2 Add personal Granola support

Each ECHO person connects Granola through browser OAuth using Nango's
`granola-mcp` provider. The same connection is available across that person's
devices. A second Mac does not create a second importer. The desktop does not
ask for API keys or expose provider credentials.

Deliver the complete personal slice:

1. Reuse the shared Tools/CLI connection lifecycle for connect, status, cancel,
   reconnect, and disconnect. Display the connected account and workspace.
2. Browse and open meetings visible to that connection. Keep browsing separate
   from permission to retain or share content.
3. Let the person select one accessible Granola folder and map it to a permitted
   ECHO project. A meeting entering the selected folder, including an existing
   meeting moved into it, or an update to a meeting in it automatically triggers
   ECHO intake and processing. Use Authority-owned work for that connection and
   mapping rather than a device-local importer. Explain retention and project
   audience when enabling the mapping, recheck current source and project
   authorization before read and admission, and keep shared transcript access
   off by default. Also provide explicit Add to ECHO for an existing selected
   meeting, showing what will be retained and allowing private context or a
   permitted project.
4. Reuse extraction and signed-record approval, with the initiating person as
   the approver. Review must be available inside ECHO; a personal Slack sign-in
   is not a prerequisite. The organization bot remains available for delivery
   and optional approval notifications.
5. Make authorized imported/approved context accessible through the existing
   list, open, global/Mine/project Ask, and citation paths under their respective
   audience and approval rules. Do not label an unapproved import as an approved
   meeting decision.
6. Keep source progress and pending work separate for each connection/person.
   Reconnect must not duplicate imports. Disconnect or membership loss stops
   new reads and invalidates in-flight admission. Already approved records keep
   their recorded audience; disconnect must explain this consequence.

First verify the actual authenticated MCP contract: account/workspace identity,
list/open/transcript response shapes, pagination, content limits, and account
or workspace changes. Granola's documentation does not establish immutable
subject/workspace IDs, an owner-only filter, or REST-equivalent incremental
cursor behavior. Do not invent those guarantees or disguise MCP responses as
the old REST contract. Reuse normalizers only where their input guarantees hold.

Automatic intake from one selected Granola folder into its mapped ECHO project
is required by the 2026-10-05 scope update. Prove folder discovery and membership,
the initial watch boundary, change detection, bounded polling or another
supported trigger mechanism, retries, and durable resume before enabling it.
Do not substitute REST cursor or API-key webhook assumptions for the actual
OAuth MCP contract. An unchanged observation must not create another import;
a changed meeting must create the correct immutable revision and trigger the
existing processing/review path without treating it as an already approved
decision. Meetings outside the selected folder must not trigger automatic
intake. Define folder removal, source access loss and project access loss so
they stop new reads and invalidate pending admission under the existing rules.
Historical bulk import remains out of scope; establish the initial folder
baseline without bulk retention, then process entries and changes after it.
People can explicitly select existing meetings.

Prefer verifying Granola's native folder-scoped webhook trigger before choosing
polling. The documented events cover first summary generation, summary edits,
and newly granted access, with folder filters including subfolders. They do not
yet prove an event for moving an already-accessible meeting into the watched
folder, every kind of content edit, or compatibility between webhook note IDs
and OAuth MCP reads. Verify those behaviors and the exact folder/subfolder scope.
The documented webhook workflow uses API keys; retaining personal OAuth access
requires proving that a notification can trigger a fresh authorized MCP read.
A webhook notification is not permission to retain or share content. Any gaps
need bounded reconciliation through the verified personal connection contract.

Phase 2 proof includes a new meeting in the selected folder, an existing meeting
entering that folder, and an edit to a meeting in it each triggering the pipeline
without Add to ECHO; no automatic intake outside that folder; no historical
bulk import when the watch starts; and durable resume after interruption.
Also prove two different people, one person on two clients, reconnect/retry
deduplication, account/workspace drift, source/folder/project revocation during
read and commit, private/project audience separation, transcript-off behavior,
provider plan restrictions (including unavailable folder tools), and
missing-source handling. Finish with a live
project question using an approved imported meeting plus live Jira and
Confluence, and a negative read by a person outside its audience.

## Shared implementation and delivery

Use the existing connector and meeting contracts. Add provider-specific MCP
transport and parsing behind them; do not copy Jira/Confluence OAuth machinery,
create a parallel approval service, or introduce another meeting store.
Replace founder-singleton assumptions only where personal intake requires it.
Every new persisted field must support a named phase 2 behavior and its test.

Keep phase 1 and phase 2 as separate reviewable changes. Complete local checks
for a phase before submitting its CI candidate. Phase 2 starts after phase 1
passes; neither phase is complete on the strength of a Connect button alone.
Live staging, provider consent, and release approval use the existing
[operator playbook](../operations/PB-OPERATIONS-001-authority-operator-lane.md).
Creating this worktree does not alter installed clients or staging.

Update the active Granola custody decision and connector documentation with
the new personal model. Preserve historical decision records as history,
with explicit supersession where applicable.

## Provider references

- [Granola MCP](https://docs.granola.ai/help-center/sharing/integrations/mcp):
  personal OAuth, accessible owned/shared meetings, active-workspace behavior,
  tool capabilities, and plan/admin limits.
- [Nango Granola MCP](https://nango.dev/docs/api-integrations/granola-mcp):
  dynamic client registration and supported MCP calls.
- [Granola webhooks](https://docs.granola.ai/webhooks): the documented webhook
  path supports folder filters and generation/edit/access events using REST
  API keys; it is not evidence of an OAuth MCP change feed or every folder-entry
  transition. Verify notification-to-MCP compatibility before selecting it.
- [ECHO connector contracts](../architecture/connector-contracts.md): existing
  connection, live-read, and meeting-export responsibilities.
