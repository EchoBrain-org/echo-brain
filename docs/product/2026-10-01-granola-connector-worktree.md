# Granola Connector Worktree

This brief defines the Granola worktree as the meeting export and approval
lane. It preserves the existing admitted-meeting path. A separate per-person
authorization boundary remains research until a compatible credential and
custody decision exists.

## Baseline

| Item | Value |
| --- | --- |
| Branch | `feat/meeting-connector` |
| Base commit | `a62ab22239d6c4b724ffa32c0847d1ba39094d0b` |
| Provider | Granola |
| Initial outcome | Exported meetings admitted, reviewed, and approved through ECHO |

This is setup documentation only. It does not authorize a deployment, a credential change, an account connection, or a live-provider rehearsal.

## What exists today

ECHO already has a Granola meeting source. The Authority service selects it in
[`organization-authority-composition-root.ts`](../../services/organization-authority/src/composition/organization-authority-composition-root.ts).

The provider implementation lives in `providers/granola/**`:

- `granola-meeting-source-admission.ts` admits one post-cutoff source after it
  verifies the configured owner and the immutable source commitments.
- `granola-meeting-source-bundle-v1.ts` rechecks those commitments before it
  reads the provider credential and constructs the source adapter.
- `source/meeting-source-adapter.ts` fetches, normalizes, versions, and pages
  meeting material through the meeting-source port.
- `source/record-owner-observation.ts` keeps the admission check
  metadata-only when it proves the configured Granola owner exists.

The current path uses an organization-held Granola credential and an owner
email proof. It is not a personal OAuth connection, a Nango connection, or a
live Ask reader.

After admission, ECHO binds custody and audience, retains immutable source
revisions, processes the meetings, and sends the resulting work through the
existing approval path. Approved meeting records can already reach Ask through
the retained evidence flow. They do not depend on the future live-ticket
Evidence Desk registry.

## Target boundary

The proposed future Granola capability is a per-person, export-equivalent
boundary. Its purpose would be to record that a named ECHO person has
authorized ECHO to retrieve meeting material that the person could export
from Granola. This handoff does not authorize implementation or collection of
personal Granola credentials. [ADR-0001](../decisions/ADR-0001-organization-operated-server-core.md)
permits the organization-owned credential and prohibits centrally collecting
personal keys; a compatible custody decision must precede a personal connection.

The shared access contract represents this with a connected `source_export`
capability. That capability is separate from `live_evidence`: granting export
permission must not create a general live-read permission.

The Granola provider would need to prove the external subject and any
applicable workspace or tenant before it treats a personal authorization as
usable. The provider owns Granola API parsing, item and revision identity,
cursor behavior, and provider-specific permission checks. An observed note
owner is not proof of the credential's owner or tenant.

ECHO continues to own the safeguards after an export:

- source custody and audience are bound by ECHO rather than inferred from a
  provider token;
- source revisions are immutable and content changes under one revision are
  rejected;
- admission remains explicit and limited to the committed source;
- review and final approval determine whether retained meeting material is
  available to broader ECHO workflows.

An export authorization alone does not allow retention, sharing, or a new Ask
surface.

## Worktree ownership

This worktree owns `providers/granola/**` and Granola-specific fixture tests.
Keep provider transport, parsing, ownership proof, and meeting normalization in
that directory.

Do not modify these shared integration areas in this worktree:

- `packages/organization-api/src/person-*`
- `packages/organization-authority-kernel/src/shared/*`
- `services/organization-authority/src/composition/person-evidence-desk-v1.ts`
- `services/organization-authority/src/composition/person-answer-v3-route.ts`
- `services/organization-authority/src/composition/organization-authority-composition-root.ts`

The final file is especially important because the Slack onboarding worktree
currently changes it. Shared API, Authority composition, and Answer-version
work belong to the shared integration lane.

## Tests and evidence

Use fixture-based tests for Granola payloads, owner observations, cursors,
revision identity, custody, admission, and approval behavior. Extend the
existing tests under `providers/granola/test/` before any live-provider check.

Keep fixture credentials synthetic. Do not add credential files, tokens, or
provider responses containing real meeting text to the repository.

## Primary-source findings, verified 2026-10-01

Research used public provider documentation and Nango's published source. No
account connection, credential, authenticated API request or live rehearsal
was used.

| Mechanism | Documented capability and limit | ECHO disposition |
| --- | --- | --- |
| Workspace API key | Admin-managed, workspace-owned key on Business and Enterprise; does not expire or depend on the creating admin's continued membership. Reads public workspace notes and notes in spaces explicitly granted Granola API access. Unshared private notes and folders remain inaccessible. | Retain the organization-owned REST path permitted by ADR-0001. |
| Personal API key | Business and Enterprise members can create keys with personal and/or public note scopes, subject to Enterprise controls. Personal scope includes owned notes and notes/folders shared with that person. | Centrally collecting these keys remains prohibited. Provider availability does not change custody policy. |
| Granola MCP | Individual browser OAuth with dynamic client registration, or Enterprise-Managed Authorization through a compatible IdP/client. No API-key or service-account MCP access. Access is limited to the user's active Granola workspace and plan/admin controls. | Future personal-authorization research only. MCP OAuth is separate from REST API-key authentication. |
| Historical CSV export | Includes titles, summaries, transcripts and basic details for owned, summarized, non-deleted notes in selected workspaces, including full history. Basic/Business default enabled; Enterprise default disabled. Emailed download requires the requesting account, expires after 24 hours and can be regenerated once per 24 hours. | Confirms an export capability exists; this slice does not implement CSV generation, download or ingestion. |

Sources: [Granola API access and workspace keys](https://docs.granola.ai/help-center/sharing/integrations/granola-api),
[Granola API overview](https://docs.granola.ai/introduction),
[Granola MCP authorization and workspace behavior](https://docs.granola.ai/help-center/sharing/integrations/mcp),
and [historical export](https://docs.granola.ai/help-center/sharing/exporting-notes).

The documented REST export surface is `https://public-api.granola.ai/v1` with
Bearer authentication:

- [List Notes](https://docs.granola.ai/api-reference/list-notes) returns note
  metadata (`id`, owner, creation/update times) and `hasMore` with an opaque
  `cursor`. Filters include `created_before`, `created_after`, `updated_after`
  and `folder_id`. `page_size` defaults to 10 and ranges from 1 to 30.
- [Get Note](https://docs.granola.ai/api-reference/get-note) returns the note,
  summary, attendees, calendar event and folder membership. `include=transcript`
  requests an inline transcript. `private_notes_*` are null for workspace keys;
  the adapter does not use these fields as evidence or permission facts.
- A large inline transcript returns HTTP `413` with
  `TRANSCRIPT_TOO_LARGE`. [Get Transcript](https://docs.granola.ai/api-reference/get-transcript)
  returns transcript pages with `hasMore` and an opaque `cursor`; `page_size`
  defaults to 50 and ranges from 1 to 100. Segment speaker metadata can vary
  between desktop and mobile. It must not be mistaken for participant identity.
- The [API overview](https://docs.granola.ai/introduction) says only notes with
  generated summaries and transcripts are returned; unfinished or never
  summarized notes are excluded from listing and return 404 on detail reads.
  It documents a 25-request burst and 5 requests/second sustained limit.

These endpoints publish update timestamps, not an immutable revision history
or a multi-request snapshot guarantee. The provider adapter owns revision
identity and must reject inconsistent observations; ECHO admission enforces
immutable content for an admitted revision. The public
[documentation index](https://docs.granola.ai/llms.txt) does not document a REST
account/key-introspection endpoint. Listing a configured `owner.email` proves
only that an accessible note reports that owner, not organization key custody,
external subject identity, or a tenant identifier.

For future MCP research, `get_account_info` is documented to return the
connected email and active workspace. The documentation does not define its
complete response schema or promise immutable subject/workspace identifiers.
MCP follows workspace changes made in the Granola app, so a future connection
must validate and fence workspace drift rather than treating a connection ID
as permanent tenant proof. See [MCP tools and troubleshooting](https://docs.granola.ai/help-center/sharing/integrations/mcp).

[Granola webhooks](https://docs.granola.ai/webhooks) are now documented for
Business and Enterprise. This does not require replacing the retained pull
adapter or adding a webhook ingress lane in this slice.

## Nango decision

Current Nango support exists in two distinct built-in providers:

- [Granola REST](https://nango.dev/docs/api-integrations/granola) connects API
  keys, injects the Bearer header and proxies REST requests. Published actions
  include `list-notes`, `get-note`, `get-transcript` and `list-folders`; syncs
  include `notes` and `folders`. The notes sync retains metadata, summaries,
  attendees and folder/space membership, **not transcripts**.
- [Granola MCP](https://nango.dev/docs/api-integrations/granola-mcp) uses OAuth
  with dynamic client registration and proxies MCP tool calls. Nango's
  [provider configuration](https://github.com/NangoHQ/nango/blob/master/packages/providers/providers.yaml)
  includes authorization, token and registration endpoints, `offline_access`
  and refresh-token handling. This is not OAuth access to the REST API.
- The [notes sync](https://github.com/NangoHQ/integration-templates/blob/main/integrations/granola/syncs/notes.ts)
  configures cursor pagination, update checkpoints and request retries.
  [Get Transcript](https://github.com/NangoHQ/integration-templates/blob/main/integrations/granola/actions/get-transcript.ts)
  returns one page;
  [Get Note](https://github.com/NangoHQ/integration-templates/blob/main/integrations/granola/actions/get-note.ts)
  reports the 413 case instead of automatically assembling a large transcript.
  Complete transcript export and provider-specific failure/revision checks
  still need explicit orchestration.
- [Nango's webhook guide](https://nango.dev/docs/api-integrations/granola/webhooks)
  documents Granola signature verification and connection routing with a
  per-connection secret and `nangoConnectionId`. Webhook events do not carry
  meeting content; a subsequent authorized fetch is required.

Nango can supply connection/authentication infrastructure, transport, reusable
functions and sync scheduling. Its REST connection verification is
`GET /v1/notes?page_size=1`; that proves API reachability, not who owns the key
or which ECHO person/tenant is authorized. Granola-specific parsing, complete
exports, source/revision identity, cursor safety, cutoff checks, owner proof
and permission semantics remain provider responsibilities. ECHO retains
custody/audience binding, durable admission and final approval.

**Decision:** retain direct REST export using the admitted organization-owned
credential and existing meeting approval pipeline. No Nango dependency,
personal-key collection or MCP connection is introduced by this slice. Both
Nango transports are technically available research options for a future
connection design; neither establishes compatible custody or personal
authorization by itself.

## Implemented behavior and fixture proof

The provider still returns canonical meetings through its existing source
adapter and bridge. It adds no shared contract, connection, custody policy or
Ask reader. Source mapping/hash version remains `2.2.0`; the canonical mapping
has not changed.

The provider boundary now validates malformed success payloads and provider
timestamps, refuses authenticated redirects, and bounds returned note pages
even when the caller supplies no smaller limit. Missing or repeated
continuations fail before detail reads. Incremental pulls enforce
`updated_after` locally: older or equal list rows are skipped before content
fetches, and missing list update times fail. The poll watermark comes from list
metadata, so a newer detail response cannot advance past concurrent notes
that were absent from that page.

Configured owner checks remain at both list and detail boundaries. An
explicitly null detail owner is ineligible; a missing owner field retains the
compatible list-owner fallback. Non-null `private_notes_*` values fail closed
because they are outside the organization-owned export lane. A detail with
the wrong note ID or an update
time older than its list observation fails the pull, producing no successful
batch, cursor or admission.

Large transcript retrieval starts only after HTTP 413 from the inline
`GET /v1/notes/{note_id}?include=transcript` request, the documented `TRANSCRIPT_TOO_LARGE`
case. HTTP 413 from list, metadata or transcript-page requests still fails.
The client requests up to 100 segments per page, allows at most 100 pages and 10,000
segments, rejects malformed pages and cursor cycles, and returns no partial
export on failure. It rereads note metadata after assembly and rejects a
changed observation. Granola does not publish the 413 error-envelope schema;
the client uses the documented HTTP status at that exact request boundary
instead of requiring an undocumented JSON field. Bodyless and non-JSON 413
responses follow the same bounded fallback. This metadata comparison detects
observed drift; it does not claim a provider transaction snapshot across
transcript pages.

Synthetic fixtures cover payload and pagination failures, configured-owner
eligibility, large transcript assembly and failure, and source/admission
behavior:

- Summary, transcript and unknown provider-metadata changes produce a new
  revision under the same source item. Object-key ordering and observation
  time do not change the revision or bridge content digest.
- A wrong detail ID late in a page prevents any source admission, including
  otherwise valid earlier notes in that page.
- Admission rejects absent or ambiguous active owners, revocation while the
  metadata preflight is awaited, and a conflicting source admitted by a
  concurrent winner.

Existing shared proofs were reused: 42 focused admission/custody/immutable
revision tests passed, and three focused Authority fixtures passed for final
approval, exact transcript release and rejection without a record. Raw source
admission still does not grant Ask access; only the retained approval and
audience policy release meeting material.

Validation on 2026-10-01:

- `npx vitest run --config vitest.config.ts providers/granola`: 4 files and
  146 tests passed.
- `npm run check`: architecture, documentation, lint, build, typecheck and
  the full suite passed; 245 test files, 3,200 passing tests, two expected
  failures and one skipped test.
- `git diff --check`: passed.

No real accounts, credentials, live-provider rehearsals or deployment were
part of this validation.

## Remaining shared prerequisites

A future per-person export connection requires:

- a custody decision compatible with or explicitly updating ADR-0001;
- shared Person API/kernel connection lifecycle and `source_export` capability
  semantics, separate from `live_evidence`;
- verified Granola subject/workspace mapping to the exact ECHO person and
  current membership, including drift, revocation and permission checks; and
- explicit Authority integration that binds accepted exports to custody and
  audience without granting raw meeting discovery or Ask access.

These are future shared-integration prerequisites. The retained admitted
meeting workflow already uses `SourceAdapterV1`, `MeetingSourceBridgeV1` and
immutable admission before processing and exact final approval. It needs no
new Evidence Desk registry, Ask response contract or Authority composition
change to continue supplying approved meeting records to Ask.
