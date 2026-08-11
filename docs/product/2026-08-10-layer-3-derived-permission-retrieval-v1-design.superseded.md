# Layer 3 reviewer retrieval minimum V1

**Status:** minimum-V1 candidate after industry review, code grounding,
invariant review, and reconciliation. Pending final post-lean verification.
Not approved, implemented, merged, or released.

**Code baseline:** `aaae7509f6b62434b1f23e811b82f3926c38eae3` on
`feat/organization-permission-pilot-v1-clean`. Code and schemas remain
authoritative for landed behavior.

**Builds on:**

- [Organization permission architecture](2026-08-09-organization-permission-architecture.md)
- [Permission pilot v1 contract](2026-08-10-permission-pilot-v1-contract.md)
- [Org decision record: append and derive](2026-08-07-org-decision-record-append-derive-design.md)
- [Approval surface v2 direction](2026-08-10-approval-surface-v2-direction.md)

## Outcome

This V1 proves one complete Layer 1 -> Layer 2 -> Layer 3 path:

> A current active member can retrieve recent atoms from a newly approved
> reviewer-marked record only when that member is the exact principal and
> exact membership that performed the approval.

It is a self-retrieval and architecture gate. It does not claim cross-person
sharing, general permissions, or company-brain readiness.

The layers are:

1. **Layer 1:** immutable, append-only approved/rejected record log.
2. **Layer 2:** deterministic, disposable, rebuildable projections and
   text-free reviewer authorization facts.
3. **Layer 3:** current Person state + marked content policy + Layer 2 facts +
   request context, evaluated before bounded content release.
4. **Layer 4:** later model-facing use of Layer 3 output.

The landed two-person pilot remains frozen. Its marker, pair, notice proof,
eligibility index, `POST /v1/recent-decisions`, DTO, and authorization policy
do not become generic. Pilot-v1 records are never reviewer-V1 candidates, and
reviewer-v2 records can never satisfy pilot eligibility.

### Release preconditions requiring founder confirmation

1. Confirm or edit the exact approval consequence below. Its audience and
   semantics cannot be weakened without repeating invariant review.
2. Confirm the proposed 180-day query-decision audit retention period before
   its migration or first write.
3. Pilot retirement is not part of V1. The default is to leave it active under
   its frozen policy until a later explicit decision.
4. Formally accept proposed invariants 11 and 12 below before implementation.

## Closed scope

V1 includes:

- one exact reviewer-only approval policy;
- one existing Slack approve/reject interaction with an added consequence
  notice;
- one new exact envelope version;
- one text-free Layer 2 reviewer-fact projection;
- one signed self-only recent read;
- one current reviewer resolver;
- one pre-response query-decision audit; and
- one local founder-live value test with a second member denied.

V1 excludes:

- attendee, invitee, participant, speaker, email, or name-based access;
- identity attestations or correction/effect ledgers;
- grants, requests, teams, roles, collections, links, or a readable floor;
- legacy-history opening;
- discovery, search, ranking, counts, cursors, pagination, or explanations;
- reverse `who`, public `can`, or target-item authorization oracles;
- models, agents, MCP, tools, or Layer 4;
- full approval-surface v2;
- cross-channel or cross-device approval;
- multi-process writers, WAL conversion, optimistic authorization, or caches;
  and
- a new atom identifier or pilot migration.

## Exact approval contract

### Human consequence

The existing Slack card retains one approve and one reject reaction. Before the
reaction instructions it contains one exact `plain_text` block and matching
top-level accessibility fallback:

```text
Approving records this package under restricted-reviewer-v1. Only you, the approving reviewer, may later read its decisions, actions, and rationales while this exact reviewer membership remains active.
```

The backticks used elsewhere for Markdown are not wire bytes. The block ID is
exactly `echo-approval-<approval_id>-reviewer-policy-v1` and `emoji` is false.
The top-level accessibility fallback is a complete alternative presentation,
not a generic notice. It joins these exact lines with LF, using the frozen
draft order and the lowercase wire kind on each item line:

```text
Decision brief awaiting approval.
Title: <exact card_title>
<kind>: <exact item text>
...one line for every frozen item...
Approving records this package under restricted-reviewer-v1. Only you, the approving reviewer, may later read its decisions, actions, and rationales while this exact reviewer membership remains active.
```

There is one positive policy, so a selector, modal, button workbench, or second
positive choice adds no V1 value. This is a constrained consequence extension
to the landed surface, not approval-surface v2. No reviewer-v2 producer or read
route ships before the consequence extension.

### Pre-approval draft bridge

The landed flow builds the organization-record envelope only after reaction,
so its current Slack authorization input cannot bind the content later
released. V1 adds an explicit bridge and narrows release to what the reviewer
actually saw.

Before posting the card, the decision-node processor freezes canonical
`reviewer-release-draft-v1` bytes containing:

```text
schema_version = 1
kind = reviewer-release-draft-v1
approval_id
card_title
items = 1..10 exact ordered {kind, text} values
```

Kinds are only decision, action, or rationale. Every title and text is NFC,
single-line, control-free, non-empty, and at most 150 and 240 Unicode scalar
values respectively. The reviewer-v2 card renders the title and
every item verbatim in deterministic plain-text sections; it adds no ellipsis,
truncation, hidden “more” count, or unrendered releasable item. It then renders
the exact consequence block and existing reaction instructions. A draft that
cannot fit this complete closed card is not eligible for reviewer v2.

The immutable pending slot stores those bytes and
`reviewer_release_draft_sha256`. The Slack renderer, signed authorization
request, envelope builder, ingest, and Layer 2 projector consume that same
frozen draft. They do not reread or reconstruct release content after
approval. Any content change creates a new processing revision, approval ID,
draft, and card; it never mutates a published draft.

`approval_presentation_v1` is the complete canonical expected Slack
presentation: approval ID, all ordinary blocks deterministically rendered from
the frozen release draft, exact reviewer-policy block, reaction block, every
block ID, and exact fallback. Authority computes
`approval_presentation_sha256` over those bytes. The card renderer can render
only that presentation.

The signed authorization request carries the bounded canonical release draft,
its digest, and the presentation digest. At action time Authority recomputes
draft -> complete expected presentation -> presentation digest, and the Slack
provider compares every live block and fallback with that expected
presentation before accepting message evidence. This is a new cross-cutting
decision-node, renderer, signed-request, provider, and builder contract, not a
field that exists in the landed Slack request.

### Exact envelope v2 intent

Envelope v1 remains unchanged. Reviewer records use a new closed envelope v2.
Its intent keys are exactly:

```text
intent.schema_version                      1
intent.visibility                          restricted
intent.policy_id                           restricted-reviewer-v1
intent.provenance.kind                     approval-surface-confirmation-v1
intent.provenance.semantic_intent_sha256   sha256:<digest>
```

`purpose_id` is omitted because the fixed policy defines the only V1 purpose.
`reconsider_after` is omitted because it has no V1 affordance or semantics.
A future purpose or reconsideration feature requires a new exact version; it
cannot reinterpret old records.

The existing envelope reviewer section freezes the Authority-derived approval
actor's principal and exact membership. No client can nominate a different
reviewer.

At action time, Authority canonicalizes semantic intent bytes containing:

- semantic schema and kind;
- `approval_presentation_sha256`;
- `approve` and the exact approval ID;
- frozen reviewer principal and membership;
- exact consequence text and version; and
- `reviewer_release_draft_sha256`.

`semantic_intent_sha256` hashes those Authority-computed bytes, not markup or
a client-authored policy object.

Authority then live-verifies Slack app, bot, team, channel, message timestamp,
the complete expected block array, fallback, presentation digest, unedited
state, reaction, and reviewer. The integration audit stores
`reviewer_release_draft_sha256`, `approval_presentation_sha256`,
`semantic_intent_sha256`, and a separate `message_presentation_sha256` over
the provider evidence plus the approval-presentation digest. The actor-bound
semantic digest cannot be placed on the pre-action card and is not claimed to
be there.

An allowed approval uses the new closed reason
`active_reviewer_restricted_notice_v1`. Ingest recomputes and matches the
release-draft, presentation, and semantic preimages, exact authenticated
actor, reason, and
action-time message evidence before append. Any mismatch is terminal invalid
input; unavailable or indeterminate evidence is retryable `503`. Reject
continues through the existing rejection path and creates no reviewer-readable
content.

Ingest also derives the ordered reviewer-release items from the final envelope
payload and requires exact equality with the frozen release draft. The
action-derived `payload.reviewed_at` equals the Authority decision's canonical
action time; reviewer/evidence, submit time, and integrity follow their
existing Authority/builder rules. None can change the approved release items.

Strict envelope-v2 dispatch and closed intent validation must land in ingest
and derive before any v2 producer. Unknown versions halt derive and remain
invisible; they never fall back to v1 or pilot behavior.

## Exact read contract

### Operation

```text
POST /v1/reviewer-recent-decisions
CLI: echo-brain organization reviewer-recent-decisions
```

The request has a new signed kind and fixes method, path, organization,
enrollment, installation, request ID, requested time, and signing key. The
caller supplies no target, policy, limit, cursor, sort, query, or atom ID.

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

`kind` admits exactly `decision`, `action`, or `rationale`. The exact wire
witness contains no Markdown backticks:

> Allowed by restricted-reviewer-v1 because every returned item records
> you as its approving reviewer and that exact reviewer membership is
> currently active.

The response exposes no atom or record ID, log position, total, hidden count,
cursor, scan depth, title, meeting ID, participant, source, evidence, subject,
score, identity value, audit reference, or internal path kind. Internal atom
and record digests remain available to the audit and integrity checks.

### Bounds

Layer 2 has an index over exact policy, reviewer principal, reviewer membership,
descending log position, and stable atom order. The fixed facts query reads at
most the ten newest matching atom facts. It does not scan other reviewers'
facts as candidates.

The response stays within:

- ten returned items; and
- 60 KiB of exact canonical response bytes.

The 1..10-item, 240-scalar release-draft rule makes every ten-item response fit
well below 60 KiB. Golden fixtures freeze the maximum complete Slack card and
canonical response bytes. Builder and ingest reject a draft that violates the
item/card/response bounds before Layer 1 append. Derive repeats every bound and
halts if an impossible row somehow exists. V1 is a recent bounded view, not
all-history retrieval.

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
- Incoherent required state, turn or database-lock timeout, failed final
  recheck, or failed audit releases no content and returns fixed `503`.
- Unexpected programming failure remains the generic fail-closed `500`.
- Outer metadata-free `403`, `413`, and `429` are pre-application
  transport/security classifications and select no content.

Every application and edge response uses `Cache-Control: no-store`. The
member reader returns bytes in memory and the CLI prints the closed DTO. No
product-owned response store or visibility-binding store is added.

## Data and authority ownership

### Layer 1

Layer 1 continues to own signed approved/rejected envelopes, reviewer
attribution, intent provenance, record hashes, positions, and receipts.
Reviewer principal and membership are approval-actor attribution, not a
recipient list. Corrections are new records; no row changes in place.

### Layer 2

For every reviewer-v2 atom, Layer 2 derives one text-free fact containing only:

- internal atom ID, record hash, log position, and stable atom order;
- `restricted-reviewer-v1`;
- frozen reviewer principal and membership;
- semantic-intent digest; and
- per-record projection-manifest hash.

One per-record manifest commits the canonical projected content, reviewer
facts, and reused provenance for that record. One
`projection_root_sha256` commits the ordered manifest hashes plus derived
cursor position and record hash.

Content rows, facts, reused provenance, manifest, root transition, and cursor
commit in one `record-derived.sqlite` transaction. They are derived only from
Layer 1 and reproduce exactly on stopped-state rebuild. Layer 2 never consults
Authority state and never stores a current reader.

Layer 3 receives only:

```text
openReviewerFactsSnapshot(served_state, exact caller)
  -> at most ten fixed-policy facts

readBoundAtoms(opaque_binding)
  -> exactly the internally bound atom rows or failure
```

The facts query selects no text. The resolver alone can create the in-memory,
module-private binding. It binds request digest, caller principal and
membership, exact internal atom/record pairs, served-state digest, and current
authorization turn. It cannot be serialized, cloned, transferred, replayed,
cached, used after turn release, or populated from caller IDs.
`readBoundAtoms` accepts no caller-selected IDs.

Authority-reachable code cannot import the raw derived database or broad
text-returning store. Source-boundary tests enforce these two ports. For each
selected record, the content adapter reprojects canonical Layer 1 data in
memory and matches the manifest, fact, reviewer, policy, provenance, kind,
text, and record hash before releasing the bound atom.

### Authority Person and policy state

The current root is:

```text
authenticated enrolled installation
AND current unexpired organization access lease
AND current active membership for the caller principal
```

The reviewer resolver adds:

```text
marked restricted-reviewer-v1 intent
AND caller principal == frozen reviewer principal
AND caller membership == frozen reviewer membership
```

A new membership for the same principal does not inherit an old approval.
Candidate selection and final item authorization invoke this same resolver.

## Consistency boundary

The single-process Authority adds one exclusive authorization turn. Reviewer
reads hold it from facts selection through final resolver evaluation, audit
commit, and immutable-byte handoff. Every Person, policy, record-head, derived
row/fact, or derived-head mutation uses the same turn and fixed database order.
There is no read-lock upgrade, second writer, or external call inside the turn.

The landed five-second SQLite busy/acquisition timeout applies. Failure to
acquire the turn or a required database lock returns fixed `503`; V1 makes no
end-to-end constant-time claim.

An append turn publishes the new log head and makes reviewer serving not-ready.
The asynchronous follower later acquires a turn, derives, verifies, and
publishes ready state. Reads in the gap return `503`. Pilot append/derive also
uses the turn; its retrieval exception, policy, response, and bytes remain
unchanged.

The persisted readiness tuple is:

```text
policy_version
restore_reconciliation_sha256
record_head_position
record_head_hash
derived_cursor_position
derived_cursor_record_hash
derive_build_id
derive_contract_version
projection_root_sha256
```

Each request adds the canonical current caller `person_state_sha256` and
`evaluated_at`; the audit stores a digest of this complete request served
state.

Startup verifies the Layer 1 chain, catches Layer 2 to its head, deterministically
recomputes expected manifests/root from Layer 1, and admits the reviewer route
only when every tuple value matches. Per-selected-record reprojection protects
the running window after startup.

After restore, a stopped-state `record-restore-reconciliation` command holds
the existing maintenance/runtime locks, validates current membership,
enrollment, installation, access/lease, policy and integration state, and
applicable existing client-held record/access receipts, then appends one
durable reconciliation act and digest. No new receipt type is introduced.
Startup requires the latest act to match recomputed state or be its proved
append-only ancestor. A perfectly consistent whole-state rollback remains
detectable only through the existing client-receipt boundary.

## Authorization sequence

1. Parse the exact request.
2. Resolve the enrolled key required for signature verification.
3. Verify enrollment/key binding, signature, and freshness. Authentication
   completes only after freshness passes.
4. Acquire the exclusive authorization turn.
5. Read current Person state and the ready consistency tuple.
6. Require the current Person root.
7. Read at most ten exact reviewer facts without text.
8. Run the reviewer resolver and issue one request-local binding.
9. Materialize only bound atoms and reproject each selected Layer 1 record.
10. Build, canonicalize, and pre-serialize the bounded response once.
11. In an Authority `BEGIN IMMEDIATE` transaction, re-read current Person
    state, re-run the same resolver for every item, recheck every served-state
    field, append the exact-response audit, and commit.
12. Hand the same immutable bytes to HTTP, release the turn, and send without
    reserialization.

A mutation ordered before step 11 wins and denies. One ordered after commit
affects the next request.

## Query-decision audit

The new typed action is
`permission.reviewer_recent_decisions_decided`. It and landed
`permission_pilot.recent_decisions_decided` are the complete
`query-decision-audit-v1` action set.

The proposed retention is 180 days from `occurred_at`. The action and existing
`(occurred_at, audit_sequence)` index are sufficient at V1 scale; no sidecar
table is added. Entries are immutable while retained.

Minimum allow evidence is:

- requester principal, membership, and installation;
- operation and signed request digest;
- decision, fixed reviewer path, reason, and evaluation completeness;
- `person_state_sha256`, `policy_version`, and
  `restore_reconciliation_sha256`;
- record head position/hash, derived cursor position/hash, derive build and
  contract versions, and `projection_root_sha256`;
- digest of that complete request served state;
- internal returned atom IDs and record hashes;
- `evaluated_at`; and
- exact response digest.

A denial contains no target/item/record/meeting/participant/title/text/source,
candidate count, or descriptive evidence. Neither allow nor denial stores
response text, prompt text, scrolls, clicks, dwell, or a claim that the client
consumed bytes. Audit failure denies.

The generic admin audit listing and overview counts omit both query-decision
actions entirely. There is no online query-audit or reverse-`who` route.

One stopped-state export command uses existing maintenance authority, requires
a configured named query-audit operator, exact reason, and at most a 31-day
range, and emits its own non-content control audit with range, count, request
digest, and export digest.

One stopped-state expiry command deletes expired query-decision rows as whole
entries and emits one aggregate non-content control audit containing operator,
policy version, time window, count, and ordered-row digest. It contains no
original audit sequence, requester, item, record, or response reference.
Existing pilot rows require no backfill because their typed action and
`occurred_at` already identify them. Already-expired rows are processed
before reviewer-route admission. Approval-authorization evidence is a
different family and is never removed by query-audit expiry.

A restored backup with expired query rows is not admitted until governed
expiry runs. Expiry is an explicit retention exception to append-only audit,
not field redaction or content-log mutation.

## Failure and recovery rules

- Legacy v1, pilot, unknown, malformed, or unproved v2 content is not a
  reviewer candidate.
- Missing, stale, lagged, corrupt, restored-but-unreconciled, build-mismatched,
  head-mismatched, root-mismatched, or audit-unavailable state releases no
  content.
- Derive lag denies the whole request. V1 never serves an older-head prefix.
- A fact is not an allow. Only the shared resolver can issue a content binding.
- A broad derived-store import or invalid binding is a build/test failure and a
  runtime denial.
- No positive decision, Person snapshot, mutable policy snapshot, or binding is
  reused across requests.
- An unavailable reviewer read never downgrades to pilot, legacy, or a broader
  policy.
- Rebuild changes no Layer 1, Authority, pilot marker, or receipt state.
- Any audit/serialization/commit failure releases no response content.

## Grounded implementation footprint

This is the minimum coherent capability, not a local Slack patch. At
`aaae750`, none of these new families is already generic:

1. **Protocol and release draft:** envelope v2 is a new discriminated
   validator/creator/builder/verifier family. The pre-approval release-draft
   bridge and complete-card renderer change decision-node persistence,
   rendering, signed authorization input, submitter construction, and golden
   fixtures.
2. **Slack and control plane:** the existing proof is pilot-specific. Reviewer
   V1 needs its own descriptor, exact block/fallback verifier, provider digest,
   reason code, integration-audit fields, evidence lookup, and Authority
   composition. It reuses the reaction mechanism, not the pilot schema.
3. **Record derive and runtime:** reviewer membership, manifests, root, cursor
   hash/build/contract, exact index, private ports, and selected-record
   reprojection are new migrations and runtime boundaries. The current broad
   derived store cannot be passed through.
4. **Consistency and recovery:** the exclusive turn is a runtime-level serial
   executor that must wrap all relevant Authority mutations, record append,
   follower commits, and reviewer reads while keeping Slack I/O outside it.
   Readiness and restore acts require durable state and operator commands.
5. **Authority and audit:** the new resolver, route, exact-byte transaction,
   admin filtering, governed export/expiry, and startup admission are new
   application and maintenance paths.
6. **Member/API and acceptance:** the request/response contracts, HTTP client,
   reader, CLI action, source-boundary checks, and full live harness are new,
   though pilot code supplies patterns.

A grounded planning range is roughly 10-16 engineer-days for one engineer,
including adversarial tests and integration work. That estimate is not a
release promise. Cutting the draft bridge, integrity/recovery spine, or audit
governance would shorten the work only by weakening accepted invariants.

## Build order

1. **Protocol guard:** frozen reviewer-release-draft schema and decision-node
   slot, exact envelope v2, complete-card/two-phase semantic golden fixtures,
   strict ingest/derive version dispatch, and impossible-item validation.
2. **Consistency substrate:** authorization turn, fixed DB order, enriched
   cursor/manifest/root, ready tuple, startup verification, restore command,
   query-audit filtering/export/expiry, and pilot-write integration.
3. **Approval and projection:** consequence renderer, Slack live proof, new
   reason/evidence matching, atomic reviewer facts/manifests, two private
   Layer 2 ports, and source-boundary enforcement.
4. **Read:** shared resolver, signed route/DTO, exact bytes, final transaction,
   audit, member client, CLI, and no-persistence proof.
5. **Acceptance:** full local matrix, restart/rebuild, then one bounded
   founder-live reviewer self-read with a different active member denied.

No later stage starts before the preceding stage is green. This document
authorizes no implementation, deployment, merge, or release by itself.

## Minimum acceptance matrix

1. **Intent and consequence:** exact v2 approval succeeds; any change to
   policy, actor, membership, release draft, complete rendered block array,
   fallback, consequence, presentation/semantic/message digest, provider
   proof, or unedited Slack card prevents append. Final payload items and
   `reviewed_at` must match the frozen draft and Authority action time. Unknown
   versions halt and never fall back.
2. **Reviewer boundary:** exact reviewer principal+membership reads; another
   active member, revoked member, expired lease, revoked installation, and new
   membership for the same principal do not. A new approval is required after
   rehire.
3. **Pilot separation and algebra:** v1/pilot/v2 eligibility is mutually
   exclusive. Every exact `400/401/404/503`, generic `500`, outer
   `403/413/429`, and audited empty `200` behavior is byte-tested.
4. **Facts before text:** fact SQL returns no text or protected metadata; broad
   store import, forged/serialized/cloned/replayed/cross-caller/stale binding,
   caller-supplied IDs, and post-turn use all fail without content.
5. **Bounded output:** query reads no more than ten exact reviewer facts;
   output has only policy, witness, kind, and text; the exact 10-item/240-scalar
   maximum renders verbatim and fits, while an eleventh item, 241st scalar, or
   oversized complete card is rejected before append. Another reviewer's
   population changes neither selected rows nor public bytes. Closed response
   validators reject every extra field, including atom/record ID, position,
   title, source, total, or count.
6. **Linearization races:** candidate and final checks use one resolver.
   Revocation, expiry, policy/head change, audit outage, turn contention, and
   database-lock timeout at every boundary release no stale content.
7. **Projection integrity:** incremental derive, restart catch-up, and stopped
   rebuild produce identical facts, roots, and response bytes. Crash after log
   commit, halted follower, cursor/root mismatch, manifest/fact/text tamper,
   and impossible logged item keep serving unavailable until canonical
   recovery.
8. **Restore:** no reviewer read is admitted until Person, integration, policy,
   existing client receipts, log, derive, and projection reconciliation is
   recorded and matches.
9. **Audit governance:** response and audit commit atomically; generic admin
   cannot list or count query rows; export is named/bounded/audited; the
   180-day boundary removes whole entries only; pilot query rows participate
   without changing pilot record evidence or response semantics.
10. **Transport and client:** full request is signed/fresh, HTTP sends the
    audited bytes without reserialization, origin and edge are `no-store`,
    and inspection of enumerated product-owned SQLite/config/cache/log paths
    proves no response text, bytes, or binding was persisted.
11. **Founder-live value gate:** approve one unique reviewer-v2 package through
    the real Slack verification path, restart Authority, retrieve as that
    reviewer, and require a non-empty item whose kind and uniquely seeded text
    match that package. The response has exactly `items`, `policy_id`, and
    `witness`. Prove a second current member receives an empty self-only result
    with no source leakage. No Layer 4 consumer is involved.

## Invariant trace

The reviewer V1 preserves landed invariants 1-10:

| Invariant | V1 mechanism |
| --- | --- |
| 1. Authorize before model/scoring | no model/search exists; exact facts are resolved before any text binding |
| 2. Do not stamp readers into content | frozen reviewer is actor attribution; current Person state makes it a reader |
| 3. Existence and content are distinct | no discovery/target oracle/IDs/count/cursor; only self-qualified output |
| 4. Deterministic sentence witness | one exact policy witness uses only caller-knowable facts |
| 5. One consistency boundary | exclusive turn, complete served state, final same-resolver check, audit before bytes |
| 6. Failure cannot widen | missing, malformed, lagged, corrupt, restored, or unauditable state releases no content |
| 7. Structure inherits visibility | exact indexed facts, ten-item cap, private binding, no hidden stubs/counts |
| 8. Models cannot confer access | models and inferred identity are outside V1 |
| 9. Recording creates no recipient list | reviewer consequence is shown/bound; actor attribution is not a reader list |
| 10. Audit without second disclosure | minimized pre-send audit, generic-admin omission, governed export/expiry |

Two additions are required:

11. **Authorization evaluates text-free, rebuildable facts.** Layer 3 decides
    visibility over a closed, text-free, provenance-bound fact projection
    derived only from Layer 1. Facts, content, reused provenance, manifest/root,
    and cursor commit in one derived transaction and rebuild deterministically.
    Protected content is materialized only through a request-local,
    non-transferable binding issued by the completed resolver for that caller,
    request, item set, and served state. Missing facts, invalid binding, or a
    broad-store bypass denies.
12. **Content-visibility approval binds consequence.** A positive content
    approval is valid only when the human-visible reviewed policy consequence,
    frozen reviewer principal and membership, complete human-presented
    reviewer-release draft, and
    action-time provider evidence are cryptographically bound over
    Authority-computed semantic bytes and verified before append. Client policy
    fields, client digests, or markup hashes alone have no authority.

## Deferred successor boundary

Verified-attendee access is not a V1 branch. A separate capture-side design and
fresh industry/code/invariant review must first prove:

- an authorization-grade explicit `attendance = attended` source fact;
- provider issuer, source instance, subject, observation time, capture method,
  and assurance grade;
- append-only identity acts plus deterministic correction/invalidation effects;
- a frozen approval-time audience basis so later identity links cannot add old
  readers;
- current active membership as a final conjunct; and
- fail-closed behavior for invitee, role, email, display-name, speaker,
  no-show, ambiguity, rehire, correction, rotation, lag, and restore cases.

Production Granola currently supplies none of that authorization-grade
attendance evidence. The landed Slack identity link proves an approval actor,
not meeting attendance.

## Sequential review record

The checklist was completed in order. Each later pass reviewed the frozen
output of the prior pass.

| Row | Stage | Reviewers | Frozen input | Outcome |
| --- | --- | --- | --- | --- |
| 1 | Initial design | Claude Fable + Codex | initial draft | reviewer and attendee paths framed; mutable Layer 2 cannot inherit pilot exception |
| 2 | Industry atlas | Fable coordinating four Claude Opus 5 research lanes | `968e11d0...af35c1` | known authorization, identity, privacy/audit, and human-approval traps folded in |
| 3 | Current-code grounding | Fable + four independent Codex code passes | `ce89795b...a68a` | production attendance absent; V1 reduced to reviewer; implementation gaps grounded at `aaae750` |
| 4 | Landed/candidate invariant check | Fable + four independent Codex audits | `5065fdc1...e8c3` | invariants 1-10 conditionally preserved; only additions 11 and 12 survived |
| 5 | Reconciliation and verdict | Fable + four Codex reconciliation passes | `a6f62072...607d7` | clean with required implementation gates; founder confirmations isolated |
| 6 | Minimum-V1 lean-down | Fable + four independent Codex lean passes | `ec1093f4...f5185a3e` | successor machinery and redundant fields removed; authorization spine retained; post-lean verification pending |

### Row-6 retained, simplified, and removed

Retained because they are live-value or invariant bearing:

- exact v2 + consequence proof + exact reviewer membership;
- text-free facts + private binding + same resolver;
- manifest/root + startup verification + selected-record reprojection;
- full request served-state digest + exclusive turn + restore gate;
- bounded signed route + pre-send audit + no-store/no persistence; and
- strict error, rebuild, race, and founder-live acceptance.

Simplified:

- ten exact indexed reviewer facts replace a twenty-record scan;
- one manifest root replaces a duplicate digest over every raw row;
- the public DTO drops internal IDs and path kind;
- existing audit action/time columns replace a retention sidecar;
- restore records one digest over existing inputs instead of adding receipts;
- approval stays on the current reaction card; and
- tests are grouped into eleven end-to-end gates.

Removed or deferred:

- attendee/identity implementation, audience basis, and cross-person paths;
- `purpose_id`, inert `reconsider_after`, and cross-channel matching;
- modal/workbench, search/discovery/grants/models, timing claims, WAL, caches,
  multiwriter support, and a new atom ID;
- generic admin query-audit visibility; and
- long agent/research narratives that do not change the implementation.

Reviewers disagreed on four lean points. The final choices are:

1. Fable preferred the prior twenty-manifest cap; exact indexed selection of
   ten reviewer facts is narrower and keeps other reviewers out of the query.
2. Fable preferred a retention sidecar; typed actions plus the existing time
   index enforce the same fixed policy at V1 scale with no duplicate state.
3. Some Codex passes proposed grandfathering pilot audit; applying the same
   retention to its already typed query-decision action closes invariant 10
   without changing pilot authorization or response semantics.
4. Fable considered deferring export until demand; one stopped-state governed
   export is retained so “auditable” has an accountable inspection path rather
   than becoming a write-only claim.

## Compact evidence record

### Industry findings retained

Four Opus 5 lanes independently covered authorization consistency, enterprise
identity lifecycle, privacy/audit, and human approval. Fable retained only
findings that changed the design:

1. Candidate enumeration is never authorization; re-run one resolver for each
   returned item at the final use boundary.
2. Current membership narrows a frozen approval attribution; later identity
   linkage must never widen an old approval.
3. Email, name, invitee, role, and inferred speaker/attendance facts are not
   authorization identity.
4. Human approval binds Authority-computed semantic consequence, not markup
   hashed by the client requesting approval.
5. A process fence orders separate SQLite files but cannot make them
   crash-atomic; recovery and restore admission are part of authorization.
6. Audit retention and governed visibility must be declared before writes.

Primary anchors:

- SQLite [attached-database atomicity](https://www.sqlite.org/lang_attach.html)
  and [isolation](https://www.sqlite.org/isolation.html)
- [SpiceDB LookupResources advisory](https://github.com/authzed/spicedb/security/advisories/GHSA-m54h-5x5f-5m6r)
  and [CWE-367](https://cwe.mitre.org/data/definitions/367.html)
- [OpenFGA consistency](https://openfga.dev/docs/interacting/consistency)
- [OIDC Core](https://openid.net/specs/openid-connect-core-1_0.html) and
  [RFC 7643](https://www.rfc-editor.org/rfc/rfc7643.html)
- [Zanzibar](https://research.google/pubs/zanzibar-googles-consistent-global-authorization-system/)
- [WebAuthn transaction-authorization issue](https://github.com/w3c/webauthn/issues/1386)
  and [Secure Payment Confirmation](https://www.w3.org/TR/secure-payment-confirmation/)
- [RFC 9111](https://www.rfc-editor.org/rfc/rfc9111.html)
- [Google Meet notes](https://support.google.com/meet/answer/14754931),
  [Teams recording permissions](https://learn.microsoft.com/en-us/microsoftteams/tmr-meeting-recording-change),
  and [Zoom summaries](https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0058013)
- [CNIL retention guidance](https://www.cnil.fr/en/sheet-ndeg14-define-data-retention-period)

These sources support design patterns, not claims that one legal regime or
competitor behavior directly governs ECHO.

### Current-code grounding retained

At `aaae750`:

- envelope v1 is exact-key and lacks human intent provenance;
- Layer 1 is immutable and hash chained;
- Layer 2 is rebuildable and commits rows/cursor atomically, but its cursor has
  only position and its public store returns protected text/metadata;
- the projector dispatches by event type rather than strict envelope version;
- Authority, integrations, record-log, and record-derived are separate
  `DELETE/FULL` SQLite files with five-second busy timeout and no request
  authorization turn;
- the pilot already proves fresh signed read, final Person recheck, exact-byte
  audit, no-store, and a non-persisting member reader;
- the landed Slack authorization request has no frozen release draft, ordinary
  block verification, or draft digest, and the submitter builds later, which
  requires the explicit pre-approval bridge and full-card verification above;
- production Granola maps participant roles but does not produce explicit
  attended status, issuer, assurance grade, or canonical observation time; and
- the pilot route and policy are exact frozen literals.

Those facts, rather than the initial two-path idea, determine this minimum V1.
