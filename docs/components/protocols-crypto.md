---
schema_version: 1
id: CMP-PROTOCOLS-CRYPTO
kind: component
title: Protocols and cryptography
owners:
  - unassigned
component_ids:
  - CMP-PROTOCOLS-CRYPTO
created_at: 2026-08-13
reviewed_at: 2026-08-13
reviewed_ref: 808ac89eaf3e8eba529b356bd80d4509b9a2a293
invariant_ids:
  - INV-IDENTITY-002
failure_pattern_ids:
  - FP-IDENTITY-002
---

# Protocols and cryptography

## Responsibility

| Package | Responsibility |
| --- | --- |
| `federation-protocol` | Canonical JSON, signatures, signed-document primitives, and identifiers |
| `organization-protocol` | Signed organization facts and record envelopes |
| `organization-api` | HTTP request and response contracts |

Protocol packages define values and verification contracts. They do not own
private-key lifecycle, provider credentials, persistence, network listeners,
or authorization policy.

## Documentation requirements

Any protocol or cryptographic change must state:

- issuer, subject, audience, purpose, and authoritative identifiers;
- exact canonicalization and signed bytes;
- accepted algorithms, key descriptors, and rejection behavior;
- expiry, not-before, replay, clock-skew, and revocation rules;
- version negotiation and mixed-version behavior;
- key generation, storage, access, rotation, retirement, and destruction;
- migration order and rollback boundary; and
- conformance fixtures and negative tests.

## Current references

- [One-organization workspace boundaries](../architecture/organization-workspace-boundaries.md)
- [`packages/federation-protocol/`](../../packages/federation-protocol)
- [`packages/organization-protocol/`](../../packages/organization-protocol)
- [`packages/organization-api/`](../../packages/organization-api)
- Protocol tests are colocated under each package's `test/` directory.
