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

## Staging service adapter

`providers/openrouter/src/claude-research` packages Claude Agent SDK `0.3.305`.
`ECHO_STAGING_CLAUDE_RESEARCH_V1=true` selects it for ordinary Ask, evaluation and
background research only at the fixed staging Authority origin. The EC2
connector-rehearsal profile selects it; other Authorities retain the existing
engine. Trigger dispatch, planner-disabled sweeps, writers and client contracts
remain unchanged. No database baseline change is required.

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

An optional staging selection binds **interactive Ask research for one authenticated
ECHO membership** to that person's own native Claude Code sign-in. It does not
replace OpenRouter: other members, background research, evaluation, extraction
and the final answer writer keep their existing provider. The account is never
selected by question text, a client header, or a project lead's identity.

The service accepts these three non-secret settings together, only at the fixed
staging origin:

| Setting | Meaning |
| --- | --- |
| `ECHO_STAGING_CLAUDE_ACCOUNT_MEMBER` | Exact ECHO membership ID allowed to use the profile |
| `ECHO_STAGING_CLAUDE_ACCOUNT_HOME` | Absolute home of that person's native Claude installation |
| `ECHO_STAGING_CLAUDE_ACCOUNT_EXECUTABLE` | Absolute path to the unmodified Claude Code executable |

The person signs into that executable through Anthropic's own `claude auth login`
flow on the machine running it. A Mac sign-in does not sign the staging host in.
ECHO does not import credential files or accept an OAuth token in configuration.
Native `auth status --json` must report `claude.ai` before a run; an absent sign-in
or a cached API-key route stops the personal request rather than changing its
billing route. Native Claude Code owns credential refresh. Its home is preserved;
each request still uses an empty working directory, ECHO-only tools, disabled
settings/plugins and no persisted SDK conversation. On macOS the OS username
and default config location preserve the existing Keychain identity.

Native authenticated model requests pass through the same request-local access
gate, then go only to `api.anthropic.com`. ECHO does not retain authentication
headers. Requests, including retries, still revalidate the exact evidence packet
before sending it; choosing a personal account grants no additional source access.
The SDK uses `claude-sonnet-5-5` and records Anthropic as the research provider.

For hosted staging, the reviewed [personal Claude setup](../../../deploy/organization-authority/README.md#personal-claude-staging-research)
uses native `login`, then `enable --member` and `status` on the installed
onboarding wrapper. Compose selects the optional non-secret binding through
`ECHO_STAGING_CLAUDE_ACCOUNT_FILE`; its native home and executable are fixed.
The file and the three explicit settings above cannot both select an account.
An absent file leaves the existing provider route unchanged. Do not copy a
laptop session into the host or change the host environment outside the
[operator playbook](../../../docs/operations/PB-OPERATIONS-001-authority-operator-lane.md).
The normal canary and release checks still follow host sign-in and enablement.

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
