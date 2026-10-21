# Headless research experiment

Claude Agent SDK feasibility and integration trials in the research-loop position.
No production module imports this directory. The native-harness candidate adds an
operator-injected staging-evaluation port to the core and removes the writer's
fixed 100-row input cutoff; deployed engines and client feeds are unchanged. The original and limit-comparison
runners use invented fixtures and have no live endpoint argument. A separate
[local staging comparison](#local-staging-comparison) uses the existing Person
client's authenticated reads; it cannot select a server engine.

## Run

From the repository root, use the pinned Node/npm versions, then:

```sh
npm ci
npm run build:workspaces
npm ci --prefix tools/evals/headless-research
npm test --prefix tools/evals/headless-research
claude auth login
node tools/evals/headless-research/run.mjs sdk projects
node tools/evals/headless-research/run.mjs current projects
```

Cases: `projects`, `yesterday`, `open_items`, `sweep`. An optional fourth argument
selects the result JSON path. The default path is `results/<engine>-<case>.json`
inside this experiment directory. Results are written with mode 600. Use a new
path to preserve a previous run. `ECHO_TRIAL_CLAUDE_BINARY` can select an installed
Claude executable; otherwise the runner uses `which claude`.

The developer trial uses that CLI's existing sign-in internally. It does not
read/copy credentials, load project/user settings or plugins, or provide filesystem,
shell, web or other MCP tools to the agent. A deployed service would need its own
supported provider authentication; the developer sign-in is not the deployment
design. SDK version is locked; the installed CLI version and actual model must be
recorded with trial evidence. This trial used CLI 2.1.302, SDK 0.3.305 and
`claude-sonnet-5-5` (selected via `sonnet`).

## What is compared

- `sdk`: Claude owns the tool loop. Three MCP functions wrap the synthetic desk:
  search, list and open. The source catalog, person, scope and client timezone
  are provided separately. Research returns notes and E/L references, not prose
  for the user. The adapter constructs the existing `AgenticEvidenceBundleV1`.
- `current`: the actual compiled `createAgenticResearchLoopV1` owns its usual
  scratchpad, step protocol and stopping decisions. Its structured-generation
  port is backed by a fresh headless Claude query per decision.
- Both use the actual compiled Ask V8 renderer and model gate. The `sweep` case
  rereads starting evidence with `planner: false`, then uses the actual sweep
  renderer. It checks the no-planner path; it does not qualify every trigger.
- Both get identical synthetic desks and the existing 90-second request budget,
  including the 25-second writer reserve. SDK queries also have a 12-turn and $2
  estimated-cost cap. SDK turns include tool results and are not ECHO research
  rounds; compare recorded model messages, tools and elapsed time separately.

This is a smoke comparison, not a production latency/cost benchmark. The current
loop's trial transport starts a CLI for each decision, while the SDK keeps its
research in one session. Structured-output calls and prompt caches can differ.
Neither path uses the deployed OpenRouter transport. Fixtures also return much
faster than live Jira/Confluence. A single run does not establish a reliable win.

## Contracts exercised

The fixtures include project leads, meeting records, Jira metadata and bodies,
Confluence metadata and bodies, a client-local date crossing UTC midnight, and
105 Jira tickets across five pages. Six tickets are open, including one on the
last page. Jira intentionally has no status/owner filters, as in the failed
release check. No filter improvement is mixed into the engine comparison.

Focused tests cover source/scoping parity, unsupported filters, discovered-only
open IDs, metadata/body distinctions, complete pagination, unknown citations,
revocation during reads and finalization, cancellation, starting slots and
disabled planner/list options. The assertions on final prose are small smoke
checks, not a semantic judge; inspect the cited statements too. A partial answer
does not pass even when it includes all expected names.

## Boundaries before a live integration

The original research bridge is deliberately **synthetic-only**. The separate
public-client staging comparison below is not a drop-in production adapter:

1. ECHO checks access before every outbound model call. The SDK's documented
   tool/batch/compaction hooks do not by themselves prove equivalent coverage of
   initial calls, retries, repairs and compaction. This needs a verified outbound
   request fence or another reviewed enforcement mechanism. The prototype aborts
   on observed access loss, but that is not a substitute for the full fence.
2. Production evidence/audit receipts, invocation digests, token accounting and
   progress need integration with the shared request lifecycle. The experiment's
   fabricated digest is explicitly synthetic and must never become a live audit.
3. Real provider continuations, missing dates, linked records, changed snapshots,
   partial reads, all trigger starting-item policies and cancellation during SDK
   retries need full contract tests. The small fixture adapter is not a replacement
   for provider authorization or an assertion of complete visibility parity.
4. Dependencies/runtime packaging, service authentication and concurrency must be
   qualified before adding the SDK to an Authority image. The experimental package
   is outside the root workspace and is not shipped in any current client/server.

References: [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview),
[custom tools](https://code.claude.com/docs/en/agent-sdk/custom-tools),
[hooks](https://code.claude.com/docs/en/agent-sdk/hooks),
[structured output](https://code.claude.com/docs/en/agent-sdk/structured-outputs).

## Limit-removal comparison

`run-limit-suite.mjs` compares the original SDK prototype with an experimental
variant that omits the application's deadline, turn and estimated-cost caps,
removes the synthetic desk's page-size maximum and research-plan size bounds,
and uses a disposable copy of the actual Ask renderer with numeric size/count
bounds removed. It does not change production source, compiled workspaces, the
original trial results, provider capabilities or access/citation validity rules.

```sh
node tools/evals/headless-research/run-limit-suite.mjs tools/evals/headless-research/results/limits-round1
# Repeat selected cases, with separate output paths:
node tools/evals/headless-research/run-limit-suite.mjs tools/evals/headless-research/results/limits-repeat open_items roster briefing chain
# Replay the exact saved research bundle with only the writer unbounded:
node tools/evals/headless-research/limit-trial.mjs writer-only roster tools/evals/headless-research/results/roster-writer-only.json tools/evals/headless-research/results/limits-round1/bounded-roster.json
```

Seven cases cover two ordinary controls, late rows in a 105-ticket inventory,
all 60 project names/citations, 18 separately requested briefing entries, a
16-document linked chain, and an absent acquisition date. The linked-chain
fixture deliberately requires successor discovery; both arms see the same graph.
The roster/briefing/chain are stress cases, not a production workload sample.
Bounded and unbounded runs alternate order; each uses a new SDK session and the
same model alias. Results preserve the actual model, outputs, evidence, calls,
estimated cost, errors, and source hashes of the disposable renderer patches.

"Unbounded" means no experiment-imposed numerical ceiling. Model/provider context
and output limits, SDK defaults/repair behavior and account rate limits still
apply. The trial does not supply an output-token maximum to the SDK in either
arm; it cannot establish the effect of production's OpenRouter token allowance.
There is no automatic experiment timeout in that arm: the operator may cancel a
stalled run, which must then be reported as interrupted, never as a model failure.
Infinity in in-memory budgets serializes as null in saved JSON; the mode and
patch manifest record why. Synthetic sources have no production HTTP, transport,
Jira body-normalization or database-scan limits, so those cannot be evaluated here.

The unbounded writer retains the original citation/privacy checks, source-only
answer prompt, list counting/selection and layout. `unlimited-core.mjs` bundles
four patched source files into ignored `.cache/unlimited`; numerical schema
maxima are removed before the SDK call. Its normal output validators still check
types, citations and outcomes with only size/count bounds removed. These outputs
are experimental: they may exceed the current desktop/server response contract.
Focused tests prove the size caps are removed and that invented evidence and
revoked access still fail. No production path imports this experiment.

Automated scoring checks requested names/codes, completeness, briefing dates and
separate entries, and abstention on the negative control. It is not a semantic
judge; review the full rendered evidence and citation associations before drawing
conclusions. Latency and SDK cost estimates are descriptive, sensitive to caching,
and are not a production cost or latency benchmark.

The [comparison report](REPORT.md#limit-removal-comparison) and
[saved evidence](limit-trial-results.json) include two runs per arm/case and three
writer-only replays. A prototype adapter correction ensures that citing a
metadata row does not promote it to full-text writer evidence. Four affected
pre-fix executions remain recorded but excluded; the open-items comparisons
were rerun after that correction. Normalize a set of result directories with
`node tools/evals/headless-research/summarize-limits.mjs <directory> ...`.

## Local staging comparison

`staging-trial.mjs` runs Claude locally with four model-free Person read tools:
list projects, read project members, list ECHO records, and open a listed record.
The existing `PersonClient` handles its saved session internally. No ECHO token
is given to Claude, and no credential is printed or copied. The account must
already be signed in to `https://authority-staging.echobrain.org`; other origins
are refused. There is no deployed engine switch, provider configuration change,
meeting submission or feed update.

```sh
node tools/evals/headless-research/staging-trial.mjs \
  'What are my active ECHO projects, and who leads each one?' \
  "$HOME/.local/share/echo-sdk-staging-trials/projects-new.json"
```

Use a private output directory and a new filename. Results contain user-visible
record content and are written with mode 0600; do not commit them. Events printed
to the terminal contain only counts, timing, tool names and model names. The
saved response is a comparison answer with S-id references, not a production
desktop payload or an Authority research/audit receipt.

The server's public client does not expose the full internal research desk:
live Jira/Confluence search and list, and the follow-up research source, are
unavailable here. A good result on records/projects does not qualify those
sources. The prompts name these limitations and require a partial answer when
the question needs them. List/open tools follow all server cursors and preserve
source availability flags. Existing server limits still apply.

Before any model request leaves the local transport, `staging-reader.mjs`
authenticates again and repeats every previously released logical read, checking
its content hash. Revocation, an account change, a changed snapshot or an
unverifiable read stops the run. Final answers get the same recheck and may cite
only released ids. This conservative approach is deliberately expensive; it is
not a production revalidation design.

`model-fence.mjs` routes the SDK through a random loopback-only path to one fixed
HTTPS upstream (`api.anthropic.com`). It checks every Messages or token-counting
request, including repeats, before forwarding any body bytes. Other routes are
refused; headers and bodies are neither logged nor persisted by the transport.
Claude's existing sign-in remains inside its client/transport. The synthetic
network probe verifies normal SDK requests traverse the gate; a second probe
revokes access after a tool read and verifies the next request is not forwarded.
This is not evidence that a server deployment's retries, compaction, concurrency,
audit lifecycle or provider authentication have all been qualified.

The routing follows Anthropic's [gateway connection documentation](https://code.claude.com/docs/en/llm-gateway-connect)
and [gateway protocol](https://code.claude.com/docs/en/llm-gateway-protocol).
Only this local experiment uses the developer's existing client sign-in. A
deployed Agent SDK engine needs its own supported service authentication.

## Native research integration candidate

`engine-driver.mjs` implements the real `AgenticResearchDriverV1` port. It no
longer constructs an evidence bundle in the synthetic bridge. ECHO's existing
research code owns search/open/list, source capabilities, pagination, links,
short ids, receipts, completion validation and progress. The SDK owns the
investigation. Ask and trigger renderers consume the normal evidence bundle;
planner-disabled sweeps never start the SDK.

The staging evaluation composition accepts `research_eval_driver` from its
operator dependencies, never from a Person HTTP request. It remains gated by
the existing staging origin and evaluation opt-in. The commands below use the
developer's Claude sign-in only for local trials. The service adapter described
below instead uses the Authority's provider binding. Neither source integration
nor a passing local test is a staging deployment.

```sh
npm run build:workspaces
node tools/evals/headless-research/engine-trial.mjs projects
node tools/evals/headless-research/engine-trial.mjs yesterday
node tools/evals/headless-research/engine-trial.mjs open_items
node tools/evals/headless-research/engine-trial.mjs sweep
```

These commands use the live SDK/model with **synthetic sources**, through the
actual request lifecycle, writer and release audit. They do not contact staging
Jira/Confluence. Use a fresh third argument for repeat evidence files. Earlier
`run.mjs` and limit comparisons retain their historical synthetic bridge.

Every outbound SDK Messages or count-token request passes through the shared
request gate with the digest of its exact body and its actual model name.
Retries and compaction requests get independent admissions. The transport
identifies exact released initial/tool packets present in the outbound body;
only packets carried by an admitted inference mark items read. A token count
or a compaction request omitting a new tool packet cannot mark it read.
The same rule applies to search/list observations used to claim absence: tools
in the same model turn cannot justify a not-found finish before their results
reach a later inference.
The gate records call counts, invocation digests, per-request usage when supplied,
and finish metadata. The loopback proxy requests identity encoding to read SSE
usage metadata without retaining generated text; missing usage stays unknown.
Full revalidation and the normal audit still precede release.

There is no additional SDK turn/cost ceiling, old planner-round limit or old
numerical research-note limit. The shared request deadline/call budget and writer
reserve still apply (live 90 seconds/24 calls; background 300 seconds/48 calls,
with two calls reserved for writing). Existing source page/body bounds, completion
rules and final answer contracts remain. Lists may span arbitrarily many source
pages within that request budget. Writer rows now use the actual prompt budget
rather than a separate 100-row ceiling; genuinely omitted rows remain explicit.

The SDK adapter is invocation-local, uses only the four ECHO MCP tools, and
inherits the isolated client's no-builtins/no-plugins/no-persistent-session setup.
Provider retry responses pass through; access failures cancel the SDK and remain
terminal. Local tests cover native evidence admission, source/scope parity,
unknown ids, metadata-only reads, pagination, source filter refusal, negative
results, no-planner/search-only triggers, cancellation, concurrent gate admission,
revocation and the persisted audit format. Real provider retry/compaction loads,
host lifecycle/concurrency and supported server authentication still need staged
qualification; a mocked compaction request is not a live compaction stress test.

## Staging service adapter

`providers/openrouter/src/claude-research` packages SDK `0.3.305` in the Authority
dependency closure. `ECHO_STAGING_CLAUDE_RESEARCH_V1=true` selects that researcher
for ordinary Ask, evaluation and background research only at the fixed staging
Authority origin. The EC2 connector-rehearsal compose overlay selects it with the
existing profile. It does not enable the SDK on other Authorities. The shared
writer, trigger dispatch, no-planner sweeps and client response contracts stay
the same. No database baseline changes are required.

Each request starts the packaged SDK executable in a temporary empty home,
without inherited host credentials, plugins, built-in tools or persisted
sessions. Its only model endpoint is a random request-local loopback path.
The parent forwards admitted requests to OpenRouter's native Anthropic Messages
endpoint with the existing service credential; no provider credential enters
the child. Every request uses the configured Sonnet model. Global model slots
are acquired before the access check, including SDK retries. HTTP refusals reach
the SDK's retry policy and the shared background cooldown; authorization loss
and cancellation stop the request. Temporary files and child processes are
cleaned up after completion or failure.
Upstream network and interrupted-stream failures carry content-free transport
diagnostics and remain retryable through fresh admission; aborts stay terminal.
When provider or network retries end in a reported SDK error, ECHO retains its normal
research fallback and can write from already released evidence. Unknown process
errors and access failures remain terminal, and raw SDK error text is discarded.

The selected private trace sink receives admitted model input and visible
text/tool output. Ordinary audit and metrics receive digests, counts and usage,
not those payloads. Shared tool and completion corrections still use #348's
named counters. SDK-owned corrections are not reported as ECHO corrections.

After building the service, the packaged executable and MCP transport can be
checked without credentials, external network requests or user records:

```sh
npm run build --workspace @echo-brain/organization-authority
node tools/evals/headless-research/service-package-smoke.mjs
```

The same smoke script can be mounted read-only at its `/app/tools/evals/...`
path inside the built Authority image and run with `--network none`. It exercises
search, finish, structured completion and per-request evidence admission against
a local synthetic Messages responder. It proves packaging and protocol wiring,
not real model quality or OpenRouter provider compatibility. Those require the
live source canaries through the existing operator release lane. Long-context
compaction and concurrent live request load remain separate qualification work.
