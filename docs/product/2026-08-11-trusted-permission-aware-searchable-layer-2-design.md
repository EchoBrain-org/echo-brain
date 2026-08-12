# B: Permission-aware lexical Layer 2 minimum V1

**Status:** approved implementation contract for minimum V1, founder-directed
2026-08-12 and independently reviewed. Implementation starts only after the
pinned predecessor below. This document does not claim a completed Job B
implementation, merge, deployment, founder-live qualification, or release.

**Pinned Job A predecessor:**
`03167cfd66fa0b5fe983abbf266271178548efb8` on
`feat/organization-permission-pilot-v1-clean`, locally validated and committed
2026-08-12. Code and migrations remain authoritative for behavior that has
already landed.

**Predecessor capability:**
[A: Reviewer permission minimum V1 with append-atomic log facts](2026-08-11-reviewer-permission-v1-log-facts-design.md).
Job A's contract and reviewer-recent serving behavior are not superseded. Job
B adds behavior-preserving acquisition of the shared authorization fence on
append/mutation paths and reuses the governed query-audit maintenance
primitive; Job A's complete suite must revalidate both composition changes.

**Builds on:**

- [Organization permission architecture](2026-08-09-organization-permission-architecture.md)
- [Org decision record: append and derive](2026-08-07-org-decision-record-append-derive-design.md)
- [Architecture invariant registry](2026-08-11-architecture-invariant-registry.md)

## Decision

Minimum V1 is one local-only, signed lexical-search operation over exactly two
closed content-policy families:

1. `restricted-reviewer-v1`, already admitted by Job A; and
2. `organization-member-readable-v1`, a new explicit approval policy defined
   here.

The operation is `POST /v1/readable-search`. It searches only decision,
action, and rationale text. It returns at most ten whole items. It has no
pagination, totals, scores, snippets, filters, facets, suggestions, vector
search, graph expansion, model call, cache, or external provider.

This is the first complete validation of permission-aware Layer 2. It includes
the human visibility choice, immutable Layer 1 admission, rebuildable
permission/content/lexical planes, immutable generation publication,
request-local authorization scope, candidate-first search, content fetch,
the final Authority fence, query-decision audit, rebuild, restart, restore,
and founder-live gates. No isolated substrate component counts as accepted
until this end-to-end operation passes.

The new organization policy is intentionally broad but not implicit. A
recording becomes organization-readable only because a human approved the
exact consequence before append. Legacy content, pilot content, malformed
content, and reviewer-only content never acquire organization visibility from
membership alone.

## Product outcome

An authenticated caller with a current active `owner` or `employee`
organization membership can search:

- every item explicitly approved under `organization-member-readable-v1`; and
- only those `restricted-reviewer-v1` items for which the caller's current
  principal and exact current membership equal the frozen approving reviewer
  tuple.

A person who joins later can search earlier organization-member-readable
content while their membership is active. A replacement membership for the
same principal also qualifies for organization-member-readable content. It
does not inherit reviewer-only content approved under an older membership.

This proves the permission model in a useful, flexible form:

```text
current Person facts
  + immutable content policy
  + policy-specific resolver
  = request-local readable candidate scope
```

Content does not contain a frozen recipient list. Membership changes affect
future organization-readable evaluations without rewriting history. A future
team, role, attendee, or direct-grant policy can add another closed policy
branch later; it cannot be smuggled into either V1 branch through nullable
columns or fallback behavior.

## Why Job A is not enough

Job A intentionally answers one bounded question: "show me recent items that
this exact membership approved." Its append-side facts are ideal for that
per-record lookup. They do not provide a trusted corpus for query terms,
ranking across records, policy unions, lexical postings, generation
publication, or hidden-corpus noninterference.

Job B pays the mutable-projection trust cost because search is cross-record
computation. It does not move Job A's recent route into Layer 2, and it never
uses a Job A hit as a reusable allow.

## Closed minimum-V1 scope

V1 includes:

- one new explicit organization-member-readable approval and envelope family;
- append-atomic, text-free Layer 1 facts for that new family;
- the existing Job A reviewer family as the second admitted input;
- one new retrieval-generation store, separate from
  `record-derived.sqlite`;
- one deterministic local lexical analyzer and scorer;
- one signed search request and one closed response;
- per-item policy witnesses for returned readable content;
- one request-local scope over at most two eligible physical segments;
- one dedicated 180-day search query-decision audit;
- strict-head availability, stopped rebuild/publication, startup admission,
  restore reconciliation, and adversarial end-to-end tests; and
- one founder-live lifecycle using real Slack approval evidence and at least
  two current members.

V1 explicitly excludes:

- vector search, embeddings, ANN, chunks, semantic similarity, or external
  retrieval providers;
- graph traversal, related items, clusters, entities, PageRank, or learned
  ranking features;
- models, prompts, answer composition, citations, grounding, streaming, or
  tool/agent access;
- titles, meeting metadata, subjects, participants, evidence, rejection
  reasons, or source locators as searchable fields;
- discoverability, labels, request-access, reverse `who`, floors, deny edges,
  attendees, teams, roles, collections, and direct content grants;
- overlapping content policies, policy selectors, caller-supplied filters,
  arbitrary segment unions, or a general ReBAC/ACL evaluator;
- totals, scores, snippets, highlights, facets, autocomplete, suggestions,
  explanations beyond the fixed readable witness, cursors, or pagination;
- query/result caches, shared global statistics, multi-writer operation, or
  distributed fencing; and
- online/incremental retrieval building. Minimum V1 publishes only complete
  stopped-state generations.

Adding any excluded capability requires a new reviewed contract version.

## Exact policy families

### Policy matrix

| Policy | Immutable record fact | Current read condition | Physical segment |
| --- | --- | --- | --- |
| `restricted-reviewer-v1` | Job A reviewer-v2 proof, exact approving principal and membership, policy/provenance/content bindings | caller principal **and exact membership** equal the frozen reviewer tuple; that membership is active | one segment per exact reviewer principal + membership tuple |
| `organization-member-readable-v1` | new explicit organization-readable consequence and approval proof, approving actor provenance, policy/provenance/content bindings | caller has a current active `owner` or `employee` membership in the organization | one organization-member-readable segment |

An indexed item has exactly one of these policies. Reviewer and organization
membership are not two paths on the same item in V1. Duplicate atom identity
across segments is generation corruption and makes the generation unavailable.

Both policies still require an authenticated enrolled installation, matching
Authority/organization/key identities, a current unexpired access lease, and
an active membership. An item fact is a candidate fact, never an allow.

### Organization-member-readable consequence

Before the approve/reject instructions, the Slack card contains this exact
`plain_text` block:

```text
Approving records this package under organization-member-readable-v1. Any person using an enrolled installation with a current unexpired access lease and current active owner or employee membership in this organization, including someone who joins later, may search and read its decisions, actions, and rationales while that access and membership remain active.
```

The accessibility fallback includes that exact sentence and every releasable
item, with no truncation or hidden count. The policy block ID is exactly
`echo-approval-<approval_id>-organization-member-policy-v1`, and `emoji` is
false.

The consequence deliberately means:

- later active members can read earlier records admitted under this policy;
- a revoked membership cannot read;
- a replacement membership can read organization-member content;
- `owner` and `employee` are the complete V1 membership-type allowlist;
- a future membership type is denied until a new policy contract names it;
  and
- approval records policy and provenance, not an approval-time reader list.

Changing any word in the consequence, membership-type allowlist, or later-
member semantics creates a new policy-contract version. It is not a runtime
configuration toggle.

The reader allowlist is not the approval-authority allowlist. Organization-
wide approval requires the exact frozen Slack reviewer identity to resolve at
action time to a current active principal and membership, an active enrolled
installation with an unexpired lease, the exact active adapter binding, and an
active policy-specific `approve` permission grant for that binding. The
create-once presentation contract freezes the configured reviewer label,
provider identity expectation, adapter instance/binding, reaction pair,
credential fingerprint, and
`organization-member-readable-v1` policy-contract digest. Authority rechecks
all of them against the live card and current control-plane state before
returning the schema-v3 allow. An ordinary current member receives no ability
to approve organization-wide disclosure merely because they can read it.
The `permission_grant_id` in the approval evidence is the existing approval-
surface action grant; it authorizes that human approval act and is never a
content-read grant or a search path.

### New closed admission family

The new policy reuses Job A's reviewed mechanisms, not its wire values:

- create-once local release draft and presentation contract;
- exact Slack card rendering and live-card revalidation;
- credential/card/provider identity binding;
- signed permission check, immutable integration audit, and exact-ID reproof;
- single-use Authority-to-record append capability;
- append-atomic item facts; and
- strict compatibility exclusion from the broad derived store.

Every durable kind, schema version, reason, policy digest, consequence digest,
and presentation digest is domain-separated from Job A. A reviewer-v2 proof
cannot satisfy the new policy and the new proof cannot satisfy reviewer-v2.

The Slack approval-surface configuration selects one exact
`presentation_mode`: `restricted-reviewer-v1` or
`organization-member-readable-v1`. There is no missing-value default and no
per-card free-form policy field. A decision is published through exactly one
configured mode and freezes that mode in its create-once presentation slot.
The decision-processor binding names exactly one approval-surface adapter
instance and the Authority control-plane binding commits that instance's
closed public configuration, including `presentation_mode`; there is no
request field or runtime fallback that selects another mode. The frozen local
contract must equal that active binding before publish and again before action
authorization. One card can never be resolved under both. Minimum V1 does not
ship a per-decision or concurrent policy selector. Changing the one mapped
mode is a stopped operator rebinding for future cards and first follows Job
A's fail-closed unresolved-card drain/rotation rule. Records already appended
under either policy retain that immutable policy and may coexist in one search
generation.

Minimum V1 has no per-decision audience chooser. The deployment declares one
closed `organization_recording_policy_v1` mapping in the private canonical
Authority serve configuration, whose digest participates in the runtime
fingerprint:

```text
schema_version = 1
kind = organization-recording-policy-v1
decision_processor_adapter_instance_id
approval_surface_adapter_instance_id
presentation_mode = restricted-reviewer-v1 |
                    organization-member-readable-v1
policy_contract_sha256
```

The decision processor can route only to its one mapped approval surface.
Authority verifies the exact active adapter binding and policy-contract digest
before permission evaluation. Missing, duplicate, ambiguous, inactive, or
mismatched mappings refuse publication/authorization. Changing the mapping is
an operator configuration/rebinding act for future cards only and must first
drain every unresolved contract on the old mapping. Ordinary and pilot
approval surfaces remain outside this B mapping and cannot be selected as a
fallback.

The new approval uses:

```text
permission-check request schema_version = 3
permission-check decision schema_version = 3
reason_code = active_organization_member_readable_notice_v1
release draft kind = organization-member-readable-release-draft-v1
presentation kind = organization-member-readable-approval-presentation-v1
record envelope schema_version = 3
payload.surface = slack-organization-member-readable-v1
```

Schema-v3 permission-check request has Job A schema-v2's exact provider,
tenant, connection, actor, adapter, reaction, HTTP, key, and integrity fields,
but its complete policy-specific tail is exactly:

```text
schema_version = 3
kind = echo-organization-permission-check-request
action = approve
approval_id
channel_id
message_ts
reaction_name = approve_reaction
approve_reaction
reject_reaction
policy_id = organization-member-readable-v1
policy_contract_sha256
release_draft_sha256
approval_presentation_sha256
provider_event_sha256
requested_at
http_method = POST
http_path = /v1/permission-checks
integrity
```

There are no reviewer-release-draft, reader, membership-type, or audience-list
request fields. The schema-v3 provider-event preimage is the same complete
request operation/identity/card field set, domain-separated with
`schema_version = 3` and
`kind = echo-organization-permission-provider-event`, and omits only
`provider_event_sha256`, `requested_at`, and `integrity`. Raw and canonical
request bytes retain the 16 KiB limit.

The Authority semantic-intent preimage is exactly:

```text
schema_version = 1
kind = organization-member-readable-semantic-intent-v1
authority_id
organization_id
visibility = organization-member-readable
policy_id = organization-member-readable-v1
policy_contract_sha256
approval_id
action = approve
approving_principal_id
approving_membership_id
consequence_version = 1
consequence_text = <exact organization consequence above>
eligible_membership_types = [employee, owner]
release_draft_sha256
approval_presentation_sha256
evaluated_at
```

Its message-presentation preimage has Job A's exact provider/card/actor fields,
uses kind `organization-member-readable-message-presentation-v1`, and binds
the schema-v3 provider-event and presentation digests. Authority reconstructs
both from the live unedited Slack card, resolves the reactor, and requires the
reactor's principal/membership to equal the enrolled installation that signed
the request.

The exact schema-v3 decision top-level keys are:

```text
schema_version = 3
kind = echo-organization-permission-check-decision
request_sha256
provider_event_sha256
allowed
reason_code
policy_id
policy_contract_sha256
principal_id
membership_id
adapter_binding_id
permission_grant_id
evaluated_at
authorization_audit_event_id
authorization_audit_entry_sha256
release_draft_sha256
approval_presentation_sha256
semantic_intent_sha256
message_presentation_sha256
```

Allow requires every value non-null and the exact policy/reason. Denial retains
Job A's closed provider/identity/binding failure reasons, with every actor,
grant, audit, and proof field null except policy ID/contract; provider
unavailable or reaction-not-observed maps to the fixed retryable 503 and
creates no durable local approval. Schema-v1/v2 decisions are invalid inputs
to the organization-member approval path.

The release draft has the same exact-key grammar, projection, ordering, and
bounds as Job A's frozen reviewer release draft, with only its domain kind
changed:

```text
schema_version = 1
kind = organization-member-readable-release-draft-v1
approval_id
card_title
items = dense 1..10 array of exact {
  signal_id_sha256,
  kind = decision | action | rationale,
  text
}
```

`card_title`, item text, signal-ID projection, canonical item order, and the
complete-card/no-truncation rule are exactly Job A's. The organization
presentation has Job A's exact top-level transport grammar and title/item/
reaction blocks, with `kind`, the policy block ID, consequence text, and
presentation digest domain changed to the values in this contract. Any other
block, field, order, fallback, edit state, reaction pair, hidden item, or
truncation denies.

Schema version 3 accepts `event_type = approval` only. Rejection remains on
the existing closed rejection path and creates no readable content or policy
facts. Protocol dispatch occurs on exact `(kind, schema_version)` before any
event, intent, payload, reviewer, or proof field is read. Missing, mixed,
extra, cross-version, or unknown fields fail closed and never fall back to
schema v1, reviewer v2, or the pilot.

Envelope v3 retains the bounded approval payload, reviewer provenance,
submitter, and signed-integrity shapes, under its own closed validator. Its
intent object has exactly:

```text
schema_version = 1
visibility = organization-member-readable
policy_id = organization-member-readable-v1
policy_contract_sha256
provenance.kind = approval-surface-confirmation-v1
provenance.semantic_intent_sha256 = sha256:<digest>
```

The approving principal and membership remain immutable provenance. They do
not constrain readers. The complete v3 authorization evidence binds the
Authority and organization, enrollment and installation, request and
approval, approving principal and membership, exact action/reason/time,
release draft, full presentation, semantic intent, provider message, and
immutable integration-audit entry. It contains no reader list.

The schema-v3 authorization evidence has exactly:

```text
schema_version = 3
kind = echo-organization-authorization-evidence
policy_id = organization-member-readable-v1
policy_contract_sha256
authority_id
organization_id
enrollment_id
installation_id
request_id
approval_id
action = approve
request_sha256
provider_event_sha256
allowed = true
reason_code = active_organization_member_readable_notice_v1
principal_id
membership_id
adapter_binding_id
permission_grant_id
evaluated_at
authorization_audit_event_id
authorization_audit_entry_sha256
release_draft_sha256
approval_presentation_sha256
semantic_intent_sha256
message_presentation_sha256
```

The envelope intent/reviewer/submitter, payload projection, frozen
presentation, permission decision, exact immutable audit row, append fact,
and durable authorization-proof preimage must agree on every value, including
the policy ID and policy-contract digest.
The schema-v3 permission request and decision use the same signed operation,
actor, installation, provider-event, and frozen-presentation binding rules as
Job A's schema-v2 request, but their exact detail object carries this policy
ID, reason, `release_draft_sha256`, and policy-contract digest. A schema-v1 or
schema-v2 request/decision/evidence value can never be normalized into this
shape.

The policy contract digest is the RFC 8785 SHA-256 of this exact logical
object:

```text
schema_version = 1
kind = organization-member-readable-policy-contract-v1
policy_id = organization-member-readable-v1
consequence_version = 1
eligible_membership_types = [employee, owner]
consequence = <the exact sentence above>
approval_action = approve
permission_check_http_path = /v1/permission-checks
permission_check_request_kind = echo-organization-permission-check-request
permission_check_schema_version = 3
permission_check_decision_kind = echo-organization-permission-check-decision
reason_code = active_organization_member_readable_notice_v1
authorization_evidence_kind = echo-organization-authorization-evidence
authorization_evidence_schema_version = 3
semantic_intent_kind = organization-member-readable-semantic-intent-v1
message_presentation_kind = organization-member-readable-message-presentation-v1
record_envelope_kind = echo-organization-record-envelope
record_envelope_schema_version = 3
payload_surface = slack-organization-member-readable-v1
release_draft_kind = organization-member-readable-release-draft-v1
presentation_kind = organization-member-readable-approval-presentation-v1
```

The membership-type array is in the exact order shown. One exported helper is
the only implementation of this digest.

### Append-atomic organization policy facts

`record-log.sqlite` adds a separate insert-only
`organization_member_readable_policy_fact` family. It is not a nullable
extension of the reviewer table. For every released item, the append
transaction commits this exact logical fact:

```text
log_position
record_hash
organization_id
envelope_sha256
atom_order
atom_id
signal_id_sha256
item_kind = decision | action | rationale
policy_id = organization-member-readable-v1
policy_contract_sha256
approving_principal_id
approving_membership_id
release_draft_sha256
approval_presentation_sha256
semantic_intent_sha256
message_presentation_sha256
authorization_audit_event_id
authorization_audit_entry_sha256
evaluated_at
authorization_proof_sha256
content_binding_sha256
provenance_binding_sha256
```

`authorization_proof_sha256` is the canonical SHA-256 of a closed,
domain-separated preimage containing the organization, envelope ID,
idempotency key, installation, canonical-envelope digest, policy and policy-
contract digest, approving principal/membership, all four presentation/intent
digests, audit event/entry, and `evaluated_at`. The output digest and the
private append-attempt token are not members of their own preimage.

For each item:

```text
content_binding_sha256 = canonicalSha256({
  schema_version: 1,
  kind: organization-record-item-content-binding-v1,
  organization_id,
  envelope_sha256,
  log_position,
  record_hash,
  atom_id,
  atom_order,
  signal_id_sha256,
  item_kind,
  text_sha256: sha256Utf8(exact item text)
})

provenance_binding_sha256 = canonicalSha256({
  schema_version: 1,
  kind: organization-record-policy-provenance-binding-v1,
  organization_id,
  envelope_sha256,
  log_position,
  record_hash,
  policy_id,
  policy_contract_sha256,
  approving_principal_id,
  approving_membership_id,
  release_draft_sha256,
  approval_presentation_sha256,
  semantic_intent_sha256,
  message_presentation_sha256,
  authorization_audit_event_id,
  authorization_audit_entry_sha256,
  authorization_proof_sha256,
  evaluated_at
})
```

Job B derives those same two binding kinds for reviewer-v2 directly from the
canonical envelope. Its exact reviewer provenance preimage is:

```text
schema_version = 1
kind = organization-record-policy-provenance-binding-v1
organization_id
envelope_sha256
log_position
record_hash
policy_id = restricted-reviewer-v1
policy_contract_sha256
reviewer_principal_id
reviewer_membership_id
release_draft_sha256
approval_presentation_sha256
semantic_intent_sha256
message_presentation_sha256
authorization_audit_event_id
authorization_audit_entry_sha256
authorization_proof_sha256
evaluated_at
```

Job A does not already store these Job B binding digests. Job B compares every
shared upstream field with Job A's append-atomic fact set, independently
recomputes Job A's authorization proof and these bindings, and halts the build
on any disagreement.

Protocol owns the closed schema-v3 wire validation. Record owns the pure
policy-fact derivation over a structural validated view supplied by the
Authority-composed protocol validator. Retrieval consumes only a closed,
verified Layer 1 projection. No record-to-organization-protocol import is
introduced. The preimages are recomputed independently at append, startup
admission, retrieval build, and selected-content fetch; a stored digest is
never accepted as the expected digest input.

The new schema-v3 record cannot commit without a live Authority-minted,
single-use capability proving the exact immutable audit row and canonical
envelope. Record and complete fact set commit together or neither commits.
Exact duplicates repeat Authority reproof and compare the complete committed
fact set before returning the original receipt. Facts have insert-only
triggers, exact foreign keys to the record, and no repair/backfill path.

Startup recomputes every fact from canonical Layer 1 and the exact integration
audit. Missing, extra, mismatched, noncanonical, or corrupt facts make the new
policy and Job B unavailable without degrading legacy append or Job A's
already-reviewed route.

The broad `record-derived.sqlite` follower emits one text-free compatibility
exclusion for valid schema-v3 content and no atom, snapshot, participant,
rejection, edge, title, evidence, or text row. Derived migration
`0003_member_readable_v3_exclusion.sql` creates the parallel insert-only
`organization_derived_member_readable_policy_exclusion` table, fixed to
envelope version 3, `organization-member-readable-v1`, and the same
`excluded_from_broad_projection` outcome semantics as Job A's v2 table.
Malformed v3 halts the follower. The broad derived database remains a
compatibility projection, not a Job B input or serving store.

### Items excluded from a particular caller's V1 scope

Legacy and invalid rows never enter a generation. Reviewer-v2 records always
build only into the segment named by their frozen reviewer tuple; the record
can exist in V1 search while remaining outside another caller's scope. The
following are excluded for the stated caller:

- every legacy schema-v1 approval or rejection;
- every fixed two-member pilot-only record;
- every record whose only marker is the historical `restricted` boolean;
- a reviewer-v2 record approved by a different principal or membership is
  outside that caller's scope;
- a reviewer-v2 record for the same principal under a replaced membership is
  outside the replacement membership's scope;
- a schema-v3 record missing exact proof or append-atomic facts;
- a malformed, unknown-version, policy-rootless, or mixed-policy record; and
- any inferred, model-created, repaired, or backfilled classification.

## Exact search wire contract

### Request

`POST /v1/readable-search` accepts one RFC 8785 canonical document signed by
the enrolled installation key. The exact top-level fields are:

```text
schema_version = 1
kind = echo-organization-readable-search-request
request_id = osq_<uuid-v4>
authority_id
authority_key_id
organization_id
enrollment_id
installation_id
installation_key_id
http_method = POST
http_path = /v1/readable-search
query
requested_at
integrity
```

The canonical request is at most 16 KiB. The raw HTTP body has the same 16 KiB
cap before parsing. After parsing, its RFC 8785 encoding must equal the raw
UTF-8 bytes exactly. The request validator snapshots through canonical JSON,
requires exact keys and dense data objects, and verifies the installation
signature and pinned identities.

`query` is NFC, trimmed, single-line, contains no Unicode `Cc`, `Zl`, `Zp`, or
unpaired surrogate, is nonempty, and is at most 240 Unicode scalar values.
There is no caller-supplied policy, subject, filter, field, limit, sort,
cursor, page, score flag, explanation flag, or target ID.

`requested_at` uses the existing installation-request freshness contract and
the configured `access_request_maximum_age_ms`; a future timestamp or a value
older than that bound is unauthorized. Freshness is checked once during
authentication. The final fence rechecks current Person/access/policy/head
state, not elapsed request age.

### Analyzer and query semantics

The analyzer is implemented in-repository and versioned as
`echo-unicode-alnum-frequency-v1`. Query and document analysis share these
first three steps:

1. require the validated NFC input;
2. split into maximal Unicode letter-or-number runs using the pinned runtime's
   Unicode `Letter` and `Number` properties; and
3. apply locale-independent lowercase to each run, then NFC again.

Query analysis then preserves each term's first occurrence, removes later
duplicates, and rejects zero terms, more than 16 unique terms, or any term
longer than 64 UTF-8 bytes. Document analysis retains every occurrence needed
to compute term frequency, has no term-count limit, and deterministically
omits an occurrence whose normalized term is longer than 64 UTF-8 bytes. Such
a term is unmatchable because a query containing it is rejected. A document
with zero remaining terms still commits its lexical-document row with no
postings; it is simply not a lexical match.

The generation manifest pins the source revision, Node version, Unicode/ICU
version, analyzer code digest, and analyzer contract digest. A change to any
one requires a new generation and contract review.

Only the exact atom `text` is tokenized. Titles, subjects, owners, status,
dates, evidence, meeting data, participants, source IDs, reviewer display
names, and policy metadata are never lexical inputs.

An item matches when at least one unique query term occurs in its analyzer
term sequence. Its internal score is:

```text
score(item) = sum(term_frequency(item, term) for each unique query term)
```

There is no inverse document frequency, corpus count, document-length
normalization, stemming, fuzzy matching, phrase boost, hidden global
vocabulary, or learned feature. Results order exactly by:

1. score descending;
2. log position descending;
3. atom order ascending; and
4. atom ID ascending.

Scores are not returned or audited. Because the score uses only each matched
authorized item, adding or changing a hidden document cannot change an
allowed item's score or order.

### Response

The exact 200 response is a closed data object with exactly three top-level
keys:

```json
{
  "schema_version": 1,
  "contract_id": "permission-aware-readable-search-v1",
  "items": [
    {
      "kind": "decision",
      "text": "the complete approved item text",
      "policy_id": "organization-member-readable-v1",
      "witness": "You may read this item because it was explicitly approved for current active owner or employee members, including members admitted after approval, and your membership is active."
    }
  ]
}
```

`items` is a dense array of at most ten whole items. `kind` is exactly
`decision`, `action`, or `rationale`. `text` is the complete approved text,
never a snippet. Every item is a closed data object with exactly `kind`,
`text`, `policy_id`, and `witness`; accessors, symbols, holes, missing keys,
and extra keys at any level are invalid. The two exact policy/witness pairs
are:

| `policy_id` | exact `witness` |
| --- | --- |
| `restricted-reviewer-v1` | `You may read this item because it records you as the approving reviewer and that exact reviewer membership is currently active.` |
| `organization-member-readable-v1` | `You may read this item because it was explicitly approved for current active owner or employee members, including members admitted after approval, and your membership is active.` |

There are no item IDs, record hashes, positions, scores, snippets, highlights,
totals, hidden counts, scan depths, segment names, cursors, or query echoes.
Equal kind/text results from distinct authorized records are allowed. An
active caller with no matching authorized item receives the same audited 200
shape with `items: []`.

The response is canonicalized once and capped at 60 KiB. The 240-scalar item
bound and ten-item cap make overflow an integrity failure rather than a reason
to truncate or skip an item. HTTP sends the same pre-serialized bytes whose
digest the Authority audit commits.

`request_id` is a correlation ID, not an idempotency key. Replaying the same
valid signed request inside its freshness window is a new response attempt and
creates a separate query-decision audit. V1 stores no response bytes for
deduplication.

### Fixed failures

All responses use `Cache-Control: no-store`. The five application error bodies
are these exact canonical UTF-8 bytes, with no BOM or trailing LF:

```text
400 {"error":{"code":"invalid_request","message":"request is invalid"}}
401 {"error":{"code":"unauthorized","message":"authorization failed"}}
404 {"error":{"code":"not_found","message":"resource was not found"}}
503 {"error":{"code":"unavailable","message":"service is temporarily unavailable"}}
500 {"error":{"code":"internal_error","message":"authority operation failed"}}
```

| Status | Code | Message | When |
| --- | --- | --- | --- |
| 400 | `invalid_request` | `request is invalid` | malformed method/path/query/body before authentication |
| 401 | `unauthorized` | `authorization failed` | unknown enrollment, invalid signature, stale request, or expired access lease |
| 404 | `not_found` | `resource was not found` | authenticated but inactive, revoked, or unbound current membership/enrollment/installation |
| 503 | `unavailable` | `service is temporarily unavailable` | no admitted exact-head generation, root/binding/scope/index/content/audit failure, lock timeout, or final head/generation mismatch |
| 500 | `internal_error` | `authority operation failed` | unexpected programming fault |

For the exact path, a wrong HTTP method or any query string returns the fixed
400 before authentication or body parsing. An unmatched path retains the
server's generic fixed 404. Outer trusted-proxy, body-limit, and rate-limit
failures retain their existing fixed 403, 413, and 429 contracts. Pre-auth
400/401, stale requests, and outer failures read no facts/index/content and
create no query-decision audit. Authority loads the enrolled installation key
before signature verification; the shared validator checks closed shape,
canonical bytes, field/key alignment, and the signature only against that
Authority-selected key.

An authenticated expired-access decision is audited before fixed 401. An
authenticated inactive/revoked/unbound current-state decision is audited
before fixed 404. An operational 503 releases no prepared content and never
falls back to Job A, the pilot, a stale generation, or a broad scan.

### Closed analyzer, search-contract, and Person digests

`analyzer_contract_sha256` is the canonical SHA-256 of this exact-key object:

```text
schema_version = 1
kind = readable-search-analyzer-contract-v1
analyzer_id = echo-unicode-alnum-frequency-v1
input_normalization = NFC
tokenization = maximal-ecmascript-unicode-Letter-or-Number-runs
case_mapping = locale-independent-String.prototype.toLowerCase
output_normalization = NFC
query_term_deduplication = first-occurrence-wins
query_zero_terms = reject
document_term_occurrences = retain-for-frequency
document_overlong_term_policy = omit
document_zero_postings = retain-document
indexed_field = exact-atom-text-only
match = any-unique-query-term
score = sum-matched-term-frequency
order = [score-desc, log-position-desc, atom-order-asc, atom-id-asc]
maximum_query_scalars = 240
maximum_query_terms = 16
maximum_query_term_utf8_bytes = 64
analyzer_source_sha256
```

`analyzer_source_sha256` covers the exact released analyzer module bytes. The
generation separately pins the Node, Unicode/ICU, and SQLite runtime versions.
Changing the source or any field above changes the contract digest and
requires a fresh generation.

`retrieval_contract_sha256` is the canonical SHA-256 of this exact-key object:

```text
schema_version = 1
kind = permission-aware-readable-search-contract-v1
contract_id = permission-aware-readable-search-v1
request = {
  schema_version: 1,
  kind: echo-organization-readable-search-request,
  request_id_prefix: osq,
  http_method: POST,
  http_path: /v1/readable-search,
  maximum_canonical_bytes: 16384,
  maximum_age_source: configured-access_request_maximum_age_ms
}
query = {
  normalization: NFC,
  trimmed: true,
  single_line: true,
  control_free: true,
  maximum_unicode_scalars: 240
}
analyzer_id = echo-unicode-alnum-frequency-v1
analyzer_contract_sha256
policies = [
  {
    policy_id: organization-member-readable-v1,
    policy_contract_sha256,
    witness: <exact organization-member witness above>
  },
  {
    policy_id: restricted-reviewer-v1,
    policy_contract_sha256,
    witness: <exact reviewer witness above>
  }
]
response = {
  schema_version: 1,
  top_level_keys: [schema_version, contract_id, items],
  item_keys: [kind, text, policy_id, witness],
  item_kinds: [decision, action, rationale],
  maximum_items: 10,
  maximum_canonical_bytes: 61440,
  ranking: [score-desc, log-position-desc, atom-order-asc, atom-id-asc],
  scores_exposed: false,
  pagination: false
}
error_bytes = {
  invalid_request: <exact 400 bytes above>,
  unauthorized: <exact 401 bytes above>,
  not_found: <exact 404 bytes above>,
  unavailable: <exact 503 bytes above>,
  internal_error: <exact 500 bytes above>
}
audit = {
  operation: permission.readable_search_decided,
  retention_days: 180
}
```

Every nested object/array is closed/dense and the displayed order is the
normative array order. The two `policy_contract_sha256` values are computed by
their respective single exported helpers. One search-contract helper builds
and hashes this object; generation build, startup, scope minting, final fence,
and audit append independently compare it.

`person_state_sha256` is the canonical SHA-256 of the current transaction's
exact-key snapshot:

```text
schema_version = 1
kind = readable-search-person-state-v1
authority_id
organization_id
principal_id
membership_id
membership_type = owner | employee
membership_status = active | revoked
membership_revoked_at = timestamp | null
enrollment_id
enrollment_status = active | revoked
enrollment_revoked_at = timestamp | null
enrollment_revocation_kind = membership_revoked | installation_revoked | null
installation_id
installation_key_id
access_state_sequence
access_state_sha256
access_status = active | revoked
access_valid_until = timestamp | null
evaluated_at
```

All keys are always present. The snapshot is reconstructed from Authority rows
inside the same transaction that evaluates it; no caller value supplies a
state field. Allow requires both active statuses, `membership_type` in the
closed allowlist, matching enrollment/access bindings, and
`access_valid_until > evaluated_at`. Audited expired/inactive decisions hash
the exact non-eligible snapshot they evaluated.

## Retrieval generation: a new Layer 2 store

### Why `record-derived.sqlite` stays untouched

The existing derived database is deterministic and rebuildable, but it is a
broad text-bearing graph with public maintenance accessors and no trusted
candidate boundary. Reviewer-v2 and member-readable-v3 intentionally project
only text-free exclusions there. Job B therefore creates a separate logical
machine and state root. It does not add a search table or serving reader to
`record-derived.sqlite`.

The implementation lives in a distinct workspace,
`services/organization-retrieval`, hosted by the Authority process. Builder,
serving, and maintenance exports are separate package subpaths. Source-boundary
tests make the retrieval workspace's serving subpath unable to import raw
record stores, broad derived accessors, migrations, builder code, or mutable
Authority persistence. Authority application composition still owns the
current-Person snapshot, fence, and audit transaction and passes only the
closed inputs/capabilities the retrieval serving subpath needs.

### Generation layout and physical planes

The private state root is mode 0700 and has this logical layout:

```text
record-retrieval/
  generations/
    <generation_id>/
      manifest.json
      segments/
        <segment_id>/
          segment-manifest.json
          facts.sqlite
          lexical.sqlite
          content.sqlite
```

Each file is mode 0600. Names contain only validated digest-derived IDs, never
principal, membership, policy, query, title, or content text.

Planes are physically separate per policy segment:

- `facts.sqlite` contains only text-free record/item/policy/proof/binding
  facts;
- `lexical.sqlite` contains only term postings and ordering inputs, with no
  text or broad vocabulary/count API; and
- `content.sqlite` contains only the bounded item text and its exact binding.

The member-readable segment and each exact reviewer tuple use different
segment directories and SQLite files. One request opens only segment handles
named in its opaque scope. A global lexical database, global vocabulary, or
cross-segment posting scan does not exist.

Each plane uses its own application ID and contiguous migration ledger, with
`journal_mode = DELETE`, foreign keys on, `trusted_schema = OFF`, and `STRICT`
tables. Migration-ledger and finalized-generation rows are immutable. The
logical schemas are closed as follows; SQL migrations must reproduce these
columns, primary/unique keys, branch checks, and indexes exactly.

`facts.sqlite` contains:

```text
retrieval_plane_metadata(
  singleton PK = 1,
  schema_version = 1,
  plane = facts,
  organization_id,
  segment_id,
  segment_kind = organization-member | reviewer,
  policy_id,
  policy_contract_sha256,
  reviewer_principal_id nullable,
  reviewer_membership_id nullable,
  analyzer_contract_sha256,
  finalized = 0 | 1
)

retrieval_permission_fact(
  atom_id PK,
  organization_id,
  envelope_sha256,
  log_position,
  record_hash,
  atom_order,
  signal_id_sha256,
  item_kind,
  policy_id,
  policy_contract_sha256,
  approval_actor_principal_id,
  approval_actor_membership_id,
  reviewer_principal_id nullable,
  reviewer_membership_id nullable,
  release_draft_sha256,
  approval_presentation_sha256,
  semantic_intent_sha256,
  message_presentation_sha256,
  authorization_audit_event_id,
  authorization_audit_entry_sha256,
  evaluated_at,
  authorization_proof_sha256,
  content_binding_sha256,
  provenance_binding_sha256,
  UNIQUE(log_position, atom_order),
  UNIQUE(log_position, signal_id_sha256)
)

INDEX retrieval_permission_fact_by_position
  (log_position DESC, atom_order ASC, atom_id ASC)
```

The metadata branch check requires both reviewer IDs to be null for
`organization-member` and both to be canonical non-null IDs for `reviewer`.
Every fact must equal the metadata organization/policy; reviewer facts must
equal its tuple, while organization facts require both reviewer columns null.

`content.sqlite` contains:

```text
retrieval_plane_metadata(<same identity columns>, plane = content)

retrieval_content_atom(
  atom_id PK,
  log_position,
  record_hash,
  atom_order,
  item_kind,
  text,
  text_sha256,
  content_binding_sha256,
  provenance_binding_sha256,
  UNIQUE(log_position, atom_order)
)
```

`lexical.sqlite` contains:

```text
retrieval_plane_metadata(<same identity columns>, plane = lexical)

retrieval_lexical_document(
  atom_id PK,
  log_position,
  atom_order,
  content_binding_sha256
)

retrieval_term_posting(
  term,
  atom_id REFERENCES retrieval_lexical_document(atom_id),
  term_frequency CHECK positive safe integer,
  PRIMARY KEY(term, atom_id)
)
```

Text, term, and identifier validators enforce the exact protocol/analyzer
bounds; all digests use canonical lowercase `sha256:*`. Once `finalized = 1`,
triggers deny every insert, update, and delete in all plane tables. Builder
finalization flips all three metadata rows only after complete independent
root validation. A build failure leaves staging unreferenced and the next
command discards it rather than resuming it.

The root preimages are exact canonical objects:

```text
segment facts root = {
  schema_version: 1,
  kind: readable-search-segment-facts-root-v1,
  segment_id,
  rows: <all fact rows in (log_position ASC, atom_order ASC, atom_id ASC)>
}

segment content root = {
  schema_version: 1,
  kind: readable-search-segment-content-root-v1,
  segment_id,
  rows: <all content rows in (log_position ASC, atom_order ASC, atom_id ASC)>
}

segment lexical root = {
  schema_version: 1,
  kind: readable-search-segment-lexical-root-v1,
  segment_id,
  documents: <all document rows in
              (log_position ASC, atom_order ASC, atom_id ASC)>,
  postings: <all posting rows in (term UTF-8 byte ASC, atom_id ASC)>
}
```

The canonical arrays contain the exact listed table columns and no SQLite row
IDs or page bytes. Ordering is computed in application code: text keys use
unsigned lexicographic comparison of their UTF-8 bytes, numeric keys compare
as safe integers, and digest/ID keys compare as their canonical ASCII bytes.
SQLite collation or query-plan order is never accepted as a root order.
Global `facts_root`, `content_root`, and `lexical_root` each hash
`{schema_version:1, kind:<plane>-generation-root-v1, segments:[...]}`, where
the dense segment array is ordered by `segment_id` and each entry contains
exactly `segment_id`, `segment_manifest_sha256`, and that plane's segment root.

### Segment identity and facts

`segment_id` is the digest of one of two closed discriminated preimages:

```text
organization-member segment:
  schema_version = 1
  kind = readable-search-organization-member-segment-v1
  organization_id
  policy_id = organization-member-readable-v1
  policy_contract_sha256

reviewer segment:
  schema_version = 1
  kind = readable-search-reviewer-segment-v1
  organization_id
  policy_id = restricted-reviewer-v1
  policy_contract_sha256
  reviewer_principal_id
  reviewer_membership_id
```

No nullable reviewer field means organization-readable. The two preimage kinds
are distinct. Segment manifests bind their exact preimage, fact root, content
root, lexical root, analyzer contract, document count, and ordered record
manifests. Counts exist only inside protected operator state and never cross a
serving port.

Every fact binds exact organization, policy, record position/hash, atom
order/ID, content digest, provenance digest, policy-contract digest, and the
complete relevant Layer 1 proof. Reviewer facts include the frozen reviewer
principal/membership. Organization facts include the approving actor only as
provenance. Neither stores a resolved reader list.

### Complete generation manifest

Every segment has one closed canonical `segment-manifest.json`:

```text
schema_version = 1
kind = readable-search-segment-manifest-v1
organization_id
segment_id
segment_kind = organization-member | reviewer
policy_id
policy_contract_sha256
reviewer_principal_id = ID | null
reviewer_membership_id = ID | null
analyzer_id = echo-unicode-alnum-frequency-v1
analyzer_contract_sha256
facts_root
content_root
lexical_root
fact_count
content_count
document_count
posting_count
```

The reviewer-null branch rule is the same as plane metadata. Counts are
non-negative safe integers and equal the independently counted rows.
`segment_manifest_sha256` is the SHA-256 of the exact canonical file.

The immutable canonical `manifest.json` has exactly:

```text
schema_version = 1
kind = readable-search-generation-manifest-v1
organization_id
generation_id
retrieval_contract_id = permission-aware-readable-search-v1
retrieval_contract_sha256
source_revision
builder_artifact_sha256
input_contract_version = 1
policies = [
  {policy_id: organization-member-readable-v1, policy_contract_sha256},
  {policy_id: restricted-reviewer-v1, policy_contract_sha256}
]
record_head = {position, record_hash}
input_cursor = {position, record_hash}
upstream_input_root
roots = {facts_root, content_root, lexical_root}
segments = <dense array ordered by segment_id of exact {
  segment_id,
  segment_manifest_sha256,
  facts_root,
  content_root,
  lexical_root
}>
analyzer = {
  analyzer_id: echo-unicode-alnum-frequency-v1,
  analyzer_contract_sha256,
  analyzer_source_sha256,
  node_version,
  unicode_version,
  icu_version
}
index = {
  format_version: 1,
  sqlite_version
}
```

For an empty log, head/cursor position is zero and hash is null. Position and
hash always agree. The generation manifest contains no wall-clock field;
publication time lives only in the Authority generation-publication audit.

`generation_id` is `canonicalSha256` of the exact manifest object above with
`kind = readable-search-generation-identity-v1` and the `generation_id` key
omitted. `manifest_sha256` is the SHA-256 of the complete canonical manifest,
including the computed `generation_id`. Both values are deterministic.
Rebuilding with the same input, contracts, runtime, source revision, and
builder artifact must reproduce the same manifest bytes, logical roots, and
generation ID; SQLite page bytes need not match.

### Complete Layer 1 input root

The builder reads verified canonical Layer 1 directly at a pinned head. It
strictly classifies every log row in order as:

- admitted reviewer-v2 approval;
- admitted organization-member-readable-v3 approval;
- known legacy/pilot/rejection exclusion; or
- unsupported/malformed, which halts the build.

The `upstream_input_root` commits the classification of every row through the
head. Its exact preimage is:

```text
schema_version = 1
kind = readable-search-upstream-input-root-v1
organization_id
input_contract_version = 1
record_head = {position, record_hash}
rows = <dense array in log_position ASC of exact {
  log_position,
  record_hash,
  envelope_sha256,
  classification = legacy-schema-v1-excluded |
                   restricted-reviewer-v2-admitted |
                   organization-member-readable-v3-admitted,
  items = [] | <dense admitted B fact rows in atom_order ASC>
}>
```

Known schema-v1 approvals, rejections, and pilot-qualified records all use the
single non-serving `legacy-schema-v1-excluded` class. Admitted items include
the exact family-neutral content/provenance bindings and independently
recomputed proof digest. Unknown or malformed rows have no classification and
halt instead of producing a root. Thus silently reclassifying, dropping, or
reordering any row changes the root.

Reviewer input is independently reprojected from the canonical envelope and
must exactly equal Job A's append-atomic fact set. Organization-member input
must exactly equal the new append-atomic fact set. Those log facts are
equivalence oracles, not authorization decisions and not a substitute for
canonical-envelope validation.

The stopped builder receives Layer 1 only through the dedicated
`@echo-brain/organization-record/retrieval-build` port created by Authority
composition. Opening the port verifies the complete record chain and both fact
families, captures an immutable `{position, record_hash}` head, and returns
frozen batches containing only:

```text
log_position
record_hash
envelope_sha256
canonical_envelope
reviewer_fact_set
organization_member_fact_set
```

The port refuses reads past or from a different captured head and exposes no
SQLite handle, append method, receipt writer, broad derived store, or serving
reader. It is exported only from the builder-qualified subpath and the source-
boundary graph permits only stopped `operator-state` composition to create it.
The retrieval serving subpath cannot import it. Protocol validators remain
Authority-injected, so the record workspace retains no protocol-package import
edge.

### Full private build and stopped publication

Minimum V1 has no online or incremental publication. The stopped Authority
command is:

```text
echo-organization-authority rebuild-readable-search --config <absolute-path>
```

It follows the existing initialization/runtime-lock and stopped-preflight
order. It verifies Authority, integrations, record log, both policy fact
families, and restore readiness before reading content. It captures one exact
record head, builds a brand-new private staging generation from position one,
computes and rechecks every root, fsyncs files and directories, and renames
the complete generation directory into its immutable final name.

Every state-root, `generations`, staging, final-generation, `segments`, and
segment directory must be a canonical current-user-owned non-symlink directory
with mode 0700; every file must be a current-user-owned non-symlink regular
file with mode 0600. A final `<generation_id>` that already exists is reused
only after byte-exact manifest and complete root validation; that is an
idempotent rebuild. A missing/different/unsafe member under the same identity
is corruption and publication stops without overwrite. Orphan staging names
are random, never referenced, and may be removed only by the stopped command
after the same ownership/path checks.

Only then does a final Authority `BEGIN IMMEDIATE` transaction recheck the
same configured identities and record head, append a minimized generation-
publication audit, and atomically replace the singleton
`authority_readable_search_active_generation` row. That strict singleton has
exactly:

```text
singleton = 1
organization_id
generation_id
manifest_sha256
retrieval_contract_sha256
record_head_position
record_head_hash
published_at
```

The transaction-owned `published_at` is not a generation field. Position zero
requires null hash; positive position requires a digest. The same transaction
appends generic action `permission.readable_search_generation_published` with
an exact closed detail containing schema/kind, organization, generation and
manifest IDs, retrieval-contract digest, head, prior generation ID or null,
and `published_at`. It contains no segment, tuple, count, term, or content
field. The pointer update and audit commit together.

A crash before pointer commit leaves an ignored orphan generation. A pointer
never references staging. An active generation is never mutated or replaced
in place. Publication takes the global authorization fence's write side before
the Authority transaction and releases it only after commit.

Startup reads exactly one active pointer and validates the complete referenced
manifest, directories, schemas, facts, content/postings bindings, roots,
contracts, runtime/analyzer versions, and exact current Layer 1 head. A missing
pointer is a clean not-built state. Missing, stale, partial, corrupt, mixed, or
unknown state makes only `/v1/readable-search` unavailable.

A new record append never waits for Layer 2. It immediately makes the active
generation stale because its head no longer equals Layer 1. Search then returns
the fixed 503 until the next stopped full rebuild publishes an exact-head
generation. V1 never serves a historical prefix.

## Request-local authorization and serving

### Narrow ports

The Authority serving graph receives only:

```text
ReadableSearchFactsPort.openEligibleSegments(pinned_generation, caller)
ReadableSearchScopeFactory.bind(current_person_snapshot, fact_headers)
ReadableLexicalSearchPort.search(scope, analyzed_query)
ReadableContentPort.fetch(scope, selected_candidates)
```

The facts port returns immutable text-free snapshots. It cannot read lexical
or content files. The lexical port cannot read facts or content and accepts no
caller-supplied segment ID. The content port cannot enumerate and accepts only
candidate handles minted by the scoped lexical port. None exposes a SQLite
handle, file path, raw posting list, vocabulary, segment count, broad atom
reader, or builder/maintenance operation.

The opaque `ReadableSearchScopeV1` is closure/WeakMap branded and binds:

```text
organization and request digest
caller principal and exact current membership
membership type
operation = search-readable
exact admitted generation and manifest digest
record head position and hash
policy-contract digests
zero, one, or two exact segment handles
Person-state digest
request nonce and authorization turn
```

It is nonserializable, noncloneable, nonloggable, noncacheable, single-request,
and a private state machine rather than a bearer token:

```text
bound
  -> lexical-searched(candidate handles frozen)
  -> content-fetched | empty
  -> closed
```

Exactly one lexical call and at most one content fetch are permitted. Content
accepts only the exact frozen handles produced by that lexical transition;
copying, reordering, adding, or dropping a handle is invalid. Every exit path
closes the session. A copied, structural, wrong-generation, wrong-caller,
expired-turn, reused, or out-of-order operation fails 503 before additional
index or content access.

### Exact serving order

```text
raw body cap + closed canonical request validation
  -> pure query analysis and bounds validation (no corpus/state access)
  -> enrollment/key/signature/freshness authentication
  -> current installation/access/membership snapshot
  -> capture one admitted exact-head generation
  -> read only text-free eligible segment headers
  -> independently evaluate the two closed policy paths
  -> mint one request-local scope
  -> open only scoped lexical segments and score candidates
  -> merge and take the first ten by the exact global order
  -> fetch only those scoped content items and verify every binding
  -> build and canonicalize one exact response buffer
  -> final Authority fence and full mutable-state/head recheck
  -> append query-decision audit and commit
  -> send the exact audited buffer
```

An active owner/employee gets the always-declared organization-member segment.
They get a reviewer segment only when its exact frozen principal and membership
equal their current tuple. The two candidate lists are merged only after both
paths are independently proved. Per-item scoring has no corpus statistic, so
the merged order is computed over the authorized union without opening any
other segment.

Every admitted generation always declares the organization-member segment,
including an empty one. Reviewer lookup derives the exact caller segment ID
and performs one manifest-key lookup; no matching declaration is a normal
`not_applicable` path and never scans other reviewer declarations. For either
path, a declared segment whose manifest/file/root is missing, malformed,
unreadable, or mismatched is `indeterminate` and makes the whole request fixed
503. `absent_by_complete_manifest` and reviewer `not_applicable` may yield a
valid empty path; damaged state may not masquerade as empty.

An empty eligible segment set or no lexical matches returns audited empty 200
without content reads. A failed policy path does not erase an independently
proved path, but an indeterminate/corrupt path makes the whole search request
unavailable rather than silently pretending it was empty.

### Final consistency fence

The single-process Authority adds one search authorization fence shared by:

- record append/head transition;
- every membership, enrollment, installation, lease, and policy mutation;
- stopped active-generation publication; and
- the final search response commitment.

The primitive is one process-owned asynchronous fair read/write lock,
`ReadableSearchAuthorizationFence`. Runtime composition creates exactly one
instance and injects it into every path above. It is not reconstructed per
module. Acquisition order is always:

```text
global fence side
  -> Authority SQLite transaction, when needed
  -> integrations/control-plane transaction, when needed
  -> record-log transaction, when needed
  -> immutable generation file reads
```

No code acquires the fence while holding a database transaction, and no path
holds two SQLite write transactions simultaneously. Existing operation-
specific crash recovery remains responsible for multi-database workflows; the
fence supplies the one live-process order and makes partial live observation
impossible.

Person/policy mutations, the final record-log append/head transition, and
active-pointer publication acquire the write side before their first final
state recheck and retain it through commit/head update. Preliminary signature,
provider, and immutable-evidence work may occur outside, but all mutable facts
are rechecked as their existing contract requires after the write side is
held. Authority database mutations remain ordered by their existing
`BEGIN IMMEDIATE` transactions.

Expensive search occurs outside the fence against one immutable generation.
The final search acquires the read side, then:

1. rereads the record-log head and immutable active generation pointer;
2. begins the Authority `writeAtLinearization` transaction;
3. re-resolves the exact caller installation, enrollment, access lease,
   principal, membership, type, and status;
4. rechecks policy-contract digests, active generation pointer, manifest, and
   record head position/hash;
5. re-evaluates every returned item's policy path against the same selected
   facts; and
6. appends the audit for the already serialized response bytes and commits.

The read side remains held until the application hands the exact immutable
buffer to the HTTP adapter, then releases in `finally`. Concurrent searches may
hold the read side together and serialize only their short audit transactions;
no authorization-relevant write can commit between final recheck and handoff.
If lock or transaction acquisition exceeds the fixed request deadline, the
route returns fixed 503 and sends no prepared prefix.

If the caller becomes inactive, the final transaction commits the appropriate
audited 401/404 denial bytes. If any selected reviewer path, record head,
generation, policy, or binding changed, the request returns fixed 503; it does
not trim, rerank, retry against a different generation, or serve the old
buffer. A mutation ordered after commit affects the next request.

There is no multi-writer claim. A second Authority writer requires a separate
distributed fence design before it can serve this route.

## Search query-decision audit

Search uses a new isolated table and operation, not Job A's reviewer audit and
not the generic admin activity list:

```text
operation = permission.readable_search_decided
retention = 180 days from Authority-owned transaction time
```

Closed allow reason:

```text
active_member_with_scoped_policy_paths
```

Closed audited denial reasons:

```text
installation_access_expired
inactive_or_unbound_organization_membership
inactive_or_revoked_installation_enrollment
```

After a signature authenticates a known enrollment, an expired lease maps to
the first reason and fixed 401; a missing/revoked membership or membership-
revoked enrollment maps to the second and fixed 404; an installation-revoked
enrollment or revoked installation access state maps to the third and fixed
404. Unknown enrollment, invalid signature, and stale request remain pre-audit
401. Operational 503/500 outcomes are not authorization decisions and do not
append this table.

The migration creates this exact logical table:

```text
authority_readable_search_query_audit(
  audit_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  occurred_at canonical UTC-millisecond timestamp,
  retain_until = occurred_at + 180 days to the exact millisecond,
  operation = permission.readable_search_decided,
  decision = allow | deny,
  reason_code,
  detail_json canonical closed JSON object
)

INDEX authority_readable_search_query_audit_retention
  (retain_until, audit_sequence)
```

Checks bind allow only to `active_member_with_scoped_policy_paths` and deny
only to the three denial reasons above. An unconditional trigger denies direct
delete and another denies every update. Online repository interfaces expose
only append inside `writeAtLinearization`; generic admin list/count and every
other online operation cannot read, update, or delete this table.

`scope_binding_sha256` is the canonical SHA-256 of:

```text
schema_version = 1
kind = readable-search-scope-binding-v1
request_sha256
requester = {
  principal_id,
  membership_id,
  membership_type,
  enrollment_id,
  installation_id
}
person_state_sha256
operation = search-readable
retrieval_contract_sha256
policy_contracts = <the exact two-entry policy array from the search contract>
generation = {generation_id, manifest_sha256}
record_head = {position, record_hash}
admitted_segments = <dense policy-id ASC array of exact {
  policy_id,
  segment_manifest_sha256
}>
```

An empty allowed corpus still carries the always-declared organization segment
manifest digest. The digest reveals no segment name or tuple and binds the
exact authorized union used for search.

The exact allow `detail_json` is:

```text
schema_version = 1
kind = readable-search-query-decision-audit-detail-v1
request_id
request_sha256
requester = {
  principal_id,
  membership_id,
  membership_type,
  enrollment_id,
  installation_id
}
decision = allow
reason_code = active_member_with_scoped_policy_paths
evaluation_complete = true
retrieval_contract_sha256
policy_contracts = <exact two-entry policy array>
person_state_sha256
scope_binding_sha256
generation = {generation_id, manifest_sha256}
record_head = {position, record_hash}
returned_atom_ids = <ordered dense array>
returned_record_hashes = <aligned ordered dense array>
returned_policy_ids = <aligned ordered dense array>
evaluated_at
response_sha256
```

The denial detail has the same schema/kind, request, requester, decision,
reason, evaluation, retrieval/policy contracts, Person state, evaluated time,
and response digest. It sets `decision = deny`, uses one closed denial reason,
and omits `scope_binding_sha256`, `generation`, `record_head`, and all returned
arrays entirely. Every nested object and array is closed/dense. The repository
receives the exact prepared response bytes, recomputes `response_sha256`,
validates the entire detail, and derives `occurred_at` and `retain_until` from
the final transaction's one sampled time before insert/readback.

It stores no raw query, analyzed term, text, snippet, score, posting, candidate
count, hidden result, segment name, file path, or corpus statistic. The signed
request digest binds the query without copying it into audit. A denial stores
no returned-item identifiers or hidden metadata.

Audit rows are immutable for 180 days, excluded from generic admin listing and
counts, and governed by two action-specific stopped commands built on the
shared non-callback `query-audit-maintenance-v1` primitive:

```text
echo-organization-authority readable-search-query-audit-export
  --config <absolute-path> --command <absolute-json-path>
  --output <absolute-path>

echo-organization-authority readable-search-query-audit-expire
  --config <absolute-path> --command <absolute-json-path>
```

The export command exact keys are:

```text
schema_version = 1
kind = echo-authority-readable-search-query-audit-export-command
command_id = sqa_<uuid-v4>
authority_id
organization_id
owner_principal_id
owner_membership_id
requested_at
reason
from_inclusive
until_exclusive
output_path_sha256
```

The expiry command omits the range/output and uses kind
`echo-authority-readable-search-query-audit-expiry-command`. Both use the same
`sqa_*` namespace, full canonical `command_sha256`, current exact active-owner
check, five-minute first-execution freshness, initialization/runtime locks,
and retry-before-freshness rule as Job A. The same ID with different bytes or
action is conflict. Only stopped `operator-state` imports the two concrete
actions; no generic callback or escaped transaction exists.

Export selects at most a positive 31-day non-future half-open range and emits
the canonical document
`echo-authority-readable-search-query-audit-export` whose rows are ordered by
`audit_sequence` and contain exactly `audit_sequence`, `occurred_at`,
`retain_until`, `operation`, `decision`, `reason_code`, and parsed `detail`.
Its generic immutable control action is
`permission.readable_search_query_audit_export_authorized`; its closed detail
contains command ID/digest, Authority/organization/owner, reason, range,
output-path digest, row count, ordered-row digest, and export digest.

The export authorization commits before a create-once mode-0600 file is
published beneath a current-user mode-0700 directory outside managed state.
Exact retry may reproduce only the byte-identical retained row set; it never
overwrites. Expiry accepts no caller cutoff, uses its transaction-owned time,
selects/deletes all and only complete rows whose `retain_until` has elapsed,
and appends `permission.readable_search_query_audit_expired` with the exact
command/owner/reason, `retention_days = 180`, cutoff, row count, and ordered-row
digest in the same transaction. The persistent default-deny delete trigger is
temporarily replaced only inside the maintenance savepoint and is restored on
success or rollback. Both control rows are immutable and invisible to query-
audit serving. These mechanics are identical to the finalized Job A governed
maintenance contract but use distinct command kinds, actions, details, and
table; a shared primitive must satisfy both suites before either release.

Audit failure, retention-state corruption, or inability to append the exact
decision releases no response bytes.

## Failure, leakage, and telemetry rules

- No valid scope means no lexical or content file is opened.
- Candidate enumeration is never final authorization.
- Missing or invalid policy data never defaults to organization-readable.
- Global retrieval followed by an ACL post-filter is prohibited.
- Hidden items cannot affect caller-visible candidates, per-item scores, order,
  response bytes, witnesses, or error classification. Governed audit may
  change only in its required opaque global record-head, generation, manifest,
  and scope commitments; it contains no hidden item ID, policy partition,
  count, term, text, or segment identity.
- A scope cannot be persisted, reused, logged, serialized, cloned, or supplied
  by a client.
- A B miss or failure never triggers a Job A, pilot, legacy, broad-derived, or
  raw-log content scan.
- Normal logs, metrics, traces, health, errors, and audit contain no raw query,
  terms, content, result text, segment identity, corpus size, candidate count,
  or indexing lag distance.
- Query and result caches are disabled.
- Requests never trigger indexing, catch-up, rebuild, file repair, or policy
  reclassification.
- No external API receives query, content, term, or index material.
- V1 makes no constant-time or resource-side-channel claim. Semantic/output
  noninterference is required; a stronger timing threat model is separate.
- No response is streamed. The complete buffer is withheld until the final
  audit commits.

## Build order and implementation gates

Implementation is sequential. A later stage cannot make an earlier incomplete
stage look acceptable, and no stage is a release by itself.

1. **Pin the predecessor.** Satisfied by reviewed Job A commit
   `03167cfd66fa0b5fe983abbf266271178548efb8`. Every Job B stage must keep its
   complete validation suite green.
2. **Land organization policy admission.** Protocol/API schema v3, frozen human
   consequence/card, Authority proof/audit, append capability, append-atomic
   facts, strict duplicate behavior, derived compatibility exclusion, startup
   admission, and local cross-layer tests all turn green before search code.
3. **Freeze search wire bytes.** Add closed API types/validators/creators,
   analyzer/ranking constants, policy/witness literals, response cap, fixed
   errors, and golden canonical fixtures.
4. **Build private generations.** Add the new workspace/state root, strict
   Layer 1 classification, plane schemas, deterministic analyzer/postings,
   segment/generation manifests and roots, full staging build, stopped
   publication, startup admission, and deterministic rebuild.
5. **Bind scope before search.** Add narrow facts/search/content ports,
   unforgeable request-local scope, physical segment isolation, exact
   authorized-union ranking, and source-boundary tests.
6. **Serve and audit.** Add the signed route/client/CLI, current-Person
   resolver, shared record-head fence, final recheck, pre-serialized response,
   isolated 180-day audit, and no-store transport.
7. **Validate the whole Layer 2.** Run the complete local lifecycle,
   adversarial noninterference, crash/rebuild/restore, and race matrix. No
   component is promoted without the end-to-end operation.
8. **Review and founder-live.** Independent code/security/lean reviews, one
   uniquely seeded real-Slack lifecycle, then a separate release decision.

## Minimum acceptance matrix

1. **Human consequence:** the exact organization-wide consequence, complete
   release draft, actor, card, provider evidence, semantic intent, and audit
   bind before append; any edit/mismatch creates neither record nor fact.
2. **Strict policy dispatch:** schema v1/pilot, reviewer v2, member-readable
   v3, rejection, malformed, and unknown versions never cross-classify or
   fallback.
3. **Atomic member facts:** every v3 record and complete text-free item-fact set
   co-commit; failure, duplicate mismatch, missing capability, fact tamper, or
   audit corruption commits neither or makes the policy unavailable.
4. **Exact membership semantics:** a later/replacement active membership sees
   organization-member content; only the frozen exact membership sees its
   reviewer content; revocation removes both current paths as applicable.
5. **Facts before index/content:** invalid caller, inactive membership, missing
   fact, invalid scope, or empty scope opens no lexical/content handle.
6. **Physical isolation:** an ordinary member opens only the organization
   segment; an exact reviewer may additionally open only their own reviewer
   segment. Global/other-reviewer/broad-derived/raw-log access is unreachable.
7. **Hidden-corpus noninterference:** add, remove, or alter another reviewer's
   records, publish a complete exact-head generation for each corpus, and
   assert byte-identical ordinary-member results, order, witnesses, and error
   behavior. The interval before republish is the separately expected global
   strict-head 503. Audit stays closed/minimized and may differ only in
   transaction time/sequence and required opaque global head/generation/scope
   commitments, never in a hidden item, tuple, partition, count, term, text,
   or segment identity.
8. **Exact lexical semantics:** Unicode analyzer fixtures pin tokens; matches,
   term frequencies, four-key ordering, ten-item cap, and empty results are
   deterministic across input enumeration order and full stopped rebuild.
9. **Plane binding:** swapped fact, content, posting, segment, manifest,
   policy, proof, record, analyzer, or generation material fails before text
   release.
10. **Generation integrity:** missing/partial/corrupt generation, position-only
    head match, wrong hash/build/runtime/analyzer/contract/root, orphan staging,
    and mixed segment files never serve.
11. **Strict-head availability:** any record append after publication makes
    search fixed-503 until a complete exact-head generation publishes; append
    itself remains available and never waits for B.
12. **Crash and rebuild:** crashes throughout staging/rename/pointer commit
    leave either the prior pointer or one complete new pointer; stopped rebuild
    reproduces logical roots/generation ID and never mutates active files.
13. **Final races:** membership, lease, installation, record-head, policy, and
    generation changes before final commit deny or return unavailable; changes
    after commit affect only the next request; audit failure sends no bytes.
14. **Audit/telemetry:** exact response digest and opaque returned bindings are
    audited for 180 days; raw query/text/terms/scores/segments/counts never
    enter audit, logs, traces, metrics, cache, or an external provider.
15. **Restore:** internally consistent stale state remains offline until
    independently retained heads/receipts, Person state, policy facts, record
    head, active pointer, manifests, roots, and audit storage reconcile.
16. **Source boundaries:** serving code cannot import raw databases, broad
    derived accessors, builders, migrations, filesystem paths, or maintenance
    commands; builders cannot import current Person state; fact code cannot
    import content/index readers.
17. **Cutover:** shadow generations cannot alter Job A behavior. The search
    route has one serving substrate and never unions/falls back across A/B.
    Job A's reviewer-recent route stays log-backed unless separately reviewed.
18. **Founder-live:** a real reviewer-v2 record and a real organization-v3
    record survive Authority restart and stopped generation rebuild; the exact
    reviewer sees both, a separately enrolled later member sees only the
    organization item, and no hidden segment/content access occurs.

## Rebuild, backup, restore, and operations

The stopped operator backup procedure includes the active generation pointer,
complete referenced generation directory, manifest sidecars/digests, and all
existing Authority, integration, record-log, and record-derived state. It
refuses temporary build directories, incomplete generations, WAL/SHM
sidecars, or a pointer whose manifest/head does not verify.

The retrieval generation is disposable, but restore is not permission to
serve. The restore runbook keeps Authority stopped and records evidence
outside restored state for:

- current membership, enrollment, installation, lease, and revocation state;
- complete integration audit and both policy-proof families;
- record chain, externally retained heads/receipts, and policy facts;
- active pointer, exact record head, generation manifest, every segment/root,
  and analyzer/build/contract versions; and
- writable query-audit storage and applicable audit-maintenance receipts.

A missing generation may be rebuilt from verified current Layer 1. A stale but
internally valid generation may not serve as a prefix. A failed rebuild leaves
the previous generation untouched; if its head is stale, it remains present
but unavailable. Active files are never repaired in place.

No local hash chain or manifest detects a perfectly consistent whole-state
rollback by itself. Release after restore remains a trusted operator decision
against independently retained evidence, matching the constitution's threat
boundary.

## Relationship to Job A and cutover

Job A remains the production candidate for its exact reviewer recent-read
operation. B consumes canonical reviewer-v2 Layer 1 records and compares its
reviewer classification with A's facts while building. That comparison proves
equivalence; it does not copy an allow.

B is first built offline or in non-serving shadow mode. Shadow state cannot
change Job A latency, readiness, audit, output, or failure classification.
`/v1/readable-search` switches from unavailable to one admitted B generation
only after every local acceptance item passes. It never consults Job A as a
fallback. Job A never waits for B and does not read B readiness.

Whether the existing reviewer-recent route later moves to B is a separate
product and migration decision. This contract does not retire the pilot or Job
A.

## Invariant trace

| Invariant | Minimum-V1 mechanism |
| --- | --- |
| `INV-01` authorize before scoring/model access | current Person plus closed policy facts mint the scope before any lexical handle opens |
| `INV-02` do not stamp readers into content | organization records carry policy and approval provenance; current membership is resolved at request time |
| `INV-03` existence and content differ | only readable search exists; no discovery/count/hidden stub surface |
| `INV-04` deterministic witness | each returned item carries its one exact policy ID and fixed caller-knowable witness |
| `INV-05` one consistency boundary | exact-head immutable generation, shared record-head fence, final Person/policy/head recheck, audit, and identical bytes |
| `INV-06` failure cannot widen | missing/stale/mixed/corrupt state is fixed-503 with no fallback or prefix serving |
| `INV-07` structure/statistics inherit visibility | physically isolated scoped segments and per-item term-frequency scoring use no hidden corpus statistics |
| `INV-08` models cannot confer access | no model exists in V1; future inferred output cannot become a policy fact |
| `INV-09` recording creates no recipient list | human-approved policy can cover later current members, but no reader identities are frozen into the record |
| `INV-10` audit without a second disclosure | isolated 180-day audit stores request/response and opaque result bindings, never query or content text |
| `INV-11A` reviewer reads start from append-atomic facts | Job A remains the reviewer input/equivalence foundation |
| `INV-11B` permission-aware derived retrieval starts from text-free facts | new generation facts, opaque scope, separated planes, roots, and candidate-first search implement this invariant for one operation |
| `INV-12` approval binds consequence | both reviewer-only and organization-member-readable admissions bind the exact human consequence before append |

## Future flexibility without a generic permission engine

The extension seam is a closed policy branch, not configuration rows such as
`reader_principal = NULL`, `role = *`, or `default_allow = true`.

A future team, role, attendee, or direct-grant policy must define its own:

1. versioned human consequence and admission/proof contract;
2. immutable text-free fact subtype;
3. current Person/effect resolver;
4. physical candidate partition and input/root binding;
5. deterministic witness and audit reason; and
6. no-widening, overlap, deduplication, ranking, restore, and race tests.

Only after a real third path exists should the two-branch V1 scope be
generalized. That keeps today's policy explicit while preserving a stable
architecture for later permission types.

## Grounded implementation footprint

Expected new/changed areas are:

- `packages/organization-protocol`: organization-member release draft,
  presentation, policy contract, permission evidence, and envelope-v3 closed
  validators/creators;
- `packages/organization-api`: schema-v3 permission check plus readable-search
  request/response/error contracts and canonical fixtures;
- Slack product/control-plane/Authority paths: frozen organization policy
  card, exact live proof, immutable audit lookup, append capability, and fixed
  failures;
- `services/organization-record`: member-policy fact migration/admission and
  v3 broad-derived exclusion;
- new `services/organization-retrieval`: builder, plane migrations, analyzer,
  manifests/roots, stopped generation publication adapters, and narrow serving
  ports;
- `services/organization-authority`: active pointer, startup admission,
  current-Person scope composition, shared record-head fence, route, isolated
  audit, backup/restore/rebuild commands, and lifecycle tests; and
- product client/reader/CLI: signed `organization readable-search` operation
  with in-memory/no-store response handling.

This is larger than Job A because it deliberately validates the whole mutable
Layer 2 lifecycle. The minimum choices above remove vector, graph, model,
discovery, pagination, generic policy, caching, external custody, online
building, and multi-writer work rather than leaving them as half-implemented
hooks.

## Review provenance and closure

The earlier B draft was a deferred architecture menu. It named reviewer-only
segments but deferred the product operation, API, engine, and organization
policy. On 2026-08-12 the founder directed that Job B become an
implementation-ready minimum V1 and that Layer 2 be validated as one complete
slice.

Five focused read-only reviews covered storage/generation, Authority/wire,
policy semantics, lean scope, and acceptance/restore. Their common findings
are incorporated here:

- use a new explicit organization policy rather than widening Job A;
- make later-member semantics visible in the human consequence;
- keep physical policy segments and score without global corpus statistics;
- build one complete stopped generation instead of an online generic
  substrate;
- ship one exact lexical route and audit rather than vector/model/graph hooks;
  and
- require the entire approval-to-search lifecycle before calling Layer 2
  validated.

A final read-only `claude-fable-5` lean review found no P0 security or
no-widening gap. Its two P1 findings are incorporated: query and document
analysis now have distinct closed bounds/overlong-term behavior, and the
search route reuses the Authority's landed fixed 401/500 bytes. The same pass
removed redundant per-record roots, an unused reverse-posting index, and the
backward coupling from immutable admission policy to one search wire version.

The remaining boundary is implementation start. This contract freezes the
exact policy consequence, two-policy search union, and wire/analyzer choices
above; changing one requires a reviewed contract revision rather than an
implementation-time interpretation.
