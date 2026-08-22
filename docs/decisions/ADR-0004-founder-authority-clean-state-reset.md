---
schema_version: 1
id: ADR-0004
kind: decision
title: Founder Authority clean-state reset
component_ids:
  - CMP-ADAPTERS
  - CMP-CENTRAL-ORGANIZATION
  - CMP-IDENTITY-ACCESS
  - CMP-CORE-PIPELINE
  - CMP-PERMISSIONS
  - CMP-OPERATIONS-RELEASE
  - CMP-PROTOCOLS-CRYPTO
created_at: 2026-08-20
reviewed_at: 2026-08-22
reviewed_ref: 15d18effbb022c90061ccbe26236734d21df9d55
status: accepted
supersedes:
  - ADR-0003
  - ADR-0005
superseded_by: []
updates:
  - ADR-0001
  - ADR-0002
---

# ADR-0004: Founder Authority clean-state reset

## Disposition

The founder accepted this decision on 2026-08-22. The acceptance rests on the
explicit facts that the founder is the only user, there are no live customers
or other users to migrate, the raw Slack, Granola, and server context remains
available outside the application state, and the founder can re-onboard.

This is the deliberately lean V1 decision. It replaces the earlier proposed
compatibility, permission-policy, audit-retention, snapshot, and rollback
ceremony in this ADR. Because ADR-0004 was still proposed, its candidate text
could be revised before acceptance. It supersedes the unaccepted contract
packet in ADR-0003 and the now-unneeded dual content-policy lineage in
ADR-0005. ADR-0001 and ADR-0002 remain binding, narrowed to one founder and one
fresh Authority lineage.

`reviewed_ref` identifies the exact pre-acceptance implementation baseline. It
does not claim that the cleanup below is already implemented or that a live
reset, deployment, or re-onboarding has occurred. Acceptance authorizes the
cleanup sprint and a later fresh initialization after its gates pass.

## Context and options

The migration had been treating a founder-only development state like a live
customer migration. That added compatibility reads, additive migrations,
multiple policy and audit lineages, historical envelope support, a recovery
manifest, and a formal rollback pair. Those mechanisms would take longer to
remove than the state is worth preserving.

The considered choices are:

1. migrate the existing state and keep compatibility until every historical
   reader and record drains;
2. initialize fresh state but retain compatibility code, additive migrations,
   and historical envelope readers as a precaution; or
3. initialize fresh state and ship one current founder-only pipeline with no
   historical compatibility surface.

This decision selects option 3.

## Decision

### Fresh lineage, not data migration

The new Authority starts from an empty lineage. Copy no application row,
identity, key, link, session, approval, rejection, audit event, record,
receipt, migration ledger, derived row, or retrieval generation from the old
state. New code must never open an old database and must contain no automatic
upgrade or mixed-lineage mode.

Before initializing the central organization, stop every old listener,
poller, writer, and provider worker. Only one lineage may own those effects at
a time. Moving old state outside the runtime path for short-term operator
convenience is allowed, but the old artifact/state pair is not a product
rollback contract.

### One lean founder pipeline

V1 has one happy-path pipeline:

1. the founder signs in through current OIDC;
2. the founder links one Slack identity and selects one approval channel;
3. the Authority reads new Granola source material;
4. one configured LLM produces a decision body;
5. the Authority posts that body to Slack;
6. the linked founder reacts with `white_check_mark` to approve or `x` to
   reject; and
7. approval appends one current record envelope, while rejection records the
   terminal outcome but exposes no readable record.

The durable minimum is the decision body shown for approval, source reference,
approval ID, Slack message/reaction reference, action, record append receipt,
and enough idempotency state to prevent duplicate work across retry or restart.
V1 does not require a policy-consequence digest graph, separate approval
capabilities, a frozen presentation protocol, delivery fan-out, or retrieval
generation.

### Current founder read

Delete the V1 and compatibility read implementations. Replace them with one
clean route that:

- authenticates one current Person bearer for the configured active founder;
- lists current approved records for that founder's single organization;
- omits rejected and pending items; and
- uses only the current top-level record envelope.

There is no restricted-reviewer/member-readable branch, tenure calculation,
record-side reader fact, permission-check transport, second authentication
pass, historical-byte reader, or readable-search dependency in lean V1.

### Genesis and audit shape

Each retained SQLite role has one directly authored genesis schema:

- Authority;
- organization control plane;
- organization record log; and
- organization record derived state.

Each role keeps its distinct SQLite `application_id` and starts at
`user_version = 1`, but it has no additive migration ledger. The 19 Authority,
5 control-plane, 4 record-log, and 3 record-derived legacy migration chains do
not run in the clean lineage. Readable-search fact, content, and lexical roles
are outside lean V1 and are not initialized.

Authority genesis never defines the old `0006` reviewer-query audit or `0007`
readable-search state. It also does not forward-migrate or merge `0010` and
`0012`. Instead, genesis defines one small current record-access event table
directly. An event identifies the access, current founder, record or listing
operation, outcome, and time. It has no policy trace, response-body digest,
hash-chain export, drain window, or retention job. It must not restore the
permission-aware read graph through a differently named schema.

### Current envelope only

The runtime reads and writes only the current top-level record envelope, V4 at
the accepted baseline. Delete production exports, validators, routes,
fixtures, and tests whose only purpose is to admit V1 through V3 envelopes.
This does not require mechanically renumbering unrelated nested schemas; it
removes top-level historical envelope coexistence from the runtime contract.

### Delete the compatibility bridge

Delete installation enrollment, lease, signature, record-ingest transport,
installation-owned access, compatibility bridge, and their zero-caller
exports, fixtures, migrations, tests, and documentation. Do not hold a bridge
for future re-keying because no old application state enters the new lineage.

### Streamlined re-onboarding

The clean onboarding flow asks only for:

- organization name, owner email, and Authority URL;
- OIDC issuer/client configuration and credential;
- Slack credential and approval channel;
- Granola credential and account email; and
- LLM provider credential.

Credential values are entered through the runtime's secret path and are not
stored in this ADR or emitted in logs. There is one owner and no employee
invitation roster. The operator then performs one smoke cycle: sign in, link
Slack, ingest one item, approve one item, reject one item, restart, and read
back only the approved record.

The onboarding UX is reviewed and rehearsed against disposable empty state
before the central organization is reset and re-onboarded.

## Failure and recovery

There is no formal old/new rollback matrix, checksummed whole-state snapshot,
or historical artifact retention promise. If the fresh V1 fails before it is
accepted for founder use, stop it, preserve only the diagnostic material that
is useful, fix the implementation, recreate empty state, and re-onboard. The
raw Slack, Granola, and server context is the recovery source.

Discovery of a real second user, customer-owned state, or irreplaceable data
before reset invalidates this clean-state premise and stops live execution for
a new decision. It does not require defensive machinery while those facts are
absent.

## Consequences and non-goals

Lean V1 intentionally has no historical state readability, multi-person
permission model, reviewer policy, readable search, retrieval generation,
delivery surface, audit export, audit-retention guarantee, row migration, or
compatibility rollback. Those capabilities may return only in response to a
real product need through a later decision and a new clean schema or envelope
version.

The implementation sprint must delete the superseded paths, update the source
boundary and documentation, and pass repository build, type, lint, unit,
boundary, documentation, and empty-state end-to-end checks. This accepted ADR
does not by itself perform the live stop, deletion, initialization,
deployment, provider call, or re-onboarding.
