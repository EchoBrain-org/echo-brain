# Permission pilot v1 contract

**Date:** 2026-08-10

**Status:** pre-merge implementation contract. It does not claim Pilot slice 1
is landed or shipped.

**Constitution:** [Organization permission architecture](2026-08-09-organization-permission-architecture.md)

## Purpose and boundary

This is the smallest useful proof: after an approval card plainly names the
two recipients, either currently active named member can retrieve a bounded
set of that card's post-activation decisions without a local meeting copy or
operator help. It is one fixed policy, `pilot-member-readable-v1`; it is not
a general resolver, historical-disclosure, role, search, or `who` feature.

Authorization uses exactly two distinct active membership ids. Human labels are
presentation only: NFC, trimmed, 1–80 Unicode scalar values, distinct, and
limited to Unicode letters, marks, numbers, ASCII space, period, apostrophe,
and hyphen. A third active membership does not globally disable the two bound
members; an unbound or inactive caller is individually denied.

## Constitution conformance

This contract narrows implementation scope; it does not weaken the constitution.

| Invariant | Pilot v1 enforcement |
| --- | --- |
| 1 — authorize candidate set before scoring/model access | Only marker-bound, canonical, notice-qualified approval rows enter the immutable index; all missing or invalid evidence denies. |
| 5 — check/use consistency | Under the constitution's reviewed immutable-append-only exception, caller authorization precedes any source access; the final Authority transaction rechecks mutable Person/access state, writes audit, and commits before the already-serialized bytes are sent. |
| 6 — failure cannot widen access | Invalid marker, proof, log, projection, storage, or audit produces no content and the fixed failure shape. |
| 7 — structure/statistics inherit visibility | The bounded index is qualified before selection; unbound callers select no rows, and the DTO exposes no counts, cursors, or hidden metadata. |
| 9 — recording creates no recipient list | Ingest eligibility requires the exact prior audience notice and approval proof; recording itself grants nobody. |
| 10 — auditable authorization | Every authenticated outcome commits a minimized decision audit before response; the exact response digest is audited without denial item ids or atom text. |

## Notice-qualified approval evidence

The activation marker stores the membership-id-sorted audience, canonical
presentation descriptor, and `audience_notice_sha256`. The descriptor fixes:

- `policy_id: "pilot-member-readable-v1"` and
  `presentation_policy_id: "pilot-two-person-audience-v1"`;
- the exact two-member audience;
- the ASCII notice: `Approving publishes this organization record's decisions,
  actions, and rationales to <member-label-1> and <member-label-2>.`; and
- `fallback_text: "Decision brief awaiting approval. <notice_text>"`.

The Slack card contains exactly the associated `plain_text` section block
`echo-approval-<approval-id>-audience-v1`, with `emoji: false`. At action
time, the verifier confirms the provider app/bot and tenant, channel and
timestamp, exact block, exact fallback text, and no edit history. It hashes
canonical JSON of the audience digest, approval id, provider identity, channel,
timestamp, block, fallback, and `message_unedited: true` as
`message_presentation_sha256`.

Only the envelope reason
`active_membership_direct_grant_pilot_notice_v1` plus matching immutable
integration-audit detail (presentation-policy id, audience-notice digest, and
message-presentation digest) qualifies a record. A missing or changed bound
field denies eligibility; unrelated Slack fields do not affect it. Old cards
and retried old envelopes therefore remain ineligible.

## Offline activation marker

`echo-organization-authority activate-permission-pilot --config <absolute-path>
--command <absolute-json-path>` accepts only a canonical command containing
`schema_version`, kind
`echo-organization-permission-pilot-activation-command`, `ppa_<uuid-v4>`
`command_id`, authority id, organization id, policy ids, the sorted audience,
`requested_at`, and `reason`. The authority and organization ids must match
resolved configuration; first creation requires a UTC-millisecond
`requested_at` within five minutes. `reason` is trimmed, 1–500 UTF-8 bytes,
with no Unicode `Cc` control character. `command_sha256` is the SHA-256 of the
complete canonical command.

The command uses normal singleton/runtime locks and refuses a live Authority.
It validates the two active memberships, then uses `BEGIN IMMEDIATE` on the
record log to reverify the canonical chain, read its head, and insert one
immutable marker. An empty verified log is exactly position `0` with record
hash `null`. Update/delete protections make the marker immutable. An exact
retry compares stored command id and digest before reading any later head and
returns the marker; a different retry fails.

The marker contains organization id, command id/digest, pair, policy and
presentation ids, complete descriptor/digest, diagnostic activation time, and
`effective_after_position`/hash. `marker_sha256` is the SHA-256 of that
canonical immutable marker and is carried with the cached activation. At
startup the Authority records exactly one in-memory pilot state:

- **absent:** no activation-marker row exists, so the pilot is inactive;
- **ready:** marker, index, canonical row, and approval evidence validate and
  pilot intake/read may proceed; or
- **degraded:** an activation-marker row exists but its marker, index, row, or
  evidence is invalid or unavailable.

In **degraded**, proofless legacy append and ordinary lower permission paths
continue. A Slack card with no audience-presentation candidate may receive only
the ordinary decision. An approval action on a card carrying the pilot audience
namespace returns the fixed retryable `503`, never a downgraded ordinary
decision or notice-specific proof; rejection remains an ordinary non-disclosing
decision. Pilot-specific ingest and recent-decision reads likewise return
`503`, add no eligibility pointer, and perform no pilot source-row selection.
**Absent** also cannot disclose pilot content. Only positions greater than the
marker boundary are in scope; pre-activation history stays invisible.

## Intake and eligibility

In the record-log transaction that appends a post-boundary,
notice-qualified approval record, append one immutable eligibility pointer for
`pilot-member-readable-v1`. It contains only record position/hash and
notice-policy/audience digests. Ineligible rows never enter this index.

If a valid notice-qualified record reaches ingest while the pilot is unavailable
(including an absent or invalid cached marker), it must be retained for a
retryable reconciliation path: return the fixed `503`, do not create a
pointer or disclose content, and do not turn the record into a terminal
authorization rejection. After the marker is repaired and the pilot is
`ready`, queued member resubmission performs the normal append/index step;
there is no autonomous repair indexer.

## Served operation

The sole operation is `echo-brain organization recent-decisions`, a signed
`POST /v1/recent-decisions`. Its signed request binds schema/kind
`echo-organization-recent-decisions-request`, request id, authority and key
ids, organization/enrollment/installation and key ids, method/path, and
`requested_at`. The Authority applies the existing five-minute freshness
bound. A fresh replay is allowed only because every attempt is newly authorized
and audited.

For this operation, authentication completes only after structural validation,
enrollment/key binding, signature verification, and the freshness bound all
pass. A stale or invalidly signed request is a pre-authorization authentication
failure: it returns the fixed `401`, selects no protected source row, and is not
written to the pilot decision audit. This prevents replay traffic from becoming
a durable audit-write amplification path.

Before selecting any content, validate signature and freshness, then current
enrollment, installation, unexpired access, active membership, and membership
in the marker pair. An expired access lease returns the exact metadata-free
`401`; authenticated inactive or unbound membership returns the exact
metadata-free `404`. Both are audited without item identifiers.

Read at most the 20 newest qualified post-boundary pointers, reproject their
canonical records in memory, and consider deterministic atom order. Return the
longest whole-item prefix of at most 10 atoms and 60 KiB of canonical JSON. If
one eligible item cannot fit alone, return the fixed `503` and no content.
The closed item DTO is only `{atom_id, kind, text, record_hash}`; kinds are
`decision`, `action`, or `rationale`. Do not expose position, count,
cursor, meeting or participant metadata, source identifiers, owners, evidence,
scores, summaries, or model output. The CLI validates this DTO, writes stdout,
and neither caches nor persists it.

Pre-serialize the exact response bytes. In the final Authority-owned
`BEGIN IMMEDIATE` transaction, recheck all mutable access facts, sample the
Authority clock as `checked_at`, calculate the concrete Person-state digest
from that transaction-owned time and current Person/access facts, append the
decision audit with the exact response digest, and commit before HTTP sends
those same bytes. A client timestamp never supplies `checked_at`. Audit
failure discards content. Do not pass the payload through a second JSON
serialization. Selected append-only records may be absent after a concurrent
append, but may never become wider through it.

Every authenticated allow and denial is audited. Allows may record returned
atom ids/hashes; denials record none and never record atom text. All HTTP and
edge responses use `Cache-Control: no-store`. Exact error bodies are:

```text
400 {"error":{"code":"invalid_request","message":"request is invalid"}}
401 {"error":{"code":"unauthorized","message":"authorization failed"}}
404 {"error":{"code":"not_found","message":"resource was not found"}}
503 {"error":{"code":"unavailable","message":"service is temporarily unavailable"}}
```

Defined database, audit, log, projection, and pilot-availability failures use
the fixed `503`; unexpected failures are generic fail-closed `500`.

The exact error-body contract begins when the request reaches this application.
Outer, metadata-free pre-application transport rejections may return `403`,
`413`, or `429`; they are separately classified as request/security/rate
enforcement, never select a pilot source row, and are not pilot authorization
decisions. Route configuration tests must prove that classification.

## Acceptance gates

Live acceptance is one loop: a bound member approves a unique post-activation
decision on the exact notice-bearing card, and the other bound member retrieves
it without a local meeting copy.

Automated acceptance must prove:

- every bound proof field rejects on mutation or absence, while unrelated Slack
  fields are ignored;
- activation command bounds, empty sentinel, immutability, exact retry, and
  refusal of a live Authority;
- real notice-qualified ingest reaches the index, survives restart, and serves
  through a signed request;
- unavailable-marker ingest is retryable rather than terminal;
- no pre-activation content, hidden count, cursor, or internal row field leaks;
- unbound callers are denied before content selection, and revoking one bound
  membership leaves the other eligible;
- method/path/identity/freshness binding, the 20/10/60-KiB limits, and closed
  DTO enforcement;
- final recheck, transaction-owned time, exact-byte audit, audit outage, and
  no second serialization; and
- exact 400/401/404/503 application bytes, origin-plus-edge `no-store`, and
  metadata-free pre-application `403`/`413`/`429` classification.

Restore reconciliation remains a deployment gate: keep a restored Authority
offline until membership, installation, revocation, and client-head
reconciliation pass.

## Explicit exclusions

No mutable floor table, discoverability, content grant, generic permission-act
envelope, separate audit system, dynamic witness engine, list-all/item query,
search, ranking, model, external ReBAC, multiwriter support, or historical
disclosure is authorized by this contract.
