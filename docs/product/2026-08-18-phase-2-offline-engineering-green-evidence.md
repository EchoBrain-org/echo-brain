# Phase-2 offline engineering green evidence

**Status:** offline engineering checkpoint; not Phase-2 completion, live
qualification, cutover authorization, or deletion authorization.

**Implementation commit:**
`fd3e2a7191fafa493376b14c118f4c9ef8772b42`.

**Checkpoint name:** `phase2/offline-engineering-green`.

**Decision source:**
[ADR-0002](../decisions/ADR-0002-external-oidc-person-sessions.md).

This checkpoint records the minimum lean-v1 foundation completed before real
meeting batches. It adds no generic identity-provider framework, policy
engine, browser credential handoff, administrator exclusion browser, local
queue, key ring, or destructive compatibility migration.

## Landed foundation

- The config-free Person client uses explicit OIDC callback-result import and
  bearer requests. Its only credential-shaped state is
  `$HOME/.local/share/echo-brain/person/session.v1.json`, inside a `0700`
  directory with `0600` current-user files. Refresh is single-claim,
  one-attempt, crash-safe, and cannot overwrite a newer explicit login.
- The client is 1,703 non-test TypeScript LOC across six files plus 24 root-CLI
  integration lines: 1,727 direct machine LOC. The exact breakdown is in the
  [machine-boundary audit](2026-08-16-machine-boundary-audit.md#fate-stays-machine--1727-direct-loc-at-lean-v1-checkpoint).
- Person Slack linking is additive V2 identity proof. It uses the existing
  server-held Slack tool credential, binds the active Person/session and exact
  observed Slack replier, and creates or reuses only the external identity
  link. It creates no adapter binding, installation enrollment, permission
  grant, or local Slack credential, and it does not reinterpret V1 bytes.
- The member valve now has an owning-Person exact-source list and one explicit
  exact-target administrator break-glass read. Additive Authority migration
  `0012` records request/response digests, count, decision, and actor evidence
  before byte release; it has no source, instance, scope, or external-ID
  columns. Generic administrator queries, JSON routes, dashboard, read-only
  inspection, and both stopped query-audit exports are sentinel-proved not to
  disclose exclusion coordinates.
- The proposed rung-1, actor-version, processing-service, and `INV-10`
  constitution changes are recorded in the
  [amendment proposal](2026-08-18-organization-permission-constitution-server-core-amendment-proposal.md)
  and its [pending review submission](2026-08-18-organization-permission-constitution-server-core-amendment-review.md).
  They are not in force.
- The exact six-table, 29-method Authority retirement is measured and mapped
  in the [Phase-4b sizing ledger](2026-08-18-phase-4b-authority-retirement-sizing-ledger.md).
  No table or method is retired by this checkpoint.

## Verification at the implementation bytes

The repository gate passed with:

- boundary, documentation, TypeScript, and ESLint checks green;
- primary suite: 149 files / 1,483 tests green; and
- product suite: 36 files / 360 tests green.

Independent read-only reviews found no remaining blocker in the Slack slice,
thin-client credential/crash boundary, exclusion privacy/audit slice, or the
combined lean-v1 scope. Focused exclusion evidence also passed 121/121 tests;
the final thin-client and hermeticity focus passed 16/16.

No live IdP, Slack workspace, meeting provider, production credential,
production database, or real meeting batch was used. No external network or
destructive Phase-3/4 action was performed.

## Gates deliberately still open

This is not `phase2/complete`. The following remain open:

- canonical Phase-1 real-corpus evidence: at least 30 real batches across at
  least three meeting types;
- live issuer/client/redirect/tenant/algorithm/secret verification and the
  live browser sign-in experience;
- real Slack identity-link validation and the final browser flow;
- constitution review acceptance;
- additive organization-record, control-plane, protocol, query-audit, and
  surviving-operation Person/Authority actor re-keying;
- real-member daily-loop qualification; and
- every Phase-3 drain, credential movement, key retirement, hold, and Phase-4
  deletion gate.

`organization rebind` remains the proved recovery path through the Phase-3
rehearsal. `jsonl-outbox` also remains: today it is a durable local recovery
and air-gap surface. It becomes incompatible with the final crash-only thin
machine only after server delivery is authoritative, but deleting it before
equivalent server recovery is proven would remove a live fallback rather than
retire redundant machinery.
