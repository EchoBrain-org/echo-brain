# Project context V1 integration evidence

Status: synthetic checkpoint plus real application/worker/HTTP/CLI integration
with fixture Person authentication and model output. Full runtime/native UI qualification and live
capability evidence are pending. This directory records PC-06 results and
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
| PC-03 | `77e1b75f4fe96c35f83d0334de3fe04458bdd789` | HTTP adapter imported as `8e8e406`; default runtime composition pending |
| PC-04 | `67a4119b8a12b65ca6bd0931175bc90c143b9e08` | CLI/transport imported as `a379dfb`; real loopback requests covered |
| PC-05 | `e44adf9e599a17732efdf92578027cbccba5d35d` | Prior home snapshot only; CLI-bound project UI pending |

The final gate requires real application/worker + HTTP composition + CLI
transport + native CLI-bound UI, then the complete repository check. Synthetic
green alone cannot satisfy it.

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

The new [CLI/HTTP integration](../../../services/organization-authority/test/project-context-integration/cli-http.test.ts)
uses real CLI parsing/session storage/transport/decoding, a loopback HTTP server,
the real application/repository and real V2 worker. Only the transport origin
is remapped; HTTP response bodies are not fabricated. Person authentication
and model output are controlled fixtures. The six cases cover visibility,
cursor/identifier misuse, no project Ask dispatch, unsupported routes, lost
HTTP delivery followed by restart/replay, and original access during worker
success/failure/revocation. This does not yet prove default runtime wiring or
the native UI and is not live capability evidence.

The [default-runtime test](../../../services/organization-authority/test/project-context-integration/runtime.test.ts)
uses real Person sessions (synthetic OIDC provider) and deliberately supplies no
project application override. Before PC-03 default composition is committed,
it reproduces a projects-create 404. This gate remains enabled; an injected
application cannot substitute for its result.

The initial full `npm run check` reached the test suite and reproduced a second
integration gap in the existing packed-client runtime test: its two expected
receipt/status kinds still name V1, whereas PC-04 sends V2. The PC-06 brief
requires a named owner for shared fixture edits; assignment was requested.
Neither this fixture nor a feature owner's code is silently patched here.

## Rollout preparation

The [unexecuted worksheet](rollout/README.md) and
[evidence template](rollout/evidence-template.json) specify fresh-V7,
runtime-only reset/reseed, compatible recovery, matched-artifact and two-Person
evidence. They identify the existing unreleased-rehearsal scope and the missing
production reset mechanism explicitly. Every live evidence slot is `not_run`.
