---
schema_version: 1
id: ADR-0006
kind: decision
title: Permission-aware clean V1 completion
component_ids:
  - CMP-PROCESSING-ADAPTERS
  - CMP-ORGANIZATION-AUTHORITY
  - CMP-IDENTITY-ACCESS
  - CMP-MEETING-PROCESSING-CORE
  - CMP-PERMISSIONS
  - CMP-OPERATIONS-RELEASE
  - CMP-PROTOCOLS-CRYPTO
created_at: 2026-08-22
reviewed_at: 2026-08-22
reviewed_ref: 815c41c7549a3985d1b30573bd3aabd997cfb9b1
status: accepted
supersedes:
  - ADR-0004
superseded_by: []
updates:
  - ADR-0001
  - ADR-0002
---

# ADR-0006: Permission-aware clean V1 completion

## Disposition and correction

The founder accepted this correction on 2026-08-22. N is already at least two,
so ADR-0004's sole-user premise and its conclusion that permission-aware reads
are unnecessary are false. This decision supersedes ADR-0004 while preserving
its clean-state, current-only, and no-compatibility decisions. No old
application row, database, compatibility bridge, historical envelope,
migration chain, backfill, or legacy reader enters the new lineage. ADR-0005
remains superseded; this decision adopts the already-current V2 policy meanings
without reviving ADR-0005 as a lifecycle authority.

`reviewed_ref` is the exact authorized implementation base. Acceptance neither
performs nor authorizes deployment, live state mutation, provider calls, or the
founder's real re-onboarding.

## Decision

The clean V1 retains permission-aware Layer 1 through Layer 3 reads. Active
organization members may read `organization-member-readable-person-v2`
content. `restricted-reviewer-person-v2` content is readable only by the exact
reviewer principal and membership tenure. Layer 1 listing and Layer 2 search
remain the two availability paths behind one Person command: `person records`
and `person records --query`. Layer 2 reconciles automatically at startup and
after record-head advancement and is never built by a query.

The pipeline keeps only current top-level V4. Its canonical bytes do not
change. Source custody, provider-action commitments, authorization proof,
integration audit, exact Authority reproof, approval-only append-atomic policy
facts, Layer 2 provenance and exact-generation binding, current-Person
authorization, the final release fence, and INV-IDENTITY-005's minimized exact
response digest remain one identity proof spine. Rejection exposes no record
or search atom, and restart recovery cannot duplicate the V4 append.

Layer 2 search responses preserve their machine-verifiable identity: the
generation and exact record head at request level, and atom, record, policy,
kind, and text at item level. Those bytes are included in the existing final
release response digest. Ranking, query, scope, authorization, policy, and
release semantics are unchanged.

## Lean audit and Layer 4 boundary

The Authority genesis has exactly one Person read-audit table. The V1 writer
appends only minimized `record_read` witnesses and stores no query, response
body, or bearer. There is no retention or expiry promise, export, audit
maintenance CLI, second audit table, legacy proof version, or duplicate
canonical proof body.

The sole schema reservation for future work is `context_kind`, constrained to
`record_read` or `answer_composition`, plus nullable `prompt_sha256` and
`answer_sha256`. A record read requires both hashes to be null; answer
composition requires both exact SHA-256 values. These three fields are bound
into the canonical row commitment. V1 has no answer-composition writer, type,
route, endpoint, handler, prompt, model call, service, agent, tool, stream,
citation generator, package, or dependency. This unused reservation is not
Layer 4 runtime authorization and is the sole exception to the otherwise
closed genesis schema.

Layer 3 remains the only Authority content-release boundary. Models, agents,
adapters, services, and provider identities have no read authority. Future
answer synthesis requires a separately accepted design and may operate only
under the exact authenticated Person and active membership for that request,
using only atoms Layer 3 released to that caller in that request.

## Consequences and verification

Clean fixtures contain an owner and a second active employee. Tests prove both
policy meanings, rejection non-disclosure, exact-head automatic reconciliation,
restart idempotency, metadata-preserving responses, the minimized read audit,
and the absence of Layer 4 production paths and dependencies. The supported
disposable rehearsal is clean-founder bootstrap, idle clean-live serve, Person
login, Person Slack link, stop, clean-founder finalize, then active clean-live
serve. It passes no generated IDs between commands and makes no live provider
call.

Changes to V4 bytes, compatibility behavior, audit expansion, policy meanings,
or Layer 4 execution require a later decision. This sprint does not redesign
Slack's ambiguous-post crash window, add a general retry framework, HA,
deployment hardening, production cutover, or an onboarding product flow.
