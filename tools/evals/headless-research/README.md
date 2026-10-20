# Headless research experiment

An isolated feasibility trial of Claude Agent SDK in the research-loop position.
No production module imports this directory. Authority, staging, triggers, client
feeds and output renderers are unchanged. All records are invented synthetic
fixtures; this runner has no live endpoint argument.

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

The prototype is deliberately **synthetic-only**. It is not yet a drop-in
production adapter:

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
