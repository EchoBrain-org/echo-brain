<!-- BEGIN ECHO -->

# ECHO

ECHO context is available through the `echo` MCP server at `http://127.0.0.1:39478/mcp`.

Before calling ECHO, follow the installed `$using-echo-mcp` skill.
On founder-live machines, those instructions also bind every ECHO-using turn to the live runtime’s versioned dogfooding journal.

<!-- echo-context-agent-instructions: 1 -->

<!-- END ECHO -->

# Post-merge local sync (all coding agents)

After every PR merge, sync the primary checkout's `main` before reporting the
merge complete or starting staging. First check that `main` is the branch
checked out there (`git symbolic-ref --short HEAD` prints `main`); on another
branch or a detached `HEAD`, report that and do not pull. Then run
`git pull --ff-only origin main` and check that `HEAD` matches `origin/main`.
If your session cannot reach the primary checkout, say so in your report. Never
reset or discard local work to sync. If local edits block the pull, stash them
under a named message and note that stash's commit id
(`git rev-parse stash@{0}`), pull, then restore them with
`git stash apply --index <id>`. When that applies cleanly, drop that same
entry, finding its current `stash@{n}` by the id first: the stash list is
shared with every worktree. Keep the stash when it does not apply cleanly, and
name it in your report. If local `main` has diverged, report it instead of
forcing a reset. Feature worktrees stay on their own branches.

# Full checks (all coding agents)

While working, run focused tests and the relevant static checks. Run the full
`npm run check` once, on the finished change, and wait for its result before
pushing; for a change to documentation only, `npm run check:docs` is enough.
When several agents build one change, they run focused checks and the agent
integrating their work runs the full check. Before starting a full check or
another heavy suite, look for one already running on this machine, in any
session or worktree, and wait for it instead of running two at once or stopping
it.

# AWS Guidance

- Do not use `aws login` for this repository and do not sign in as the AWS
  account root user. Authenticate through IAM Identity Center with
  `aws sso login --profile echo-prod` and pass `--profile echo-prod` to AWS CLI
  commands.
- Coding agents access EC2 hosts only through bounded SSM Run Command
  operations already wrapped by this repository's CLIs. Coding agents must not
  run `aws ssm start-session`, SSH, `su`, `sudo -i`, or an interactive root
  shell. A human at the keyboard may use Session Manager for an exact installed
  host wrapper named by the Authority operator playbook; any privilege
  elevation stays non-interactive and scoped to that command.
- Prefer the AWS MCP Server for read-only AWS inspection. Do not use AWS MCP,
  the AWS CLI, or CloudFormation APIs to mutate the Authority staging slot or
  onboarding-transfer boundary. Those mutations go through
  `npm run authority:staging` and `npm run authority:staging-onboarding-transfer`
  only. Current-host staging release actions additionally use the reviewed
  `npm run authority:staging-release` CLI, which transfers only checksum-bound
  non-secret artifacts and invokes named installed update-wrapper actions via
  bounded SSM. It does not mutate infrastructure or the onboarding-transfer
  boundary. Host-local onboarding remains in the human Session Manager lane.
  If the MCP is unavailable,
  use the AWS CLI only for inspection that the repository CLIs do not expose.
- The client update feed (CLI kits and desktop apps) is a separate AWS lane.
  `npm run client-update:staging` creates a CloudFormation change set for the
  feed's S3 stack, and
  `npm run client-update:publish` writes release objects to that bucket;
  `npm run client-update:sign` signs locally. Mutate the feed stack and bucket
  only through these CLIs, following the operator playbook and
  [`deploy/client-updates/README.md`](deploy/client-updates/README.md).
  Execution requires a human-reviewed exact change set; signing and publishing
  require an approved exact manifest digest.
- Before starting a task, check whether a relevant AWS skill is available.
  Load the skill with `retrieve_skill` and prefer its guidance over
  general knowledge.
- When uncertain about specific AWS details (API parameters, permissions,
  limits, error codes), verify against documentation rather than guessing.
  State uncertainty explicitly if you cannot confirm.
- When creating infrastructure, prefer infrastructure-as-code (AWS CDK or
  CloudFormation) over direct CLI commands.
- When working with infrastructure, follow AWS Well-Architected Framework
  principles.
- Do not use em dashes in AWS resource names or descriptions. Use
  hyphens instead.

## Secret Safety

- MUST load the `aws-secrets-manager` skill first for any secret,
  credential, API key, token, or password task. MUST NOT call
  `secretsmanager get-secret-value` or `batch-get-secret-value`, and MUST
  NOT hit the Secrets Manager Agent daemon directly. MUST use
  `{{resolve:secretsmanager:secret-id:SecretString:json-key}}` with
  `asm-exec` so the secret resolves at runtime without entering context.

## Codex Cloud task boundary

Codex Cloud is the default lane for isolated issue investigation, implementation,
tests, and pull requests. Cloud tasks may install dependencies, use public
documentation, read repository and issue metadata, create an issue branch, and
open or update its pull request.

Cloud tasks MUST NOT:

- call AWS, SSM, EC2, production endpoints, or deployment commands;
- receive or retrieve AWS, GitHub, Slack, Granola, OpenRouter, or application
  secrets or tokens;
- perform a production deploy or a live Slack/Granola rehearsal; or
- merge a pull request or close an issue directly.

For a bug fix, the Cloud task sequence is: reproduce the issue with a focused
failing test or command, implement the smallest root-cause fix, run the focused
proof, run `npm run check`, and open a pull request using the repository template.
Use `Closes #NN` only for a complete fix and `Refs #NN` for partial work.
When using `gh`, place `--repo EchoBrain-org/echo-brain` immediately after the
subcommand so the repository-scoped command rules match without an approval.

Production validation remains a local operator step through SSM and the EC2
instance role. Never copy a production secret into a Cloud environment.

## Authority operator playbook (all coding agents)

Codex, Claude Code, and Cursor are the same operator. There is one playbook.
Do not add a tool-specific skill, playbook, or chat checklist that restates it.

Before `authority:local`, `authority:staging`, `authority:staging-release`, onboarding transfer,
`onboard-clean-v1.sh`, `update-clean-v1.sh`, `restore-clean-v1-host.sh`,
`client-update:staging`, `client-update:sign`, `client-update:publish`,
Authority image or host-bundle builds, SSM, restage, onboard, or deploy, read
and follow
[`docs/operations/PB-OPERATIONS-001-authority-operator-lane.md`](docs/operations/PB-OPERATIONS-001-authority-operator-lane.md).

That file is the router. The Codex Cloud boundary above still wins; the
playbook is not permission to call AWS.

Never use `--initialize-blank-data-volume` on a prepared volume, restage to
compile, guess `authorityPinSha256` from the public endpoint, or put a login
grant in output, argv, or chat.

For a current-host staging update, a local coding agent may drive the reviewed
release CLI, exact offline Person-client installation, and both candidate-client
checks. During initial onboarding, the
local operator on the designated owner Mac may also verify the release-installed
client and run both authenticated Person reads; host wrapper actions still
remain in the human Session Manager lane. Reuse valid sessions, completed setup
evidence and existing approval for an unchanged operation scope. Login/MFA,
approval of the canary meeting (on the desktop, or on the Slack DM copy when
linked), and the exact candidate's final release decision remain human inputs.
Never fabricate that authorization or infer it from a canary receipt, PR merge,
or blanket approval to automate. Unknown drift, unconfirmed remote execution,
and destructive/infrastructure changes stop the automatic release lane.
