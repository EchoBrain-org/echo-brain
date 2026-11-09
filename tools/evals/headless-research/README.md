# Claude SDK research integration

This directory retains the offline package check and a concise
[experiment summary](REPORT.md). The exploratory runners, fixtures, their tests,
raw aggregate results and separate dependency lockfile are archived at commit
`070b6adeb4c1cceccc7b8d309a2f9c4ad17e6601`:

- [Browse the archived experiments](https://github.com/EchoBrain-org/echo-brain/tree/070b6adeb4c1cceccc7b8d309a2f9c4ad17e6601/tools/evals/headless-research).
- [Download the matching source snapshot](https://github.com/EchoBrain-org/echo-brain/archive/070b6adeb4c1cceccc7b8d309a2f9c4ad17e6601.zip).
- The branch `archive/headless-research-experiments-070b6ad` retains that snapshot.

Use the archived README and matching source to reproduce the historical trials.
The archive is development evidence, not a release candidate. Application
regression tests remain in the kernel, provider and service test suites, and the
root `npm-shrinkwrap.json` retains the production SDK dependencies.

## Staging OpenRouter research adapter

`providers/openrouter/src/claude-research` packages Claude Agent SDK `0.3.305`.
When no native Claude account is selected, `ECHO_STAGING_CLAUDE_RESEARCH_V1=true`
selects it for ordinary Ask, evaluation and background research only at the fixed staging Authority origin. The EC2
connector-rehearsal profile selects it; other Authorities retain the existing
engine. Trigger dispatch, writers and client contracts remain unchanged. No
database baseline change is required.

The SDK owns the investigation through ECHO's search, list, open and finish
tools. ECHO retains source visibility, pagination, known-id opens, completion
checks, progress, answer rendering and release authorization. Every outbound
Messages or token-count request enters the shared model queue and fresh access
check, including retries. Evidence counts as observed only when its actual
packet reaches an admitted inference; same-turn reads cannot support absence.

The child uses an empty temporary home, no built-in tools, plugins or persisted
sessions, and a request-local loopback endpoint. The parent authenticates the
fixed OpenRouter Anthropic Messages route with the existing service binding;
the child receives no provider credential. Model identity, request digests,
usage and selected private traces use ECHO's existing observability. Provider
and network failures can retry through fresh admission, then fall back to
writing from released evidence. Access loss and unknown process errors remain
terminal. Cancellation waits for child closure before temporary-home cleanup.

There is no additional SDK turn/cost or old numerical research-note ceiling.
Existing request deadlines/call budgets, writer reserve, source bounds and
answer contracts remain. Writer rows use the actual context budget instead of
a separate 100-row cutoff; omitted rows remain explicit.

## Personal Claude account selection

The staging selection binds **all Authority model work** to one native Claude
account: Ask for every member, background research and writing, and meeting
extraction use `claude-sonnet-5-5`. The account pays for requests; ECHO still
authenticates each caller and revalidates that caller's evidence permissions.
There is no per-member provider override or automatic OpenRouter fallback.

The reviewed [personal Claude setup](../../../deploy/organization-authority/README.md#personal-claude-staging-research)
uses the installed wrapper's `login`, `enable` and `status` actions on a fresh
staging rehearsal, before source admission. Compose names one private marker
through `ECHO_STAGING_CLAUDE_ACCOUNT_FILE`; its content is exactly
`{"kind":"echo-staging-claude-account-v1"}`. The service fixes the native home and
executable. An absent marker selects OpenRouter. Changing provider after source
admission requires a fresh rehearsal; existing processing state is not migrated.

Native Claude Code owns sign-in and refresh on the machine running it. A laptop
login does not sign the host in. Native authentication must report `claude.ai`;
an absent sign-in or cached API-key route stops model work. Requests use empty
working directories, ECHO-only tools, disabled settings/plugins and no persisted
SDK conversation. Every native request passes through ECHO's admission gate
before reaching `api.anthropic.com`; authentication headers are not retained.
Follow the [operator playbook](../../../docs/operations/PB-OPERATIONS-001-authority-operator-lane.md)
for host sign-in, canary approval and release checks.

Claude Agent SDK has no separate harness fee; model access uses the selected
subscription limits or API billing, and infrastructure has its own costs.
See Anthropic's [subscription usage guidance](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)
and [native sign-in and hosting conditions](https://code.claude.com/docs/en/legal-and-compliance).

## Offline package check

From the repository root, after installing the production dependencies:

```sh
npm run build --workspace @echo-brain/organization-authority
node tools/evals/headless-research/service-package-smoke.mjs
```

This uses the packaged SDK and real MCP search/finish calls against a local
synthetic Messages responder. It needs no credential, remote endpoint or user
records. The same script can be mounted read-only at its matching `/app/tools/`
path inside the Authority image and run with `--network none`.

This proves package and protocol wiring. Real provider compatibility, connected
Jira/Confluence and internal-source canaries, long-context compaction and
concurrent live load require staging qualification through the
[Authority operator playbook](../../../docs/operations/PB-OPERATIONS-001-authority-operator-lane.md).
