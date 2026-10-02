# Connector and context capture integration V1

**Status: implementation for source testing; production activation is deferred.**
This combines the connector implementation at `577c065` and the context
foundation at `08eb41d`. It implements the ingestion-only direction in the
[foundation design](2026-10-01-context-intake-foundation-v1-design.md).
It does not accept the proposed design or ADRs by implication.

## Implemented path

```text
Configured provider source and current read authorization
  -> provider-owned classification and typed mapping
  -> shared SourceEnvelopeV1<ContextCaptureContentV1>
  -> Authority identity, representation and policy checks
  -> authorized immutable SQLite capture OR request-only result
```

The envelope, structured payload, semantic revision builder and validation live
in `organization-processing/core`. Providers depend inward on that contract;
they do not import Authority service internals. Authority retains policy
selection, current authorization, transaction fencing and storage ownership.

`createContextSourceIntakeV1` binds a configured source identity, organization
and disposition. It serializes pulls, checks the read grant before and after a
single source pull, owns returned bytes before an asynchronous recheck, and
passes them to the existing shared intake. The default pull limit is 50; each
provider may impose a lower bound. Returned cursors are caller-owned and are
returned only after successful admission of the batch. Cancellation and identity
drift prevent admission. A read grant never implies a retention grant.

The opt-in provider profiles in
[`provider-context-intakes-v1.ts`](../../services/organization-authority/src/composition/provider-context-intakes-v1.ts)
make the integration choices explicit:

| Source | Mapping and representation | Authority disposition |
| --- | --- | --- |
| Granola | Reuses the one configured meeting adapter. Selected normalized summaries, notes and transcripts become a bounded exact snapshot, or a pointer. A source start time produces a meeting payload; otherwise a plain-text note payload. Participant refs remain opaque. | Explicit retained policy with synchronous transaction fence, or request-only |
| Jira | Uses the existing person-bound transport and fixed configured project. Preserves ticket key, status, labels, provider update time, optional priority and opaque assignee account reference. Body is an excerpt or omitted for a pointer. | Request-only; profile accepts no database or retained mode |
| Slack | Existing organization setup, personal identity links and private approval cards. | No content capture adapter is registered |

Granola still uses its existing organization API credential directly. This
integration does not add another setup, Nango sync or background poller. Jira
reuses its transport and current-grant fence, with no new OAuth implementation.
Jira date-only due dates are omitted rather than converted into invented UTC
instants. Provider display names never create directory identities.

Capture revision IDs commit semantic content and optional predecessor, excluding
poll time and adapter implementation version. An unchanged replay deduplicates;
changed metadata or representation creates a new immutable revision. A snapshot
keeps its exact full selected text; its bounded passage list need not cover every
character. Pointer metadata is still content and requires policy authorization.

## Source proof

The Authority integration tests compose actual provider implementations with
fake provider responses, then use the shared intake and real SQLite:

- [Granola integration](../../services/organization-authority/test/granola-context-source-intake-v1.test.ts): actual meeting adapter over a fake Granola API client; one configured pull, retained captures, immutable replay/change, restart and retention revocation.
- [Jira integration](../../services/organization-authority/test/jira-context-source-intake-v1.test.ts): actual bounded HTTP transport/parser over fake HTTP responses; request-only captures, grant revocation, fixed organization/disposition and no durable-admission invocation.
- [Intake composition](../../services/organization-authority/test/context-source-intake-v1.test.ts): provider-byte ownership across async checks, concurrent pull exclusion, retry cursor ownership, cancellation and identity drift.

These are local source proofs. They are not provider-live, artifact, deployment
or customer acceptance qualification. Real Slack/Nango and Granola probes from
the connector review remain separate work.

## Connector recovery repairs included

Startup recovers durable approval outcomes without reaching Slack/Nango for
terminal card redraw. Periodic presentation attempts are bounded to one terminal
card, fairly rotated and cancellable. Optional presentation failure cannot
prevent required durable processing or its search reconciliation.

Lost Slack connection rebind verifies the same app/workspace/bot, then checks
that the previous Nango connection is still absent. Current owner and local
state fences run after the last provider await and before the synchronous
credential write. This is a fresh remote observation, not an atomic transaction
with Nango. [ADR-0027](../decisions/ADR-0027-rebind-lost-nango-slack-connection.md)
retains its proposed status.

## Shared Jira connection flow

`echo-brain person tools connect --tool jira` now follows the shared browser and
wait pattern. The Jira client fragment supports status/cancel by attempt ID and
disconnect; the separate `person jira` command family and shared-server Jira
routes are removed. Provider-owned status discovers consent and verifies the
current Person, configured site and account before committing a grant. Durable
attempt status survives restart, and local cancellation wins over in-flight
completion. The client prints no consent URL or Nango connection locator.

This is connection plumbing with synthetic-provider proof. It adds no content
pull command, source registration, scheduler, retention grant or Jira production
enablement. See [the Jira provider](../../providers/jira/README.md) for commands
and the remaining live qualification boundary.

## Boundaries before activation

Neither profile is registered in the production composition root or a scheduler.
The existing meeting approval path remains the production path; a later startup
profile must select a single owner for each source cursor, rather than polling
the same source through both paths. Jira remains production-disabled. Slack bot
approval history is not a personal content read grant.

Malformed or oversized provider items fail the bounded pull without returning a
cursor. Earlier committed captures can be replayed and deduplicate, but a
permanently invalid item still requires intervention. This slice adds no retry
loop, rejection ledger or skip policy. Durable rejection accounting and cursor
progress past bad items must be designed before unattended ingestion. Existing
Granola HTTP response-size and bad-note retry concerns are not solved by a
post-fetch capture size bound.

Production activation additionally needs accepted capture policy, registered
current read and retention authorities, retention lifecycle/deletion decisions,
capacity checks and live provider qualification. The factories require these
authority ports; they do not synthesize permission from a working credential.

Graph projection, enrichment/learning, Evidence Desk, retrieval, Ask, release
audits and response schemas are unchanged. Request-only Jira captures disappear
with the request; they do not yet enrich a durable graph or feed Ask through
this capture path.
