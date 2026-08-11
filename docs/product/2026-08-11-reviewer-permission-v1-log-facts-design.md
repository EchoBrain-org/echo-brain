# A: Reviewer permission minimum V1 with append-atomic log facts

**Status:** approved implementation contract. The founder choices are closed,
and fresh code-grounding, storage/port, wire-contract, scope, and invariant
reviews completed against the named baseline. This status authorizes only the
implementation described here. It is not implemented, merged, deployed, or
released.

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
  -> policy-routed reviewer-fact lookup by exact principal + membership
  -> current-Person resolver
  -> request-local content binding
  -> canonical reprojection of only referenced Layer 1 records
  -> final Person recheck + exact-response audit commit
  -> immutable response bytes
```

The landed two-person pilot remains frozen. Pilot-v1 records are never
reviewer-V1 candidates, reviewer-v2 records never satisfy pilot eligibility,
and neither route falls back to the other.

### Founder decisions confirmed 2026-08-11

The founder confirmed all four release-contract choices without amendment:

1. the exact human consequence below is the V1 product copy;
2. reviewer query-decision audit rows are retained for 180 days;
3. pilot retirement remains outside this V1; and
4. the scoped append-atomic fact rule (`INV-11A`) and consequence-binding rule
   (`INV-12`) govern this implementation.

These are closed decisions. Changing any one requires a reviewed contract
revision rather than an implementation-time interpretation.

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

### Publication-mode freeze

Reviewer V1 is a new, narrow publication mode, not a reinterpretation of an
already-posted card. Runtime configuration may select exactly one mode for
future Slack publications: `ordinary-v1`, the frozen
`pilot-member-readable-v1` mode, or `restricted-reviewer-v1`. Pilot and
reviewer presentation configuration are mutually exclusive and startup
rejects both being enabled.

Publication first creates the immutable local slot
`presentation-contract-slack-authority-v1.json` under the existing decision-
node lock, **before** any Slack request. Its exact event is:

```text
schema_version = 1
event_type = approval-presentation-contract
node_id
surface = slack-authority-v1
created_at
presentation_contract = <the exact object below>
```

`presentation_contract` is this exact closed object:

```text
schema_version = 1
kind = echo-slack-approval-presentation-contract
mode = restricted-reviewer-v1
adapter_id
adapter_instance_id
adapter_version
channel_id
reviewer_slack_user_id
reviewer_name
credential_ref
credential_fingerprint_sha256
approve_reaction
reject_reaction
reviewer_release_draft_sha256
approval_presentation_sha256
```

The release draft is deterministically reprojected from the already-immutable
requested decision; the slot stores only the closed contract and digests, the
non-secret `env:`/`file:` credential reference, and frozen adapter settings,
not token bytes or a second copy of title/item text. The credential fingerprint
is `canonicalSha256({schema_version:1,
kind:'slack-credential-fingerprint-v1', token:<resolved token>})`; it is local-
only and detects in-place secret rotation without persisting the token.
Creating the slot is an atomic create-once
operation. An existing slot must validate exactly, and its frozen mode and
adapter identity/reaction pair override current configuration for every render,
post retry, poll, and action request. The adapter reprojects the immutable
requested slot and requires both stored digests before remote I/O.

The existing `published-slack-authority-v1.json` slot remains only the durable
`channel_id`/`message_ts` reference written after Slack acknowledges the exact
card. A crash after Slack accepts the post but before that reference is filed
may cause an at-least-once duplicate post, as today, but every retry renders
the same frozen contract. An unrecorded Slack message is never polled and its
reaction cannot produce an action request. No retry consults current mode or
reaction configuration.

A content change creates a new processing revision, approval ID, requested
slot, release draft, card, and presentation-contract slot. Existing ordinary
or pilot cards retain their original path and can never be upgraded,
downgraded, or silently interpreted as reviewer V1.

Enabling reviewer mode performs a local preflight over unresolved
Authority-marked slots and refuses startup if any card was published without
the reviewer contract; those ordinary/pilot cards must be resolved or rejected
under their original configuration first. Resolved historical slots need no
rewrite. Once reviewer mode is enabled, every new Authority-marked card carries
the exact pre-publication slot above. No migration guesses a mode from current
configuration, and the pilot's existing read eligibility remains frozen.

Reviewer V1 forbids in-place reaction-pair, adapter-identity, channel,
reviewer, credential-reference, credential value, workspace, bot, or app
rotation while any local reviewer presentation contract is unresolved. Local lifecycle
preflight scans those slots and rejects such a configuration change. A new
provider configuration requires a new immutable secret reference,
`adapter_instance_id`, connection, and central binding for future cards. The
old credential reference/value, connection, and binding remain usable until
their locally known cards resolve, after which they may be revoked. Render,
post retry, polling, live identity lookup, and action authorization resolve the
credential and all adapter settings from the stored contract, require the
resolved credential fingerprint to match, and never use the new
configuration. If an operator violates that drain order, the frozen card fails closed and is not
reinterpreted; recovering it requires restoring the exact old binding or an
explicit future retirement feature, not using the new pair. This is a V1
one-reviewer operational constraint, not a distributed pending-card registry.

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
lowercase wire kind, with no trailing LF:

```text
Decision brief awaiting approval.
Title: <exact card_title>
<kind>: <exact item text>
...one line for every frozen item...
Approving records this package under restricted-reviewer-v1. Only you, the approving reviewer, may later read its decisions, actions, and rationales while this exact reviewer membership remains active.
React :<approve_reaction>: to approve or :<reject_reaction>: to reject. To record a reason, reply in this thread before reacting.
```

There is one positive policy. A selector, workbench, or second positive choice
adds no V1 value. No reviewer-v2 producer or read route ships before this
consequence is verified end to end.

### Frozen pre-approval release draft

Before posting the card, the decision-node processor derives this exact-key,
dense-array document from `requested.json` and freezes its RFC 8785 digest in
the publication contract:

```json
{
  "schema_version": 1,
  "kind": "reviewer-release-draft-v1",
  "approval_id": "<64 lowercase hex>",
  "card_title": "<exact title>",
  "items": [
    { "signal_id_sha256": "sha256:<digest>", "kind": "decision", "text": "<exact text>" }
  ]
}
```

Kinds are exactly `decision`, `action`, or `rationale`. Title and item text are
already NFC, trimmed, single-line, non-empty, contain no Unicode `Cc`, `Zl`,
`Zp`, or unpaired surrogate, and are bounded to 150 and 240 Unicode scalar
values respectively. `signal_id_sha256` is the lowercase SHA-256 digest of the
exact UTF-8 bytes of the frozen protocol `signal_id`. The source `signal_id` is
NFC, trimmed, non-empty, contains no Unicode `Cc`, `Zl`, `Zp`, or unpaired
surrogate, is at most 512 UTF-8 bytes, and is unique within the payload; its
digest must therefore also be unique within the draft. The
raw ID is neither rendered nor sent to Authority at approval time. The array
contains 1..10 items and rejects holes, symbols, accessors, missing keys, and
extra keys.

The sole projection is:

```text
card_title = payload.brief.meeting.title ?? payload.brief.meeting.id
items = payload.brief.decisions, then actions, then rationales
item = exact {
  signal_id_sha256: sha256Utf8(signal.id),
  kind: signal.kind,
  text: signal.text
}
```

Draft order is exactly the current projector's canonical order: decisions in
payload order, then actions in payload order, then rationales in payload order.
The final envelope preserves each raw `signal_id`, kind, text, collection, and
within-collection order; ingest hashes each raw ID and requires the complete
reprojected draft to match. The internal atom identity remains the landed
`derivedAtomId(record_hash, signal_id)`; A introduces no new atom-ID scheme.

The card renders the title and every item's kind/text verbatim. It has no ellipsis,
truncation, hidden count, or unrendered releasable item. A draft that cannot
fit the complete closed card is not eligible for reviewer V1.

`reviewer_release_draft_sha256 = canonicalSha256(release_draft)`. The renderer
and action authorizer reproject the same document from the requested slot and
require that digest. The signed reviewer action request carries only this
content-free digest, never the draft, title, text, raw signal ID, meeting ID,
or processing key. Authority reconstructs the exact draft from the live Slack
card grammar below, hashes it, and then discards the transient title/text; it
never persists or audits them. Envelope building and ingest independently
reproject from the final payload and require digest equality. At every
boundary, draft `approval_id`, decision-node `approval_id`, envelope
`idempotency_key`, and authorization `approval_id` are identical.

`approval_presentation_v1` is the following exact-key canonical object:

```text
schema_version = 1
kind = reviewer-approval-presentation-v1
approval_id
approve_reaction
reject_reaction
text
blocks
transport = {
  mrkdwn: false,
  unfurl_links: false,
  unfurl_media: false
}
```

`text` is the exact accessibility fallback above. Every nested object is
closed. The block array is exactly:

```text
{
  type: header,
  block_id: echo-approval-<approval_id>-title-v1,
  text: {type: plain_text, text: <exact card_title>, emoji: false}
}

for each zero-based item i:
{
  type: section,
  block_id: echo-approval-<approval_id>-item-<i>-<signal digest hex>-v1,
  text: {type: plain_text, text: <kind>: <exact item text>, emoji: false}
}

{
  type: section,
  block_id: echo-approval-<approval_id>-reviewer-policy-v1,
  text: {type: plain_text, text: <exact consequence sentence>, emoji: false}
}

{
  type: context,
  block_id: echo-approval-<approval_id>-reaction-v1,
  elements: [{
    type: mrkdwn,
    text: React :<approve_reaction>: to approve or :<reject_reaction>: to reject. To record a reason, reply in this thread *before* reacting.,
    verbatim: false
  }]
}
```

`<signal digest hex>` is the 64 lowercase hex characters after `sha256:` in
the corresponding draft item. Both reaction names match
`^[a-z0-9_+-]{1,64}$` and are distinct. No other block, element, field,
truncation, summary, or ellipsis is allowed.

The Slack transport sends `text`, `blocks`, and the three fixed `transport`
values, with strict post acknowledgement. The client gains the explicit
`mrkdwn` input needed to send `false`; link and media unfurl flags remain
false. Slack returns message `text` and `blocks`, not those transport flags, so
publication verifies the complete acknowledgement while action-time live
verification compares only provider-returned `text`/`blocks` and relies on the
fixed contract constants for transport. It never claims Slack reported fields
that Slack does not return.

Authority parses only this closed live card grammar, reconstructs the release
draft from title, item kind/text, item-order, and signal-ID digests, and
computes both `reviewer_release_draft_sha256` and
`approval_presentation_sha256`. The Slack provider compares every live block
and fallback, verifies the expected team/app/bot/channel/message, requires
`edited` to be absent, and verifies the reaction before accepting evidence.

The control-plane verifier adds a closed reviewer variant without changing the
pilot variant or null legacy path. Its reviewer expectation contains exactly
`policy_id`, `approve_reaction`, `reject_reaction`,
`reviewer_release_draft_sha256`, and `approval_presentation_sha256`; approval
ID and provider coordinates remain the existing top-level verifier inputs. A
positive result returns those two recomputed digests plus
`message_presentation_sha256` and no title, text, block, or reconstructed draft.
Missing/malformed blocks, wrong digest/order/reaction, edit evidence, or a
mixed pilot/reviewer presentation cannot produce reviewer proof and never
downgrades a schema-v2 request to legacy allow.

### Exact reviewer approval request and decision

Reviewer approval uses schema version 2 of the existing
`echo-organization-permission-check-request` on
`POST /v1/permission-checks`. Reviewer-card rejection continues through the
unchanged schema-v1 request and rejection record path. Schema v2 requires
`action = approve`; a v2 rejection is invalid.

For that schema-v1 rejection only, the surface takes `reaction_name` from the
stored presentation contract's frozen `reject_reaction`; it never reads the
current local setting. Authority still requires that reaction to match the
current active central adapter binding. The Slack parser always recognizes the
reviewer policy/item namespace as an extension, even when no reviewer proof is
requested. For this rejection it parses both frozen reaction names from the
closed live context/fallback, requires request `reaction_name = live
reject_reaction`, uses `live approve_reaction` as the verifier's opposite, and
requires **both** live names to equal the current active binding's pair. Any
pair rotation, mixed namespace, malformed reviewer card, or conflicting
reaction denies rather than reinterprets the card. A valid rejection produces
no reviewer digests.
An allowed reject keeps the landed rejection reason/evidence, resolves the node
as rejected, emits only the schema-v1 rejection envelope, and creates neither
reviewer content nor reviewer facts. It cannot fall through the schema-v2
approval path.

The schema-v2 signed request has exactly these top-level keys:

```text
schema_version = 2
kind = echo-organization-permission-check-request
request_id = pcr_<uuid-v4>
authority_id
authority_key_id
organization_id
enrollment_id
installation_id
installation_key_id
provider = slack
provider_issuer = https://slack.com
provider_tenant_kind = workspace
provider_tenant_id
provider_enterprise_id
provider_connection_subject_id
provider_connection_bot_id
provider_connection_app_id
provider_subject_kind = human_user
provider_subject_id
adapter_kind = approval-surface
adapter_id
adapter_instance_id
adapter_version
action = approve
approval_id
channel_id
message_ts
reaction_name
approve_reaction
reject_reaction
policy_id = restricted-reviewer-v1
reviewer_release_draft_sha256
approval_presentation_sha256
provider_event_sha256
requested_at
http_method = POST
http_path = /v1/permission-checks
integrity
```

All inherited IDs, nullable enterprise/app fields, Slack coordinates, adapter
fields, and `integrity` retain their schema-v1 validators. `requested_at` uses
the configured absolute-difference freshness window in `1..300000` ms (300000
ms in the standard configuration, with the exact boundary accepted). Both
reaction names match
`^[a-z0-9_+-]{1,64}$`, must be distinct, and the inherited selected
`reaction_name` equals `approve_reaction`. Authority passes the frozen
`reject_reaction` to the internal Slack verifier as
`opposite_reaction_name`; that internal port field is not a public request key.
The three request adapter-identity fields and both reaction fields must equal
the immutable local presentation contract; request `channel_id` and
`provider_subject_id` must equal its frozen channel and reviewer Slack user.
The local reviewer label used on resolution also comes from that contract.
Neither Authority nor provider code consults current local adapter/reaction/
credential configuration. Authority separately requires the named central
binding, provider connection, and live bot/app/workspace identity to remain
currently active and exact.

The v2 provider-event preimage has exactly these keys:

```text
schema_version = 2
kind = echo-organization-permission-provider-event
authority_id
authority_key_id
organization_id
enrollment_id
installation_id
installation_key_id
provider
provider_issuer
provider_tenant_kind
provider_tenant_id
provider_enterprise_id
provider_connection_subject_id
provider_connection_bot_id
provider_connection_app_id
provider_subject_kind
provider_subject_id
adapter_kind
adapter_id
adapter_instance_id
adapter_version
action
approval_id
channel_id
message_ts
reaction_name
approve_reaction
reject_reaction
policy_id
reviewer_release_draft_sha256
approval_presentation_sha256
http_method
http_path
```

`provider_event_sha256` is the canonical SHA-256 of that object. The
installation signature covers the complete request and frozen reaction/digest
commitments. Authority takes no raw draft, reviewer identity, semantic digest,
or proof digest from the client.

Both raw HTTP body and canonical schema-v2 document retain the landed
`MAX_ORGANIZATION_API_BODY_BYTES = 16 * 1024` ceiling. The member client
canonicalizes, enforces the same cap, and sends those exact bytes. A larger raw
body receives the fixed pre-application `413` response
`{"error":{"code":"payload_too_large","message":"request body is too large"}}`,
with no parsing, authorization audit, integration lookup, or content access.
Schema-v1 request, validator, client limit, and wire bytes remain unchanged.

Authority live-verifies Slack, reconstructs and hashes the draft/presentation
from the exact live card, matches both signed digest commitments, and only then
resolves the current actor principal and membership. It holds title and item
text only in bounded request memory and never stores, logs, traces, metrics, or
returns them from the approval path. Its canonical
semantic preimage has these exact keys:

This preserves the landed rule that `/v1/permission-checks` carries no meeting
or decision content. It makes one explicit refinement to raw-custody `AD-06`:
the Authority verifier may transiently parse the same bounded proposed items
already present on the organization Slack approval card solely to prove the
human-visible consequence and content binding. Transcripts, vendor payloads,
evidence spans, meeting/participant metadata, and reason text never enter this
path; no pre-approval content is persisted centrally. This reviewer-specific
verification exception is part of `INV-12`, not a general pre-approval ingest
or reusable content API.

Schema-v2 allow additionally requires the Slack reactor's resolved principal
and membership to equal the authenticated enrollment/installation principal
and membership that signed the request. A different linked Slack member is a
`provider_identity_mismatch` denial and cannot create reviewer proof. This
keeps V1 self-only and makes the
integration-audit `actor_kind = installation` principal/membership identical
to the human reviewer; cross-user or delegated approval is out of scope.

```text
schema_version = 1
kind = reviewer-restricted-semantic-intent-v1
authority_id
organization_id
visibility = restricted
policy_id = restricted-reviewer-v1
approval_id
action = approve
reviewer_principal_id
reviewer_membership_id
consequence_version = 1
consequence_text = <exact confirmed sentence>
reviewer_release_draft_sha256
approval_presentation_sha256
evaluated_at
```

`semantic_intent_sha256 = canonicalSha256(semantic_preimage)`. `evaluated_at`
is Authority transaction time; Slack supplies no trustworthy reaction time.

The live provider-message preimage has these exact keys:

```text
schema_version = 1
kind = reviewer-message-presentation-v1
provider_event_sha256
approval_presentation_sha256
team_id
enterprise_id
bot_user_id
bot_id
app_id
actor_user_id
channel_id
message_ts
reaction_name
message_unedited = true
```

`message_presentation_sha256 = canonicalSha256(message_preimage)`. All IDs are
the already validated connection/message/request values; `app_id` must be
non-null and match connection and message for a positive reviewer proof.

The exact schema-v2 decision has only these top-level keys:

```text
schema_version = 2
kind = echo-organization-permission-check-decision
request_sha256
provider_event_sha256
allowed
reason_code
principal_id
membership_id
adapter_binding_id
permission_grant_id
evaluated_at
authorization_audit_event_id
authorization_audit_entry_sha256
reviewer_release_draft_sha256
approval_presentation_sha256
semantic_intent_sha256
message_presentation_sha256
```

For allow, every proof field is non-null, `reason_code` is exactly
`active_reviewer_restricted_notice_v1`, and the four landed actor/binding/grant
IDs are non-null. For denial, all six proof fields and all four
principal/membership/binding/grant fields are null; `reason_code` is exactly
one of `installation_inactive`, `no_active_link_binding_or_grant`,
`provider_unavailable`, `provider_identity_mismatch`,
`provider_reaction_not_observed`, or `target_membership_inactive`.
`active_membership_and_direct_grant` and every pilot reason are invalid in a
schema-v2 decision. Provider-unavailable/not-observed evaluations may be
audited and then surfaced as fixed `503` rather than returning this DTO. For a
schema-v2 permission check, every operational unavailable path returns exactly
`503 {"error":{"code":"unavailable","message":"service is temporarily unavailable"}}`;
the member classifies it retryable and receives no decision/evidence object.
Timestamped/internal provider messages never enter the response. Schema-v1
permission-check status/body behavior remains byte-for-byte unchanged. The existing
pinned-Authority HTTPS rule authenticates the decision; the member verifies
both request/event digests and every returned proof field before resolving the
node. The integration audit stores only digests and identifiers, never draft,
title, or item text, and returns its generated `aud_*` ID and entry digest in
the allow decision.

For an allowed schema-v2 request,
`recordReviewerPermissionDecision()` appends exactly one existing
`organization_integration_audit` row and returns its generated event ID/hash.
Its outer columns are fixed as follows:

```text
organization_id = request.organization_id
occurred_at = evaluated_at
actor_kind = installation
actor_principal_id = reviewer principal
actor_membership_id = reviewer membership
actor_identity_link_id = null
actor_installation_id = request.installation_id
command_id = pce_<uuid-v4>
provider_event_sha256 = request.provider_event_sha256
action = permission.approve
subject_kind = approval
subject_id = request.approval_id
membership_id = reviewer membership
identity_link_id = verified candidate identity link
connection_id = verified Slack connection
adapter_binding_id = verified current binding
permission_grant_id = verified current approve grant
outcome = allowed
reason_code = active_reviewer_restricted_notice_v1
idempotency_key = permission-evaluation:<command_id>
authority_checked_at = evaluated_at
authority_evidence_sha256 = current Authority-status digest
correlation_id = request.request_id
```

Its exact `detail_json` object is:

```text
schema_version = 2
kind = reviewer-restricted-approval-audit-detail-v1
authority_id
request_sha256
provider_event_sha256
principal_id
policy_id = restricted-reviewer-v1
provider = slack
provider_issuer = https://slack.com
team_id
enterprise_id
bot_user_id
bot_id
app_id
actor_user_id
adapter_id
adapter_instance_id
adapter_version
channel_id
message_ts
reaction_name
approve_reaction
reject_reaction
reviewer_release_draft_sha256
approval_presentation_sha256
semantic_intent_sha256
message_presentation_sha256
message_unedited = true
consequence_version = 1
```

The repository RFC-8785 encodes this object, computes its existing
`detail_sha256`, and computes the existing chained `entry_sha256` with one
shared pure helper over exactly this preimage:

```text
audit_sequence
audit_event_id
previous_entry_sha256
occurred_at
actor_kind
actor_principal_id
actor_membership_id
actor_identity_link_id
actor_installation_id
command_id
provider_event_sha256
action
subject_kind
subject_id
membership_id
identity_link_id
connection_id
adapter_binding_id
permission_grant_id
outcome
reason_code
idempotency_key
authority_checked_at
authority_evidence_sha256
correlation_id
detail                      # parsed exact object
detail_json                 # its RFC-8785 string
detail_sha256
```

This deliberately preserves the landed hash contract: `organization_id` and
the output `entry_sha256` are stored columns but are not members of that
historical preimage, while parsed `detail` and canonical `detail_json` both
are. Append and verification must call the same exported helper so existing
entry bytes do not change. The exact-ID lookup reselects all outer columns plus
detail, validates organization binding and the predecessor/sequence relation,
recomputes both hashes, and
reconstructs the semantic and provider-message preimages from these stored
values and the fixed consequence. Its matched `proof` has exactly:

```text
policy_id = restricted-reviewer-v1
reviewer_principal_id
reviewer_membership_id
reviewer_release_draft_sha256
approval_presentation_sha256
semantic_intent_sha256
message_presentation_sha256
authorization_audit_event_id
authorization_audit_entry_sha256
evaluated_at
```

Every value must match the expected schema-v2 authorization evidence. No raw
presentation content is returned. Startup verifies the whole audit chain;
per-ingest and selected-fact lookup revalidate the exact row and preimages.

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
and exact membership. A client cannot nominate a different reviewer. The outer
reviewer object has exactly `principal_id`, `membership_id`, `reviewed_by`, and
`authorization`. `reviewed_by` is the frozen local reviewer display label from
the resolved Slack adapter configuration, is NFC/trimmed/control-free and
1..256 Unicode scalar values, and has no authorization meaning. Principal and
membership must equal the Authority decision. The authorization object has
exactly these keys:

```text
schema_version = 2
kind = echo-organization-authorization-evidence
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
reason_code = active_reviewer_restricted_notice_v1
principal_id
membership_id
adapter_binding_id
permission_grant_id
evaluated_at
authorization_audit_event_id
authorization_audit_entry_sha256
reviewer_release_draft_sha256
approval_presentation_sha256
semantic_intent_sha256
message_presentation_sha256
```

It requires
`allowed = true`, `action = approve`, and the exact reviewer reason. The
envelope reviewer principal/membership must equal that evidence; submitter
installation must equal it; intent digest must equal its semantic digest; and
the evidence `authorization_audit_event_id` and audit-entry digest must be
valid `aud_*`/`sha256:*` values.

Envelope v2 reuses the exact schema-v1 approval payload and submitter shapes
and the landed P-256/RFC-8785 signed-document rules. Additional closed
validation requires:

- `envelope_id` is the landed `rec_<uuid-v4>` form and `idempotency_key` is
  the 64-lowercase-hex approval ID;
- alternatives are empty, links are null, and `payload.surface` is exactly
  `slack-reviewer-v1`;
- payload contains 1..10 release signals satisfying the reviewer bounds;
- deterministic payload projection produces exactly the
  `reviewer_release_draft_sha256` frozen by the publication contract, signed
  request, live-card reconstruction, decision, and immutable audit row;
- `payload.reviewed_at = reviewer.authorization.evaluated_at` and
  `submitter.submitted_at >= payload.reviewed_at`;
- every draft, presentation, semantic, provider-message, audit-event, and
  audit-entry value matches the immutable Authority audit row; and
- the entire canonical signed document remains within the landed 256 KiB
  record-document ceiling.

Reviewer-v2 resolution extends the local resolver input with the Authority
decision's canonical `evaluated_at`. For `surface = slack-reviewer-v1`,
`DecisionNodeStore.resolve()` validates that value against the verified
decision and persists it as `resolved.reviewed_at` instead of sampling its
local clock. An idempotent retry must match status, reviewer, reason, surface,
that exact timestamp, and canonical equality of the complete resolved metadata;
any conflict fails. Reviewer-v2 approval metadata has exactly one key,
`authorization`, whose value is the complete exact schema-v2 authorization
evidence above. The signed request's provider-event digest already binds its
Slack coordinates and frozen adapter/reaction fields, so they are not copied
as a second mutable metadata object. Schema-v1 resolution retains its current
local-clock behavior and metadata shape.

The schema-v1 approval validator explicitly rejects reason
`active_reviewer_restricted_notice_v1`; only schema v2 can carry it. This
prevents a reviewer-approved payload from entering the broad schema-v1 derive
path. Reviewer-card rejection remains a schema-v1 rejection and creates no
reviewer-readable content.

Ingest recomputes and matches every preimage, exact actor, action time, reason,
draft, and message proof before append. Proved mismatch is terminal invalid
input; unavailable or corrupt evidence is retryable `503`. The exact audit ID
is unique by schema, so multiplicity is database corruption rather than an
`ambiguous` lookup result.

Strict v2 dispatch and closed validation land before any v2 producer. Unknown,
malformed, or unproved versions halt and remain invisible. They never fall
back to v1 or pilot behavior.

### Authority-verified reviewer eligibility proof

The record package never queries Authority or integrations databases and does
not trust client-signed evidence fields or a caller-constructible proof object.
The Authority-owned append coordinator first performs an exact primary-key
lookup of the immutable integration-audit row and matches the allowed reason,
actor, action, provider evidence, and every digest.

The signed schema-v2 authorization evidence carries that exact audit event ID
and entry digest. The control-plane port is
`findAllowedReviewerAuthorizationEvidenceById(audit_event_id, expected)` and
returns only `matched {audit_entry_sha256, proof}` or
`absent|mismatch|corrupt|unavailable`; its SQL starts with
`WHERE audit_event_id = ?`. Healthy absent/mismatch is terminal invalid input.
Corrupt/unavailable audit state is retryable `503` and degrades reviewer V1.

Only after that lookup does it mint a single-use, non-exported runtime
`ReviewerRestrictedEligibilityCapabilityV1`. The capability is closure/
`WeakMap` branded, bound to this append attempt and exact canonical envelope,
and can be consumed only by the internal record append port. Its binding
includes organization, envelope ID, idempotency key, installation ID,
canonical-envelope SHA-256, a private append-attempt token, and the fields
below. The final digest is output, not an input to its own preimage:

```text
policy_id = restricted-reviewer-v1
reviewer_principal_id
reviewer_membership_id
reviewer_release_draft_sha256
approval_presentation_sha256
semantic_intent_sha256
message_presentation_sha256
authorization_audit_event_id       # existing unique aud_* key
authorization_audit_entry_sha256
evaluated_at
authorization_proof_sha256
```

`authorization_audit_event_id` is the exact existing unique `aud_*` lookup
key, not a descriptive scan. The control-plane exact-ID lookup returns the
stored audit `entry_sha256` and recomputes that entry before matching the
closed reviewer proof. No control-plane migration is needed.

`authorization_proof_sha256` is `canonicalSha256` of an exact-key object with
this exact preimage:

```text
schema_version = 1
kind = echo-reviewer-restricted-eligibility-proof
organization_id
envelope_id
idempotency_key
installation_id
canonical_envelope_sha256
policy_id = restricted-reviewer-v1
reviewer_principal_id
reviewer_membership_id
reviewer_release_draft_sha256
approval_presentation_sha256
semantic_intent_sha256
message_presentation_sha256
authorization_audit_event_id
authorization_audit_entry_sha256
evaluated_at
```

This `evaluated_at` is one value everywhere: the Authority transaction time in
the permission decision, `reviewer.authorization.evaluated_at`, integration-
audit `occurred_at`, integration-audit `authority_checked_at`, and the local
resolved event's reviewer-v2 `reviewed_at`. Any disagreement is corrupt
evidence and cannot mint a capability.

The private append-attempt token and the output
`authorization_proof_sha256` are both absent from that preimage. The digest is
durable and recomputable at startup; the token exists only as object identity
in the shared private `WeakMap`. The proof digest is only an integrity binding.
The unforgeable capability and exact Authority lookup confer trust. Neither
the capability nor its body is an envelope field, public receipt, serializable
DTO, or exported constructor.

The internal channel factory returns an issuer and consumer sharing one
unexported `WeakMap`. `issue(proofPreimage)` validates the exact durable
preimage above, computes `authorization_proof_sha256`, creates the private
append-attempt token, and returns an opaque capability.
`consume(capability, expected envelope identity)` marks it spent before any
comparison and returns the binding plus recomputed durable proof. Copied,
structural, wrong-channel, reused, or mismatched capabilities fail retryably.
No public module exports a capability constructor or its brand.

The log writer inserts reviewer facts only when:

- the exact reviewer-v2 envelope and live capability are both present;
- consuming the capability proves its single use and exact organization,
  envelope/idempotency/installation identity, canonical-envelope digest, and
  append-attempt token;
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
new attempt capability. Schema-v1 exact duplicates retain the landed receipt
recovery path. Schema-v2 duplicates may not return before Authority
verification: they repeat the exact audit lookup, mint and consume a fresh
capability, reproject and compare the complete committed fact set, and only
then return the existing row/receipt without a second insert.

Startup log-fact integrity admission is coordinated by Authority. The record
package validates fact/envelope/proof-digest structure; Authority independently
verifies the integration-audit chain through its current head, re-queries each
exact `authorization_audit_event_id`, and matches the complete proof
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
new `organization_derived_reviewer_policy_exclusion` table created by
`derived/0002_reviewer_v2_exclusion.sql` (derived schema version 2):

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

The exclusion table has `log_position INTEGER PRIMARY KEY`, unique digest-
shaped `record_hash`, exact `envelope_version = 2`, exact policy and outcome
checks, and update/delete denial triggers. The pure projection returns exactly
one exclusion and empty atoms/snapshots/observations/rejections/edges for valid
reviewer v2. `contentDigest()` includes the exclusion collection under derived
diagnostic schema 2; existing schema-v1 projected rows remain byte-identical.

This row is operational compatibility, not a visibility fact, candidate, or B
generation. A never reads it while serving. B later rebuilds from canonical
Layer 1 records under its own contract; it does not reinterpret this exclusion
row. Restart and stopped rebuild must reproduce the same exclusion outcome.

## Append-atomic reviewer facts

### Ownership and shape

Layer 1 remains the sole content truth. It owns the canonical signed envelope,
reviewer attribution, human-intent proof, record hash, position, and receipt.

`log/0003_reviewer_policy_fact.sql` moves the log schema from 2 to 3 and creates
the exact policy-specific table
`organization_record_reviewer_policy_fact`. Each reviewer-v2 item contributes
one row with exactly:

```text
reviewer_principal_id
reviewer_membership_id
log_position
record_hash
atom_order                  # zero-based canonical draft/projector order
signal_id_sha256
atom_id
semantic_intent_sha256
authorization_audit_event_id
authorization_audit_entry_sha256
authorization_proof_sha256
```

The row contains no text, title, subject, evidence, source locator, meeting or
participant field, score, current membership status, or resolved reader.
`signal_id_sha256` and `atom_id` are opaque digests; neither raw signal identity
nor semantic text is a fact-plane column. `atom_id` is internal and is never
returned publicly.

The table name and insert contract fix policy
`restricted-reviewer-v1`; no constant policy column is stored or indexed. The
physical identity is `PRIMARY KEY(atom_id)` plus
`UNIQUE(log_position, atom_order)` and
`UNIQUE(log_position, signal_id_sha256)`.
The table is immutable after insert. Update and delete triggers deny mutation.
Insert guards require:

- an exact canonical approval record at the same position/hash;
- strict reviewer-v2 policy and envelope validation;
- exact verified action reason and evidence;
- exact reviewer principal and membership;
- zero-based canonical item order, exact signal-ID digest, and atom ID produced
  by the fixed pure projector from the frozen draft/final payload; and
- a live Authority-minted eligibility capability whose proof digest and audit
  ID match the fact; and
- all card and response bounds.

The canonical record and all of its reviewer facts commit in one existing log
`BEGIN IMMEDIATE` transaction. Any fact insert or invariant failure rolls back
the record append. A migration creates an empty table; it does not backfill v1,
pilot, legacy, rejection, unknown-version, or prior records.

The serving index is:

```text
(reviewer_principal_id, reviewer_membership_id,
 log_position DESC, atom_order ASC)
```

The exact query uses `INDEXED BY
organization_record_reviewer_policy_fact_by_reviewer`, equality on the exact
principal and membership, `ORDER BY log_position DESC, atom_order ASC`, and
`LIMIT 10`. It selects only the eleven text-free columns above. It does not
scan another reviewer's facts into the logical candidate set.

The migration also adds unique index
`organization_record_log_position_record_hash(position, record_hash)` so the
fact's composite foreign key binds one exact canonical row. SQL checks enforce
digest/ID shapes, `atom_order` in `0..9`, reviewer-v2 envelope kind/version,
approval event, exact reviewer actor, semantic digest, reason, audit event ID,
and record position/hash. Pure application code proves complete item count,
signal/order/atom derivation, audit-entry/proof digest, and capability validity;
SQLite has no hashing function and does not pretend to prove those values.

### Fact trust model

A fact is an address hint and frozen policy assertion, not an allow decision.
For every selected fact, the reader loads only the referenced canonical log
row and reruns the fixed projector in memory. It requires exact equality of:

- position, record hash, atom order, and internal atom ID;
- SHA-256 of the canonical row's raw signal ID equals the stored signal digest,
  then the raw signal ID plus record hash reproduce the landed atom ID;
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

There is no fact repair, reconstruction, backfill, or mutable shadow index in
V1. The migration is empty before the first reviewer-v2 producer; every later
fact is co-committed with its record. Any incomplete or corrupt fact state
keeps reviewer reads and new reviewer-v2 ingest unavailable until a complete
known-good state restore and the restore reconciliation gate below. Legacy
append/derive and the frozen pilot remain live unless an existing global
preflight independently fails. Facts are never used to repair canonical truth.

### Private read boundary

The serving package exposes one narrow session factory and no raw store:

```text
openReviewerReadSession(exact caller, request digest, max 10)
  -> closure-owned single-use session

session.readFacts()
  -> text-free facts fixed to that exact caller tuple

session.bindResolvedFacts(complete ordered fact array proved by the resolver)
  -> non-exported request-local capability

session.readBoundCanonicalRecords(capability)
  -> only canonical rows fixed inside that capability
```

The session state machine is exactly `opened -> facts-read -> bound ->
content-read -> closed`; every transition is single-use. Empty facts may go
directly from `facts-read` to a canonical empty response without opening
content. The implementation uses a closure-owned runtime identity and private
`WeakMap`/brand state rather than a structural TypeScript DTO. The current
Person resolver can bind only the complete ordered fact array returned by the
same live session. The
capability fixes request digest, principal, membership, exact
position/hash/signal-digest/item pairs, authorization attempt, and single-use
state.
A copied object, reconstructed JSON, different-session fact, partial or
reordered array, second read, or post-request use fails as internal
`unavailable` and maps to fixed `503`.

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

The request has exactly these payload keys plus the landed exact
`SignedIntegrity` object:

```text
schema_version = 1
kind = echo-organization-reviewer-recent-decisions-request
request_id = rrd_<uuid-v4>
authority_id
authority_key_id
organization_id
enrollment_id
installation_id
installation_key_id
http_method = POST
http_path = /v1/reviewer-recent-decisions
requested_at
integrity
```

IDs use the landed `oau_`, `org_`, `enr_`, and `ins_` UUID forms; key IDs are
`sha256:*`; `requested_at` is a canonical UTC-millisecond timestamp; integrity
key equals `installation_key_id`; and the P-256 signature covers every payload
field. The canonical request is capped at 16 KiB and uses the same configured
freshness rule as the approval request. The route's raw HTTP body cap and the
member client's pre-send canonical-byte cap are independently the same landed
`16 * 1024` bytes. The caller supplies no target, policy, limit, cursor, sort,
query, or atom ID, and query parameters are invalid.

The canonical response has exactly:

```json
{
  "schema_version": 1,
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

`kind` is exactly `decision`, `action`, or `rationale`. Every response `text`
is NFC, trimmed, single-line, non-empty, contains no Unicode `Cc`, `Zl`, `Zp`,
or unpaired surrogate, is 1..240 Unicode scalar values, and must equal the
canonically reprojected item text byte-for-byte. The response exposes no atom
or record ID, log position, total, hidden count, cursor, scan depth,
title, meeting ID, participant, source, evidence, subject, score, identity
value, audit reference, or internal path kind.

The fact and response order is exactly `log_position DESC, atom_order ASC`.
The query returns at most ten facts and the response returns the corresponding
zero to ten whole items and at most 60 KiB of exact RFC-8785 bytes. Equal
kind/text pairs from distinct facts are allowed. There is no prefix truncation:
the frozen draft bounds guarantee fit, and builder/ingest reject impossible
input before append.

### Status and byte algebra

```text
400 {"error":{"code":"invalid_request","message":"request is invalid"}}
401 {"error":{"code":"unauthorized","message":"authorization failed"}}
404 {"error":{"code":"not_found","message":"resource was not found"}}
503 {"error":{"code":"unavailable","message":"service is temporarily unavailable"}}
500 {"error":{"code":"internal_error","message":"authority operation failed"}}
```

The existing outer transport classifications remain exact and are not reviewer
authorization decisions:

```text
403 {"error":{"code":"proxy_identity_unavailable","message":"trusted proxy identity is unavailable"}}
413 {"error":{"code":"payload_too_large","message":"request body is too large"}}
429 {"error":{"code":"rate_limited","message":"too many requests"}}
```

`429` also carries the landed integer `Retry-After` header. These responses,
like every application response below, carry `Cache-Control: no-store` and
select no reviewer fact or content row.

- Malformed structure or method/path binding is pre-authorization `400`.
- Unknown enrollment, invalid signature, or stale request is
  pre-authorization `401`.
- An authenticated expired lease is audited `401`.
- An authenticated inactive, revoked, or unbound Person root is audited
  `404`.
- An active caller with no matching reviewer facts receives audited canonical
  `200` with `items: []`.
- A final recheck that observes expired or inactive Person state commits the
  corresponding audited `401`/`404` rather than returning stale content.
- Incoherent log/fact state, Authority or integration storage failure, lock
  timeout, or failed audit returns fixed `503` and no content.
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

### Restore boundary

A does not introduce a remote monotonic witness or automatic reconciliation
act. As in the landed pilot contract, a **known restore** is an operational
deployment gate: Authority remains stopped until the trusted operator verifies
current membership, enrollment, installation, access/revocation, integration
audit, complete record chain/facts, and applicable client-held signed receipts,
then records the release evidence in the deployment runbook before starting
the reviewer route. A state backup cannot overwrite that operator evidence.

The application openly cannot detect a concealed valid-prefix rollback when
both the database and all external evidence are withheld or rolled back. That
case remains inside the trusted infrastructure/operator boundary stated by the
constitution. The exact guarantee is: a declared restore is never served
before reconciliation, and the surviving chain is tamper-evident relative to
the latest receipts/evidence the operator presents. Anything stronger requires
an off-host monotonic witness and is outside A and B.

## Query-decision audit

Reviewer reads use a new
`authority_query_decision_audit` table in `authority.sqlite`, not the landed
generic `authority_audit_log`. The table has a closed operation
`permission.reviewer_recent_decisions_decided`, a monotonic sequence,
`occurred_at`, decision/reason columns, and one canonical minimized
`detail_json`. It is written inside the same final Authority transaction as
the Person recheck.

`0006_reviewer_query_audit.sql` moves the Authority schema from 5 to 6. The
table has exactly: positive autoincrement `audit_sequence`; `occurred_at`;
Authority-computed `retain_until = occurred_at + 180 days`; fixed `operation`;
`decision IN (allow, deny)`; a decision-bound `reason_code`; and canonical
object `detail_json`. The retention index is `(retain_until,
audit_sequence)`. Updates are denied. Deletes before `retain_until` are denied;
the stopped expiry path is the only production code with delete access.

The same migration adds the partial unique expression index
`authority_audit_log_reviewer_query_control_command_id_unique` on
`json_extract(detail_json, '$.command_id')` for generic-audit actions
`permission.reviewer_query_audit_export_authorized` and
`permission.reviewer_query_audit_expired`. A `qac_*` command ID is therefore
unique across both governed operations without adding it to online query
rows.

Allow reason is exactly `active_exact_reviewer_membership`, including an empty
result. Denial reasons are exactly `installation_access_expired` and
`inactive_or_unbound_reviewer_membership`. Pre-authentication `400/401`,
operational `503`, transport classifications, and unexpected `500` are not
response-authorization decisions and do not create rows.

The separate table is required because the landed generic audit repository
lists and counts all actions and has no selective retention contract. Pilot
audit rows remain frozen in their landed store and are not migrated,
reclassified, or expired by A.

The confirmed reviewer-query retention is 180 days from `occurred_at`.
Entries are immutable while retained. Minimum allow evidence is:

- requester principal, membership, and installation;
- operation and signed request digest;
- decision, fixed reviewer path, reason, and evaluation completeness;
- `person_state_sha256` over the same membership/enrollment/installation/access
  fields and transaction-owned time used by the landed pilot snapshot;
- fixed policy ID and `policy_contract_sha256` over the exact policy,
  consequence, envelope, action-request, and read-contract versions;
- verified record-log head position/hash;
- internal returned atom IDs and record hashes;
- `evaluated_at`; and
- exact response digest.

The allow `detail_json` has exactly these keys:

```text
schema_version = 1
kind = reviewer-query-decision-audit-detail-v1
request_id
request_sha256
requester = { principal_id, membership_id, enrollment_id, installation_id }
decision = allow
reason_code = active_exact_reviewer_membership
evaluation_complete = true
policy_id = restricted-reviewer-v1
policy_contract_sha256
person_state_sha256
record_head = { position, record_hash }
returned_atom_ids = <ordered dense digest array>
returned_record_hashes = <ordered dense digest array aligned by item>
evaluated_at
response_sha256
```

For an empty canonical log, `record_head` is exactly
`{position: 0, record_hash: null}`. Otherwise it is the verified positive head
position and matching `sha256:*` record hash. Empty results and an empty log
remain auditable 200 allows; they do not omit the head witness.

`policy_contract_sha256` is `canonicalSha256` of the exact-key object
`{schema_version:1, kind:restricted-reviewer-policy-contract-v1, policy_id,
consequence_version:1, consequence_text, envelope_version:2,
action_request_version:2, read_contract_version:1}`.

The denial detail has the same schema/kind/request/requester/decision/reason,
evaluation/policy/person/evaluated/response keys, with `decision = deny`, and
omits `record_head`, `returned_atom_ids`, and `returned_record_hashes` entirely.
All nested objects and arrays are closed/dense. Empty allow stores empty
returned arrays and the canonical empty-200 response digest.

A denial contains no target, item, record, meeting, participant, title, text,
source, candidate count, or descriptive evidence. Neither allow nor denial
stores response text or claims the client consumed bytes. Audit failure denies.

Generic admin listing and overview counts cannot see the separate query table.
The query-audit repository is not part of the online admin-query interface.
There is no online query-audit or reverse-`who` route.

The governed export bytes are the RFC-8785 UTF-8 encoding, with no BOM or
trailing newline, of this exact document:

```text
schema_version = 1
kind = echo-authority-reviewer-query-audit-export
authority_id
organization_id
from_inclusive
until_exclusive
rows = <dense rows ordered by audit_sequence ASC>
```

Each row has exactly `audit_sequence`, `occurred_at`, `retain_until`,
`operation`, `decision`, `reason_code`, and `detail`, where `detail` is the
parsed, closed canonical object stored in `detail_json`. The ordered-row digest
is `canonicalSha256({schema_version:1,
kind:'echo-authority-reviewer-query-audit-row-set', rows})`. The export digest
is `canonicalSha256(export_document)` and therefore also the SHA-256 of its
exact canonical output bytes. No database JSON string representation or
newline convention participates implicitly.

A stopped-state export/expiry command is one of these two exact-key canonical
documents:

```text
schema_version = 1
kind = echo-authority-reviewer-query-audit-export-command
command_id = qac_<uuid-v4>
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

```text
schema_version = 1
kind = echo-authority-reviewer-query-audit-expiry-command
command_id = qac_<uuid-v4>
authority_id
organization_id
owner_principal_id
owner_membership_id
requested_at
reason
```

The IDs must match configured Authority/organization and an exact currently
active owner principal+membership. `requested_at` is canonical and within five
minutes for a first execution. `reason` is NFC, trimmed, single-line,
control-free, and 1..240 Unicode scalar values. Each command is hashed in full
as `command_sha256` and acquires the existing initialization/runtime locks.
There is no HTTP or generic admin-query method.

Before freshness or mutation, the stopped command transaction searches both
control actions by the unique command ID. An existing row with the same
`command_sha256` is an exact retry and returns the stored generic control event
without authorizing a second disclosure or deleting again, even after the
original freshness window. That exact stored row
`{audit_sequence, occurred_at, actor_kind, action, subject_id, detail_json}` is
the immutable maintenance receipt; the baseline generic audit has no `aud_*`
ID or entry hash, and A does not invent one. The maintenance repository adds
an exact command-ID lookup and an append method that inserts, reads back, and
returns this stored row inside the transaction. The same ID with different
bytes, kind, or digest is terminal conflict. The partial unique index closes
concurrent insertion races.

Both control rows use `actor_kind = admin`, `subject_id = owner_membership_id`,
and transaction-owned `occurred_at`. Their `detail_json` is the RFC-8785
encoding of the exact detail object. Export action is
`permission.reviewer_query_audit_export_authorized`; its exact detail is:

```text
schema_version = 1
kind = reviewer-query-audit-export-authorized-detail-v1
command_id
command_sha256
authority_id
organization_id
owner_principal_id
owner_membership_id
reason
from_inclusive
until_exclusive
output_path_sha256
row_count
ordered_rows_sha256
export_sha256
```

Expiry action is `permission.reviewer_query_audit_expired`; its exact detail
is:

```text
schema_version = 1
kind = reviewer-query-audit-expired-detail-v1
command_id
command_sha256
authority_id
organization_id
owner_principal_id
owner_membership_id
reason
retention_days = 180
cutoff
row_count
ordered_rows_sha256
```

Export additionally fixes `[from_inclusive, until_exclusive)` to a positive
range no greater than 31 days and not in the future. It canonicalizes complete
selected rows and computes the exact export bytes and digest in memory. In the
same Authority transaction it appends the
closed export control event above, but no exported row. **Only after that
transaction commits** may composition atomically create the operator-supplied
mode-0600 local output file with those exact bytes. The event means authorized release, not
file-write success or consumption, so a crash after commit and before rename is
an audited non-delivery rather than an unaudited disclosure.

The export port returns exactly `{control_event, delivery_status}`, where
`control_event` is the stored generic audit event and `delivery_status` is
`written|already_present|unavailable`. On exact retry, a matching existing
file yields `already_present`; otherwise retained rows may be reselected only
when recomputed row count, ordered-row digest, and exact export-byte digest all
equal the stored event. If rows are no longer retained, any digest differs, or
an I/O check fails, retry returns the stored event with `unavailable` and
writes nothing. It never creates a replacement authorization event or claims
historical bytes were reproduced.

The output path is a normalized absolute CLI input whose canonical
`output_path_sha256` is
`canonicalSha256({schema_version:1, kind:'reviewer-query-audit-output-path-v1',
absolute_path:<normalized path>})` and must equal the command and control event.
Its parent must
already be a current-user mode-0700 directory outside managed
Authority/member state; symlinks and non-regular existing targets are rejected.
Publication uses the landed create-once primitive: an existing exact-digest
mode-0600 regular file yields `already_present`, while a nonmatching target is
never overwritten and yields `unavailable`. A new final file is mode 0600 and
the atomic create fsyncs file and parent before reporting `written`.

Expiry accepts no caller-selected cutoff. Its cutoff is the transaction-owned
time itself. It hashes the complete ordered rows with
`retain_until <= transaction_time`, deletes those whole entries, and appends
the exact closed expiry control event above in the same transaction. It never
deletes a row before its
Authority-computed `retain_until`, and it never deletes approval evidence,
content-log, generic Authority audit, or pilot rows. A restored backup with
overdue reviewer-query rows keeps only reviewer V1 unavailable until governed
expiry runs.

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

1. **Protocol and frozen draft:** a new envelope-v2 family, deterministic
   requested-brief projection, strict dispatch, builder/verifier, and golden
   fixtures.
2. **Reviewer approval-surface mode:** immutable publication-mode/digest
   persistence,
   product renderer, signed action request, organization API, control-plane
   verifier, reviewer descriptor, provider digest, reason code, immutable
   integration-audit evidence, and Authority composition. This is a narrow but
   real approval-surface-v2 subproject, not a notice-only patch.
3. **Record log:** one migration, append-atomic immutable facts, deterministic
   projector reuse, exact indexed reader, log-fact integrity admission,
   and selected-row reprojection.
4. **Derived compatibility:** strict envelope-version dispatch and one
   text-free exclusion outcome so the existing broad v1 store never receives
   reviewer-v2 protected content.
5. **Authority:** verified reviewer-proof threading and startup revalidation,
   current reviewer resolver, signed route, separate query-
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
including audit governance, adversarial integration tests, focused
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
   and canonical reprojection.
4. **Compatibility and read:** safe derived-v2 exclusion, resolver, restore
   runbook gate, signed route, closed DTO, exact bytes, final recheck, separate
   query-audit table/export/expiry, client, and CLI.
5. **Acceptance:** local adversarial matrix, restart/restore, then one bounded
   founder-live reviewer self-read with a different active member returning no
   items.

No later stage starts before the preceding stage is green. Implementation
authorization is fixed by the status at the top of this contract; deployment,
merge, and release always require their separate gates.

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
   response has only `schema_version`, `items`, `policy_id`, and `witness`; all
   extra metadata is rejected; another reviewer's population changes neither
   rows nor bytes.
9. **Linearization:** every revocation/expiry race before final commit denies;
   audit outage and DB-lock timeout release no content; concurrent later append
   affects only the next request.
10. **Restore and corruption:** a declared restore is held offline until the
    operator reconciles current Person/integration state, the complete
    log/facts, and applicable retained receipts; log-fact admission detects
    invalid/incomplete state and offers no repair; valid-prefix rollback behind
    presented evidence, corruption, or mismatch remains unavailable and never
    returns a partial response.
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

## Invariant trace and adopted additions

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

A adopts one scoped feature-contract invariant, not a claim that Layer 2 is
already permission-aware:

11A. **Reviewer reads start from append-atomic, text-free facts.** A reviewer
read selects only immutable facts committed atomically with the verified Layer
1 record. Protected content is released only through a request-local binding
after the current-Person resolver completes. Missing facts, failed canonical
reprojection, an invalid binding, or a broad-store bypass denies.

The founder also adopts the consequence-binding invariant for this feature:

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
[`064ac93553bccde09f2f9af07b21b94a4dcb7e1dd94c7cdf2a0ab6d9a14186f1`](2026-08-10-layer-3-derived-permission-retrieval-v1-design.superseded.md).
That review established the approval proof, exact membership, facts-before-
text, final recheck/audit, and failure boundaries retained here.

The founder's later A/B split changed the index placement and removed mutable
Layer 2 from V1. Fresh focused reviews completed on 2026-08-11 against the
named code baseline and the final A contract:

- code grounding verified the exact protocol, Slack, control-plane, record,
  Authority, client, migration, and retry seams;
- storage and port review verified append atomicity, single-use content
  binding, exact audit-evidence lookup, fact repair, query-audit governance,
  and export/expiry crash behavior;
- wire review verified the complete frozen Slack presentation, content-free
  signed request, v1 rejection coexistence, provider identity, immutable audit
  preimages, and fixed response bytes;
- scope review verified that no Layer 2 trust substrate, search, attendee,
  grant, model, or general approval-workbench work remains hidden in A; and
- invariant review found the contract compatible with the landed architecture
  and its bounded immutable-content consistency exception.

Those reviews supersede the predecessor verdict for A and found no remaining
implementation blocker. The predecessor remains historical evidence only.
