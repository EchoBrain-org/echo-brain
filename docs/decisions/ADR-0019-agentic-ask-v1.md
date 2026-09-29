---
schema_version: 1
id: ADR-0019
kind: decision
title: Bounded agentic Ask and the evidence desk
component_ids:
  - CMP-ORGANIZATION-AUTHORITY
  - CMP-PERMISSIONS
  - CMP-PERSON-CLIENT
created_at: 2026-09-27
reviewed_at: 2026-09-27
reviewed_ref: 83c8eb63aed78ba760678294ecf7fef863743e06
status: accepted
supersedes: []
superseded_by: []
updates:
  - ADR-0007
  - ADR-0015
---

# ADR-0019: Bounded agentic Ask and the evidence desk

## Context and decision

One literal search misses multi-part and keyword-free questions. Adopt
[RFC-0002](../rfcs/RFC-0002-agentic-ask-v1.md) for a new V3 Ask route, with the
lean clarifications recorded there. A model-free Layer 3 evidence desk owns
authenticated scope, bounded search and open, exact release receipts and
snapshot checks. Layer 4 plans, searches, judges and writes separate parts
using only desk-released evidence, with deterministic evidence fallback.

The request has at most three rounds, twelve model calls including repairs,
five parts and forty evidence items within 49,152 bytes. Every model call and
final response revalidates all releases, including newly acquired items and
metadata. Authorization, audit and snapshot failures terminate the request;
malformed model output permits one repair within the global budget and then
falls back to released evidence. Cancellation stops new work and publishes no
answer. Decision status, citation identities and private markers remain
source-owned.

V1 and V2 retain ADR-0007 and ADR-0015's existing contracts. This decision
changes their single-batch/no-loop restriction only for V3. It does not grant
models membership, privileged storage access, cross-request memory, write
tools or arbitrary provider selection. It adds no source or index migration.

## Rollout and evidence

An organization-scoped capability is off by default. Clients negotiate V3 and
otherwise use V2; errors during V3 execution never silently downgrade. The
evidence CLI uses the same desk over authenticated HTTP, with a fresh scope
and snapshot for each invocation. The existing audit table holds versioned
content-free loop receipts while old rows and readers retain their contract.

The RFC's offline checks precede bounded staging testing. Source tests, live
model quality, deployment and qualification are separate claims. Candidate
release, human canary approval and final release decisions continue through
the existing Authority operator playbook. Rollback disables the capability.
