# Project context: sprint tasks and file ownership

Status: PC-00 contracts implemented and verified locally on
`feat/project-context-pc00`, 2026-09-21. PC-01 through PC-07 remain planned;
project persistence, routes and client operations are not live. The installed
desktop UI remains build `9f28656`, with unsupported features labeled
“Not live yet.”

PC-00 validation: `npm run check` passed all architecture/documentation/lint/
build/type checks and 187 test files (2,198 tests passed, one skipped).
Independent review covered public schemas, replay identity, authorization
ports and fixtures. The full suite ran with localhost permission for its
existing login/HTTP fixtures after the sandboxed run was stopped. This is
offline implementation evidence, not project authorization or live-release
qualification; those require the later stateful and integration tasks.

Related scope: [CLI wiring and contract gaps](2026-09-21-projects-cli-wiring-and-contract-gaps.md)
and the frozen [PC-00 project context V1 contract](2026-09-21-project-context-v1-contract.md).

## Current Write path

Write is connected to the existing upload path:

1. `product/echo-overlay/projects.swift`: `ProjectWriteSheet.saveNote()` calls
   `UploadSession.submit()` with the original body and explicit audience.
2. `product/echo-overlay/uploads.swift`: a private immutable file snapshot and
   request ID are passed to `person updates submit` through the installed CLI.
3. `src/product/person-client/{commands,client,authority-client}.ts`: validate
   input, use the existing Person session, and POST `/v1/person/updates`.
4. `services/organization-authority/src/application/person-updates.ts` and
   `src/adapters/persistence/sqlite/person-update-inbox-v1.ts`: authenticate and
   commit the immutable original plus a pending enrichment-work row in one
   transaction. The HTTP route returns 202 with the stored receipt afterward.
5. `services/organization-authority/src/composition/person-update-processing-v1.ts`:
   a worker claims pending/due work and generates optional search hints. The
   Authority processing coordinator calls this worker during its cycle.

The server receives the text in the upload request. It does not later fetch
the file from the Mac. Read/search already work from the saved original while
metadata is pending or unavailable. There is no Slack approval, decision
extraction, signed-record append, or Ask admission for these uploads.

The inbox and work queue are durable SQLite tables in the Authority, not a
separate object-store inbox or an external queue. The work remains optional
enrichment of a saved original. Project support should extend this custody
path rather than create another upload service.

Evidence here is the source trace and existing automated coverage (including
the installed UI's native fixtures). A new live upload/worker observation was
not performed for this planning task.

## Confirmed intake and worker scope

The founder selected shared intake/worker infrastructure with immediate
original-note read/search access. Uploads do not need decision/action
extraction or approval before their originals become usable.

The existing runtime already shares one serialized Authority worker lifecycle:
`OrganizationAuthorityProcessingCoordinator` runs the admitted meeting cycle
and then `PersonUpdateProcessingV1.runOnce()`. The current ingress/custody
contracts remain source-specific: meetings use a source adapter/cursor and
admitted meeting state; Person Write uses authenticated HTTP and the immutable
upload/work tables. Meeting processing and upload enrichment have different
publication rules. Sharing the worker does not make these rules identical.

Reuse that lifecycle and the existing durable upload path for project context.
No prerequisite exists to wrap uploads as `MeetingDocument`, invent meeting
participants/cursors, or route original notes through approval. A common
internal intake helper is justified only where it removes actual duplication;
PC-00 must name that boundary and its file owner before it expands this scope.
Project metadata and authorization must survive ingress through read/release
and optional enrichment without changing original bytes or immediate access.

## Delivery boundary

First delivery: create/list projects, manage members/leads, associate and save
text context, explicitly share with project members, and browse/search/read
permitted project context. Retain private/team behavior, exact retries,
receipts, original-byte custody and approval/record semantics for new data.

Ask over project context is a separate follow-up. Project-scoped Ask remains
labeled unavailable in the first delivery; it must not fall back to a global
query while appearing scoped. Unread counts, binary attachments, withdrawal,
automatic Slack/meeting-to-project routing and project-only approved-record
policies are outside the first delivery.

## Disposable staging and production data

The founder confirmed that all existing staging and production data is
disposable for this sprint. This supersedes this plan's earlier requirement
for a state-preserving V6 transition.

PC-01 targets a fresh, versioned schema and fresh initialization. Remove
old-data migration, backfill and historical receipt/record preservation work.
Do not add legacy schema support or dual API versions solely to carry that
disposable state forward. Existing private/team product behavior still needs
coverage in the new schema, and unsupported clients must fail explicitly.

PC-06 plans an explicit reset/reseed for each environment with coordinated
server and client artifacts. Runtime initialization still verifies the exact
schema; normal application startup is not an implicit data-reset operation.
The operator handoff identifies the exact datastore reset, fresh organization/
membership setup, any required human sign-in, and the resulting verification
evidence. Source/release artifacts and provider configuration are separate
from runtime datastore contents and remain governed by the operator playbook.

This is the selected rollout assumption, not a report that any environment has
already been reset. No staging or production mutation is part of writing this
task plan.

## Task map

PC-00 is implemented in the isolated worktree and has passed its checks; it
has not been merged or deployed. PC-01 through PC-07 remain planned. Paths
marked “new” in those later tasks are proposed file locations. PC-00's public
API and CLI contracts are fixed by its checked-in codecs and fixtures.

| ID | Subtask | Primary owned locations | Depends on |
| --- | --- | --- | --- |
| PC-00 | Shared contract and policy decisions | API codecs, Authority application/repository port definitions, CLI fixtures and this scope | None |
| PC-01 | Fresh database schema and persistence | Authority kernel SQLite baseline/initialization; Authority service SQLite repositories | PC-00 |
| PC-02 | Server project authorization and application operations | Authority service `application/`, project authorization tests, upload enrichment eligibility | PC-00; PC-01 to integrate |
| PC-03 | HTTP routes and runtime composition | Authority service `presentation/` and runtime composition entrypoints | PC-00/01 for implementation; PC-02 for real wiring |
| PC-04 | Person CLI and transport | `src/product/person-client/`, `tests/person-client/` | PC-00; PC-03 for end-to-end proof |
| PC-05 | Native project UI | `product/echo-overlay/`, native fixtures | PC-00 CLI contract/fixtures; PC-04 for integration |
| PC-06 | Integrated proof and reset/reseed rollout | New cross-layer fixtures, matched artifacts and operator handoff | Harness can start after PC-00/01; final proof waits for PC-02 through PC-05 |
| PC-07 | Project Ask and original evidence | Retrieval/answer contracts and routes; client citation readers | Separate follow-up after PC-06 |

After PC-00, persistence, server application, CLI and UI work can proceed
against agreed interfaces and fixtures. Completion depends on integration,
not just a task's isolated tests. These are ownership boundaries, not
permission to merge mutually incompatible partial contracts.

### Parallel wave after PC-00 and PC-01 land

PC-00 must land executable codecs, application/repository interfaces and exact
CLI output fixtures, not just prose. PC-01 must supply repository implementations
conforming to those interfaces. With that foundation:

| Lane | Independent implementation boundary | Integration gate |
| --- | --- | --- |
| PC-02 auth/application | Real PC-01 repositories and frozen application port | Authorization and application proofs pass |
| PC-03 HTTP/runtime | Fake implementation of the PC-00 application port | Bind the real PC-02 application before enabling routes |
| PC-04 CLI | Contract HTTP fixtures, including unsupported operations | Run against PC-03 routes |
| PC-05 UI | Exact command/output fixtures agreed in PC-00 | Run against the real PC-04 CLI |
| PC-06 harness preparation | New synthetic scenarios and fixtures | Final integration waits for all four lanes |

This permits concurrent implementation and isolated review. Runtime enablement
still waits for the integrated proof and compatible artifacts. A client may
land earlier only while unavailable operations remain clearly labeled and
disabled. PC-07 is a later evidence/retrieval change, not another unrestricted
lane editing the CLI/UI alongside PC-04/05.

PC-00 alone owns shared codec/port/fixture edits; PC-01 owns SQLite adapters;
PC-02 owns application policy; PC-03 owns runtime composition; PC-04 owns the
TypeScript client; PC-05 owns Swift; PC-06 owns new cross-layer harnesses. A
contract change discovered by one lane returns to PC-00 for coordinated
revision rather than diverging interfaces or duplicate implementations.

## PC-00: shared contract and policy decisions

Own:

- `packages/organization-api/src/project-context-v1.ts` and
  `person-updates-v2.ts`, with public exports in `src/index.ts` and ownership
  in the workspace source-boundary registry. The existing upload V1 decoder
  remains unchanged.
- `packages/organization-api/test/project-context-v1.test.ts`, alongside the
  retained V1 codec coverage.
- `services/organization-authority/src/application/ports/project-context-v1.ts`
  for application/repository/authorization and enrichment interfaces.
- `services/organization-authority/src/application/project-context-command-v1.ts`
  and its focused test for the common immutable replay commitment.
- Exact command names, arguments, success/error JSON examples and shared
  fixtures under a new `tests/fixtures/project-context-v1/` directory, consumed
  by CLI and native tests. These are agreed contract artifacts, not a CLI stub
  that claims a live operation succeeded.
- `tests/architecture/project-context-contracts.test.ts` for fixture/codec and
  literal command/HTTP correspondence.

Deliver a contract for project identity, memberships/leads, association,
project audience, bounded feed/search, errors and idempotent writes. Separate
the selected project from the content audience. Land the application and
repository interfaces with this task so HTTP/application/persistence work can
compile independently. Define the unsupported-operation contract so old-server
handling is identical in CLI and UI. Preserve the confirmed immediate-original
access and shared-worker scope above.

The [PC-00 contract](2026-09-21-project-context-v1-contract.md) now fixes
member-only discovery, any-active-member creation with an initial lead,
history-on-join, exact-tenure grants, multiple leads/last-lead conflict,
one association per original, add/remove authority, uploader loss of
project-audience reads on removal, and current enrichment eligibility. PC-01
through PC-05 must consume those decisions rather than silently selecting a
different default in SQL, HTTP, CLI, or UI.

Done when malformed/unknown fields and invalid audience combinations fail
closed, private/team behavior is proved, and all downstream tasks have
the same request/response examples. Clients must never turn an unsupported
project audience into organization-wide sharing.

## PC-01: fresh database schema and persistence

Own:

- New versioned SQL under
  `packages/organization-authority-kernel/baselines/`, with an exact baseline
  identity for the new runtime; historical release artifacts stay immutable.
- `packages/organization-authority-kernel/src/adapters/persistence/sqlite/baseline.ts`
  and the corresponding database-open/schema-validation modules.
- New project SQLite repositories under
  `services/organization-authority/src/adapters/persistence/sqlite/` and
  `person-update-inbox-v1.ts` project-query changes.
- `services/organization-authority/test/current-storage-schema.test.ts`,
  `person-update-inbox.test.ts`, and fresh-initialization/repository tests.

Deliver durable projects, memberships bound to organization membership tenures,
roles, context associations, audience bindings and authorization revisions.
Implement bounded permitted reads/search/feed through the agreed repository
ports. Preserve transactionality and request replay, including project and
audience coordinates in the new request identity where applicable.

Done when fresh initialization produces the exact expected schema; invalid
cross-organization relationships fail; restart and replay preserve new writes;
private/team/project audiences are enforced; and ordinary startup rejects an
incompatible database. No old-data migration/backfill or offline transition
tool is required. New original uploads remain immutable; association does not
silently change their audience.

## PC-02: server authorization and application operations

Own:

- New project application and project-authorization modules under
  `services/organization-authority/src/application/`.
- Implement the application/repository/auth snapshot ports landed in PC-00;
  interface revisions return to that shared-contract owner.
- `services/organization-authority/src/application/person-updates.ts`.
- `services/organization-authority/src/composition/person-update-processing-v1.ts`
  for the agreed project eligibility checks around enrichment.
- New project-authorization/application tests and
  `services/organization-authority/test/person-update-processing.test.ts`.

Compose current Person authentication with current project membership,
source audience and operation-specific authority. Implement project/member/lead
operations and validate association requests. Keep organization-owner People
administration distinct from project leadership.

Carry a project authorization revision through admission and release/audit.
Use a separate project snapshot where possible: login/session token formats
need not change simply because project membership changes. If a shared Person
authorization type must change, propose that contract explicitly in PC-00.

Done when a valid organization session is insufficient to read another
project's private material, removal invalidates a pending release, rejoining
uses the agreed tenure rules, and a private note stays private after association.
Use dedicated new application tests so PC-01 remains the single owner of the
existing mixed inbox test file during implementation.

## PC-03: HTTP routes and runtime composition

Own:

- `services/organization-authority/src/presentation/organization-authority-http-server.ts`
  and route adapters consuming the PC-00 application interface.
- `services/organization-authority/src/composition/organization-authority-api-runtime.ts`.
- `services/organization-authority/src/composition/organization-authority-runtime.ts`
  only where the new repositories/eligibility policy need wiring.
- `services/organization-authority/test/organization-authority-api-runtime.test.ts`
  and focused project route tests.

Bind validated HTTP input to PC-02 applications and PC-01 persistence. Preserve
body limits, consistent denial behavior and unsupported-version handling.
Route project feeds through bounded listing, not an empty search query.
Implementation and route tests may use a fake of the PC-00 application port
while PC-02 is in progress. Real composition and runtime enablement wait for
the completed authorization/application implementation.

Done when endpoint tests exercise the actual applications/repositories,
authorization is never supplied by caller fields, supported client versions
work and unsupported ones fail explicitly, and no project operation enters
the meeting approval workflow.
The worker already consumes upload work; add no second queue or scheduler.

## PC-04: Person CLI and transport

Own:

- `src/product/person-client/commands.ts`.
- `src/product/person-client/client.ts` and `authority-client.ts`.
- `src/product/person-client/source-boundary.v1.json` if new imports require it.
- `tests/person-client/person-client.test.ts`, `person-client-help.test.ts`,
  and focused new project command fixtures.

Expose the agreed project/member commands and explicit context scope through
the existing session-aware client. Decode project/audience responses strictly.
Extend exact retry and status reconciliation without substituting a new
request ID or dropping the selected project. No new local content database.

Done when CLI arguments map to the agreed wire contract, invalid combinations
fail before network calls, incompatible servers produce an explicit unavailable
result, and private/team commands work. Help text must distinguish
project association from project sharing.

## PC-05: native UI

Own:

- `product/echo-overlay/projects.swift`, `uploads.swift`, and `main.swift`.
- `product/echo-overlay/source-assembly.v1.json` if a project client is extracted
  into a new Swift file, plus affected builder/source-fixture input lists.
- `tests/architecture/echo-uploads.test.ts`, native overlay architecture tests,
  and their Swift fixtures in `tests/fixtures/`.

Replace disconnected project design/store code with the real project CLI
client. Wire project list/create, project people/lead operations, project
destination and audience choices, permitted feed/search and original reading.
Bind selected project and membership to pending work; clear scoped content
when account/project access changes. Preserve uncertain-save recovery.

Done when UI tests exercise the CLI boundary, unsupported server operations
retain visible “Not live yet” labels, organization People is not shown as the
project roster, and project Ask cannot silently call global Ask. Enable each
control only when its contract is available. Label remaining unsupported
attachments, unread indicators and Undo accurately.

## PC-06: integrated proof and reset/reseed rollout

Own new cross-layer fixtures and release evidence, leaving the other tasks'
feature files with their named owners. Changes to shared setup fixtures need
one designated owner before simultaneous implementation.

Prove two projects with overlapping and disjoint memberships, a private note
associated with a project, team context, removal during a request,
cross-project identifier misuse, replay after timeout, restart recovery, and
explicit unsupported-client behavior. Capture the write receipt and original
read/search before optional hints finish, then after hints succeed or fail.

Run focused proofs and `npm run check`. Prepare fresh-schema initialization
and reset/reseed evidence, matching server/client artifacts, recovery steps
and an operator handoff for both staging and production. Existing runtime
data may be discarded as authorized above. Actual server rollout follows the
existing Authority operator playbook and its applicable gates. A local app install or fixture result is
not proof that the live server supports projects. A live rehearsal, when
authorized, must use clearly identified test content and record bounded
receipt/status evidence rather than private bodies.

## PC-07: separate Ask follow-up

Own the selected changes in:

- `services/organization-authority/src/composition/person-record-search-route.ts`
  and `person-answer-route.ts`.
- `packages/organization-retrieval/src/application/` where project filtering,
  related-atom expansion and result limits must respect the scope.
- `packages/organization-authority-kernel/src/answer-composition/retrieval-grounded-answer-composition.ts`
  and versioned evidence/citation contracts when original uploads are admitted.
- Corresponding API/CLI/Swift answer/source decoders in a later coordinated
  change; this task must not concurrently edit PC-00/04/05-owned files.

First distinguish project filtering of existing approved records from Ask
over originals. The latter must not fabricate a `record_sha256` or approval
policy for an upload. Bind project scope/revision through retrieval, model
handoff and response revalidation, including counts and citations. Define and
test the distinct source viewer for original notes.

Done when only permitted evidence from the selected scope reaches the model
and caller, citations open under current permissions, and source provenance
clearly distinguishes original notes from approved decisions.
