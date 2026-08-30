---
schema_version: 1
id: FP-ADAPTERS-002
kind: failure-pattern
title: Provider accepts a write but acknowledgement differs from stored state
component_ids:
  - CMP-PROCESSING-ADAPTERS
  - CMP-PERSON-CLIENT
  - CMP-PERMISSIONS
created_at: 2026-08-13
reviewed_at: 2026-08-13
reviewed_ref: 8d61edada1cf994678aa7c2201c47ff08753ea08
origin: live
evidence_status: observed-live
status: mitigating
severity: high
first_observed: 2026-08-12
invariant_ids:
  - INV-ADAPTERS-002
  - INV-PERMISSIONS-013
evidence_ids:
  - EVID-JOB-AB-LEDGER-001
implementation_refs:
  - commit:8d61edada1cf994678aa7c2201c47ff08753ea08
regression_test_refs:
  - tests/adapters/slack-reactions-approval-surface.test.ts@8d61edada1cf994678aa7c2201c47ff08753ea08
  - tests/product/slack-reviewer-publication.test.ts@8d61edada1cf994678aa7c2201c47ff08753ea08
  - tests/adapters/slack-web-api-client.test.ts@8d61edada1cf994678aa7c2201c47ff08753ea08
---

# FP-ADAPTERS-002: Provider accepts a write but acknowledgement differs from stored state

## Plain-English summary

Slack stored one approval card but normalized a fallback newline in its create
response. ECHO compared that immediate echo byte-for-byte and threw before
saving Slack's message reference. A blind retry could have posted a duplicate.

## Boundary, trigger, and symptom

The path combined three different facts: ECHO's outbound intent, Slack's
acknowledgement echo, and Slack's durable stored message. Verification failure
discarded provider coordinates that were already known.

## Risk and root cause

Remote success can be reported locally as failure. The local/provider dual
write then permits duplicate external effects after restart or retry.

## Tempting but unsafe response

Do not broadly relax exact comparison or simply retry `chat.postMessage`.
Either response would weaken card integrity or preserve duplicate risk.

## Required behavior, recovery, and regression

Persist provider coordinates immediately, read the stored object, apply only a
versioned narrow canonicalization rule, and finalize after exact stored-state
verification. Retry reads the same reference. Crash, timeout, normalization,
mutation, restart, and concurrent-winner cases are regression-tested. The
indexed live evidence records recovery without reposting; the exact
implementation and test scope is fixed by the refs above.
