# Project context V1 integration evidence

Status: synthetic checkpoint and local real-layer integration are implemented,
including default API composition with real Person sessions and native clients
calling the real CLI. Live capability evidence remains unexecuted. This directory records PC-06 results and
candidate-specific evidence requirements; the existing
[Authority operator playbook](../PB-OPERATIONS-001-authority-operator-lane.md)
remains the sole operator router.

Foundation: `ae0481e635367c561a19f5d42098475839dc8408` (PC-00/PC-01).
Worktree: `.worktrees/project-context-pc06-integration`.
Branch: `feat/project-context-pc06-integration`.

## Synthetic checkpoint

First committed checkpoint: `6d666b3` (all required synthetic scenarios).
The [harness](../../../services/organization-authority/test/project-context-integration/synthetic.test.ts)
has 18 passing cases. It uses real V7 persistence, frozen codecs and enrichment
eligibility with explicitly simulated authentication, delivery and model
completion. Its [fixture notes](../../../tests/fixtures/project-context-integration/README.md)
define the exact assurance limits. No host, provider or installed product was
used.

| Scenario | Bounded proof |
| --- | --- |
| Two projects; overlapping/disjoint members; join history | Member discovery, permitted feed/search, generic versus scoped reads |
| Private association, team originals, separate audience project | No audience widening, no lead bypass, immutable receipt coordinates |
| Cursor/identifier misuse | Project, requester, operation, query and limit scope rejection |
| Revocation during release | Project, organization and synthetic session changes release no response or audit |
| Exact response/audit failure | Committed digest matches released response; failed audit releases nothing |
| Optional hints | Original read and search before, during, after success and after failure |
| Enrichment revocation | Before/during handoff, remove/rejoin and revoked tenure discard hints; association-only removal does not cancel |
| Timeout, restart, replay | One original/work row after post-commit lost reply and SQLite reopen; changed request conflicts |
| Rejoined organization tenure | No inherited project grant |
| Unsupported clients and exclusions | Strict version/audience codec rejection, frozen list-only availability fixture, no extra tables or meeting/approval rows |

Focused command:

```sh
./node_modules/.bin/vitest run --config vitest.config.ts services/organization-authority/test/project-context-integration
```

## Committed integration gates

Only committed feature heads may be integrated. Rebuild in this worktree, run
the focused harness after each integration, and record the SHA, command and
result here. A foundation-only head is not an implementation checkpoint.

| Lane | Observed committed SHA | Qualification status |
| --- | --- | --- |
| PC-02 | `37b6e557f3898bb4af30159f8ce70a5d1fffb047` | Application/worker and adversarial tests imported through `95de82c` |
| PC-03 | `67a2c42e8686fcf4be163ec351a7b319c674c058` | HTTP adapter and real default runtime/worker wiring imported through `af03657` |
| PC-04 | `066db491ece28329c8e7f6584efe2527b73aca77` | CLI/transport and adversarial proofs imported through `1ae5713` |
| PC-05 | `fbfd85cc7f38b88eec1ebcc4a8572c86c169fe68` | Native feature `7730e5b48f4afb77cdb7e3093a2d1660218ee0b4` imported as `786829e`, earlier home `e44adf9` as `8ef8bcd`; equivalent CLI commit already integrated |

The final local gate combines real application/worker + HTTP composition + CLI
transport + native CLI-bound UI, then the complete repository check. The PR
records that final check's exact source SHA and result. Synthetic green alone
cannot satisfy it. Local integration is separate from exact deployed-artifact
qualification and the two-Person live worksheet below.

### PC-02 application checkpoint result

The [application integration](../../../services/organization-authority/test/project-context-integration/application.test.ts)
drives all sixteen real application operations through the real repository.
It covers two-project permissions, independent association/audience, current
reauthentication, malformed caller identity fields, replay and restart. Its
Person authenticator remains a fixture; no HTTP/CLI/UI claim follows.

```text
./node_modules/.bin/vitest run --config vitest.config.ts services/organization-authority/test/project-context-integration services/organization-authority/test/project-context-application-v1.test.ts
3 files passed; 23 tests passed.

npm run build:workspaces
FAILED: project-context-application-v1.ts:121 TS6133 unused parameter actor.
```

PC-02's `38c67644838a327375cbbe39fd225201d27e2681` adversarial checkpoint
also exposed malformed coordinate mapping (`not_found` versus expected
`invalid_request`): 54 tests passed, one failed. Both failures were corrected
by the owner's `8772671237ea72d46c5fc7d496919c7c8adf5d7c` worker/application
commit, imported as `18ab461`. No owner feature file was patched by PC-06.

### Committed checkpoint verification

Each row ran after importing only the named lane's committed changes, using
this worktree's own dependencies and workspace outputs. Tests use
`./node_modules/.bin/vitest run --config vitest.config.ts` and the following
path arguments. `npm run build:workspaces` passed before every successful row.

| Integration | Exact test path arguments | Result |
| --- | --- | --- |
| PC-02 through `37b6e55` | `services/organization-authority/test/project-context-integration services/organization-authority/test/project-context-application-v1.test.ts services/organization-authority/test/project-context-application-adversarial-v1.test.ts services/organization-authority/test/project-update-enrichment-worker-v2.test.ts services/organization-authority/test/project-update-enrichment-lifecycle-v2.test.ts` | 5 files / 62 passed; final path was an absent filter (the actual adversarial worker file is covered in the next row) |
| PC-03 HTTP `77e1b75` | `services/organization-authority/test/project-context-integration services/organization-authority/test/project-context-http.test.ts services/organization-authority/test/organization-authority-api-runtime.test.ts services/organization-authority/test/project-update-enrichment-adversarial-v2.test.ts` | 5 files / 87 passed |
| PC-04 CLI `67a4119` | `services/organization-authority/test/project-context-integration tests/person-client/project-context-cli.test.ts` | 3 files / 57 passed |
| PC-03 runtime `67a2c42` | `services/organization-authority/test/project-context-integration services/organization-authority/test/organization-authority-api-runtime.test.ts` | 5 files / 35 passed |
| PC-04 transport `066db49` | `services/organization-authority/test/project-context-integration tests/person-client/project-context-cli.test.ts tests/person-client/project-context-transport.test.ts` | 6 files / 160 passed |
| PC-05 native `7730e5b` | `services/organization-authority/test/project-context-integration tests/architecture/echo-projects.test.ts tests/architecture/echo-uploads.test.ts tests/architecture/echo-overlay-sources-fixture.test.ts tests/architecture/echo-overlay.test.ts` | 8 files / 102 passed |

The new [CLI/HTTP integration](../../../services/organization-authority/test/project-context-integration/cli-http.test.ts)
uses real CLI parsing/session storage/transport/decoding, a loopback HTTP server,
the real application/repository and real V2 worker. Only the transport origin
is remapped; HTTP response bodies are not fabricated. Person authentication
and model output are controlled fixtures. The six transport/worker cases cover visibility,
cursor/identifier misuse, no project Ask dispatch, unsupported routes, lost
HTTP delivery followed by restart/replay, and original access during worker
success/failure/revocation. This seam alone does not prove default runtime
wiring or the native UI and is not live capability evidence.

The [default-runtime test](../../../services/organization-authority/test/project-context-integration/runtime.test.ts)
uses real Person sessions (synthetic OIDC provider) and deliberately supplies no
project application override. It first reproduced projects-create 404, then
passed after importing PC-03 `67a2c42`: create, project-audience submit, API
restart, original read, receipt reconciliation and revoked-session denial.
OIDC is synthetic; current session resolution, authorization and application
selection are real. This gate remains enabled; an injected application cannot
substitute for its result.

The native subprocess case compiles
[`native-cli-proof.swift`](../../../tests/fixtures/project-context-integration/native-cli-proof.swift)
with the real `ProjectSession`, `ProjectClient`, `ProjectCLI` and `UploadClient`.
Its executable runs this worktree's built CLI, including real account status,
request parsing and response decoding, against the loopback server. Alice and
Carol exercise overlapping/disjoint discovery, feed/search/roster/original
read, project audience different from destination, inaccessible-read clearing,
account-change clearing and unsupported-list handling. No canned CLI JSON is
returned. The native UI control/disabled-Ask assertions remain in PC-05's
compiled controller fixtures, which intentionally use canned CLI responses.
Together these prove bounded local cross-layer behavior, not a GUI-to-live-host
rehearsal or real provider/model execution.

After adding that case, `cli-http.test.ts` passed all 7 tests on macOS.

The initial full `npm run check` completed with 202 files passing and one
failing (2,411 passed, one failed, one skipped). Its packed-client runtime
failure was the missing V2 route before PC-03 default composition landed.
Inspection also found two stale V1 receipt/status expectations in that shared
test. The user explicitly assigned this bounded update to PC-06; only those
two kind expectations were changed to V2. The exact packed-client test then
passed using:

```sh
./node_modules/.bin/vitest run --config vitest.config.ts services/organization-authority/test/organization-authority-private-approval-runtime.test.ts -t 'runs submit/status from the exact packed Person CLI'
```

Result: one passed, 21 unrelated tests skipped by the focused name filter.
The initial full run overlapped subsequent integrations and is retained only
as failure evidence, not a final-source qualification. Final full-check results
belong to the unchanged committed PR head.

## Rollout preparation

The [unexecuted worksheet](rollout/README.md) and
[evidence template](rollout/evidence-template.json) specify fresh-V7,
runtime-only reset/reseed, compatible recovery, matched-artifact and two-Person
evidence. They identify the existing unreleased-rehearsal scope and the missing
production reset mechanism explicitly. Every live evidence slot is `not_run`.
