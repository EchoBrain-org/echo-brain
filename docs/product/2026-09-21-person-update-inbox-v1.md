# Person updates through a durable Authority inbox

Status: Implemented on `feat/person-updates-inbox-v1`; offline verification and PR review are required before separate live qualification.

Prepared: 2026-09-21. Baseline: `origin/main` at
`7f86b29577afa33806a61a71c2617437aee712e0`.
Implementation branch: `feat/person-updates-inbox-v1`.
Local worktree, relative to the primary checkout: `.worktrees/person-updates-inbox-v1`.

## Agent handoff

Implement the bounded V1 described here, starting from this document's commit.
Read root `AGENTS.md` and workspace-specific contributor instructions first.
Use deterministic fixtures and disposable local state. Finish with focused
behavior proofs, `npm run check`, and a reviewable PR using the repository
template. Report implementation, compatibility, and deferred live qualification
separately. No issue has been assigned to this brief; do not invent an issue
number or a `Closes` reference.

The founder requested a clean worktree and implementation document after
discussing Person submission versus server pull. ECHO recovered related hybrid
context discussions, but did not recover the exact earlier inbox decision.
This document defines the new implementation target; it does not claim that
an earlier ADR accepted this exact design.

The primary checkout contains unrelated answer experiments and observability
work. They are not dependencies. Do not copy changes from that checkout or
rebase onto its experimental branch. Refresh against main before opening the
implementation PR and recheck any changed integration points.

## Outcome and size

An active organization member can deliberately submit a short text update,
receive a durable receipt, and inspect its processing status. The Authority
processes the received update even after the Person client exits. Extracted
decisions/actions/rationale enter the existing private human-review workflow.
Only approved content becomes readable organizational knowledge.

This is a medium feature spanning client, API, persistence, processing,
approval routing, and source presentation. Planning estimate: **5–8 focused
engineering days**, including offline compatibility and failure tests, with
three reviewable implementation slices. This is an estimate, not a measured
delivery promise; source-admission and frozen-record compatibility are the
main uncertainties. Native authoring UI is a separate follow-up.

The inbox API alone would be a smaller task, but would not fulfill this brief.
Completion requires submission through approved, permission-aware retrieval.

## V1 boundary

```text
explicit Person text submission
  -> authenticated Authority intake
  -> durable organization inbox + receipt
  -> bounded server worker consumption
  -> extraction and frozen candidate
  -> submitter's private approval workflow
  -> approved record + policy facts
  -> existing search and Ask publication

meeting provider -> existing pull intake -> same downstream processing guarantees
```

Push transfers selected text from the Person machine into organizational
custody. Pull controls when the server processes that durable text. The inbox
lives in the Authority's existing SQLite state, not on the laptop and not in
a new hosted queue service. The server does not connect back to the laptop.

Include:

- Explicit, immutable plain-text updates from the signed-in member.
- API and installed Person CLI submission and exact status lookup.
- Durable receipt, safe duplicate submission, bounded consumption, restart
  recovery, and visible blocked/terminal outcomes.
- Existing extraction, private review, visibility selection, record append,
  and retrieval protections, with truthful Person-update provenance.
- Small presentation corrections where an update would otherwise be called
  a meeting, including approval cards and approved Sources.

Defer:

- Native compose window, an inbox dashboard, status history/list pagination,
  notifications, background capture, automatic synchronization, local outbox,
  retry daemon, or new agent-facing MCP tool.
- Attachments, URL fetching, directory upload, chat-history harvesting,
  bulk import, edits, withdrawal, correction/supersession APIs, and arbitrary
  client-authored canonical records.
- New approval channels, direct approval in the CLI, automatic approval,
  new visibility policies, new cloud services, or generalized plugin/queue
  infrastructure. Reuse existing delegation behavior where already supported.

## What exists, and what must change

Paths below are relative to repository root and verified at the baseline.

| Area | Existing implementation | Consequence for this feature |
| --- | --- | --- |
| Person transport | `src/product/person-client/{commands,client,authority-client}.ts`; `packages/organization-api/src/` | Extend the thin authenticated client. No local product database or provider code. |
| HTTP and sessions | `services/organization-authority/src/presentation/organization-authority-http-server.ts`; `src/application/person-identity-sessions.ts` in the same workspace | Add bounded authenticated routes; derive the actor from the current session. |
| API composition | `services/organization-authority/src/composition/organization-authority-api-runtime.ts` | Bind application ports to Authority persistence; do not put SQL or provider calls in request parsers. |
| Pull/extract/stage | `packages/organization-processing/src/admitted-meeting-processing/meeting-processing-cycle-v1.ts` | Reuse frozen candidate, evidence, and approval handoff guarantees. |
| Durable admission | `packages/organization-processing/src/admitted-meeting-processing/sqlite-authority-meeting-processing-state-v1.ts` | Admission/progress currently use `singleton = 1`; a second adapter alone is insufficient. |
| Authority schema | `packages/organization-authority-kernel/baselines/authority-baseline-v5.sql` | Existing candidates reference the single live-source admission. Add explicit compatible persistence for Person intake. |
| Worker | `services/organization-authority/src/composition/organization-authority-service-lifecycle.ts` | Extend the existing serialized lifecycle; retain approval publication and shutdown ordering. |
| Approval actor | `providers/slack/server/src/private-approval/resolve-meeting-owner-private-slack-approval-reviewer-v1.ts` | Meeting ownership currently resolves through an observed email. Person updates must use the authenticated submission's exact membership tenure. |
| Approval composition | `providers/slack/server/src/private-approval/private-slack-approval-workflow-bundle-v1.ts` | Add a verified-actor seam; reuse current Slack identity, assignment, policy, and terminal checks. |
| Signed provenance | `packages/organization-protocol/src/record-envelope-v4.ts` | V4 binds source adapter, instance, external ID, revision, and normalizer. Preserve these commitments. |
| Truthful presentation | `providers/slack/server/src/private-approval/private-slack-approval-block-kit-card-v1.ts`; `product/echo-overlay/main.swift` | Existing copy says “Meeting” and “Approve meeting”; update sources must be distinguishable. |

Read [processing architecture](../architecture/meeting-processing-core-and-adapters.md),
[Person architecture](../architecture/person-client-architecture.md),
[ADR-0012](../decisions/ADR-0012-person-public-response-privacy.md), and
[provider-boundary invariant](../invariants/INV-ADAPTERS-005-provider-semantics-at-boundary.md).
The processing architecture already states that a push source requires an edge
buffer or a versioned provider-independent capability. This inbox is that buffer.

## Submission and receipt contract

Use `POST /v1/person/updates` with the existing Person authentication mechanism.
Define the shared strict request/response validators in `organization-api`.
The request has exactly these fields:

```json
{
  "schema_version": 1,
  "kind": "echo-person-update-submit-v1",
  "request_id": "<caller-generated UUID>",
  "title": "Release rollout update",
  "text": "We agreed to pause the rollout until the readiness review."
}
```

- `title`: nonblank, at most 200 UTF-8 bytes. `text`: nonblank, at most
  8 KiB UTF-8. Bound the whole JSON request with the existing API body limit;
  escaped input is also subject to that total limit. Reject invalid UTF-8,
  NUL, unsupported controls, unknown keys, malformed IDs, and unsupported
  schema/kind. Preserve accepted text exactly; no silent truncation or rewrite.
- The server supplies organization, principal, membership ID/tenure, and
  received timestamp. The caller cannot select an author, reviewer, source
  adapter, processor, organization, or approval policy in the body.
- Submission explicitly transfers only this text into organizational pending
  custody. It grants neither approval nor organization-wide read access.
- Key deduplication by `(organization_id, membership_id, request_id)` and bind
  the canonical validated payload digest. A matching retry returns the same
  receipt. Reusing the key with different content returns `409 conflict` and
  changes nothing. Scope prevents collisions or disclosures across members.
- Return `202` only after the inbox transaction commits. A matching replay
  also returns `202` with the original receipt, even if processing has advanced.
  The immutable receipt contains schema/kind, request ID, received timestamp,
  and receipt state `received`; current progress comes from status lookup.
- No extraction, Slack operation, record append, or awaited worker run occurs
  inside the HTTP request. A database failure yields no successful receipt.
- Check idempotent replay before capacity checks. Initial pending limits are
  100 submissions per membership and 1,000 per organization; reject new work
  beyond either bound with `429` before insertion. Include awaiting-review and
  blocked items in pending capacity. Make these tested server constants.

Expose `GET /v1/person/updates/<request_id>` for the current membership only.
It returns the caller's receipt coordinates and one public processing status:
`received`, `processing`, `awaiting_approval`, `resolved`, `no_signals`,
`blocked`, or `failed`. `resolved` includes `approved`, `rejected`, or
`partially_approved`, as supported by the existing block-review outcome.
Approval resolution and retrieval-index freshness are different facts; never
claim searchable readiness merely because approval finished.

Missing and other-member IDs return the same generic `404`. Every request
checks current membership/session state. Responses contain no submitted text,
candidate content, provider messages, internal stack traces, global head,
queue position/depth, or other-member activity. Blocked/failure reasons are
fixed safe codes, such as `reviewer_unavailable`, `temporarily_unavailable`,
`processing_rejected`, and `approval_delivery_quarantined`.

CLI surface:

```text
echo-brain person updates submit --request-id <uuid> --title <title> --file <utf8-text-file>
echo-brain person updates status --request-id <uuid>
```

Require the request ID explicitly so a lost response can be recovered with
status or an exact manual retry. Read the file with bounded bytes; do not put
the text in argv. Print only validated receipt/status data, and preserve safe
Authority error codes and nonzero exit behavior. Explain that submission
uploads the file to the organization for review. An ambiguous transport error
must say the outcome is unknown and instruct reuse of the same request ID;
never silently mint a replacement ID or start an automatic mutation retry.
Retain existing session-refresh rules. No new local persisted state is needed.

## Durable processing and source integration

Persist the immutable submission, digest, exact authenticated actor, receipt,
and the minimum mutable work state needed for recovery. Keep pending text in
Authority processing custody. Do not store it in `integrations.sqlite` or
append it directly to the approved record. Reuse canonicalization helpers.

The existing singleton source cannot be overwritten or relabeled as Person
updates. Introduce a narrow source-keyed admission/candidate storage seam so
the existing meeting source and the organization inbox can coexist. Preserve
the meeting source's cursor and admission semantics. The inbox has its own
stable source identity and progress; an inbox item additionally has an exact
submitting actor. An organization-level inbox admission must not confer an
owner's identity on employee submissions.

Extract/reuse the common post-normalization extraction, freezing, staging,
and recovery operations. Use two explicit inputs in Authority composition;
do not build a scheduler framework or copy the full meeting pipeline. Shared
processing sees canonical source identity and verified actor evidence, not
Granola/Slack-specific branches. Register new owned source paths/exports in
the existing boundary manifests without weakening workspace rules.

Normalize each immutable text submission once, with stable source external ID,
revision, normalizer version, content-block IDs, and a pinned processor
configuration. A source document must identify itself as a Person update.
The existing `MeetingDocument`/brief field names can remain compatibility
containers if their validators admit an authored note honestly: no invented
meeting date, calendar event, attendees, organizer, transcript, or attendance.
Use the distinct source adapter identity in signed provenance and retain
verified authorship through permitted, approved metadata where needed.
The author and final approver remain distinct if delegation occurs.

The model must treat the text as evidence, not instructions, and must not infer
that an update is already approved. Do not turn receipt time into the date of
the described business event or a meeting date. Relative dates without a
supported source anchor stay unresolved under the existing extraction rules.

Prefer retaining the existing signed V4 shape and bytes for all old records.
Do not widen exact validators or change the meaning of a signed field silently.
If honest Person provenance cannot round-trip through the existing shape,
document and implement a narrowly versioned codec with compatibility fixtures;
do not ship mislabeled meeting evidence to avoid that work. Record this finding
in slice 1 before downstream implementation. A broader record redesign is
outside this brief.

Consume through the existing single-writer lifecycle. Bound work to at most
one new inbox item per periodic cycle initially, alongside the existing
meeting intake bound. A handled source/provider failure must not prevent the
other intake or already-durable approval publication from progressing. Treat
database/integrity failures as failures, not successful empty polls. Preserve
cancellation, shutdown, and separately scheduled search reconciliation.

Recovery requirements:

- A committed receipt survives worker inactivity and process restart.
- Reclaim interrupted processing under the existing exclusive process/writer
  lifecycle; do not add distributed leases or multiple worker processes.
- Reuse a frozen extraction/candidate on retry. Persist a stable submission-to-
  candidate link before marking the inbox item handed off. A crash between
  stores is repaired by looking up that deterministic candidate, not by
  creating a second approval. Do not assume cross-database atomicity.
- Temporary provider failures retain retryable work with bounded backoff and
  allow subsequent items to progress. Permanent failures become explicit
  terminal outcomes. Reuse existing ambiguous Slack-post reconciliation;
  never blindly post a second card after an unknown outcome.
- Processing/model calls may repeat if a crash precedes freezing. The promise
  is idempotent durable effects, not exactly-once model invocation.
- `no_signals` is a successful terminal processing result, with no empty card.
  Corrupt/invalid persisted work fails closed and remains diagnosable through
  content-free codes; it must not silently advance intake as success.

## Approval, identity, and publication

Bind the initial reviewer to the authenticated submission's persisted
organization/principal/membership tuple. Resolve its current Slack connection
through existing provider-owned identity-link checks. Never choose an actor
from uploaded prose, a caller-supplied email, a claimed meeting owner, or a
new membership tenure sharing the same email. Extend the approval resolver
seam to accept verified actor evidence; do not fabricate a meeting organizer.

If the member has no current Slack link, retain the accepted item as blocked;
it can resume after the same membership links Slack. If that membership is
revoked, no further model processing, card delivery, or approval is authorized
for that actor. Keep it blocked under the old tenure; rejoining does not claim
the old submission. Recheck before each consequential stage and retain all
existing final-action checks, including any already supported delegation.

Reuse the current private DM and its default **Only me** visibility. **Team**
requires the existing explicit review action. Submitting is not approving.
Approved blocks use the existing record/policy and search publication path;
rejected blocks produce no readable facts. Status reports terminal resolution
only from durable terminal outcomes, not from an attempted Slack click.

Approval copy and approved Sources must clearly identify **Person update**.
Use signed source provenance as the discriminator, not a user-controlled
title prefix. Do not expose raw pending text through records, search, Ask, or
status. Preserve evidence citations to the exact frozen text and all
restricted-reviewer versus organization-member read protections. Any additional
public source metadata follows current release revalidation and audit rules.

## Schema and compatibility

Authority V5 is a pinned baseline, and ordinary database open applies no
migrations. Follow that design: use the next versioned baseline, exact-schema
tests, and an explicit offline compatibility transition. Do not edit pinned
V5 SQL in place, migrate on HTTP/startup, or restage/reinitialize real data.

Include a disposable V5-to-new-baseline fixture proof preserving existing
admission/cursor, frozen candidates, pending/ambiguous approvals, Person
sessions, and all record hashes. Update affected lineage/version checks and
artifact assets. Unsupported old/new combinations must fail closed with an
actionable version error. No new general migration framework is required.
The implementation PR must describe the offline transition and rollback to a
matching code/state snapshot; execution on a real host is separate operator work.

Pending payloads inherit existing protected Authority backup/custody rules.
Document their actual retention; do not imply new deletion guarantees. Keep
receipt/idempotency evidence for the supported replay lifetime. A new retention
scheduler or organization-record purge is outside V1.

## Implemented source, custody, and compatibility mapping

The Person source uses `person-update-inbox-v1`, version `1`, with one stable
`person-inbox-<organization digest>` instance per organization. Its immutable
external ID is canonical JSON containing the server-verified organization,
principal, membership ID, membership type, and caller request ID. V4 signs that
exact external ID, so the submitter remains distinct from the final approver.
The canonical/source revision is the validated request digest; the normalizer
is `person-update-note-v1`; the single evidence block is `person-update-text`.
No event date, organizer, calendar, or participants are introduced. Receipt
time is only `observed_at`. The existing model input supplies null event-date
anchors and treats note text as evidence, with no approval authority.

Compatibility finding: the existing `MeetingDocument`, brief `meeting`, and
V4 `meeting-source` capability containers already admit authored notes with
empty participants and absent time. They round-trip this source without a new
signed field or widened validator. The distinct signed adapter ID selects
**Person update** in approval and Sources presentation. Old V4 codecs, hashes,
and golden bytes remain unchanged. Verified reviewer lookup reads the immutable
inbox submission and exact current membership; it never infers an actor from
this external ID or uploaded prose alone. The current approval surface has no
partial-review or delegation action: it resolves the whole update as approved
or rejected. The public status codec reserves `partially_approved` for an
existing surface that can supply that durable outcome; V1 does not invent one.

Authority V6 adds a source-keyed immutable processing-source registry and two
Person submission/work tables. The existing meeting admission and cursor stay
intact; its insert trigger registers its unchanged semantic identity. Frozen
candidates reference the registry. Inbox progress is per submission, using
that stable source's fixed `source-keyed-v1` cursor. The shared extraction,
freezing, evidence validation, staging, and approval recovery cycle is reused.
The inbox consumes at most one eligible item per tick, with 1–256 second
exponential retry delays (bounded by the 300-second server ceiling). Blocked
and awaiting-approval items consume pending capacity. Provider failures use
fixed safe status codes. Integrity failures remain visible worker failures.
Inbox model calls suppress content telemetry while retaining operational
measurements; no submitted text is logged by intake or emitted in status.

Pending and completed submitted text, receipts, payload digests, work links,
and frozen candidates are retained indefinitely in protected Authority state
and inherit its backup custody. There is no new deletion promise or retention
scheduler. Exact replay remains supported while that Authority lineage and
submission evidence are retained. No pending text enters `integrations.sqlite`
or the approved record; approved evidence and signals use the existing
permission-aware publication path.

For a **stopped disposable snapshot**, after building, the explicit compatibility
artifact can be produced with:

```sh
node tools/copy-authority-v5-to-v6.mjs /snapshot/authority.sqlite /output/authority-v6.sqlite
```

This command requires the exact pinned V5 schema and a new output path. It opens
the input read-only, copies every existing row, preserves candidate and receipt
identities, and updates only the output Authority lineage schema binding. The
other databases, root lineage, and signed record bytes remain untouched. Ordinary
open/startup performs no transition. V5 code/state and V6 code/state must match;
rollback restores the complete matching stopped code/state snapshot, not a
single database after newer writes. Real-host conversion, backups, deployment,
and acceptance remain in the existing operator playbook and are not authorized
by this implementation document.

## Implementation slices

| Slice | Deliverable | Exit proof |
| --- | --- | --- |
| 1. Intake and compatibility | Strict shared contracts, Authority inbox/application/routes, durable idempotency/status, versioned schema and offline transition. Record the precise source/actor/provenance mapping in this document. | Lost response, concurrent duplicate, conflict, restart, authorization, capacity, and old-state preservation tests. |
| 2. Server workflow | Source-keyed integration, worker consumption/recovery, exact Person reviewer, extraction/card/source labels, terminal status, record/search publication. | One submitted update reaches authorized retrieval with fakes; crash and provider-failure windows do not duplicate durable effects or regress meeting work. |
| 3. Person delivery | Installed CLI commands/help/validators, safe unknown-outcome behavior, packaging checks, documentation and full regression. | Exact packed CLI can submit/status against a disposable Authority; no server dependency or local queue enters the client. |

These can be sequential commits in one implementation PR. Intermediate slices
are not a completed feature; keep new intake disabled/unmounted in any partial
release that cannot safely consume it. If split into PRs, state those limits
explicitly and use the repository's existing review process.

## Required behavioral proof

Use the real Authority application, SQLite, worker, and signed-record path with
deterministic model/Slack/source fakes. Focus new tests on these observable
boundaries rather than mirroring helper implementations:

1. Submit, exit client, restart server, process, approve, publish search, then
   read/Ask from an authorized Person. Before approval there are no readable
   facts. A rejected update never becomes readable; partial approval releases
   only the approved blocks.
2. Matching and concurrent retries produce one inbox entry and one durable
   candidate/review lineage. Different content under the same key conflicts.
   Simulate loss of the successful HTTP response and recover by exact status.
3. Stop after receipt commit, claim, frozen extraction, candidate commit,
   external approval post, and final approval before record append. Restart
   and prove no lost accepted item, duplicate card, or duplicate canonical act.
4. Reject missing/expired sessions and forged actor fields. Another member
   cannot inspect status. Revocation between receipt/extraction/staging/action
   fails closed; an email reused in a new tenure acquires no authority.
5. Missing Slack link produces a recoverable blocked state. Temporary model
   failure/backoff, permanent rejection, ambiguous Slack outcome, and zero
   extracted signals have distinct outcomes; none silently loses the update.
6. A busy inbox and an unavailable meeting source do not starve each other or
   durable approval publication. Cancellation/shutdown preserves work. Existing
   Granola admission/cursor and processing regression fixtures remain valid.
7. Title/text/JSON bounds include multibyte and escaped input. Pending-cap
   enforcement is atomic. Invalid requests create no state. Responses/logs
   disclose no raw text, model/provider payload, or global queue information.
8. Source identity, author, evidence blocks, and revision survive extraction,
   approval, signed append, and authorized source rendering. An update is never
   presented as a meeting. Existing record golden bytes/hashes remain intact.
9. A private approved update is unavailable to another active employee; Team
   visibility follows existing current-membership rules. Preserve ADR-0012
   response privacy, final authorization, audit-before-release, and stale-index
   behavior.
10. The V5 transition preserves pending/ambiguous old work and signed records;
    unsupported state versions fail before writes. The exact Person package
    contains neither server processing code nor an automatic uploader.

Reuse relevant tests under `tests/person-client/`,
`packages/organization-api/test/`, `packages/organization-processing/test/`,
`providers/slack/server/test/`, `services/organization-authority/test/`, and
`tests/architecture/`. Run the narrow suites while implementing, then:

```sh
npm ci
npm run check
```

Use repository-defined packaging/architecture checks for the exact Person
artifact. Build the native decoder when its source presentation changes.
Record commands, outcomes, and any platform-limited checks in the PR. The implementation PR records the final verification outcomes.

## Definition of done and operating boundary

The implementer hands back a PR, passing focused and full checks, the exact
source/actor mapping, offline transition evidence, and a short deterministic
submit-to-approved-read walkthrough. Update current component/architecture
documentation to describe the implemented pending-custody exception; historical
ADRs are not silently rewritten.

Follow the root [agent instructions](../../AGENTS.md) for Cloud isolation and
the [Authority operator playbook](../operations/PB-OPERATIONS-001-authority-operator-lane.md)
for any later live qualification. Deployment, real state conversion, live
Slack/Granola rehearsal, final release acceptance, and PR merge are not part
of this implementation handoff. Do not create another operator playbook here.
