# Shared context intake foundation worktree

This worktree prepares ECHO's shared context intake foundation. Each tool keeps
its provider adapter, while incoming source context converges on one logical
intake contract with explicit retention and processing choices. The eventual
first implementation should prove capture, graph discovery, authorized evidence
release, and a cited Ask answer together.

**Current authorization is worktree preparation and design only.** This brief
does not authorize implementation. The agreed direction below is a target;
it does not amend accepted ADRs or claim that the current code implements it.

## Worktree and dependency

| Item | Value |
| --- | --- |
| Worktree | `.worktrees/context-foundation` |
| Branch | `feat/context-foundation-v1` |
| Preparation base | `c9b3af6b37d426e1891fa734d4425a44ce0530bd` |
| Dependency | Draft [PR 250](https://github.com/EchoBrain-org/echo-brain/pull/250), branch `review/connectors-20261001` |
| Initial deliverable | Design and implementation handoff for one backend flow using fixtures |

The base is a fixed snapshot of an unmerged PR under Claude's review, not an
accepted or qualified release. Claude owns that review and its connector fixes.
Do not edit its worktree, cherry-pick unfinished fixes, or merge its branch here
during preparation. Before implementation, reconcile this plan with the final
review and establish ownership of any shared files. Before a foundation PR is
opened, integrate the finalized dependency so connector changes are not presented
as foundation changes.

## Current architecture and proposed extension

[ADR 0014](../decisions/ADR-0014-unified-source-ingestion-and-document-custody.md)
already establishes `SourceAdapterV1`, `SourceEnvelopeV1`,
`SourceAdmissionScopeV1`, and `pullAndAdmitSourceBatchV1` for retained inputs.
Meeting exports and accepted Person originals use this admission pattern.
Provider-specific parsing and specialized downstream processing remain separate.

Live evidence currently follows a different, request-local path through the
[shared connector contracts](../architecture/connector-contracts.md) and the
Evidence Desk. PR 250 contains an opt-in Jira Ask composition path that is
disabled by default; it does not retain ticket bodies or add a durable ticket
graph. Slack onboarding supplies identity and an
approval surface; it does not supply Slack conversation intake. Granola follows
the existing meeting export and approval path with its direct API adapter.

The proposed extension is one logical intake boundary for incoming **source
context**, including retained and temporary observations. This is an internal
contract and coordinator, not one provider endpoint, one transport, or a giant
function. Uploads, pulls, and future webhooks may have different external doors.
Their context must receive the same identity, revision, provenance, bounds, and
Authority policy checks before its selected downstream disposition.

Temporary live evidence must participate without being forced into persistent
source admission. The design must show exactly how the shared gate composes
with the existing audited live-reader boundary and preserves its request binding,
citation validation, cancellation, and revalidation. Existing live adapters
remain unchanged until ownership and the necessary design decisions are settled.

## Layer boundaries

| Layer | Target responsibility |
| --- | --- |
| Layer 1 | Durable source identities, permitted captures and observations, alongside authoritative people and human-act records in their separately owned stores |
| Layer 2 | Rebuildable graph and search representations grounded in retained inputs and their exact revisions |
| Layer 3 | Evidence Desk release under the asking person's current identity, scope, and permissions, with audit before release and later revalidation |
| Layer 4 | Request-local agentic Ask using only Desk-released evidence and server-owned citations |

Today, the organization record log is a narrower Layer 1 contract for signed
human approval and rejection acts. Generic source custody already exists outside
that log. The broader logical Layer 1 above must be documented as a proposed
architecture extension; raw captures must not be inserted into approved-record
contracts or presented as approved facts. Existing signed bytes, rejected-act
semantics, and accepted decision records remain intact.

## Context model

The foundation uses people, items, and observations as its conceptual model.
Identity, content kind, storage representation, truth status, and permission are
separate dimensions.

- **People:** use the authoritative onboarding directory and verified external
  account links. A name, email mention, meeting participant, or provider actor
  does not create an ECHO membership or merge identities.
- **Items:** use stable source coordinates and immutable captured revisions.
  Types may include documents, notes, messages, tickets, meetings, decisions,
  and tasks; an item does not acquire meeting fields merely to enter ECHO.
- **Observations:** record supported source relationships or events with their
  origin and time semantics. An activity that happened is distinct from a task
  someone should perform or a decision someone approved.

The first contract must support pointer-only, bounded excerpt, and full-snapshot
representations. A pointer can carry identifying metadata, but cannot supply
invented answer text. External tools remain authoritative for mutable external
state: a captured Jira revision is an observation, not ECHO taking ownership of
the ticket's current lifecycle. Derived text, chunks, graph projections, and
indexes must reference their input revision and processor contract.

Provider credentials, generated answers, user queries, and control callbacks
are not source captures merely because they travel through ECHO. Ask activity
may eventually supply permitted feedback events, but this phase does not retain
queries or learn new facts from generated answers.

## Intake and retention rules

The shared gate must validate the source identity, capture revision, content
digest, source anchors, provenance, size bounds, and cancellation. Authority
supplies custody, access policy, and retention disposition outside provider data.
Repeated identical revisions deduplicate; changed content under an existing
immutable revision conflicts. A duplicate does not mean all downstream work
has finished.

The retention decision distinguishes:

- **Retained observations:** persist only the permitted pointer, excerpt, or
  snapshot. These can supply rebuildable Layer 2 inputs.
- **Request-only observations:** keep content and handles in request memory.
  Preserve only the audit fields permitted by the existing release contract;
  do not persist titles, pointers, relationships, or graph edges by default.

A successful OAuth flow or read grant does not authorize retention or sharing.
A content type selects parsing and processing; it does not grant access. The
common gate must never replace the Desk's current read authorization. Meetings
may retain their automatic analysis and human approval policy; documents can
be indexed without decision extraction; live tickets can remain temporary.

## Graph foundation

Propose a small, deterministic graph projection from retained captures first.
Every relationship must identify its supporting source revision and anchor or
exact source metadata. Relation meanings must distinguish observations from
human-approved claims. Do not build an unrestricted ontology, infer people
matches, or implement a task lifecycle in this phase.

Graph generations must identify their complete input revisions and projection
version. An approved-record head alone cannot identify a generation containing
other source captures. A changed input must produce a new representation; a
restart or rebuild must recover from durable inputs. Define bounded discovery,
failure isolation, and stale-generation behavior before implementation.

Relationships and discovery metadata must obey their supporting evidence's
access and retention rules. Cross-source links must not reveal restricted
endpoints or combine permissions into a wider audience. Graph results are
retrieval candidates, not permission grants, membership facts, or direct model
inputs. Current authorization and source visibility remain mandatory at release.

This establishes a foundation for improvement through additional permitted
captures. Automatic feedback ranking, personalization, model training, and
self-modifying graph rules are deferred; not every Ask necessarily changes or
improves the durable graph.

## Design decisions before implementation

Record an explicit versioned design before widening current contracts:

1. Define the broader Layer 1 boundary, the ownership of each store, supported
   retention and deletion rules, and whether existing admission tables suffice.
   Do not assume a database change is unnecessary or reset state at startup.
2. Define the graph contract, input manifest, visibility treatment, relation
   grounding, and rebuild behavior. [ADR 0010](../decisions/ADR-0010-disposable-related-atom-projection-v1.md)
   authorizes only a narrow projection of untyped approved-atom pairs and
   explicitly excludes a general typed graph. Preserve that accepted behavior
   while proposing the new capability separately.
3. Define how live readers participate in the common intake gate without new
   retention or release authority. Respect the request-only constraints in
   [RFC 0003](../rfcs/RFC-0003-multi-source-agentic-ask.md) and the still-proposed
   [Jira ADR 0026](../decisions/ADR-0026-jira-person-live-evidence-nango.md).
4. Identify any API, schema, or production composition changes separately.
   A preparation brief cannot silently accept a proposed ADR or expand an
   invariant's enforcement scope.

## Implementation sequence after authorization

1. Finalize the design decisions and file ownership against Claude's review.
2. Define the provider-neutral intake envelope and retained/request-only
   disposition, reusing existing source identity and admission primitives.
3. Prove immutable retained capture, explicit custody and access resolution,
   replay, revised evidence, and bounded downstream recovery.
4. Add the versioned graph projection and bounded discovery over permitted
   retained captures, without altering the existing approved-atom projection.
5. Compose discovery, the existing evidence-release boundary, and the existing
   Ask loop in a backend fixture. Preserve source anchors and citations through
   the answer. Model output must never write canonical provenance or truth.
6. Prove the request-only route through the common gate with no durable context
   or graph writes. Real provider activation follows later qualification.

The first end-to-end proof should use already-supported Authority custody and
audience policies with synthetic provider data and a scripted model. It must
exercise real persistence and release components rather than mock away the
permission boundary. Provider adapters can later map to the same contract under
explicit retention decisions; preparing this worktree does not enable them.

## Acceptance evidence

| Scenario | Required outcome |
| --- | --- |
| Pointer, excerpt, and full capture | Each uses the same intake contract; only permitted retained bytes become durable |
| Replay and revised source | Identical revision deduplicates; conflicting bytes fail; a new revision is separately discoverable |
| Capture through Ask | Authorized graph discovery leads to Desk-released source evidence and a valid cited answer |
| Restart and rebuild | Captures survive restart; graph reconstruction uses exact durable inputs |
| Access changes | Removed membership, audience access, or live grant prevents release and invalidates previously released context before later model calls and final response |
| Private relationships | Hidden endpoints and supporting metadata do not leak through graph search, counts, snippets, or traversal |
| Request-only read | No source content, item metadata, or relationships become durable graph inputs |
| Bad or oversized input | Reject malformed, conflicting, unanchored, or oversized values without inventing evidence or causing a permanently poisoned queue |
| Audit or projection failure | Audit failure prevents release; projection failure leaves a safe generation and permits unrelated processing to continue under the documented policy |

After authorized code changes, run focused proofs, architecture and docs checks,
and `npm run check`. Provider rehearsals and production release remain separate
qualification steps. The preparation commit itself requires only documentation
validation and a diff confirming that no implementation files changed.

## Ownership and agent handoff

Treat PR 250's provider transport, Nango behavior, onboarding, identity binding,
Slack approvals, Jira routes, current Authority composition, Person surfaces,
deployment scripts, and review fixes as reserved for Claude. Do not alter those
files here during preparation. This is a conservative reservation, not a claim
that a file-by-file agreement has already been negotiated.

Candidate foundation work belongs in provider-neutral contracts and processing,
new graph representations, explicit generic Authority policy ports, and fixture
proofs. Consume the existing admission and Desk interfaces first. Changes to
existing shared files require ownership coordination before editing. Follow
[workspace boundaries](../architecture/organization-workspace-boundaries.md),
[provider boundary rules](../invariants/INV-ADAPTERS-005-provider-semantics-at-boundary.md),
[source-owned grounding](../invariants/INV-ADAPTERS-004-source-owned-grounding.md),
and [the Layer 3 release invariant](../invariants/INV-PERMISSIONS-015-layer-3-person-release-boundary.md).

An agent entering this worktree should read this brief and the repository's
`AGENTS.md`, report any design conflict, and stay in design mode until the user
explicitly starts implementation. Do not build a second provider pipeline, a
second permission engine, or a parallel meeting-shaped context model.
