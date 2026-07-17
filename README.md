# echo-brain

`echo-brain` is ECHO's standalone, tool-agnostic connection layer for turning
meeting material into reviewed decisions and delivering those decisions to the
places where a team works. Meeting tools, decision-processing providers, and
communication tools are adapters around a stable core; no vendor defines the
core product model.

```text
meeting-source adapter(s)
        -> canonical meeting documents
        -> decision-processing core
        -> canonical decisions, actions, and briefs
        -> manual approval
        -> communication-channel adapter(s)
        -> delivery receipts
```

The repository contains canonical contracts, an adapter/factory registry,
durable SQLite core state, a resumable manual-approval queue, processing and
brief-building primitives, and a composed CLI without importing Project
ECHO's daemon, MCP, Machine capture, or Fleet orchestration.

This repository is now self-building and installable as a local DEV package. It
is not yet the authoritative live product:

- maturity: `DEV`
- authority: `false`
- production adapter composition: implemented
- bundled semantic/model processor and team-channel adapters: pending
- real meeting / FOUNDER LIVE evidence: pending
- registry publication: disabled (`private: true`)

## Requirements

- macOS
- Node `22.22.1`
- npm `10.9.4`
- Xcode command-line tools when `better-sqlite3` must build from source

The original phase-one qualification target is macOS arm64. A successful build
on another architecture is development evidence, not phase-one qualification.

## Build and verify from a clean checkout

```sh
npm ci
npm run check
npm pack --json
```

The committed shrinkwrap contains both runtime and development dependencies, so
no Project ECHO checkout or out-of-band TypeScript/Vitest/ESLint installation is
required.

Useful individual commands:

```sh
npm run build
npm run typecheck
npm run lint
npm test
npm run check:provenance
npm run check:boundary
npm run check:dependencies
```

`npm run build` emits JavaScript, declarations, source maps, and the SQLite
migrations under `dist/`. `npm pack` runs that build automatically and includes
the CLI, runtime schema, migrations, license, README, and shrinkwrap.

## Install the local tarball

After `npm pack`, install the exact tarball into a user-controlled prefix:

```sh
npm install --global ./echo-brain-0.0.0-dev.0.tgz
```

Or keep it isolated:

```sh
npm install --prefix "$HOME/.local/share/echo-brain" ./echo-brain-0.0.0-dev.0.tgz
"$HOME/.local/share/echo-brain/node_modules/.bin/echo-brain" --help
```

## Runtime configuration

Operational commands require an absolute JSON config path. A DEV example:

```json
{
  "schema_version": 1,
  "lane": "team-product",
  "state_dir": "/Users/you/.echo-brain",
  "meeting_sources": [
    {
      "adapter_id": "granola",
      "instance_id": "primary",
      "credential_ref": "env:GRANOLA_API_KEY",
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
  "communication_channels": [
    {
      "adapter_id": "jsonl-outbox",
      "instance_id": "team-primary",
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

Credential values do not belong in this file. The schema accepts `env:` and
`keychain:` references; the bundled Granola adapter resolves `env:` by default
and accepts an injected resolver for other credential stores. A credential
reference is optional because some adapters do not require authentication.
`settings` is deliberately opaque to the core and is validated by the selected
adapter. Adapter IDs select an implementation; instance IDs distinguish
multiple configured instances of the same capability.

`state_dir` is the single authority for current product state. The standalone
product does not read `ECHO_HOME`; integrations and compatibility workers must
receive concrete checkpoint, health, and output paths from their caller.

```sh
echo-brain validate-config --config /absolute/path/runtime-config.json
echo-brain selftest --config /absolute/path/runtime-config.json
echo-brain run-once --config /absolute/path/runtime-config.json
echo-brain approvals --config /absolute/path/runtime-config.json
echo-brain approve --config /absolute/path/runtime-config.json --id <id> --reviewer <name>
echo-brain run --config /absolute/path/runtime-config.json
```

- `validate-config` validates the schema and local-filesystem requirement.
- `selftest` is offline. It verifies that SQLite can open and load the packaged
  migration, reports the configured adapter references without loading them,
  and keeps `wedge_executed: false`.
- `run-once` loads adapters through the common factory shape, checks their
  configuration and health, runs every meeting source once, and persists its
  cursor and processing state in SQLite. Every adapter operation has a host
  deadline and receives an `AbortSignal`; a non-settling adapter cannot hold the
  process open forever.
- An unreviewed brief is written to `state_dir/approvals/` with private file
  permissions. `approvals`, `approve`, and `reject` operate that durable queue.
  The next cycle delivers the exact approved snapshot; pending work never
  advances the source cursor.
- `run` performs the same cycle immediately and repeats it at
  `cycle_interval_ms` until `SIGINT` or `SIGTERM`. Shutdown aborts the active
  adapter operation before closing durable state.

Delivery failures are conservative. Authentication, configuration, transport,
timeout, and unknown-outcome failures pin the source cursor for retry or
operator repair. Only an explicit non-retryable `rejected` receipt proves that
one artifact is terminal: it is recorded as a dead letter, surfaced as an
unsuccessful cycle, and does not starve later source pages. Successful receipts,
resolved approvals, extracted decision sets, and adapter-version cursors are
monotonic across restarts.

The bundled `structured-text` processor intentionally extracts only lines that
begin with `Decision:`, `Action:`, or `Rationale:`. It is an honest offline
baseline, not a semantic or model-backed extractor. The bundled
`jsonl-outbox` channel is a durable, idempotent local delivery reference, not a
substitute for a team's communication adapter.

## Stable core and adapter boundaries

The governing extension rules and per-capability checklists are documented in
[`docs/architecture/core-and-adapters.md`](docs/architecture/core-and-adapters.md).

The core owns canonical meeting, decision, brief, provenance, approval,
delivery, receipt, and error shapes. It also owns idempotency, checkpoints,
storage, orchestration, and health semantics.

The canonical meeting contract is version-controlled as
[`schemas/meeting-context.v1.schema.json`](schemas/meeting-context.v1.schema.json).
This is the rich baseline contract—not a compatibility branch for the removed
narrow meeting shape. Only identity, provenance, capture status, and the
participant/content/artifact collections are required. Meeting details and
context remain optional so each source adapter can preserve exactly what its
tool provides.

Adapters own authentication, vendor APIs, pagination, rate-limit handling,
vendor error translation, and mapping to or from the canonical shapes. All
adapters share identity, configuration, lifecycle, health, and error contracts;
their directional capabilities remain typed as meeting source, decision
processor, or communication channel.

Future PM, engineering, and other surfaces should be introduced as capability
adapters over the same canonical artifacts. Portable concepts belong in typed
core fields; uncommon vendor-specific values stay in bounded `extensions` or
adapter `settings` and must not become required core semantics.

## What remains before advancing beyond DEV

1. Add and qualify a semantic decision-processor adapter and the first real
   team communication-channel adapter using the same contracts.
2. Move the remaining legacy enrichment consumers from the Granola adapter's
   raw-event compatibility API to canonical records, then retire that API.
3. Bound first-run processing to seven days and serve newest meetings first,
   independent of the selected meeting adapter.
4. Add install/status/doctor/service lifecycle and rollback behavior.
5. Run the exact artifact through isolated FOUNDER LIVE before advancing beyond
   `DEV`.

## Extraction provenance

The immutable extraction baseline is commit
`41c28171c64710b3ad23392a2606d75cfe8e7b2c`, extracted from Project ECHO commit
`2971310441b69735cbe759293abd8c4d044bf347` under item
`2026-07-13-133-local-echo-brain-source-extraction`.

The JSON records under `provenance/` bind that historical commit. Later
standalone changes are successor work and are not relabeled as copied source.
`node tools/check-provenance.mjs` therefore verifies the immutable extraction
commit by default.

The first successor restores the byte-identical
`src/storage/migrations/0001_initial.sql`, which the extracted SQLite runtime
requires but the one-time artifact closure accidentally omitted. The standalone
core state is added separately by `0002_core_state.sql`.
