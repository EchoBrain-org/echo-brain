# Project context parallel implementation handoff

The founder approved PC-00/PC-01 in PR #199 and requested an adversarial review
before preparing the next worktrees. This document is the common launch brief
for the parallel lanes. Preparation does not start those implementations or
enable project functionality. Project routes, CLI/UI operations, V2 worker
activation and project Ask remain **not live yet**.

Read the [frozen V1 contract](2026-09-21-project-context-v1-contract.md),
[PC-01 persistence handoff](2026-09-21-project-context-pc01-persistence.md),
[sprint scope](2026-09-21-project-context-sprint-v1.md), repository `AGENTS.md`,
and the applicable [invariants](../invariants/README.md) and
[known failures](../failure-patterns/README.md) before implementation.

## Worktrees and branches

Paths are relative to the repository's primary checkout. All five lanes start
from the final merged PR #199 foundation. PC-05 additionally carries the
previously committed native home implementation from `9f28656`; its updated
project contract documentation takes precedence over that older UI snapshot.
The local preparation record under `.worktrees/project-context-parallel/`
records the exact base and resulting heads after creation.

| Lane | Worktree | Branch | Can begin with |
| --- | --- | --- | --- |
| PC-02 | `.worktrees/project-context-pc02-auth` | `feat/project-context-pc02-auth` | Real PC-01 repository and fake/current Person authentication in tests |
| PC-03 | `.worktrees/project-context-pc03-http` | `feat/project-context-pc03-http` | A fake of the frozen project application port |
| PC-04 | `.worktrees/project-context-pc04-cli` | `feat/project-context-pc04-cli` | Frozen HTTP and command fixtures |
| PC-05 | `.worktrees/project-context-pc05-ui` | `feat/project-context-pc05-ui` | Existing Projects home plus frozen CLI fixtures |
| PC-06 | `.worktrees/project-context-pc06-integration` | `feat/project-context-pc06-integration` | New synthetic cross-layer harness and rollout planning |

Dependencies are installed separately in each worktree. Build output and tests
belong to that worktree. Do not use another lane's `dist/`, `node_modules/`,
working tree, or uncommitted files as an integration dependency. Exchange
committed changes and record their SHAs when integrating.

## PC-02: application authorization and existing upload worker

Own new project application modules and focused tests, plus:

- `services/organization-authority/src/application/person-updates.ts` if needed
  for the selected V1/V2 application boundary.
- `services/organization-authority/src/composition/person-update-processing-v1.ts`
  and its worker tests. This file belongs exclusively to PC-02 even though it
  is in `composition/`.
- New worker-port declarations under `application/ports/` and a new V2 work
  adapter under `adapters/persistence/sqlite/` when needed to consume the
  already-created `authority_person_update_work_v2` rows. The existing
  project repository and V7 schema remain foundation-owned.

Implement the complete `ProjectContextApplicationV1` interface against the
real repository. Authenticate the Person; validate unknown input; create the
operation scope inside the transaction; reauthenticate immediately before
read release; return the exact audited response only after commit. Preserve
generic inaccessible/missing behavior, exact-tenure ownership and replay.

PC-01 supplies V2 work storage and enrichment eligibility, but does not yet
implement V2 claim/retry/completion in the runtime worker. PC-02 owns that
bridge. Reuse the existing serialized upload worker and its optional hints
behavior. Validate original integrity, capture current eligibility before
model handoff, and make final eligibility checking plus hint persistence
atomic. Stop enrichment on revocation without hiding an otherwise permitted
original. No new queue, scheduler, meeting-document conversion, extraction or
approval path.

Share the application factory/constructor and worker-adapter signatures with
PC-03 as an early committed integration checkpoint. PC-03 must not invent a
second implementation. Finish with real repository/application and worker
tests, then `npm run check`.

## PC-03: HTTP and runtime wiring

Own `presentation/organization-authority-http-server.ts`,
`composition/organization-authority-api-runtime.ts`,
`composition/organization-authority-runtime.ts`, focused route tests and the
existing API-runtime test file in the Authority service. PC-02 owns
`composition/person-update-processing-v1.ts`; coordinate through its exported
binding rather than editing it concurrently.

Implement transport against the frozen application interface using a fake
while PC-02 is in flight. Preserve strict request/response bounds, current
server-derived identity, error shapes and capability detection. An unsupported
projects-list probe may report not-live; a single project lookup cannot treat
every 404 as evidence that the capability is absent.

Integrate PC-02's committed application/worker binding before enabling actual
routes. Prove HTTP through the real repository, final session checks and
worker composition. Preserve the shared meeting/upload lifecycle. Finish
with route/runtime proofs and `npm run check`.

## PC-04: Person CLI and transport

Own `src/product/person-client/` command, client, Authority transport and help
changes, its source-boundary registry if necessary, and `tests/person-client/`.
Use the frozen API codecs and fixtures under `tests/fixtures/project-context-v1/`.

Implement all agreed project/member/association/feed/search/read operations
and explicit V2 upload coordinates. Keep association distinct from audience.
Preserve request IDs and immutable drafts through unknown outcomes; never
fallback from project sharing to team sharing. Strictly decode responses and
surface unsupported operations consistently. No local content database.

Publish a committed CLI fixture/behavior checkpoint for PC-05. Implement
against mock HTTP first; real end-to-end proof waits for PC-03. Finish with
focused CLI/help tests and `npm run check`.

## PC-05: native Projects UI

Own `product/echo-overlay/{projects,uploads,main}.swift`, its source-assembly
manifest, related native architecture tests and Swift fixtures. This worktree
includes the prior CLI-backed home; do not reconstruct it from the dirty root
checkout or remove its existing working Ask/upload/account behavior.

Wire project discovery/creation, project roster and lead management, scoped
feed/search/original reads, and independent destination/audience choices to
the frozen CLI contract. Keep organization People separate from project
membership. Clear scoped content and draft authorization when account/access
changes; preserve uncertain-save recovery with its original request ID.

Use CLI fixtures until PC-04's committed client is available. Unsupported
controls retain visible not-live labels and stay disabled. Project Ask cannot
silently invoke global Ask. Unread counts, attachments and Undo remain outside
this delivery. Finish with native fixture proofs and `npm run check`; an
installation is a later matched-artifact step.

## PC-06: integration harness and rollout preparation

Own new project-context integration tests/fixtures and project release
evidence. Add files under a dedicated project-context harness path; do not
edit PC-02 through PC-05 feature files or their existing shared setup fixtures.
Request a named owner before a shared fixture must change.

Start the scenario harness now: two projects with overlapping/disjoint members,
private associated notes, team notes, different audience and association
projects, removal during release/enrichment, timeouts and replay, restart,
unsupported clients, and original access before hints succeed or fail.
Integrate the other lanes' committed heads to complete actual cross-layer
proof. The harness cannot claim end-to-end completion from fakes alone.

Prepare explicit fresh-V7 reset/reseed and recovery evidence for matched
server/client artifacts. This lane's preparation does not authorize a
deployment or destructive host operation; runtime actions follow the existing
[Authority operator playbook](../operations/PB-OPERATIONS-001-authority-operator-lane.md).
Existing runtime data is disposable under the founder's sprint decision;
provider configuration, credentials and release artifacts are separate.

## Shared ownership and integration order

PC-00 codecs, shared command fixtures, application/repository ports and PC-01
schema/repositories are frozen foundation files. A required contract or
persistence correction goes through a small coordinated foundation change,
then every affected lane advances to that same commit. Do not fork a schema
or silently relax a validator in one lane.

PC-02 and PC-03 may implement concurrently, but real PC-03 composition waits
for PC-02. PC-04 waits for PC-03 only for server integration. PC-05 waits for
PC-04 only for client integration. PC-06 harness work can start immediately;
final qualification waits for all four lanes. PC-07 project Ask is a separate
follow-up and has no worktree in this parallel wave.

Run focused proofs and `npm run check` in each lane before its PR. Do not merge
another lane's uncommitted work, enable unsupported UI early, or deploy the
foundation as proof of project feature availability.
