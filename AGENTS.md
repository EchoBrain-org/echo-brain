<!-- BEGIN ECHO -->

# ECHO

ECHO context is available through the `echo` MCP server at `http://127.0.0.1:39478/mcp`.

Before calling ECHO, follow the installed `$using-echo-mcp` skill.
On founder-live machines, those instructions also bind every ECHO-using turn to the live runtime’s versioned dogfooding journal.

<!-- echo-context-agent-instructions: 1 -->

<!-- END ECHO -->

# AWS Guidance

- Do not use `aws login` for this repository and do not sign in as the AWS
  account root user. Authenticate through IAM Identity Center with
  `aws sso login --profile echo-prod` and pass `--profile echo-prod` to AWS CLI
  commands.
- Coding agents do not access EC2 hosts. They must not run
  `aws ssm start-session`, SSH, `su`, `sudo -i`, or an interactive root shell,
  and this repository no longer wraps any SSM Run Command. A human at the
  keyboard may use Session Manager for an exact installed host wrapper named by
  the Authority operator playbook; any privilege elevation stays
  non-interactive and scoped to that command.
- Prefer the AWS MCP Server for read-only AWS inspection. Do not use AWS MCP,
  the AWS CLI, or CloudFormation APIs to mutate the production Authority host,
  its recovery stack, or its observability stack. The AWS staging slot and its
  repository CLIs were retired on 2026-09-06. Host changes are human actions
  through the installed wrappers, and host-local onboarding remains in the
  human Session Manager lane. If the MCP is unavailable, use the AWS CLI only
  for inspection.
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

Before `authority:local`, `onboard-clean-v1.sh`, `update-clean-v1.sh`,
`backup-authority-maintenance.sh`, Authority image builds, SSM, onboard, or
deploy, read and follow
[`docs/operations/PB-OPERATIONS-001-authority-operator-lane.md`](docs/operations/PB-OPERATIONS-001-authority-operator-lane.md).

That file is the router. The Codex Cloud boundary above still wins; the
playbook is not permission to call AWS.

Never put a login grant in output, argv, or chat.

There is no automated release lane. Host updates, login/MFA, private Slack-card
approval, and the release decision are human actions. Never fabricate that
authorization or infer it from a canary receipt, PR merge, or blanket approval
to automate. Unknown drift, unconfirmed remote execution, and
destructive/infrastructure changes stop any agent-driven step.
