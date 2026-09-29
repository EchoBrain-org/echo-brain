---
schema_version: 1
id: ADR-0022
kind: decision
title: Agentic Ask is the only Ask
component_ids:
  - CMP-ORGANIZATION-AUTHORITY
  - CMP-PERSON-CLIENT
  - CMP-PROCESSING-ADAPTERS
created_at: 2026-09-28
reviewed_at: 2026-09-28
reviewed_ref: 201b3be22f6f5940efaa3a53fae9eb8d113785b6
status: accepted
supersedes: []
superseded_by: []
updates:
  - ADR-0007
  - ADR-0015
  - ADR-0019
  - ADR-0021
---

# ADR-0022: Agentic Ask is the only Ask

## Context and options

[ADR-0019](ADR-0019-agentic-ask-v1.md) added the agentic Ask (`/v3/person/ask`,
V4 answers) beside the single-batch V1 and V2 routes, behind an
organization capability that was off by default. Staging now runs only the
agentic loop ([RFC-0003](../rfcs/RFC-0003-multi-source-agentic-ask.md)),
and keeping three Ask paths meant three answer contracts, two audit writers
and a client that negotiated between them. On 2026-09-28 the founder chose to
retire both V1 and V2 and make the agentic Ask the only Ask. The options were
retiring V2 only (V1 was already unused by current clients) or keeping V2
behind the capability as a fallback.

## Decision and consequences

**One Ask.** The Authority serves Ask only at `POST /v3/person/ask`, with V3
requests and V4 answers. `POST /v1/person/ask` and `POST /v2/person/ask` are
gone and answer 404. The retrieval-grounded answer composer, its answer-audit
writer and the V1/V2 routes are deleted; the git tag `ask-v2-final` names the
last commit that has them. Structured-generation types the loop still uses
move to `answer-composition/structured-generation-v1`.

**No capability switch.** The agentic Ask is composed whenever an answer model
is configured. `ECHO_AGENTIC_ASK_V1` is ignored; the release record's
`agentic_ask_v1` field still materializes it, so older records keep their
bytes. `GET /v3/person/capabilities` reports `agentic_ask_v1: true` exactly
when an answer model is configured. The small-scope shortcut keeps its own
switch. The Person client calls `/v3/person/ask` without probing
capabilities, and the desktop app renders only V4 answers.

**Cited originals keep their door.** `POST /v2/person/ask/source` and
`person ask-source` still read a cited original's evidence packet. The route
moves to its own module; its contract and path are unchanged.

**A deadline that fits the proxy.** Cloudflare drops an origin response after
100 s (HTTP 524), so the loop's hard deadline is 90 s, with 25 s reserved for
the answer and 25 s per research step. The client waits 135 s so a server
timeout is reported as one. A hard server deadline returns the existing
HTTP 503 `unavailable` response so the desktop offers a manual "Try again";
its journey and audit still record a timeout. The client does not automatically
restart the whole question.

**Bounded recovery.** A model call may get one additional attempt, within the
same 90-second request and 24-call limit. Timeouts, transport failures,
408/429/5xx responses and provider errors inside a successful HTTP response
retry unchanged; invalid JSON, schema or truncated output gets repair guidance.
Other HTTP rejections, explicit refusals and content filtering stop further
generation for that request. Local configuration/contract errors and unknown
exceptions remain terminal. Retrying cannot repair invalid caller inputs.

Every attempt revalidates the released evidence and then recomputes its timeout
in whole milliseconds, retaining the answer and finalization reserves. When
generation cannot finish, the response may show up to three fully released
items from the bounded writer evidence set, in its existing citation-first
order. This includes full search hits even if research stopped before opening
or citing them. With no usable evidence, the existing V4 no-evidence outcome
remains, but an interrupted search is identified in the visible gap instead of
claiming that a completed search found nothing. Permission, snapshot, audit,
cancellation and deadline failures still suppress publication. The audit's
existing `repairs` count includes both unchanged retries and output repairs;
only admitted extra model calls increment it.

**Throughput routing.** The loop makes several sequential model calls, and
OpenRouter's default routing picked slow providers. Ask model requests now set
`provider.sort: "throughput"` beside `require_parameters` and
`data_collection: "deny"`. Only the route order changes; no provider that
collects data becomes eligible.

**Outcomes.** ADR-0021's authorship-unsupported answer does not exist in V4.
An off-scope project answer offers no wider ask; a not-found project answer
still offers "Ask across everything you can see".

Clients that know only `/v2/person/ask` fail with 404 and must update.
Answer-quality gates written for V3 text, such as the demo rehearsal answer
gate, need V4 versions before they can qualify a candidate again.

## Migration, rollback, and evidence

No stored data changes. Old answer-audit rows stay in the audit table; nothing
writes new ones. Rollback is a release of the tag `ask-v2-final` (server and
clients together), not a switch.

Evidence: `person-answer-v3-http.test.ts` checks that the V1 and V2 paths are
gone and the capability follows the answer model;
`organization-authority-service-cli.test.ts` checks the ignored flag;
`person-source-evidence-route.test.ts` and
`person-source-evidence-http.test.ts` cover the source door;
`person-client.test.ts` covers the client; the desktop unit and end-to-end
suites cover V4 rendering; `npm run test:capacity` and `capacity:checkpoint`
exercise the agentic route with a deterministic model.

Recovery evidence: `agentic-ask-v1.test.ts` exercises failure classification,
evidence fallback and slow permission checks; `agentic-ask-v1-finalization.test.ts`
keeps the final authorization and audit boundaries terminal;
`agentic-ask-openrouter-timeout-contract.test.ts` drives the real kernel and
provider adapter with local scripted responses and a fractional clock.
