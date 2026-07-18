# Slack Approval Surface — Design

Date: 2026-07-17
Status: implemented (see "Implementation refinements" for deltas from the
original draft, adopted after an external implementation consultation)

## Goal

Add Slack as the first remote approval surface for decision briefs, while
restructuring approval storage into an append-only, chain-ready decision-node
store. Approval surfaces (CLI, Slack) become interchangeable resolvers over one
shared store, fully decoupled from delivery channels.

## Vision context (drives the schema, not the v1 feature set)

Every approval is a decision node: `(decision, reason, alternatives) + metadata`,
linkable like git commits. Later features will revisit a decided node with new
context (e.g. bad release feedback), reason against its recorded alternatives,
and append a superseding linked node — branches and temporal history. V1 ships
the node shape (with `alternatives` empty and `links` null) but no revisit
tooling, so the chain becomes additive later with no migration.

## Decisions made

1. **Interaction model:** emoji reactions + thread reason. The bot posts each
   brief to a channel; an allowlisted reviewer reacts with the approve/reject
   emoji; an optional thread reply from that reviewer is captured as the
   reason. Pure pull — no Socket Mode, no inbound endpoint; fits the existing
   polling `ApprovalGate` exactly.
2. **Chain scope:** chain-ready schema now, empty links; no revisit/branch
   tooling in v1.
3. **Wiring:** shared decision-node store with pluggable surfaces
   (Approach B). CLI and Slack both resolve against the same store;
   `ManualApprovalQueue` records migrate into it.

## Architecture

The core contract (`ApprovalGate.review()`, polled each cycle) is untouched.
All new code lives in product/adapter layers.

```
core cycle ──polls──> ApprovalGate (store-backed)
                          │
                 DecisionNodeStore  (append-only, chain-ready)
                    ▲           ▲
            CLI surface     Slack surface (new adapter kind: approval-surface)
        (approve/reject)    posts brief → polls reactions+thread → appends resolution
```

Either surface can resolve any pending node. A Slack outage never blocks
approval — the CLI still works against the same truth.

## Component 1: DecisionNodeStore

Append-only, per-node event directories under the product state root:

```
<state>/decisions/<sha256(processing_key)>/
  000-requested.json
  001-published.json    (optional; written by a surface that posted the node)
  002-resolved.json
```

Event payloads:

- `requested`: `{ schema_version: 1, node_id, processing_key, brief,
  requested_at, alternatives: [], links: { parent: null, supersedes: null },
  metadata }`
- `published`: `{ surface: 'slack', channel_id, message_ts, posted_at }`
- `resolved`: `{ status: 'approved' | 'rejected', reviewed_at, reviewed_by,
  reason: string | null, surface: 'slack' | 'cli', metadata }`

Rules:

- Events are new files only — never rewrite (unlike the current
  `ManualApprovalQueue` mutate-in-place records).
- Current state = fold of events. **First `resolved` event wins**; appending a
  second resolution is an error (idempotent re-append of an identical
  resolution is accepted).
- Concurrency: reuse `acquireProcessFileLock` per node + `atomicWrite`
  (0o700 directories, secret-sensitive writes), matching existing patterns.
- Legacy migration: on first open, if `<state>/approvals/*.json` exists, each
  record is converted idempotently into `requested` (+ `resolved` if decided)
  events. Legacy files are left in place and ignored afterwards.
- `alternatives` and `links` are schema-present but unused in v1.

## Component 2: store-backed ApprovalGate + CLI surface

- A thin `ApprovalGate` implementation folds the node's events and returns the
  canonical `ApprovalDecision`. In `manual` mode this replaces
  `ManualApprovalQueue` as the wired gate.
- CLI commands `approvals` / `approve` / `reject` are reimplemented over the
  store (list = fold all nodes; resolve = append `resolved` with
  `surface: 'cli'`). Flags and output stay compatible.

## Component 3: Slack surface adapter

New adapter kind `approval-surface`, `adapter_id: 'slack-reactions'`,
registered in `createDefaultAdapterFactories()` like the other kinds.

`review(request)` per cycle:

1. Ensure the node's `requested` event exists (append if new).
2. If no `published` event: post the brief to the configured channel as a
   Block Kit message (meeting title/time, decisions, actions, and the
   instruction "react :white_check_mark: to approve, :x: to reject; reply in
   this thread to record a reason"). Append `published` with the returned
   `message_ts`. The stored event makes posting idempotent across cycles and
   processes.
3. If still pending: call `reactions.get` on the message. A qualifying
   reaction is the configured approve or reject emoji from an allowlisted
   Slack user ID.
   - Exactly one decisive side present → fetch `conversations.replies`; the
     latest thread reply authored by the resolving reviewer (if any) becomes
     `reason`. Append `resolved` with `reviewed_by` mapped from config
     (`slack_user_id → name`, fallback to the raw user ID) and
     `metadata.slack = { channel_id, message_ts, reviewer_user_id }`.
   - Both approve and reject reactions from allowlisted users → **fail
     closed**: remain `pending` (Slack does not expose reaction timestamps, so
     ordering is unknowable). Humans resolve the conflict in-channel or via
     CLI.
   - Non-allowlisted reactions are ignored entirely.
4. Return the folded state.

Slack Web API access uses injected `fetchImpl` (LLM-adapter pattern) against
`https://slack.com/api/*` with the bot token as a bearer header.

## Config & secrets

`runtime-config.v1.schema.json` changes:

- `approval_mode`: `"manual" | "slack"` (was `const "manual"`).
- New optional `approval_surface` block, required iff `approval_mode` is
  `"slack"`, following the existing adapter-instance shape:

```jsonc
"approval_mode": "slack",
"approval_surface": {
  "adapter_id": "slack-reactions",
  "instance_id": "founder-approvals",
  "settings": {
    "channel_id": "C0123ABCD",
    "reviewers": [{ "slack_user_id": "U0456EFGH", "name": "zhenye" }],
    "approve_reaction": "white_check_mark",
    "reject_reaction": "x",
    "token_env": "SLACK_BOT_TOKEN"
  }
}
```

- The bot token is read from `context.environment[settings.token_env]`
  (granola pattern); tokens never appear in config files. Missing/empty token
  fails composition validation.
- Required Slack scopes: `chat:write`, `reactions:read`, `channels:history`
  (plus `groups:history` for private channels).
- `approve_reaction` / `reject_reaction` default to `white_check_mark` / `x`;
  must differ.
- `reviewers` must be non-empty; `manual` mode requires no `approval_surface`
  block and behaves as today (CLI over the new store).

## Error handling

- Slack API or transport failure during `review()` → log via the run summary
  and return the current folded state (normally `pending`). Fail closed; never
  fabricate a resolution. CLI resolution keeps working during outages.
- Only unresolved nodes with a `published` event are polled; per-cycle work is
  bounded by pending-node count — comfortably inside Slack rate limits at this
  scale. Rate-limit (HTTP 429) responses are treated as transport failures.
- Invalid or unparsable event files → hard error for that node (strict
  validation, matching repo style).
- The existing `approvalMs` cycle deadline bounds the entire `review()` call.

## Testing

- **Store:** fold logic; first-resolution-wins; append-only invariant;
  idempotent legacy import; lock contention.
- **Slack adapter** (fake `fetchImpl`, injected `now`): idempotent publish;
  approve and reject via reaction; thread-reason capture; allowlist filtering;
  both-reactions → stays pending; API error → stays pending; reviewer-name
  mapping.
- **Product:** CLI approve/reject over the shared store; config-schema
  validation (mode/surface pairing, reaction distinctness, reviewer
  non-emptiness); full `runCoreCycle` test with the Slack gate wired
  (pending → approved → delivered).

## Implementation refinements (supersede conflicting sections above)

- **Slot files, not numbered events.** Node directories hold create-once
  semantic slots — `requested.json`, `published-<surface>.json`,
  `resolved.json` — with no ordering semantics. Resolution never requires
  publication (the CLI can win first). Slots are written with a no-clobber
  atomic create (temp file + hard link), not rename-over.
- **Config shape.** `approval_mode: "manual" | "adapter"` (tool names stay
  inside adapter-owned config), paired with a top-level `approval_surface`
  adapter-instance block required iff mode is `adapter`. The bot token uses
  the existing `credential_ref: "env:SLACK_BOT_TOKEN"` mechanism, not a
  `token_env` setting.
- **Exactly one reviewer in v1.** Slack reactions carry no timestamps, so
  multi-reviewer attribution has no defined winner. `settings.reviewer` is a
  single `{slack_user_id, name}` object.
- **Node identity.** `node_id` is a UUID distinct from the storage key
  `sha256(processing_key)` (still exposed as `approval_id` for CLI
  compatibility), so future chain nodes for the same processing key are
  representable.
- **Failure surfacing.** Slack failures during `review()` throw typed
  retryable `AdapterError`s after the node is safely staged, so they appear
  in the run summary as approval-stage failures instead of silently reading
  as `pending`. Reaction rosters that Slack reports incomplete
  (`count !== users.length`) fail closed to pending.
- **Reason capture ordering.** The posted message instructs: reply in the
  thread *before* reacting — polling resolves irreversibly on the reaction.
- **Posting is at-least-once.** Slack post + local `published` record is a
  dual write; a crash between them can duplicate the message on retry. The
  recorded reference always wins as the polled message.
- **SQLite caveat.** The core state store keeps its own monotonic approval
  snapshot; once a resolution is copied there, the cycle stops consulting the
  gate for that node. The node store is the source of truth for surfaces; the
  SQLite copy is a derived cache.

## Out of scope (v1)

- Socket Mode buttons/modals, slash commands.
- Revisit/supersede/branch tooling (`alternatives` capture, chain traversal).
- Per-channel approval (approval remains brief-level, unlocking all delivery
  channels).
- Editing or retracting a posted Slack message after resolution (a follow-up
  "✅ approved by …" thread reply is a nice-to-have, not required).
