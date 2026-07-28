# echo-brain

`echo-brain` turns meeting material into reviewed decisions and delivers those
decisions to the places where a team works.

```text
meeting source
  -> canonical meeting
  -> decision processor
  -> explicit approval
  -> delivery surfaces
  -> durable receipts
```

The near-term product is deliberately one organization with multiple
employees. The repository contains:

- the tool-agnostic decision core;
- Granola meeting ingestion;
- deterministic and LLM decision processors;
- local and Slack approval;
- JSONL and Slack delivery;
- SQLite product state, onboarding, backup, and restore;
- one centrally hosted organization authority for enrollment and access.

It does not contain multi-tenant control-plane, billing, fleet, or
multi-replica authority infrastructure.

## Requirements

- Node `22.22.1`
- npm `10.9.4`
- macOS arm64 for the machine-installed product and persistent service
- a compiler toolchain if `better-sqlite3` has no prebuilt binary for the
  machine

The supported machine-installable product target is macOS arm64. Its
persistent service uses a per-user LaunchAgent; the decision core and
foreground commands remain Node-based.

## Build, test, and install

```sh
npm ci
npm run check
npm pack
npm install -g ./echo-brain-0.0.0-dev.0.tgz
```

`npm run check` runs the source-boundary check, TypeScript, ESLint, and the
stable test suite. `npm pack` builds the CLI and includes its three local
protocol packages. A package built from a clean commit records that commit and
a content manifest for every npm-packed file except the manifest itself. A
dirty or untracked worktree is marked unverified and cannot supply founder
artifact evidence. The manifest detects package corruption or local tampering;
it is not a publisher signature. This pre-1.0 installer does not preserve
package history automatically, so retain an older installed package tree when
its previously recorded artifact identity must remain verifiable after an
upgrade.

Initialize private config and state:

```sh
echo-brain onboard \
  --config /absolute/path/runtime.json \
  --state-dir /absolute/path/state

echo-brain init --config /absolute/path/runtime.json
echo-brain run-once --config /absolute/path/runtime.json
echo-brain doctor --config /absolute/path/runtime.json
```

The file-backed installation signer stores an exportable P-256 key below the
private state directory and labels its assurance as
`software_key_development_only`. The signer port remains replaceable by a
hardware-backed implementation later. Beginning founder identity bootstrap
requires `--allow-exportable-software-key` so pilot-grade assurance cannot be
accepted silently. This signer can be operationally ready for a pilot, but it
never makes `seed_grade_ready` true; `identity-check --strict` continues to
require hardware-bound, non-exportable key assurance.

This pre-1.0 build does not migrate a Secure Enclave identity to the portable
file signer. `identity-check` reports `unsupported_legacy_key_backend` for that
state. Preserve the prior state and signer when identity continuity matters;
otherwise re-bootstrap only as an explicit continuity-breaking reset.

## Runtime configuration

Operational commands require an absolute JSON config path. This offline
baseline uses Granola, local manual approval, and a JSONL outbox:

```json
{
  "schema_version": 1,
  "lane": "team-product",
  "state_dir": "/Users/you/.echo-brain",
  "meeting_sources": [
    {
      "adapter_id": "granola",
      "instance_id": "primary",
      "credential_ref": "file:/Users/you/.echo-brain/credentials/granola-api-key",
      "settings": {
        "page_size": 30,
        "cursor_overlap_ms": 1000
      }
    }
  ],
  "decision_processor": {
    "adapter_id": "structured-text",
    "instance_id": "primary",
    "settings": {}
  },
  "delivery_surfaces": [
    {
      "adapter_id": "jsonl-outbox",
      "instance_id": "local",
      "settings": {
        "path": "/Users/you/.echo-brain/outbox.jsonl",
        "destination_id": "reviewed-briefs"
      }
    }
  ],
  "approval_mode": "manual",
  "cycle_interval_ms": 60000
}
```

Credential values never belong in the config. Interactive runs may use `env:`;
persistent service configuration requires private `file:` references.

The LLM processor supports Ollama, OpenAI, Anthropic, and OpenRouter while
retaining one canonical output schema and validator:

```json
{
  "decision_processor": {
    "adapter_id": "llm",
    "instance_id": "primary",
    "credential_ref": "file:/Users/you/.echo-brain/credentials/openai-api-key",
    "settings": {
      "provider": "openai",
      "model": "YOUR_STRUCTURED_OUTPUT_MODEL",
      "max_output_tokens": 4096,
      "request_timeout_ms": 240000
    }
  }
}
```

Only Ollama accepts a custom `base_url`; hosted credentials cannot be redirected
to an arbitrary endpoint.

## Slack approval and delivery

Slack remains a first-class internal surface. For reaction approval:

```json
{
  "approval_mode": "adapter",
  "approval_surface": {
    "adapter_id": "slack-reactions",
    "instance_id": "internal-approvals",
    "credential_ref": "file:/Users/you/.echo-brain/credentials/slack-bot-token",
    "settings": {
      "channel_id": "C0123ABCD",
      "reviewer": {
        "slack_user_id": "U0456EFGH",
        "name": "founder"
      },
      "approve_reaction": "white_check_mark",
      "reject_reaction": "x"
    }
  }
}
```

The bot needs `chat:write`, `reactions:read`, and the appropriate public or
private channel history scope. Only the configured reviewer can resolve a
brief.

Slack delivery is independent of Slack approval:

```json
{
  "delivery_surfaces": [
    {
      "adapter_id": "slack",
      "instance_id": "team-decisions",
      "credential_ref": "file:/Users/you/.echo-brain/credentials/slack-bot-token",
      "settings": {
        "channel_id": "C0123ABCD",
        "request_timeout_ms": 30000
      }
    }
  ]
}
```

Confirmed Slack message identities are persisted as delivery receipts.
Ambiguous post outcomes stop automatic retry so the product does not knowingly
duplicate a message.

## Day-to-day commands

```sh
echo-brain validate-config --config /absolute/path/runtime.json
echo-brain selftest --config /absolute/path/runtime.json
echo-brain run-once --config /absolute/path/runtime.json
echo-brain approvals --config /absolute/path/runtime.json
echo-brain approve --config /absolute/path/runtime.json --id <id> --reviewer <name>
echo-brain run --config /absolute/path/runtime.json
```

`run-once` loads the configured adapters, processes available meetings,
persists cursors and decisions, waits for approval, and delivers the exact
approved snapshot. Failures conservatively pin the source cursor.

Backups and restores are explicit maintenance operations:

```sh
echo-brain backup \
  --config /absolute/path/runtime.json \
  --backup-root /absolute/path/backups \
  --id before-change

echo-brain restore \
  --config /absolute/path/runtime.json \
  --backup /absolute/path/backups/before-change \
  --backup-root /absolute/path/backups \
  --id restore-before-change
```

Backups can contain credentials and raw meeting state. Protect them like the
live state.

## Organization onboarding and access

The single-organization authority is a separate workspace and deployment. Its
employee APIs and `/admin` console share one HTTPS origin behind a standard
reverse proxy. See:

- [authority service](services/organization-authority/README.md)
- [portable one-machine deployment](deploy/organization-authority/README.md)
- [organization protocol boundaries](docs/architecture/organization-workspace-boundaries.md)

The employee product owns its installation private key and pins the authority
identity. The authority owns membership, enrollment grants, leases, and
revocation; it never owns meeting or reasoning data.

## Architecture

The core owns canonical meeting, decision, brief, approval, delivery, receipt,
and error shapes. Adapters own authentication, vendor APIs, pagination,
rate-limit handling, and mapping to or from those shapes.

Extension rules are in
[core-and-adapters.md](docs/architecture/core-and-adapters.md). The original
source-extraction history remains available in Git; it is no longer active
runtime or CI machinery.
