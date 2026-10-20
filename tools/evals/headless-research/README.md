# Headless research experiment

An isolated feasibility trial of Claude Agent SDK in the research-loop position.
No production module imports this directory. Authority, staging, triggers, client
feeds and output renderers are unchanged. The original and limit-comparison
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
