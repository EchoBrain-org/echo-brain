---
schema_version: 1
id: ADR-0027
kind: decision
title: Rebind a lost Nango Slack connection under the same credential handle
component_ids:
  - CMP-ORGANIZATION-AUTHORITY
  - CMP-IDENTITY-ACCESS
  - CMP-PROCESSING-ADAPTERS
  - CMP-PERSON-CLIENT
created_at: 2026-10-01
reviewed_at: 2026-10-02
reviewed_ref: 1d7e72bd75babcfbc8025b4a089a8517aef80d7b
status: proposed
supersedes: []
superseded_by: []
updates:
  - ADR-0025
---

# ADR-0027: Rebind a lost Nango Slack connection under the same credential handle

This is a proposal awaiting founder acceptance. The connection-recovery fix on
PR #250 implements it; the claim is source-tested only, not deployed or
qualified. [ADR-0025](ADR-0025-nango-holds-slack-connection-credentials.md)
stays accepted and is not edited.

## Context and options

ADR-0025 keeps every outstanding approval card valid across a reconnect: the
reconnect reuses the same Nango connection ID, so the credential bundle, the
connection state hash and the cards are unchanged. Replacing the connection
with a different app or workspace is refused in v1. It does not cover Nango
no longer having the connection (deleted in Nango's dashboard, say). Then the
bot-token source failed every read without marking the connection, so the
owner still saw `connected`; `--reconnect` asked Nango for a reconnect
session on an ID it no longer has and reported "Slack setup is unavailable";
and a fresh install was refused as `already_connected`. Only
`replace-rehearsal` led back.

A reconnect that landed in another workspace was also refused as
`already_connected`, after Nango had already overwritten its connection with
that workspace. ECHO wrote nothing, but the owner saw `connected` and a
message about a different app.

- **A. Keep the dead end.** Recovery is a fresh lineage. Rejected: it throws
  away the organization's state for a loss in a third party's bookkeeping.
- **B. Replace the connection.** Rejected for ADR-0025's reason: each
  pending approval's `connection_state_sha256` is a foreign key to the current
  state row, so a new state cannot coexist with decided cards.
- **C. Rebind.** Keep the contract, the state row and the bundle's handle, and
  point the bundle's Nango connection ID at a new Nango connection that
  proves the exact same app, workspace and bot. Proposed.

## Decision and consequences

- **What a card freezes.** The credential identity a pending card resolves
  under ([INV-PERMISSIONS-013](../invariants/INV-PERMISSIONS-013-frozen-pending-contract.md))
  is the state's `credential_reference_sha256`, a digest of the opaque handle,
  plus its verification evidence digest and observed scopes. Nothing hashes
  the bundle bytes or the Nango connection ID. Under one handle the app ID,
  client ID, client secret and signing secret never change; only the Nango
  connection ID can be rebound.
- **Trigger.** The owner's Install first reads the bound Nango connection. A
  404 opens a connect session with the attempt's own organization, membership
  and attempt tags, which is found and checked like a first install. After
  Slack verifies the new token and before any further provider await, the old
  ID is read again and must still answer 404. The owner and current-state
  fences then run synchronously before the bundle write; if the old ID is
  back, the attempt fails and the owner's next Install reconnects it.
- **Proof.** Slack's `auth.test` and `bots.info` on the new token must
  reproduce the stored evidence digest exactly, with the same team,
  enterprise, app, bot, bot user and sorted scopes, and Nango's report must
  agree with Slack's. The bundle must still hold the app credentials read at
  begin and the lost ID. Only then is it rewritten under the same handle with
  the new ID, by a same-directory replace. The state row is untouched, so its
  `verified_at` and `verification_event_id` still describe the first
  verification. Like a reconnect, a rebind writes no durable record of who
  rebound the connection or when.
- **Refusals.** A reconnect or rebind that proves another workspace or bot is
  refused as `workspace_mismatch` and marks the connection "needs reinstall"
  at once, since Nango's connection then holds the other one. The CLI tells
  the owner to run setup again with `--reconnect` and choose the
  organization's workspace. `already_connected` stays for a different app,
  and for a different Nango connection outside a rebind.
- **Health.** A 404 for the bound connection on a bot-token read or reconnect
  status read marks it "needs reinstall". A 404 for a newly found replacement
  during rebind status does too; the final old-ID 404 instead proves that the
  rebind may proceed. Nango's 401 or 403 (this Authority's own key) and
  unavailability do not mark it. A mark from a read that an install overtook
  is dropped. The five-minute token cache is keyed by the unchanged state hash
  and survives a rebind; that is safe only because the proof requires the
  same bot.

### Proposed optional public-channel capability extension

The [staging V2 capture design](../product/2026-10-01-connector-context-integration-v1.md#optional-slack-public-channel-read-capability)
adds an explicit provider-owned setup capability for the baseline bot scopes
plus exactly `channels:read` and `channels:history`. It preserves the frozen
baseline connection contract and state used by existing cards and person
links. This is a source implementation proposal; it does not change this ADR's
acceptance or provider-qualification status.

The ordinary exact-proof rule above remains the default. With this capability
selected, reconnect and rebind may instead project an independently verified
live six-scope proof to the historical baseline. The helper must first
reconstruct the canonical live `auth.test` and `bots.info` proof and require
equality with the provider evidence. It then projects only the scope list and
requires equality with the stored baseline proof. Workspace, enterprise, app,
bot and bot user must still match. Missing scopes, unknown extra scopes and an
unverified evidence digest cannot use this exception. Rebind still proves the
old Nango ID absent and applies the existing owner and local state fences.

Channel intake must separately prove the read capability; the historical
connection contract only proves the approval capability. A cached baseline
token may therefore continue to serve approval delivery while channel capture
waits for a token with the read scopes. Capture must fail closed in that case.

Consequences:

- **Misconfiguration looks like loss.** A wrong Nango environment key or
  integration key also answers 404. The owner sees "needs reinstall", and a
  rebind moves the connection into the misconfigured environment.
- **Custody.** The old Nango connection, and the connection made by any
  refused install, stays in Nango with a copy of a bot token. Nothing deletes
  it.
- **Per-organization Nango environment is unconfirmed.** ADR-0025 lists one
  Nango environment per organization as an open item, not a founder
  decision, so this record does not rely on it. The rebind's proof
  does not need it: exact evidence plus the organization and attempt tags.
  Its custody consequence does: in an environment shared between
  organizations, any of their keys can read an orphaned connection's bot
  token, and a key misconfigured with another organization's environment
  moves this organization's connection there. Until the rule is confirmed, a
  rebind on a shared environment is unsafe.
- **Spike-sensitive.** The 404 for an unknown ID on Nango's
  `GET /connections/{id}` is assumed, not observed: ADR-0025's phase-0 spike
  is unrecorded. The reconnect-session endpoint's answer for an unknown ID is
  not relied on. A sanitized real-Nango probe must confirm the 404 before
  qualification ([INV-ADAPTERS-001](../invariants/INV-ADAPTERS-001-provider-transport.md)).
- **Partial failure.** A failure after the bundle's rename reports
  `provider_unavailable` although the bundle names the new connection; the
  owner's next Install finds it and reconnects normally.
- **Out of scope.** Replacing the app (the Slack app was deleted) or the
  workspace stays refused, as in ADR-0025. So do cleanup of orphaned Nango
  connections and Nango key rotation.

## Migration, rollback, and evidence

There is no schema change, and the bundle format is unchanged. Rolling the
code back leaves a rebound bundle that names an existing Nango connection,
which ADR-0025's reconnect path accepts.

Evidence, source-tested:
`services/organization-authority/test/slack-nango-proof-path.test.ts` steps
11 to 16 run the production composition through a refused reconnect, a
reconnect back to the original workspace, a lost connection marked "needs
reinstall", a rebind with an unchanged state hash and handle, and a restart
whose waiting card approves with the new connection's token. The coordinator,
setup workflow, bot-token source and
`packages/organization-control-plane/test/file-secret-store.test.ts` tests
cover the refusals, the compare-and-swap and the replace.
