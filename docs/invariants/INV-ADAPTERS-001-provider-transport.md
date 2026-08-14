---
schema_version: 1
id: INV-ADAPTERS-001
kind: invariant
title: Provider transport is part of the verified contract
component_ids:
  - CMP-ADAPTERS
created_at: 2026-08-13
reviewed_at: 2026-08-13
reviewed_ref: 06811c29458b0bf3aac443baf35453d3a2eb27f3
normative: MUST
enforcement_status: partial
enforcement_scope: Slack identity verification on the founder-live hardening branch
failure_pattern_ids:
  - FP-ADAPTERS-001
---

# INV-ADAPTERS-001: Provider transport is part of the verified contract

## Statement

An adapter MUST verify the exact provider method, parameter placement and
encoding, credential placement, redirect policy, success envelope, and
required response object before treating a provider operation as successful.

## Scope and failure behavior

This applies to every external provider method, including methods offered by
the same provider. An `ok` envelope without the requested bounded object fails
closed and must not produce authorization-grade evidence.

## Enforcement and verification

Slack `bots.info` transport and response assertions are implemented at the
reviewed ref. Future providers require equivalent wire-contract tests and a
sanitized real-provider probe before qualification.
