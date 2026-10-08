# Connector and context capture integration V1

**Status: implementation for source testing; production activation is deferred.**
This combines the connector implementation and the context foundation, merged
in #251 (`1d7e72b`). It implements the ingestion-only direction in the
[foundation design](2026-10-01-context-intake-foundation-v1-design.md).
It does not accept the proposed design or ADRs by implication.

The organization Granola acquisition and rehearsal paths described below were
retired by the [Personal Granola cleanup](2026-10-05-personal-granola-sprint-v1.md).
This document preserves their implementation evidence as historical context.
Shared capture transforms, custody, approval and personal connector code remain;
tool capture libraries have no active production registration.

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
The contract accepts only the note, message, ticket and meeting payloads these
providers emit. The payload kind is the capture's source type, and captures
carry no observation list. Captures retained in staging before this contract
was narrowed on 2026-10-02 keep their earlier content; capturing the same
source again admits a new revision rather than a duplicate.

`createContextSourceIntakeV1` binds a configured source identity, organization
and disposition. It serializes pulls, checks the read grant before and after a
single source pull, owns returned bytes before an asynchronous recheck, and
passes them to the existing shared intake. The default pull limit is 50; each
provider may impose a lower bound. Returned cursors are caller-owned and are
returned only after successful admission of the batch. Cancellation and identity
drift prevent admission. A read grant never implies a retention grant.

The retired `provider-context-intakes-v1.ts` factory selected the Granola
library mapping below. The organization acquisition path and Jira/Slack capture
selection have since been removed; tools are read live. The following table
records the original library representations:

| Source  | Mapping and representation                                                                                                                                                                                                                                          | Authority disposition                                                                                                                            |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Granola | Reuses the one configured meeting adapter. Selected normalized summaries, notes and transcripts become a bounded exact snapshot. A source start time produces a meeting payload; otherwise a plain-text note payload. Participant refs remain opaque.               | Explicit retained policy with synchronous transaction fence, or request-only                                                                     |
| Jira    | Uses the existing person-bound transport and fixed configured project. Preserves ticket key, status, labels, provider update time, optional priority and opaque assignee account reference. Body is omitted for a pointer.                                          | Request-only by default. An explicit Authority binding may retain pointers only through the shared SQLite admission fence; excerpts are refused. |

The retired Granola path used an organization API credential directly. It added
no second setup, Nango sync or background poller. The current Jira implementation
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

- Granola integration (retired organization-Granola proof): actual meeting adapter over a fake Granola API client; one configured pull, retained captures, immutable replay/change and configured-instance refusal.
- Staging runtime HTTP (retired organization-Granola proof): the fixed profile's request binding, owner-bound Jira connection across restart, retained Granola, live Jira reads, no Slack read at all, and rejection of tool capture before provider I/O or custody writes.
- [Intake composition](../../services/organization-authority/test/context-source-intake-v1.test.ts): provider-byte ownership across async checks, concurrent pull exclusion, retry cursor ownership, cancellation and identity drift.

These are local source proofs. They are not provider-live, artifact, deployment
or customer acceptance qualification. Real Slack/Nango and Granola probes from
the connector review remain separate work.

### Cross-source Ask verification

`npm run test:context-e2e` exercises the production HTTP/API composition with
real Person authentication, SQLite records and search, provider parsers, audited
request-local readers, and synthetic provider/model responses. It is also part
of the ordinary `npm run check` suite and spends no provider model credit.

The shared question requires a seeded, approved record with Granola provenance,
a readable document, a Jira ticket, and a Slack message. Granola ingestion and
human approval are not exercised in this HTTP test. The test checks that all four
reach the answer prompt and produce validated citations, that release audits
precede model access, and that the happy path makes exactly three model calls.
That assertion describes the synthetic fixture; it does not reduce the ordinary
Ask request's existing 24-call ceiling. A paid qualification run needs its own
lower call/token budget and replay protection before activation.
Negative cases cover private evidence, missing/revoked source grants, and
stale source content. A connection, retained pointer, empty response, or a
successful answer from only one source is not a cross-source pass.

Source selection remains explicit. The generic API can compose an audited Slack
reader alongside Jira for global Ask. Source results share the existing bounded
result limit; the dispatcher interleaves them and preserves truncation and
release receipts. Mine and unmapped project scopes never expand to these live
sources. `person records --query` still searches approved records; request-local
Jira and Slack search belongs to the Ask evidence path.

The test's Slack source is an in-memory reader that exercises the same audited
release, revocation and final-revalidation fences. No production Slack reader
exists: the Slack bot only delivers approvals, and reading Slack for Ask will
use each Person's own grant. Jira can be constrained to the configured project,
including exact reads and final citation revalidation.

These source tests do not activate new permissions on the current V3 staging
profile. That profile rejects generic live-reader injection and all capture.
The separately invoked `verify-read` diagnostic
described below permits one transient, zero-model read, not a live Ask grant.
A live cross-source qualification must be
separately authorized for the exact release, owner, Jira project,
request-only model release and spending bounds. It must require nonempty reads,
cross-source search, and a cited answer through these same paths. The ordinary
synthetic approval canary alone does not establish that qualification.

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

## Capture building blocks

Two source-tested building blocks support the staging rehearsal below;
real-provider qualification remains the outstanding live proof:

- Jira's server-only `captureConnection` derives a transport and current-grant
  fences from the authenticated Person's stored connection. It accepts no
  caller-selected account, site or connection locator. The
  staging HTTP test (retired organization-Granola proof)
  exercises this handoff through live read verification without retaining tool
  data, and the
  [provider connection test](../../providers/jira/test/jira-person-connection-v1.test.ts)
  proves that reconnect and disconnect invalidate it before another provider read.
- `runContextCaptureRehearsalV1` performs one pull of 1–5 items through an
  already-authorized intake with a cooperative deadline. Its receipt contains
  source identity and revision hashes, source type, admission results and
  counts. It emits neither provider contents nor opaque cursors. The trusted
  intake remains responsible for checking limits and current authorization
  before any durable admission; a receipt wrapper cannot undo prior writes.

The retired organization Granola transport bounded streamed JSON and paged
transcripts. Its cursor and fallback semantics are historical evidence, not a
contract for personal MCP acquisition. The retained normalizer and context
mapping have no HTTP client or source cursor. The personal sprint must verify
its own authenticated transport, response bounds and update behavior.

## Staging connector rehearsal

The rehearsal supports Jira `verify-read` only. Organization Granola capture
and polling are retired by the personal Granola sprint. All capture requests
are refused before provider I/O, and the Slack bot reads nothing. The merged
capture/derive foundations remain available for explicit authorized intake.

The selected live-test target is the existing staging Authority. One versioned
opt-in profile reuses its HTTPS origin, Google sign-in and owner session. The
profile is embedded in the existing nonsecret onboarding input, installed
privately by the host wrapper at a fixed path, and selected only on the exact
staging origin. It is fixed for the life of a rehearsal; another Jira project
needs a fresh rehearsal.

The closed, nonsecret profile has `schema_version: 3`, kind
`echo-staging-connector-rehearsal-profile-v3`, read policy
`initial-owner-jira-pointer-v3`, and the fixed Jira `cloud_id`, `integration_key`
and `project`. It accepts no credentials, arbitrary endpoints, message bodies
or caller-selected owner. V1/V2 profiles, the organization Granola policy and
the inert Slack channel field are retired. The wrapper, Authority and runner
refuse earlier profiles. A selected older profile needs a fresh rehearsal under
the operator playbook; existing bindings are not reinterpreted in place.

This is an explicit staging qualification selection, not a production startup
profile or downstream read capability. It does not accept ADR-0026 or enable the
ordinary Jira release gate. The selecting composition mounts provider-owned Jira
connection commands and one authenticated rehearsal endpoint through a neutral
HTTP runtime port. It does not mount general ticket-evidence or additional Ask
routes. Existing Slack setup and approval delivery, the synthetic release canary,
periodic processing and telemetry keep their ordinary paths. Implementation and
live qualification remain separate claims.

The owner Mac runs `authority:staging-connector-rehearsal` with the expected
release ID and the exact nonsecret profile. The client verifies the staging
session and uses the existing bounded Person transport; no bearer credential
enters command arguments, host control, output or a test receipt. The server
compares the expected release and profile digest and authenticates the exact
initial owner. The request has no capture action or meeting limit.

The separate `verify-read` action explicitly authorizes a bounded, request-local
diagnostic under that same owner and fixed profile. It checks the local connection
before provider work, lists one item, opens only its issued handle, and revalidates
provider access and the current local grant before returning success. Its single
15-second deadline and Jira 25-request cap apply
without pagination or retries. No body enters custody, an audit, a model or the
receipt. The receipt contains only a source-coordinate hash, text hash and
positive UTF-8 byte count up to 3 KiB, or an allowlisted refusal phase and reason.
Jira's normalized issue text includes its key and summary, so this does not prove
a nonempty description. Empty results refuse. This action preserves the selected
V3 profile and connection bindings; it does not enable generic live-reader
injection, search, Evidence Desk or Ask.

The staging canary has its own admitted synthetic infrastructure. Its source
returns no meetings and reads no provider. The existing explicit release-bound
canary request exercises shared custody, extraction, approval and retrieval.

Implementation note, 2026-10-08: the canary no longer has an organization-level
admitted source. It runs on the owner's synthetic personal source and its
proposal is approved on the desktop or in Slack
([unified meeting approval](2026-10-07-unified-meeting-approval-v1.md)).

Jira bindings come from verified connections: Jira uses the initial owner's
existing connection and current grant. A working token or Nango tag does not
grant custody. Current membership, connection and grant checks apply around live
provider reads. Tool pointers, metadata, bodies and change histories never
enter the rehearsal capture store. The removed capture paths are not replaced
with request-only capture; the existing live reader handles verification.
Previously retained staging rows are not purged by this code change.

The `/v1/staging/connector-rehearsal` endpoint carries explicitly versioned
request and response bodies. The outer receipt has schema version 3 and kind
`echo-staging-connector-rehearsal-receipt-v3`. It carries status or a Jira read
result; there is no nested capture receipt. All receipts remain
`qualified: false` and omit provider content and cursors.

Jira consent attempts and connection references live in a private rehearsal
sidecar outside the canonical Authority databases. A marker binds that sidecar
to the Authority lineage, initial owner and profile digest. Same-profile process
restarts can resume consent; a different binding fails closed. The sidecar is
not an additional canonical database or a recovered Person grant. Host recovery
must follow the explicit cleanup/refusal rules in the
[deployment guide](../../deploy/organization-authority/README.md#optional-staging-connector-rehearsal).
Remote Nango connections require explicit disconnect/revocation when retiring
the rehearsal; a local reset alone cannot prove remote cleanup.

The [service guide](../../services/organization-authority/README.md#staging-connector-rehearsal)
owns the commands. Source tests are not live qualification: the server image,
matching Person client and reviewed host tooling must first be deployed through
the existing operator lane. Every receipt remains `qualified: false`; successful
read checks are evidence for those observations, not blanket provider acceptance.

### Retired Slack public-channel read capability

Staging once selected an optional provider-owned setup capability that asked
for `channels:read` and `channels:history` beside the four bot scopes, so the
bot could read one public channel. It was removed when the bot became
delivery-only. Slack setup now asks only for the four delivery scopes, and
rebind is exact-only
([ADR-0027](../decisions/ADR-0027-rebind-lost-nango-slack-connection.md)). A bot
token installed earlier may keep the two channel scopes until the app is
reinstalled from scratch; nothing uses them.

## Boundaries before activation

The general production profile registers no organization meeting source. The
explicit staging profile mounts request-bound, zero-model Jira verification;
synthetic approval qualification has separate canary infrastructure. The shared
meeting processing and approval code remains available for personal intake.
Jira live Ask requires the explicit ADR-0026 runtime selection described below.
Slack bot approval history is not a personal content read grant.

The personal Granola sprint must prove bounded discovery, deduplication,
revocation, durable retries and progress past malformed items against the actual
OAuth MCP contract before enabling automatic folder intake.

Tool capture, change history, retained Slack snapshots and tool retention rules
are outside the current Layer 1 scope. The existing tool capture adapters remain
dormant library code. The rehearsal cannot select their storage paths.

The capture cleanup changes no graph projection, enrichment, Evidence Desk,
retrieval, release audit or Ask response schema. The accepted ADR-0026 follow-up
opens the Jira code gate and selects global live Ask on staging with
`ECHO_STAGING_JIRA_ASK_V1=true`. It reuses the fixed profile and existing owner
connection. The EC2 overlay enables the switch only when that profile is present.
Project mapping and per-person Slack tokens remain separate work. The merged
capture/derive foundations stay dormant.

## Historical Granola provider research, verified 2026-10-01

The conclusions below record the earlier organization-key design. The personal
Granola sprint supersedes that selection with OAuth MCP and selected-folder
intake; public REST findings do not establish the new authenticated contract.

The Granola connector research used public provider documentation and Nango's
published source. No account connection, credential, authenticated API request
or live rehearsal was used.

| Mechanism | Documented capability and limit | ECHO disposition |
| --- | --- | --- |
| Workspace API key | Admin-managed, workspace-owned key on Business and Enterprise; does not expire or depend on the creating admin's continued membership. Reads public workspace notes and notes in spaces explicitly granted Granola API access. Unshared private notes and folders remain inaccessible. | Retain the organization-owned REST path permitted by ADR-0001. |
| Personal API key | Business and Enterprise members can create keys with personal and/or public note scopes, subject to Enterprise controls. Personal scope includes owned notes and notes/folders shared with that person. | Centrally collecting these keys remains prohibited. Provider availability does not change custody policy. |
| Granola MCP | Individual browser OAuth with dynamic client registration, or Enterprise-Managed Authorization through a compatible IdP/client. No API-key or service-account MCP access. Access is limited to the user's active Granola workspace and plan/admin controls. | Future personal-authorization research only. MCP OAuth is separate from REST API-key authentication. |
| Historical CSV export | Includes titles, summaries, transcripts and basic details for owned, summarized, non-deleted notes in selected workspaces, including full history. Basic/Business default enabled; Enterprise default disabled. Emailed download requires the requesting account, expires after 24 hours and can be regenerated once per 24 hours. | Confirms an export capability exists; ECHO does not implement CSV generation, download or ingestion. |

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
Business and Enterprise. They do not require replacing the retained pull
adapter or adding a webhook ingress lane.

### Granola Nango decision

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
personal-key collection or MCP connection is introduced. Both Nango transports
are technically available research options for a future connection design;
neither establishes compatible custody or personal authorization by itself. A
future per-person export connection needs a custody decision compatible with
or explicitly updating ADR-0001, verified Granola subject/workspace mapping to
the exact ECHO person and current membership, and the shared `source_export`
capability, separate from `live_evidence`.
