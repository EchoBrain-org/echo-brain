---
schema_version: 1
id: FP-IDENTITY-004
kind: failure-pattern
title: Missing provider identity is repaired by blind backfill
component_ids:
  - CMP-IDENTITY-ACCESS
  - CMP-ORGANIZATION-AUTHORITY
  - CMP-OPERATIONS-RELEASE
created_at: 2026-08-13
reviewed_at: 2026-09-27
reviewed_ref: 83c8eb63aed78ba760678294ecf7fef863743e06
origin: live
evidence_status: observed-live
status: retired
severity: critical
first_observed: 2026-08-12
invariant_ids:
  - INV-IDENTITY-001
  - INV-IDENTITY-004
failure_pattern_ids:
  - FP-IDENTITY-001
evidence_ids:
  - EVID-JOB-AB-LEDGER-001
implementation_refs:
  - commit:77b7744b46a912b9154c218b3a036e8552d7180e
regression_test_refs:
  - services/organization-control-plane/test/control-plane-migrations.test.ts@77b7744b46a912b9154c218b3a036e8552d7180e
  - services/organization-authority/test/organization-integrations-application.test.ts@77b7744b46a912b9154c218b3a036e8552d7180e
---

# FP-IDENTITY-004: Missing provider identity is repaired by blind backfill

## Retirement

Retired. The Slack app-identity promotion migration, the integrations
repository and owner re-onboarding path that ran it, and both linked tests
were deleted with the retired server lineage in `59ee182b` (lean: delete
retired server lineage). The control-plane database at the reviewed ref opens
its clean baseline without importing or applying migrations, and the current
Slack tool-connection contract in
[`organization-tool-connection-contracts-v2.ts`](../../providers/slack/server/src/organization-control-plane/application/organization-tool-connection-contracts-v2.ts)
requires `provider_app_id` on every connection. No historical null app ID
remains to repair.
[`INV-IDENTITY-004`](../invariants/INV-IDENTITY-004-provider-identity-migration.md)
is retired with it. The pinned regression refs remain historical proof at
their commit. The pattern below is kept as history. It applies again if a
future required identity field is added over existing connections, bindings,
or grants.

## Plain-English summary

Historical Slack connections legitimately stored a null app ID under the old
schema. Filling that field from configuration or a message would rewrite an
audited security binding without fresh provider proof.

## Boundary, trigger, and symptom

A stronger downstream identity invariant is introduced after connections,
bindings, and grants already exist. Ordinary migration machinery is tempted to
invent the new field or create a parallel connection.

## Risk and root cause

The system can bind existing authority to the wrong provider application,
split stable identities, or make rollback incompatible with the new database
state.

## Tempting but unsafe response

Do not run a direct SQL backfill, accept caller-supplied identity, or weaken
the verifier for legacy rows.

## Required behavior, recovery, and regression

Require owner-authorized re-verification against authoritative endpoints and
atomically promote every exact binding while preserving stable IDs and
appending audit. Reject partial and malformed promotion. The pinned tests
covered migration, multi-binding atomicity, and no in-place fallback. The
indexed live evidence
records the promotion outcome; the exact implementation and test scope is fixed
by the refs above.
