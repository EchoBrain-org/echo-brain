# Project context V1 integration evidence

Status: synthetic checkpoint and local real-layer integration are implemented,
including default API composition with real Person sessions and native clients
calling the real CLI. This reconciliation candidate retains the latest committed
PC-05 native robustness and CLI assertions, PC-06's real CLI/HTTP proof, and
PC-04's service-owned transport proof. The integrated checkpoint `5f8501c` passed the full local check (206 files,
2,547 tests passed and one skipped) and all CI jobs. Final review added durable
project-mutation recovery and fair V1/V2 enrichment scheduling; PR #204 records
the final candidate SHA and complete verification results. Live capability
evidence remains unexecuted. This directory records PC-06
results and candidate-specific evidence requirements; the existing
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
| PC-03 | `6ccb8f7dcbfb3796ff078d92db3bbba6ca99fc34` | Current HTTP/default runtime/worker source, including error-contract correction `7377318cb16a72849c32fa7a90e6f58b24ffbc55` as `4668ae5` |
| PC-04 | `97d2c54cbbecdf73059c815501ec3cee8f8e6d5e` | Current CLI/transport proof; the service-owned transport test is `services/organization-authority/test/project-context-person-transport.test.ts` |
| PC-05 | `f9a3411d714f43c0842795af3b4f0aeaf4309c38` | Native robustness, duplicate-JSON rejection and CLI bridge assertions, including merged PC-04 dependency |
| PC-06 | `e83ba7e7a191ec5a2b682a51dc62ebb7cc61b3c0` | Real native CLI-to-loopback-HTTP proof, V2 packed-client qualification and committed evidence ledger |

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
| PC-04 transport `97d2c54` | `tests/person-client/project-context-cli.test.ts services/organization-authority/test/project-context-http.test.ts services/organization-authority/test/project-context-person-transport.test.ts` | Current owner-lane focused proof: 3 files / 198 passed |
| PC-05 native `7730e5b` | `services/organization-authority/test/project-context-integration tests/architecture/echo-projects.test.ts tests/architecture/echo-uploads.test.ts tests/architecture/echo-overlay-sources-fixture.test.ts tests/architecture/echo-overlay.test.ts` | 8 files / 102 passed |
| PC-04 test ownership `63159d0` | `services/organization-authority/test/project-context-integration services/organization-authority/test/project-context-person-transport.test.ts` | 5 files / 32 passed |
| PC-05 native hardening `fc84419` | `services/organization-authority/test/project-context-integration tests/architecture/echo-projects.test.ts tests/architecture/echo-uploads.test.ts` | 6 files / 68 passed |
| PC-03 error contract `7377318` | `services/organization-authority/test/project-context-integration services/organization-authority/test/project-context-http.test.ts services/organization-authority/test/organization-authority-api-runtime.test.ts tests/architecture/test-layer-ownership.test.ts` | 7 files / 120 passed |

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

The native subprocess case compiled `native-cli-proof.swift` (removed with the
Swift app on 2026-09-25; the Electron desktop app in `product/echo-desktop`
replaces it) with the real `ProjectSession`, `ProjectClient`, `ProjectCLI` and `UploadClient`.
Its executable runs this worktree's built CLI, including real account status,
request parsing and response decoding, against the loopback server. Alice and
Carol exercise overlapping/disjoint discovery, feed/search/roster/original
read, project audience different from destination, inaccessible-read clearing,
account-change clearing and unsupported-list handling. No canned CLI JSON is
returned. The native UI control/disabled-Ask assertions remain in PC-05's
compiled controller fixtures. These include both canned CLI responses and,
after `fc84419`, real CLI execution with controlled fixture HTTP responses.
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
as failure evidence, not a final-source qualification. A second full check at
unchanged `b15b3f57366354f24842ab3c7f82697ec54b4847` passed architecture,
documentation, lint, build and type checks, then reported 205 test files
passing and one failing: test-layer ownership rejected PC-04's then-stale
`tests/person-client/` location. PC-04's committed `63159d0` moved that
repository-backed test into Authority service tests. The current reconciliation
passed `npm run build`, 32 real integration/transport tests, 87 native tests,
18 test-layer ownership tests and the architecture-boundary check. The
aggregate check at `5f8501c` then passed all architecture, documentation, lint,
build and type checks, plus 206 test files / 2,547 tests with one skipped.
That result predates the two final review corrections below; PR #204 records
their final combined check at the exact committed candidate.

## Final review corrections

Pending native project mutations now retain bounded, account-scoped command
recovery metadata before submission. Normal shutdown does not discard the
request ID or exact command; a matching account can retry after reconstruction
with a fresh preferences instance. The record contains operation coordinates
and the bounded creation name when needed, never original-note text, session
credentials or an authoritative project cache. Missing and damaged records
are distinct: damaged recovery blocks a new mutation until explicit abandonment.
Storage acknowledgement failure prevents submission or clearing and restores
the previous record. Confirmed success and explicit abandonment are the only
clear paths. Focused recovery proofs cover exact create/member replay, account
isolation, damaged/oversized records, successful clearing and storage failures.
The persistence acknowledgement follows Foundation's documented disk-save
contract; this is not a hardware power-loss guarantee.

The existing upload worker alternates V1/V2 claims after each claimed item.
It retains one item per pass and the existing meeting-before-upload lifecycle.
A sustained V1 backlog or V1 source-integrity failure cannot indefinitely block
due V2 enrichment. The source-integrity failure still surfaces on its own turn.
The focused worker/adversarial suite passes 25 tests, including both progress
regressions. No new queue, scheduler or public contract was added.

## Rollout preparation

The [unexecuted worksheet](rollout/README.md) and
[evidence template](rollout/evidence-template.json) specify fresh-V7,
runtime-only reset/reseed, compatible recovery, matched-artifact and two-Person
evidence. They identify the existing unreleased-rehearsal scope and the missing
production reset mechanism explicitly. Every live evidence slot is `not_run`.
