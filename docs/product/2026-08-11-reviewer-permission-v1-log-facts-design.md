# A: Reviewer permission minimum V1 with append-atomic log facts

**Status:** post-review split candidate. This document extracts the smallest
coherent reviewer self-read from the previously combined Layer 2/Layer 3
design. It awaits a fresh invariant and code-grounding review because the
index placement changed. It is not approved, implemented, merged, deployed,
or released.

**Code baseline:** `aaae7509f6b62434b1f23e811b82f3926c38eae3` on
`feat/organization-permission-pilot-v1-clean`. Code and schemas remain
authoritative for landed behavior.

**Split companion:**
[B: Trusted permission-aware searchable Layer 2](2026-08-11-trusted-permission-aware-searchable-layer-2-design.md).
B is not a prerequisite for A.

**Builds on:**

- [Organization permission architecture](2026-08-09-organization-permission-architecture.md)
- [Permission pilot v1 contract](2026-08-10-permission-pilot-v1-contract.md)
- [Org decision record: append and derive](2026-08-07-org-decision-record-append-derive-design.md)
- [Approval surface v2 direction](2026-08-10-approval-surface-v2-direction.md)

## Decision

The first reviewer-only access index lives in `record-log.sqlite`, not
`record-derived.sqlite`.

It is a policy-specific, text-free, append-only physical index committed in
the same transaction as the verified immutable record. It is a Layer 1
adjunct, not Layer 2, not a permission-effect ledger, and not an authorization
decision. Every positive candidate is re-proved from its canonical Layer 1
envelope before content is released.

This placement is deliberate. Reviewer V1 needs only facts derivable from one
record in isolation. It does not need search, embeddings, ranking, graph
traversal, or any other cross-record computation. Keeping the index beside the
log makes record and index publication atomic and avoids introducing a mutable
derived-store readiness contract for a feature that does not use Layer 2's
unique capability.

## Outcome

> A current active member can retrieve recent items from a newly approved
> reviewer-marked record only when that member is the exact principal and
> exact membership that performed the approval.

This is a self-retrieval and authorization-kernel gate. It does not claim:

- that current Layer 2 is permission-aware;
- cross-person sharing or general permissions;
- search, discovery, ranking, or company-brain readiness; or
- that a reviewer fact alone authorizes content.

The data path is:

```text
verified reviewer-v2 envelope
  -> one Layer 1 append transaction
     -> canonical immutable record
     -> text-free immutable facts for its released items
  -> exact (policy, principal, membership) fact lookup
  -> current-Person resolver
  -> request-local content binding
  -> canonical reprojection of only referenced Layer 1 records
  -> final Person recheck + exact-response audit commit
  -> immutable response bytes
```

The landed two-person pilot remains frozen. Pilot-v1 records are never
reviewer-V1 candidates, reviewer-v2 records never satisfy pilot eligibility,
and neither route falls back to the other.

### Founder confirmations before implementation

1. Confirm or edit the exact human consequence below.
2. Confirm the proposed 180-day query-decision audit retention period.
3. Confirm that pilot retirement remains outside this V1.
4. Accept the scoped append-atomic fact rule and proposed consequence-binding
   invariant below.

## Closed scope

V1 includes:

- one exact reviewer-only content policy;
- one narrow reviewer-policy approval-surface-v2 mode that retains the
  existing Slack approve/reject interaction while changing its frozen input
  and verified presentation;
- one new exact envelope version;
- one append-atomic, text-free reviewer fact index in the log database;
- one deterministic, text-free compatibility outcome in the existing derived
  follower so reviewer-v2 text never enters its broad v1 store;
- one signed, self-only recent read;
- one current reviewer resolver;
- one pre-response query-decision audit; and
- one founder-live test in which the reviewer succeeds and another current
  member receives no items.

V1 excludes:

- any reviewer serving dependency on `record-derived.sqlite`;
- attendee, invitee, participant, speaker, email, or name-based access;
- identity attestations or correction/effect ledgers;
- grants, requests, teams, roles, collections, links, or a readable floor;
- legacy-history opening or fact backfill;
- discovery, search, ranking, counts, cursors, pagination, or explanations;
- reverse `who`, public `can`, or target-item authorization oracles;
- models, agents, MCP, tools, or Layer 4;
- a general approval workbench, policy selector, multi-policy surface, or
  other approval-surface-v2 mode beyond this exact reviewer card;
- cross-channel or cross-device approval;
- a generic access-index framework, dual log/derived indexing, or migration to
  B; and
- multi-process writers, WAL conversion, optimistic authorization, or caches.

## Exact approval and record-admission contract

### Human consequence

The existing Slack card retains one approve and one reject reaction. Before
the reaction instructions it contains one exact `plain_text` block:

```text
Approving records this package under restricted-reviewer-v1. Only you, the approving reviewer, may later read its decisions, actions, and rationales while this exact reviewer membership remains active.
```

The block ID is exactly
`echo-approval-<approval_id>-reviewer-policy-v1`, and `emoji` is false.

The top-level accessibility fallback is a complete deterministic alternative
presentation. It joins these lines with LF, in frozen item order, using the
lowercase wire kind:

```text
Decision brief awaiting approval.
Title: <exact card_title>
<kind>: <exact item text>
...one line for every frozen item...
Approving records this package under restricted-reviewer-v1. Only you, the approving reviewer, may later read its decisions, actions, and rationales while this exact reviewer membership remains active.
```

There is one positive policy. A selector, workbench, or second positive choice
adds no V1 value. No reviewer-v2 producer or read route ships before this
consequence is verified end to end.

### Frozen pre-approval release draft

Before posting the card, the decision-node processor freezes canonical
`reviewer-release-draft-v1` bytes:

```text
schema_version = 1
kind = reviewer-release-draft-v1
approval_id
card_title
items = 1..10 exact ordered {signal_id, kind, text} values
```

Kinds are exactly `decision`, `action`, or `rationale`. Title and item text are
NFC, single-line, control-free, non-empty, and bounded to 150 and 240 Unicode
scalar values respectively. `signal_id` is the already frozen protocol signal
identity, is unique within the draft, and is not rendered or returned publicly.

Draft order is exactly the current projector's canonical order: decisions in
payload order, then actions in payload order, then rationales in payload order.
The final envelope preserves each `signal_id`, kind, text, collection, and
within-collection order. The internal atom identity remains the landed
`derivedAtomId(record_hash, signal_id)`; A introduces no new atom-ID scheme.

The card renders the title and every item's kind/text verbatim. It has no ellipsis,
truncation, hidden count, or unrendered releasable item. A draft that cannot
fit the complete closed card is not eligible for reviewer V1.

The immutable pending slot stores the draft bytes and
`reviewer_release_draft_sha256`. The renderer, signed action request, envelope
builder, ingest, and log-fact projector consume that same frozen draft. A
content change creates a new processing revision, approval ID, draft, and
card; it never mutates a published draft.

`approval_presentation_v1` is the complete canonical Slack presentation:

- approval ID;
- every ordinary block rendered from the frozen release draft;
- the exact reviewer-policy block and reaction block;
- every block ID; and
- the complete exact fallback.

Authority recomputes draft -> presentation ->
`approval_presentation_sha256`. The Slack provider compares every live block
and fallback with that expected presentation before accepting evidence.

### Exact envelope v2 intent

Envelope v1 remains unchanged. The outer signed reviewer frame is exactly:

```text
schema_version = 2
kind = echo-organization-record-envelope
event_type = approval
```

Its remaining top-level keys are the approval-v1 frame's exact keys:
`envelope_id`, `idempotency_key`, `payload`, `reviewer`, `intent`, `submitter`,
and `integrity`, interpreted only by the new closed v2 validator. Envelope v2
admits approval only. Rejection remains schema v1; `schema_version = 2` with
`event_type = rejection` is invalid.

Dispatch first canonicalizes the bounded outer document, then switches on the
exact pair `(kind, schema_version)` before reading event, intent, payload, or
reviewer fields:

- `echo-organization-record-envelope` + `1` uses only the landed exact v1
  validators/projector;
- the same kind + `2` uses only the reviewer-v2 approval validator and its
  explicit derived-compatibility outcome; and
- every other kind/version, malformed frame, or cross-version field set is
  unknown and halts ingest/derive.

Reviewer envelope v2 has intent keys exactly:

```text
intent.schema_version                      1
intent.visibility                          restricted
intent.policy_id                           restricted-reviewer-v1
intent.provenance.kind                     approval-surface-confirmation-v1
intent.provenance.semantic_intent_sha256   sha256:<digest>
```

`purpose_id` and `reconsider_after` are absent because they have no V1
affordance or semantics. A future purpose or reconsideration feature requires
a new exact version.

The reviewer section freezes the Authority-derived approval actor's principal
and exact membership. A client cannot nominate a different reviewer.

At action time, Authority canonicalizes semantic bytes containing:

- semantic schema and kind;
- `approval_presentation_sha256`;
- `approve` and exact approval ID;
- frozen reviewer principal and membership;
- exact consequence text and version; and
- `reviewer_release_draft_sha256`.

`semantic_intent_sha256` hashes those Authority-computed bytes. It is not a
markup hash or client-authored policy digest.

Authority live-verifies Slack app, bot, team, channel, message timestamp,
complete block array, fallback, presentation digest, unedited state, reaction,
and reviewer. The integration audit stores:

- `reviewer_release_draft_sha256`;
- `approval_presentation_sha256`;
- `semantic_intent_sha256`; and
- a separate `message_presentation_sha256` over provider evidence plus the
  approval-presentation digest.

An allowed approval uses the new closed reason
`active_reviewer_restricted_notice_v1`. Ingest recomputes and matches every
preimage, exact authenticated actor, reason, and message proof before append.
Mismatch is terminal invalid input; unavailable or indeterminate evidence is
retryable `503`. Reject uses the existing rejection path and creates no
reviewer-readable content.

Ingest derives the ordered release items from the final payload and requires
exact equality with the frozen draft. `payload.reviewed_at` equals the
Authority action time. Reviewer, evidence, submission time, and integrity
follow their existing Authority/builder rules and cannot change the approved
release items.

Strict v2 dispatch and closed validation land before any v2 producer. Unknown,
malformed, or unproved versions halt and remain invisible. They never fall
back to v1 or pilot behavior.

### Authority-verified reviewer eligibility proof

The record package never queries Authority or integrations databases and does
not trust client-signed evidence fields or a caller-constructible proof object.
The Authority-owned append coordinator first performs an exact primary-key
lookup of the immutable integration-audit row and matches the allowed reason,
actor, action, provider evidence, and every digest.

Only after that lookup does it mint a single-use, non-exported runtime
`ReviewerRestrictedEligibilityCapabilityV1`. The capability is closure/
`WeakMap` branded, bound to this append attempt and exact canonical envelope,
and can be consumed only by the internal record append port. Its binding
includes organization, envelope ID, idempotency key, installation ID,
canonical-envelope SHA-256, append nonce, and the fields below:

```text
policy_id = restricted-reviewer-v1
reviewer_principal_id
reviewer_membership_id
reviewer_release_draft_sha256
approval_presentation_sha256
semantic_intent_sha256
message_presentation_sha256
authorization_audit_event_id       # existing unique aud_* key
authority_action_time
proof_sha256
```

`authorization_audit_event_id` is the exact existing unique `aud_*` lookup
key, not a descriptive scan. `proof_sha256` commits the ordered canonical
fields but is only an
integrity binding; the unforgeable capability and exact Authority lookup are
what confer trust. Neither the capability nor its body is an envelope field,
public receipt, serializable DTO, or exported constructor.

The log writer inserts reviewer facts only when:

- the exact reviewer-v2 envelope and live capability are both present;
- consuming the capability proves its single use and exact organization,
  envelope/idempotency/installation identity, canonical-envelope digest, and
  append nonce;
- policy, actor, action time, and all digests match each other;
- the final payload matches the frozen draft; and
- the evidence reason is the exact closed reviewer reason.

A missing, forged, consumed, or indeterminate capability is retryable
unavailable and appends neither record nor facts. A proved evidence mismatch
is terminal invalid input. Direct record-store imports and structural proof
objects are blocked by the production export/source boundary. Legacy and
rejection appends do not require this capability and cannot create reviewer
facts.

The log transaction alone allocates position, predecessor, and `recorded_at`
and computes the record hash. That hash already commits the validated canonical
envelope digest. The same transaction writes facts with the resulting
position/hash before commit, so Authority does not predict or reserve a record
hash and performs no external audit I/O while holding the log write lock.
After a failed transaction, a retry repeats the exact audit lookup and mints a
new attempt capability. An exact already-committed idempotent retry revalidates
the same envelope/audit binding and returns the existing record/facts without
a second insert.

Startup log-fact integrity admission is coordinated by Authority. The record
package validates fact/envelope/proof-digest structure; Authority independently
re-queries each exact `authorization_audit_event_id` and matches the complete proof
before marking reviewer reads ready. Each request also revalidates the at-most-
ten selected facts' exact audit rows before the resolver can mint a content
binding. Missing or corrupt evidence makes reviewer read and new reviewer-v2
ingest unavailable; legacy append/derive remains live. There is no window in
which a self-consistent but unaudited fact becomes readable.

### Existing derived-follower compatibility

A does not serve reviewer content from `record-derived.sqlite`, but it must
define what the landed follower does when the log gains envelope v2.

Before any v2 producer ships, derive dispatch becomes strict by envelope
version. Existing v1 behavior remains byte-for-byte unchanged. A valid
reviewer-v2 approval produces one deterministic, text-free exclusion row in a
new derived compatibility table:

```text
log_position
record_hash
envelope_version = 2
policy_id = restricted-reviewer-v1
outcome = deferred-to-permission-aware-retrieval
```

The exclusion row and derived cursor advance in one existing derived
transaction. Reviewer-v2 text, title, subjects, evidence, snapshots,
observations, and edges are not written to the current broad v1 derived tables.
Unknown or malformed versions still halt the follower rather than skipping.

This row is operational compatibility, not a visibility fact, candidate, or B
generation. A never reads it while serving. B later rebuilds from canonical
Layer 1 records under its own contract; it does not reinterpret this exclusion
row. Restart and stopped rebuild must reproduce the same exclusion outcome.

## Append-atomic reviewer facts

### Ownership and shape

Layer 1 remains the sole content truth. It owns the canonical signed envelope,
reviewer attribution, human-intent proof, record hash, position, and receipt.

The same log database contains one policy-specific table conceptually named
`organization_record_reviewer_policy_fact`. Each reviewer-v2 item contributes
one row with exactly:

```text
policy_id = restricted-reviewer-v1
reviewer_principal_id
reviewer_membership_id
log_position
record_hash
atom_order                  # zero-based canonical draft/projector order
signal_id
atom_id
semantic_intent_sha256
authorization_audit_event_id
authorization_proof_sha256
```

The row contains no text, title, subject, evidence, source locator, meeting or
participant field, score, current membership status, or resolved reader.
`atom_id` is internal and is never returned publicly.

The physical identity is `PRIMARY KEY(atom_id)` plus
`UNIQUE(log_position, atom_order)` and `UNIQUE(log_position, signal_id)`.
The table is immutable after insert. Update and delete triggers deny mutation.
Insert guards require:

- an exact canonical approval record at the same position/hash;
- strict reviewer-v2 policy and envelope validation;
- exact verified action reason and evidence;
- exact reviewer principal and membership;
- zero-based canonical item order, exact signal ID, and atom ID produced by the
  fixed pure projector from the frozen draft/final payload; and
- a live Authority-minted eligibility capability whose proof digest and audit
  ID match the fact; and
- all card and response bounds.

The canonical record and all of its reviewer facts commit in one existing log
`BEGIN IMMEDIATE` transaction. Any fact insert or invariant failure rolls back
the record append. A migration creates an empty table; it does not backfill v1,
pilot, legacy, rejection, unknown-version, or prior records.

The serving index is:

```text
(policy_id, reviewer_principal_id, reviewer_membership_id,
 log_position DESC, atom_order ASC)
```

The exact query returns at most ten facts. It does not scan another reviewer's
facts into the logical candidate set.

### Fact trust model

A fact is an address hint and frozen policy assertion, not an allow decision.
For every selected fact, the reader loads only the referenced canonical log
row and reruns the fixed projector in memory. It requires exact equality of:

- position, record hash, atom order, and internal atom ID;
- signal ID and the landed atom-ID derivation;
- policy, reviewer principal, and reviewer membership;
- semantic-intent and authorization-proof digests;
- exact immutable authorization-audit event ID and its revalidated proof; and
- projected kind and text.

Any selected mismatch denies the whole request. A missing fact can only omit
content; it cannot grant or widen access. Before the route is admitted,
startup performs **log-fact integrity admission**: it verifies the log chain
and deterministically compares every reviewer-v2 canonical record with the
complete fact table. This maintenance verifier reads canonical rows directly;
it never routes protected content through the serving facts port. Normal
appends preserve admitted integrity through the atomic insert contract.

There is no live fact repair or mutable shadow index. If fact integrity alone
fails while the canonical chain remains valid, a stopped-state, copy-on-write
fact-index reconstruction holds the existing initialization/runtime locks and:

1. verifies the schema fingerprint, complete log chain/head, signed receipts,
   immutable pilot activation/eligibility state, and external head evidence;
2. revalidates every reviewer record's exact Authority integration-audit event
   key and prepares a canonical reconstruction plan/digest;
3. opens one log `BEGIN IMMEDIATE`, creates a private replacement fact table,
   populates it deterministically from the verified canonical rows/proofs, and
   verifies all keys, counts, constraints, and logical digest;
4. transactionally replaces only the old physical reviewer-fact table and its
   indexes/triggers with the verified replacement under the exact production
   names; and
5. proves every pre-existing non-reviewer table is logically unchanged,
   including log rows, metadata, receipts, pilot marker, and pilot eligibility,
   before commit and again before route admission.

Runtime update/delete triggers still forbid row mutation; the stopped
maintenance transaction is the only governed physical-index replacement. A
crash or validation failure rolls back the DDL transaction, leaves existing
tables in place, and keeps the reviewer route unavailable. If the canonical
chain, pilot state, receipts, or external head evidence fails, normal record-
log restore/reconciliation is required instead; facts are never used to
repair canonical truth.

### Private read boundary

The serving package exposes one narrow session factory and no raw store:

```text
openReviewerReadSession(exact caller, request digest, max 10)
  -> closure-owned single-use session

session.readFacts()
  -> text-free facts fixed to that exact caller tuple

session.bindResolvedFacts(exact subset proved by the resolver)
  -> non-exported request-local capability

session.readBoundCanonicalRecords(capability)
  -> only canonical rows fixed inside that capability
```

The implementation uses a closure-owned runtime identity and private
`WeakMap`/brand state rather than a structural TypeScript DTO. The current-
Person resolver can bind only facts returned by the same live session. The
capability fixes request digest, principal, membership, exact
position/hash/signal/item pairs, authorization attempt, and single-use state.
A copied object, reconstructed JSON, different-session fact, changed subset,
second read, or post-request use fails at runtime.

The production export surface splits maintenance/append storage from serving.
Authority composition receives only this reviewer session port; it cannot
import `OrganizationRecordLogStore`, its public `database`, broad `rows()`, or
the derived store. Maintenance and append modules remain separately bounded.
Source-boundary and query-plan tests prove that fact selection reads no
content columns and uses the exact composite index. Content access without the
live session capability is a build/test failure and runtime denial.

## Exact read contract

### Operation

```text
POST /v1/reviewer-recent-decisions
CLI: echo-brain organization reviewer-recent-decisions
```

The new signed request fixes method, path, organization, enrollment,
installation, request ID, requested time, and signing key. The caller supplies
no target, policy, limit, cursor, sort, query, or atom ID.

The canonical response has exactly:

```json
{
  "items": [
    {
      "kind": "decision",
      "text": "..."
    }
  ],
  "policy_id": "restricted-reviewer-v1",
  "witness": "Allowed by restricted-reviewer-v1 because every returned item records you as its approving reviewer and that exact reviewer membership is currently active."
}
```

`kind` is exactly `decision`, `action`, or `rationale`. The response exposes
no atom or record ID, log position, total, hidden count, cursor, scan depth,
title, meeting ID, participant, source, evidence, subject, score, identity
value, audit reference, or internal path kind.

The query returns at most ten facts and the response returns at most ten whole
items and 60 KiB of exact canonical bytes. The frozen draft bounds guarantee
fit; builder and ingest reject impossible input before append.

### Status and byte algebra

```text
400 {"error":{"code":"invalid_request","message":"request is invalid"}}
401 {"error":{"code":"unauthorized","message":"authorization failed"}}
404 {"error":{"code":"not_found","message":"resource was not found"}}
503 {"error":{"code":"unavailable","message":"service is temporarily unavailable"}}
```

- Malformed structure or method/path binding is pre-authorization `400`.
- Unknown enrollment, invalid signature, or stale request is
  pre-authorization `401`.
- An authenticated expired lease is audited `401`.
- An authenticated inactive, revoked, or unbound Person root is audited
  `404`.
- An active caller with no matching reviewer facts receives audited canonical
  `200` with `items: []`.
- Incoherent log/fact/Person state, failed final recheck, lock timeout, or
  failed audit returns fixed `503` and no content.
- Unexpected programming failure remains generic fail-closed `500`.
- Outer metadata-free `403`, `413`, and `429` are pre-application transport
  classifications and select no content.

Every application and edge response is `Cache-Control: no-store`. The member
reader returns bytes in memory and the CLI prints the closed DTO. No
product-owned response or binding store is added.

## Authorization and consistency sequence

The current root is:

```text
authenticated enrolled installation
AND current unexpired organization access lease
AND current active membership for the caller principal
```

The reviewer path adds:

```text
restricted-reviewer-v1 immutable policy
AND caller principal == frozen reviewer principal
AND caller membership == frozen reviewer membership
```

A replacement membership for the same principal does not inherit an old
approval. The reviewer fields are frozen actor attribution; current Person
state turns that attribution into a reader at request time.

A uses the constitution's reviewed bounded exception for independently
immutable, append-only content and still uses the constitutional final
Authority fence for live Person recheck and audit-before-bytes. It does not
introduce B's longer mutable-generation publication and mixed-file readiness
machinery.

The request sequence is:

1. Parse the exact request.
2. Resolve the enrolled key needed for signature verification.
3. Verify enrollment/key binding, signature, and freshness. Authentication
   completes only after freshness passes.
4. In Authority, read and require the current Person root before any
   record-log content or fact selection.
5. Query at most ten exact text-free facts for that principal and membership.
6. Re-read each selected fact's exact immutable authorization-audit row and
   match its closed proof; any unavailable/mismatch denies before content.
7. Run the reviewer resolver and issue one request-local binding.
8. Read only bound canonical rows, reproject, and verify every fact and item.
9. Build and pre-serialize the bounded response once.
10. In an Authority `BEGIN IMMEDIATE` transaction, re-read current Person
   state, rerun the same resolver for every item, recheck the request and fixed
   policy, append the exact-response audit, and commit.
11. Hand the same immutable bytes to HTTP and send without reserialization.

The final Authority transaction is the authorization linearization point. A
membership, lease, enrollment, or installation mutation ordered before it
wins and denies. One ordered after commit affects the next request.

Because selected records and facts are immutable and co-committed, a
concurrent later append may affect only a later request. It cannot alter or
widen the selected response. This is not a reusable authorization token and
does not permit mutable projections to be selected outside the full B fence.

Before any served read after restore, a stopped-state reconciliation validates
current membership, enrollment, installation, access/lease, relevant policy
and integration state, the verified log head, and applicable client-held
receipts. Startup requires the latest reconciliation act to match recomputed
state or its proved append-only successor. This requirement is independent of
index placement.

## Query-decision audit

Reviewer reads use a new
`authority_query_decision_audit` table in `authority.sqlite`, not the landed
generic `authority_audit_log`. The table has a closed operation
`permission.reviewer_recent_decisions_decided`, a monotonic sequence,
`occurred_at`, decision/reason columns, and one canonical minimized
`detail_json`. It is written inside the same final Authority transaction as
the Person recheck.

The separate table is required because the landed generic audit repository
lists and counts all actions and has no selective retention contract. Pilot
audit rows remain frozen in their landed store and are not migrated,
reclassified, or expired by A.

The proposed reviewer-query retention is 180 days from `occurred_at`. A
dedicated `(occurred_at, audit_sequence)` index supports bounded governance.
Entries are immutable while retained. Minimum allow evidence is:

- requester principal, membership, and installation;
- operation and signed request digest;
- decision, fixed reviewer path, reason, and evaluation completeness;
- `person_state_sha256`, policy version, and restore-reconciliation digest;
- verified record-log head position/hash;
- digest of the complete request served state;
- internal returned atom IDs and record hashes;
- `evaluated_at`; and
- exact response digest.

A denial contains no target, item, record, meeting, participant, title, text,
source, candidate count, or descriptive evidence. Neither allow nor denial
stores response text or claims the client consumed bytes. Audit failure denies.

Generic admin listing and overview counts cannot see the separate query table.
The query-audit repository is not part of the online admin-query interface.
There is no online query-audit or reverse-`who` route.

A stopped-state export uses existing maintenance authority, a configured named
query-audit operator, exact reason, and at most a 31-day range. It emits a
non-content control audit with range, count, request digest, and export digest.

A stopped-state expiry removes expired reviewer-query rows as whole entries
and emits one aggregate, non-content control audit with operator, policy,
window, count, and ordered-row digest. It never deletes approval evidence or
content-log, generic Authority audit, or pilot-query rows. The export and
expiry control events go to the generic non-content Authority audit. A
restored backup with expired reviewer-query rows is not admitted until
governed expiry runs.

## Failure and recovery rules

- Legacy v1, pilot, unknown, malformed, unproved v2, and rejection records are
  not reviewer candidates.
- Missing or mismatched selected facts, invalid canonical reprojection,
  corrupt log chain, unreconciled restore, unavailable Person state, or audit
  failure releases no content.
- A fact is not an allow. Only the current-Person resolver can issue a
  request-local content binding.
- No positive decision, Person snapshot, policy snapshot, or binding is reused
  across requests.
- An unavailable reviewer read never downgrades to pilot, legacy, B, or a
  broader policy.
- Append atomicity prevents a committed reviewer record without its complete
  fact set and prevents facts from leading their canonical record.
- Any serialization, final-recheck, audit, or commit failure releases no
  response content.

## Grounded implementation footprint

A remains cross-cutting, but it no longer includes mutable derived-store trust
machinery:

1. **Protocol and frozen draft:** a new envelope-v2 family, pending-slot draft,
   strict dispatch, builder/verifier, and golden fixtures.
2. **Reviewer approval-surface mode:** decision-node frozen-draft persistence,
   product renderer, signed action request, organization API, control-plane
   verifier, reviewer descriptor, provider digest, reason code, immutable
   integration-audit evidence, and Authority composition. This is a narrow but
   real approval-surface-v2 subproject, not a notice-only patch.
3. **Record log:** one migration, append-atomic immutable facts, deterministic
   projector reuse, exact indexed reader, log-fact integrity admission,
   stopped copy-on-write fact-index reconstruction, and selected-row
   reprojection.
4. **Derived compatibility:** strict envelope-version dispatch and one
   text-free exclusion outcome so the existing broad v1 store never receives
   reviewer-v2 protected content.
5. **Authority:** verified reviewer-proof threading and startup revalidation,
   current reviewer resolver, restore admission, signed route, separate query-
   audit migration/repository/governance, exact-byte final transaction, and
   failure mapping.
6. **Member and acceptance:** request/response API, client, reader, CLI,
   source-boundary tests, and full Slack -> append -> restart -> reviewer read
   lifecycle.

It explicitly does not include derived manifests, projection roots, enriched
derived cursors, permission-aware follower publication, derived serving
admission, search partitions, embeddings, or cross-record computation. The
text-free v2 exclusion row is compatibility work, not a reviewer serving
dependency.

A grounded planning range is roughly 10-15 engineer-days for one engineer,
including restore/audit governance, adversarial integration tests, focused
review, operator documentation, and founder-live validation. This is not a
release promise.

## Build order

1. **Protocol guard:** frozen release draft with stable signal identities,
   complete presentation, envelope v2, strict dispatch, and impossible-item
   validation.
2. **Approval proof:** narrow reviewer approval-surface mode, exact Slack
   renderer/verifier, signed action input, semantic/message evidence, closed
   reviewer proof, reason, and ingest matching.
3. **Append facts:** log migration, co-committed facts, immutable guards,
   exact index, private facts/content boundary, log-fact integrity admission,
   stopped copy-on-write fact-index reconstruction, and canonical reprojection.
4. **Compatibility and read:** safe derived-v2 exclusion, resolver, restore
   admission, signed route, closed DTO, exact bytes, final recheck, separate
   query-audit table/export/expiry, client, and CLI.
5. **Acceptance:** local adversarial matrix, restart/restore, then one bounded
   founder-live reviewer self-read with a different active member returning no
   items.

No later stage starts before the preceding stage is green. This document does
not authorize implementation, deployment, merge, or release by itself.

## Minimum acceptance matrix

1. **Approval binding:** any change to policy, actor, membership, signal ID or
   item order, frozen draft, complete card/fallback,
   semantic/presentation/message digest, immutable integration-audit evidence,
   closed reviewer proof, payload items, or action time prevents append. A
   structural/self-hashed/consumed/cross-append capability is rejected, and no
   fact is readable without exact audit-event revalidation.
2. **Exact reviewer:** exact principal+membership succeeds; another member,
   revoked member, expired lease, revoked installation, or replacement
   membership does not.
3. **Policy separation:** v1, pilot, and reviewer-v2 eligibility are mutually
   exclusive; unknown versions never fall back.
4. **Derived compatibility:** v1 projection stays byte-identical; reviewer-v2
   writes only the exact text-free exclusion row and cursor; no reviewer-v2
   content reaches broad derived tables; malformed/unknown versions halt;
   restart/rebuild reproduces the outcome.
5. **Append atomicity:** record and all facts commit together; injected fact
   failure rolls back the record; primary/unique constraints, update/delete,
   duplicate, and mismatched insert fail.
6. **Facts before text:** fact SQL returns no protected content; another
   reviewer's facts never enter the candidate set; forged, serialized,
   replayed, stale, cross-caller, or post-request bindings fail before content.
7. **Canonical proof:** fact/record swaps, changed signal/order, forged
   reviewer or policy, proof/audit/digest mismatch, and projector mismatch deny
   the whole request.
8. **Bounds and no oracle:** at most ten exact facts and ten whole items;
   response has only `items`, `policy_id`, and `witness`; all extra metadata is
   rejected; another reviewer's population changes neither rows nor bytes.
9. **Linearization:** every revocation/expiry race before final commit denies;
   audit outage and DB-lock timeout release no content; concurrent later append
   affects only the next request.
10. **Restore and corruption:** rollback or unreconciled restore is not
    admitted; log-fact integrity admission detects invalid/incomplete state;
    copy-on-write reconstruction changes only the fact table while proving log,
    receipts, pilot state, and metadata unchanged, or leaves the old table
    unavailable; a mismatch never returns a partial response.
11. **Audit governance:** exact response digest commits to the separate query
    table before bytes; generic admin cannot see it; named bounded export and
    whole-row 180-day expiry are audited; approval evidence, generic audit, and
    pilot rows are retained.
12. **Transport/client:** exact signed/fresh request, fixed error bytes,
    no-store at origin and edge, no second serialization, and no product-owned
    persistence of response text, bytes, or bindings.
13. **Founder-live:** approve one uniquely seeded reviewer-v2 package through
    real Slack verification, restart Authority, retrieve it as that reviewer,
    and prove a second current member receives audited empty output with no
    content-row access or hidden metadata.

## Invariant trace and proposed additions

Landed invariants 1-10 remain intact:

| Invariant | A mechanism |
| --- | --- |
| 1. Authorize before scoring/model access | exact text-free reviewer facts and resolver precede content; no scoring/model exists |
| 2. Do not stamp readers into content | reviewer fields are frozen actor attribution; current exact membership is a request-time conjunct |
| 3. Existence and content are distinct | self-only bounded result; no target, IDs, counts, discovery, or reverse oracle |
| 4. Deterministic witness | one exact witness uses only caller-knowable reviewer facts |
| 5. One consistency boundary | bounded immutable-content exception plus final Authority recheck/audit before identical bytes |
| 6. Failure cannot widen | invalid fact, proof, Person state, restore, or audit denies and never falls back |
| 7. Structure inherits visibility | exact caller index, fixed cap, no cursor/count/statistic, private binding |
| 8. Models cannot confer access | models and inferred identities are absent |
| 9. Recording creates no recipient list | the exact consequence is shown before approval; current Person state remains required |
| 10. Audit without second disclosure | minimized pre-send audit, no response copy, governed visibility and retention |

A proposes one scoped admission rule, not a claim that Layer 2 is already
permission-aware:

11A. **Reviewer reads start from append-atomic, text-free facts.** A reviewer
read selects only immutable facts committed atomically with the verified Layer
1 record. Protected content is released only through a request-local binding
after the current-Person resolver completes. Missing facts, failed canonical
reprojection, an invalid binding, or a broad-store bypass denies.

The consequence invariant remains:

12. **Content-visibility approval binds consequence.** A positive content
approval is valid only when the human-visible policy consequence, frozen
reviewer principal and membership, complete human-presented release draft, and
action-time provider evidence are cryptographically bound over
Authority-computed semantic bytes and verified before append. Client policy
fields, client digests, or markup hashes alone have no authority.

The broader text-free, rebuildable Layer 2 invariant is owned by B and is not
claimed by A.

## Boundary with B and later policies

B may later rebuild a permission-aware searchable corpus from canonical Layer
1 records. A's log-local facts may act as a shadow equivalence oracle, but they
are not a second source of truth. That is a separate trust promotion, not an
online dual write or silent migration.

Until B passes its own acceptance gates:

- A remains the only reviewer-V1 serving path;
- B cannot change A's candidates, response, availability, or audit;
- a B hit is never an allow decision;
- a B miss never triggers a broader fallback; and
- no B content, embedding, score, statistic, or edge enters A.

At any future cutover, stable bindings are policy, record hash, item identity
and order, reviewer principal, and reviewer membership. B must prove
deterministic equivalence and no-widening before it participates in a served
candidate path.

Verified-attendee access remains a separate successor. Reviewer facts cannot
be reinterpreted as attendance, participant identity, a grant, or a reader
list.

## Review provenance

The combined predecessor completed sequential Fable/Codex review at content
SHA-256
`064ac93553bccde09f2f9af07b21b94a4dcb7e1dd94c7cdf2a0ab6d9a14186f1`.
That review established the approval proof, exact membership, facts-before-
text, final recheck/audit, and failure boundaries retained here.

The founder's later A/B split changes the index placement and removes mutable
Layer 2 from V1. Therefore this document must receive a fresh focused review
before implementation. The predecessor's clean verdict is evidence, not an
approval of this changed candidate.
