# Project context V1 contract

Status: PC-00 minimum-V1 contract, 2026-09-21. This document freezes the public
and application boundaries that PC-01 through PC-06 consume. It is not a claim
that routes, SQLite state, CLI commands, or the installed desktop product are
live. It distinguishes the founder-confirmed minimum-V1 defaults from the
implementation-selected mechanics needed to make them concrete. This document
does not rewrite an accepted ADR.

Related scope: [project-context sprint](2026-09-21-project-context-sprint-v1.md),
[CLI wiring and gaps](2026-09-21-projects-cli-wiring-and-contract-gaps.md), and
[original-upload contract](2026-09-21-person-update-inbox-v1.md).

## Boundary

V1 adds projects around Person-uploaded original text. It includes project
creation, membership and leads, original-to-project associations, the
`project` audience at upload time, and authorized feed/search/read operations.
An original is saved through the existing Authority custody path and remains
readable immediately once admitted. Optional enrichment may add search hints;
it never changes the original or its audience.

The admitted meeting source, decision extraction, Slack approval, signed
record, and approved-record retrieval paths remain separate. The serialized
Authority lifecycle can continue to run the existing upload-enrichment pass
after meeting processing, but V1 creates no second queue, scheduler,
`MeetingDocument`, meeting participant, approval, record, or Ask input.

V1 excludes project-scoped Ask, approved-record association, named readers,
unread counts, visibility edits, withdrawal, binary or multiple attachments,
automatic provider routing, and project-only approved-record policies. A
project identifier must never be added to a global Ask question as a simulated
scope.

## Selected product policy

The following choices are fixed for PC-01 through PC-06.

| Question | V1 selection | Basis |
| --- | --- | --- |
| Create | Any active organization member may create a project and becomes its initial lead. | Founder-confirmed default |
| Discover | A project is discoverable only to its current active project members. | Founder-confirmed default |
| History on join | A newly admitted project member may read the project's already-associated context, subject to the source audience on every item. | Founder-confirmed default |
| Lead management | Leads manage project membership. | Founder-confirmed default |
| Associations | One original has zero or one project association. Association neither copies the original nor changes its source identity or audience. | Founder-confirmed default |
| Private association | A private item remains private when associated with a project. | Founder-confirmed default |
| Membership identity | A project member is the exact `(organization_id, principal_id, membership_id)` organization-membership tenure. A rejoined person receives a fresh project grant and does not inherit the prior tenure's grant. | Implementation selection |
| Lead mechanics | A project may have multiple leads. A voluntary removal or demotion that would leave no lead conflicts. Organization membership revocation always wins and may leave a project leadless; no organization-owner or private-content bypass repairs that state. | Implementation selection |
| Add/remove association | Add requires the uploading membership to currently read the original and to belong to the target project. Adding a second project conflicts; it never silently moves the original. Remove requires either that same uploader or a target-project lead, and both must currently read the original. This prevents project operations from enumerating hidden originals. | Implementation selection |
| Audience | An original's immutable admission audience is exactly `only_me`, `team`, or `project`. A `project` audience has exactly one audience project. Associations may be to other projects but never widen that audience. | Implementation selection |
| Removal | Loss of a project membership ends read access to `project`-audience originals through that project. `only_me` remains uploader-only and `team` continues to use active organization membership. The uploader's receipt remains minimally retrievable by its existing account-scoped receipt rule; a receipt does not disclose the original. | Implementation selection |
| Enrichment | Eligible only while the uploader's organization-membership tenure is active and, for a `project` audience, while the uploader is still an active member of that audience project. The worker checks current eligibility before model handoff. An association to another project never changes model eligibility, original audience, or source bytes. | Implementation selection |

Project leadership is project-administration authority only. It grants neither
meeting-source custody nor decision-approval authority, and it cannot override
an original's private, team, or project audience.

## Wire and identifier boundary

The current `/v1/person/updates` request and response codecs remain byte-for-
byte strict. They reject project fields and retain only `only_me` and `team`.
PC-01 does not need a legacy database compatibility burden, but PC-00 does not
reinterpret V1 bytes or loosen its decoder. V1 retirement is a later coordinated
server/client decision.

New project operations are under `/v1/person/projects`. New original-context
operations, including a project audience, are under `/v2/person/updates`.
Both families authenticate through the existing Person session; clients never
submit caller organization, caller principal, caller membership, authorization
revision, or a resolved-reader list. A project-administration command may name
a target `membership_id`; Authority resolves that target in the caller's current
organization and does not treat it as caller identity.

All codec objects are closed, recursively plain JSON data. Unknown fields,
duplicate item identifiers, accessors, symbols, sparse arrays, out-of-bound,
cross-version, and cross-kind values fail before any mutation. JSON parser
duplicate-member handling remains a transport concern; codecs operate on the
parsed data value. IDs are opaque, server-selected coordinates: `prj_` and
`mem_` prefix UUID-v4 values; `ctx_` prefixes exactly 64 lowercase hexadecimal
characters. Timestamps are canonical millisecond UTC strings. Request IDs are
lowercase UUID-v4 values.

Project/V2 request bodies retain the 16 KiB organization-API request limit and
uploaded title/text retain their existing 200-byte/8 KiB bounds. Every new
project/V2 HTTP reply and matching CLI success JSON uses the explicit 32 KiB
response cap, so an accepted 8 KiB original can be read with its required
envelope and metadata. The response cap does not increase the accepted
source-text size or imply attachment support.

No response contains a project authorization revision, membership count,
hidden count, resolved audience roster, source query, model payload, bearer,
or an identifier that changes when inaccessible content changes.

### Projects

The version-one project object has the following public shape:

```json
{
  "schema_version": 1,
  "kind": "echo-project-summary-v1",
  "project_id": "prj_<uuid-v4>",
  "name": "bounded visible project name",
  "created_at": "2026-09-21T22:01:00.000Z",
  "role": "lead"
}
```

`name` is required, nonempty, single-line, control-character-free UTF-8 and
bounded to 200 bytes. It is a project label, never a source/audience selector.
The list operation returns only projects in which the authenticated caller has
an active exact-tenure project grant. A nonexistent project and a project the
caller may not discover both produce the same public `not_found` response.
Its deterministic keyset order is `created_at DESC, project_id ASC`.

A member entry identifies a current, already-admitted organization membership
tenure and a `lead` or `member` role. Project membership changes are idempotent
only through their own request ID and exact semantic request body. A changed
body for the same replay coordinate conflicts. The server derives organization
identity from the session and validates the target membership against its own
organization; a client cannot name another organization or synthesize a
membership tenure. Member lists and directory results order by binary
`display_name ASC, membership_id ASC`. Directory search first requires the
caller's current project-lead role, then searches only current active
organization-member display names using the existing shared normalized query
terms. It neither searches email nor exposes revoked/hidden membership state,
and it returns no organization or roster-wide count.

An ordinary current project member may read that project's active roster,
including each active member's display name and project role. The roster returns
no revoked project grants or revoked organization memberships. Lead-only
directory search is a separate candidate-selection operation; its lead gate is
checked before any directory candidate is inspected.

### Original upload V2 and audience

`POST /v2/person/updates` accepts the existing bounded UTF-8 title/text and
request ID with a required closed audience object:

```json
{ "kind": "only_me" }
{ "kind": "team" }
{ "kind": "project", "project_id": "prj_<uuid-v4>" }
```

For `only_me` and `team`, `audience.project_id` is forbidden. For `project`,
`audience.project_id` is required and must name an active project in the
caller's organization where the caller currently has membership. The V2 upload
also has one required top-level `project_id`, either an opaque project ID or
`null`. This independent
association coordinate may equal the audience project or name another project
in which the caller is active. A non-null value creates the one permitted
association. No project ID in the request changes `only_me` or `team` access.

Every mutation uses the common replay key `(organization_id, caller
membership_id, request_id)` and commits the operation kind plus complete
validated request-body digest. The V2 upload digest includes the selected
audience and top-level `project_id` in addition to title and text. An exact
retry returns the committed immutable receipt. A changed title, text, audience,
audience project, association, operation, or any other validated field under
the same replay key returns `conflict`; it is never interpreted as an edit,
association change, or second upload. A caller's role change or session refresh
does not rewrite the original command or its replay commitment.

The shared identity helper is
[`project-context-command-v1.ts`](../../services/organization-authority/src/application/project-context-command-v1.ts):
`projectCommandIdentityV1` binds the exact actor organization/principal/
membership, operation and validated request into the commitment. PC-01 uses
that identity for the one replay record family; PC-02 uses it for admission.
It computes identity only and does not substitute for current authorization.

The V2 receipt and status return the stored audience and the immutable initial
root association coordinate from upload admission. They do not report a later
explicit dissociation or reassociation. Generic V2 content/search return the
stored audience but intentionally omit association coordinates; project-scoped
feed/search/read return their selected project coordinate after project
authorization. After an association mutation, UI refreshes the appropriate
project feed/read rather than treating an older upload receipt as current
association state. A project audience is serialized as its kind and opaque
project ID, never as a current roster. Callers cannot use association endpoints
or search to learn an inaccessible title, excerpt, association, or count.

### Association, feed, search, and read

An add or remove association names exactly one `context_id`, one `project_id`,
and one request ID. It adds or removes the one permitted link and never
duplicates the source. Adding a link while one to a different project exists
conflicts; callers must explicitly remove the first association before adding
the next. A repeated matching add/remove succeeds idempotently; a changed
request body under the same request ID conflicts. Association cannot create an
audience, update an audience, or change original title/text/receipt time.

Project feed and project search take an explicit `project_id`, are bounded to
at most ten items per page, and use an opaque, untrusted stateless keyset cursor
when pagination is needed. Its encoding is selected by PC-01, but its semantic
contents are limited to version, the ordering coordinates of the last publicly
returned authorized item, and a scope digest binding operation, selected
project, canonical query, limit, and the exact requester organization and
membership tenure. It contains no session/token, authorization revision,
global digest, private key/MAC, cursor row, or new secret.

The implementation-selected keysets are: project list `created_at DESC,
project_id ASC`; member/directory list `display_name` binary `ASC,
membership_id ASC`; and project feed `received_at DESC, context_id ASC`.
Project search first selects only authorized project candidates, then exactly
reuses the upload lexical score: every distinct normalized query term must
occur in original title/text or optional hints; each term occurring in the
original contributes two points and each hints-only term contributes one. It
orders by `score DESC, received_at DESC, context_id ASC`. A cursor carries the
complete position tuple
for its selected operation and only from its last returned row: respectively
`(created_at, project_id)`, `(display_name, membership_id)`,
`(received_at, context_id)`, or `(score, received_at, context_id)`. Generic V2
upload search remains the existing nonpaged, ten-result behavior. These ordering
and ranking mechanics are PC-00 implementation selections, not founder policy.

Every continuation reauthenticates and recomputes candidate visibility before
matching, pagination, excerpts, and the final release/audit fence. A malformed
cursor, invalid ordering coordinate, or cursor used with another operation,
project, query, limit, organization, or membership fails as `invalid_request`.
A tampered but well-formed cursor can at most skip already eligible results; it
never authorizes a candidate. Membership and visibility changes between pages
are evaluated fresh. V1 offers neither a stable snapshot nor total/completeness
across edits, and it does not promise stale-cursor rejection after a permitted
state change. This supersedes the earlier PC-00 suggestion to bind a public
cursor to private authorization revisions. An empty search query is not a feed.
Every candidate is selected from the specified project and each original is
then authorized under its immutable audience before title, excerpt, association,
or bytes are released. No result, cursor, count, placeholder, or error
distinction leaks an unauthorized item.

Content read remains an explicit original read by `context_id`; it does not
infer an item from a project list. The application captures a private project
authorization snapshot at candidate admission and re-resolves the session,
organization membership, project membership, audience and source binding at
the final release/audit fence. The snapshot and audit contain the necessary
private authorization revision(s), but those values are never public API data.

## Application and repository port contract

PC-00 defines interfaces only. PC-01 implements persistence, PC-02 implements
authorization/application behavior, and PC-03 selects them in HTTP composition.
No port permits a caller to supply authorization facts.

The project repository transaction owns organization-scoped project identity,
current exact-tenure project grants, lead roles, project associations, immutable
upload audience bindings, replay records, and authorization/audit observations.
It exposes atomic operations for project creation, membership/lead changes,
V2 upload admission, association change, admitted project candidate selection,
and final release/audit commitment. A transaction must reject cross-
organization IDs and must not materialize a resolved reader list into an
immutable original.

The application owns an opaque `ProjectAuthorizationSnapshot` for one Person
operation. It contains the authenticated binding, operation, target project or
original coordinate, and private project/audience authorization state. It is
captured after the current Person session is authenticated and checked again
immediately before content release/audit. It is not a session-token claim, wire
field, cache key shared across callers, or replacement for the current Person
authorization check.

`revalidateAndAuditRelease(snapshot, currentActor, validatedResponse)` accepts
the validated response selected by the repository. It rechecks current Person
and project state, verifies that the response kind matches the admitted scope,
derives response digest and released count itself, commits the minimized audit,
and returns an immutable response copy. The application releases that returned
copy unchanged. No caller supplies an audit digest or count, and no await or
provider call intervenes between the final check, audit, and release.

The upload-enrichment port accepts only immutable source coordinates and an
eligibility decision made by Authority policy. It has no project-member list,
lead privilege, audience-write method, or original-byte mutation method.

## Public failures and availability

The project and V2 upload families use the existing error envelope:

```json
{ "error": { "code": "invalid_request", "message": "request failed" } }
```

PC-00 adds no new error code. PC-03 uses the existing Authority error envelope
and code family: `invalid_request`, `conflict`, `invalid_output`, `not_found`,
`stale_access_state`, `unauthorized`, `rate_limited`, and `unavailable`.
Validation failures are `invalid_request`; inaccessible and nonexistent
project/original coordinates are the same non-disclosing `not_found`; replay
and last-lead failures are `conflict`; and failed final authorization uses the
existing closed authorization outcome.

`person projects list` is the sole UI capability probe. A `404 not_found` at
that exact route means “Not live yet”; the same result for an individual
project or original remains non-disclosing and is never relabeled unavailable.
A canonical 4xx mutation result carries its request ID and CLI
`mutation_outcome: not_submitted` for that attempted request; it does not prove
that an earlier attempt with the same replay key was never committed, including
when the result is `409 conflict`. A timeout, 5xx, noncanonical response, or
malformed response carries the same request ID and CLI
`mutation_outcome: unknown`. It never causes a retry against V1, conversion of
`project` to `team`, a local success, or a silently global search/Ask.

## CLI and HTTP contract

PC-04 owns implementation, but PC-00 freezes the following exact command
family and route fixtures in
[`tests/fixtures/project-context-v1/`](../../tests/fixtures/project-context-v1).
Every success is the exact validated response JSON followed by one newline on
stdout, without an `ok` envelope. Every CLI failure is sanitized JSON on stderr
and exits nonzero. The fixture README contains the complete request/response
examples.

| CLI argv after `person` | HTTP operation |
| --- | --- |
| `projects list [--limit] [--cursor]` | `GET /v1/person/projects?limit={limit}&cursor={cursor}`; no request body |
| `projects create --request-id --name` | `POST /v1/person/projects` |
| `projects read --project-id` | `GET /v1/person/projects/{project_id}` |
| `projects members --project-id [--limit] [--cursor]` | `POST /v1/person/projects/members` |
| `projects directory --project-id --query [--limit] [--cursor]` | `POST /v1/person/projects/directory` |
| `projects member-set --request-id --project-id --membership-id --role member\|lead` | `POST /v1/person/projects/members/set` |
| `projects member-remove --request-id --project-id --membership-id` | `POST /v1/person/projects/members/remove` |
| `projects associate\|dissociate --request-id --project-id --context-id` | `POST /v1/person/projects/context/{associate\|dissociate}` |
| `projects feed --project-id [--limit] [--cursor]` | `POST /v1/person/projects/context/feed` |
| `projects search --project-id --query [--limit] [--cursor]` | `POST /v1/person/projects/context/search` |
| `projects read-context --project-id --context-id` | `GET /v1/person/projects/{project_id}/context/{context_id}` |
| `updates submit --request-id --title --file --visibility only-me\|team\|project [--audience-project-id] [--project-id]` | `POST /v2/person/updates` |
| `updates status --request-id`, `updates search --query [--limit]`, `updates read --context-id` | `GET /v2/person/updates/{request_id}`, `POST /v2/person/updates/search`, `GET /v2/person/updates/content/{context_id}` |

`--audience-project-id` is required only for `--visibility project`; the
optional root `--project-id` is the independent association coordinate. The
CLI strictly decodes every success and error object using these codecs and
stores no local project/content database. It preserves a user-provided upload
request ID and V2 project coordinates across an uncertain outcome, then uses
status rather than issuing a different upload. PC-04 cannot add an implicit
global feed/search, grant, audience coercion, or Ask path.

## PC-00 codec, replay, and fixture proof

PC-00 codec/unit tests and fixtures prove only the stateless contract:

1. strict parsing, canonical IDs/timestamps, recursive data-only values, bounds,
   unknown-field rejection, and every invalid audience combination;
2. V1 request/response bytes remain strict and reject every V2 project field;
3. V2 `project` requires one audience project, while `only_me`/`team` forbid
   it; its required top-level `project_id` is either `null` or one independent
   association coordinate;
4. common replay identity uses organization, caller membership, request ID,
   operation and complete validated payload; a changed payload conflicts;
5. the exact CLI/path/method/JSON fixtures, list-only capability probe, and
   canonical 4xx versus unknown-outcome result shapes; and
6. 16 KiB request and 32 KiB response caps, including a valid 8 KiB original
   read response.

## PC-01 through PC-06 stateful proof

These require persistence, authorization, route and client implementation;
they are not satisfied by PC-00 fake ports:

1. PC-01 rejects cross-organization membership/project/context relationships,
   persists matching replay receipts across restart, and preserves source bytes,
   audience, and initial association through explicit association changes. It
   implements the deterministic ordering/keysets above without a roster/global
   count or hidden-member candidate search.
2. PC-02 proves rejoin grants, lead rules, current candidate authorization,
   final reauthorization/audit fences, and non-disclosure after removal during
   a request.
3. PC-03 through PC-05 prove feed/search cursor semantics, generic versus
   project-scoped reads, strict CLI decoding, and the list-only capability
   probe without a client-side audience fallback.
4. PC-06 proves optional enrichment eligibility after tenure/audience-project
   change, no meeting/approval/Ask/scheduler coupling, and the two-project
   cross-layer scenarios in the sprint.

A canonical 4xx mutation response is rejected for the current attempt but does
not prove that an earlier attempt under the same replay key was never committed.
Only a timeout, 5xx, noncanonical response, or malformed response is reported
as `mutation_outcome: unknown`; neither case permits a V1 retry or audience
coercion.

## Invariant and known-failure review

This PC-00 review covered the invariant registry and every stable record in
[`docs/invariants/`](../invariants/README.md), the permission registry in
[`2026-08-11-architecture-invariant-registry.md`](2026-08-11-architecture-invariant-registry.md),
and every record in [`docs/failure-patterns/`](../failure-patterns/README.md).
The table records applicability to this contract, not a claim that a partial
existing enforcement becomes global.

| Record(s) reviewed | PC-00 disposition |
| --- | --- |
| `INV-01` through `INV-10` | Applicable. Candidate authorization precedes project feed/search; immutable originals hold no resolved readers; existence is non-disclosing; admission and final release share a current-state fence; failures cannot widen; derived search structure inherits audience; uploads create no recipient list; every released response is audited without a second public disclosure surface. The current global gaps remain gaps. |
| `INV-11A`, `INV-11B`, `INV-12` | Out of scope for V1 originals. They govern approved-record append/retrieval policy facts and human approval consequence. Project leadership or an upload never becomes a record/approval policy. |
| `INV-ADAPTERS-001` through `INV-ADAPTERS-005` | No new external provider, model, or provider-neutral contract is introduced. Applicable boundary consequence: no provider fields or model-authored audience/source facts cross the new neutral codecs or ports. |
| `INV-IDENTITY-001`, `INV-IDENTITY-004`, `INV-IDENTITY-005` | Applicable identity discipline: project authorization uses only the existing exact Person organization-membership binding and never provider/display/email inference. Provider repair/approval chains are otherwise out of scope. |
| `INV-IDENTITY-002`, `INV-IDENTITY-003` | No session/lease protocol change. V1 must use current server-side Person rechecks and must not claim that an offline client observes membership removal before it contacts Authority. |
| `INV-PERMISSIONS-013`, `INV-PERMISSIONS-014` | Consequential provider approval is out of scope. The analogous requirement retained here is that enrichment uses persisted immutable source coordinates and never reinterprets current project configuration to mutate original audience; project lead does not gain source custody or approval authority. |
| `INV-PERMISSIONS-015` | Project Ask is out of scope. The direct-read/search extension still follows the existing upload path's equivalent current authorization, final fence, and minimized audit; it does not create a lower-layer record/retrieval bypass or claim Layer 3 coverage. |
| `INV-RUNTIME-001` | Applicable: no second queue/scheduler. Existing runtime lifecycle continues to own durable enrichment work, with bounded eligibility checks. |
| `INV-OPERATIONS-001`, `INV-RELEASE-001` | No runtime/release action in PC-00. PC-06 must qualify reset/reseed and matched artifacts; any later installation binds artifact identity to its actual worktree. |

All known failure patterns were reviewed. `FP-ADAPTERS-001` through
`FP-ADAPTERS-005` do not authorize provider/model work here; their applicable
consequence is strict server-owned transport and no model-authored evidence or
audience. `FP-IDENTITY-001` through `FP-IDENTITY-004` require exact current
Person identity, no lease change, no offline-revocation overclaim, and no
identity backfill. `FP-PERMISSIONS-001` requires immutable original/audience
facts not be reinterpreted by current project configuration. `FP-RUNTIME-001`
prohibits another follow-up loop. `FP-OPERATIONS-001` and `FP-RELEASE-001` are
PC-06 deployment/qualification controls, not a reason to make PC-00 release
claims. `FP-ADAPTERS-002` remains relevant to existing upload receipts: replay
reconciles the stored receipt and never duplicates a source.

## Schema and rollout boundary

PC-01 creates a fresh versioned Authority schema and initialization path for
the new contracts. Existing staging and production runtime data is disposable
for this sprint, so no migration, backfill, preservation of historical upload
receipts, or legacy database dual-read is required. Historical artifacts stay
immutable. Ordinary startup verifies the expected schema and fails closed; it
does not erase or reseed data implicitly. PC-06 owns the separately authorized
environment reset/reseed and matched-artifact evidence.

This displacement applies to runtime data only. It does not authorize deletion
of provider configuration, source/release artifacts, credentials, or any
unidentified host data.
