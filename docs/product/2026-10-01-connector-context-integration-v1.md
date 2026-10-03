# Connector and context capture integration V1

**Status: implementation for source testing; production activation is deferred.**
This combines the connector implementation and the context foundation, merged
in #251 (`1d7e72b`). It implements the ingestion-only direction in the
[foundation design](2026-10-01-context-intake-foundation-v1-design.md).
It does not accept the proposed design or ADRs by implication.

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

The opt-in Granola and Jira profiles in
[`provider-context-intakes-v1.ts`](../../services/organization-authority/src/composition/provider-context-intakes-v1.ts)
and the Slack source in
[`slack-context-capture-runtime-v1.ts`](../../services/organization-authority/src/composition/slack-context-capture-runtime-v1.ts),
whose intake
[`connector-rehearsal-capture-v1.ts`](../../services/organization-authority/src/composition/connector-rehearsal-capture-v1.ts)
builds, make the integration choices explicit:

| Source  | Mapping and representation                                                                                                                                                                                                                                          | Authority disposition                                                                                                                            |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Granola | Reuses the one configured meeting adapter. Selected normalized summaries, notes and transcripts become a bounded exact snapshot. A source start time produces a meeting payload; otherwise a plain-text note payload. Participant refs remain opaque.               | Explicit retained policy with synchronous transaction fence, or request-only                                                                     |
| Jira    | Uses the existing person-bound transport and fixed configured project. Preserves ticket key, status, labels, provider update time, optional priority and opaque assignee account reference. Body is omitted for a pointer.                                          | Request-only by default. An explicit Authority binding may retain pointers only through the shared SQLite admission fence; excerpts are refused. |
| Slack   | A pointer-only adapter reads one fixed authorized channel and maps message coordinates, selected metadata and a Slack-provided permalink. The staging selection below supplies the read capability and Authority binding.                                         | Explicit retained pointers in the staging selection only; no message body or production registration.                                              |

Granola still uses its existing organization API credential directly. This
integration does not add another setup, Nango sync or background poller. Jira
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

- [Granola integration](../../services/organization-authority/test/granola-context-source-intake-v1.test.ts): actual meeting adapter over a fake Granola API client; one configured pull, retained captures, immutable replay/change and configured-instance refusal.
- [Jira integration](../../services/organization-authority/test/jira-context-source-intake-v1.test.ts): actual bounded HTTP transport/parser over fake HTTP responses; default request-only capture, explicit retained-pointer admission, replay/change, wrong read grant and transaction-time custody-fence revocation, and organization/disposition refusal.
- [Slack provider adapter](../../providers/slack/server/test/context/slack-context-source-v1.test.ts) and [transport](../../providers/slack/server/test/context/slack-context-transport-v1.test.ts): fake Slack API responses exercise fixed-channel pointer mapping, grant fences, bounded paging and provider-response validation. They do not compose an Authority intake or prove configured Slack scopes.
- [Slack capture runtime](../../services/organization-authority/test/slack-context-capture-runtime-v1.test.ts): real Authority and provider SQLite state, fresh scope proof, current owner/link fences and retained pointer admission with synthetic provider responses.
- [Staging runtime HTTP](../../services/organization-authority/test/staging-connector-rehearsal-runtime-http.test.ts): the fixed profile's request binding, owner-bound Jira connection across restart, retained Granola, Jira and Slack pointer replay, and refusal of the retired request wire and a revoked Slack link.
- [Intake composition](../../services/organization-authority/test/context-source-intake-v1.test.ts): provider-byte ownership across async checks, concurrent pull exclusion, retry cursor ownership, cancellation and identity drift.

These are local source proofs. They are not provider-live, artifact, deployment
or customer acceptance qualification. Real Slack/Nango and Granola probes from
the connector review remain separate work.

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
  [rehearsal capture test](../../services/organization-authority/test/connector-rehearsal-capture-v1.test.ts)
  connects this actual handoff to shared request-only intake, and the
  [provider connection test](../../providers/jira/test/jira-person-connection-v1.test.ts)
  proves that reconnect and disconnect invalidate it before another provider read.
- `runContextCaptureRehearsalV1` performs one pull of 1–5 items through an
  already-authorized intake with a cooperative deadline. Its receipt contains
  source identity and revision hashes, source type, admission results and
  counts. It emits neither provider contents nor opaque cursors. The trusted
  intake remains responsible for checking limits and current authorization
  before any durable admission; a receipt wrapper cannot undo prior writes.

Granola HTTP JSON is now limited to 2 MiB while streaming, before parsing.
Missing or misleading Content-Length cannot bypass that limit. Oversized inline
transcripts use the existing paged fallback; each page is bounded and assembled
transcripts are limited to 16 MiB. These are provider transport limits, separate
from the selected context snapshot's 128 KiB limit. Oversized data is rejected,
never silently truncated. Focused source tests cover cancellation and fallback;
real provider qualification is still pending.

Granola capture is a retained, initial-owner-scoped qualification observation
under the shared capture foundation. It reads the current admitted cursor but
does not advance it. The legacy processing cycle remains the single owner of
meeting intake, approval publication and that cursor. There is no scheduler or
automatic convergence.

## Staging connector rehearsal

The selected live-test target is the existing staging Authority. One versioned
opt-in profile reuses its HTTPS origin, Google sign-in and owner session. The
profile is embedded in the existing nonsecret onboarding input, installed
privately by the host wrapper at a fixed path, and selected only on the exact
staging origin. It is fixed for the life of a rehearsal; another Jira project or
Slack channel needs a fresh rehearsal.

The closed, nonsecret profile has `schema_version: 2`, kind
`echo-staging-connector-rehearsal-profile-v2`, capture policy
`initial-owner-granola-retained-jira-pointer-slack-pointer-v2`, the fixed Jira
`cloud_id`, `integration_key` and `project`, and one Slack `channel_id`. It
accepts no credentials, arbitrary endpoints, message bodies or caller-selected
owner. The selected channel must be a public channel; the provider verifies both
its C-prefixed coordinate and Slack's explicit `is_private: false` response
before accepting messages. The earlier request-only V1 profile and its
predecessor-anchored V2 rebind are retired: the wrapper refuses them at prepare,
and the Authority and runner refuse them at startup.

This is an explicit staging qualification selection, not a production startup
profile or downstream read capability. It does not accept ADR-0026 or enable the
ordinary Jira release gate. The selecting composition mounts provider-owned Jira
connection commands and one authenticated rehearsal endpoint through a neutral
HTTP runtime port. It does not select the ticket reader or the additional Ask
route. Existing Slack setup and approval delivery, the synthetic release canary,
periodic processing and telemetry keep their ordinary paths. Implementation and
live qualification remain separate claims.

The owner Mac runs `authority:staging-connector-rehearsal` with the expected
release ID and the exact nonsecret profile. The client verifies the staging
session and uses the existing bounded Person transport; no bearer credential
enters command arguments, host control, output or a test receipt. The server
compares the expected release and profile digest and authenticates the exact
initial owner. Each capture pulls 1–5 items under the runtime's exclusive work
lane, propagates cancellation, and releases only validated counts and hashes.
The current-owner and source/grant checks apply around provider reads and
durable admission. Concurrent capture requests are refused rather than queued.

Granola uses the same admitted source object as ordinary meeting processing.
Its separate owner-scoped capture policy permits retained snapshots; this test
never moves the legacy meeting cursor. Ordinary polling remains the cursor
owner, so an observation may legitimately contain zero items.

Jira and Slack bindings come from verified connections. Jira uses the initial
owner's existing connection and current grant. Slack derives workspace, app and
bot identity from the active organization connection and requires the owner's
active Slack person link. A working bot token or Nango tag does not grant
custody. Explicit owner-scoped Authority policy selects retained pointers;
current membership, connection and policy fences apply around provider reads
and at synchronous SQLite admission. Opaque message authors and ticket assignees
remain references, not identity or permission grants.

Both sources produce the same shared typed envelope used by Granola. Jira keeps
ticket coordinates and selected metadata, and Slack keeps message coordinates,
selected metadata and its provider permalink. Neither captures a body.
Identical replays deduplicate; changed selected metadata creates an immutable
revision. The shared intake owns admission. This adds no extraction, graph
projection, retrieval, Evidence Desk or Ask selection.

The `/v1/staging/connector-rehearsal` endpoint carries explicitly versioned
request and response bodies. The outer receipt has schema version 2 and kind
`echo-staging-connector-rehearsal-receipt-v2`; its nested generic capture
receipt remains V1. Successful captures report admission or duplicate, never
request-only. All receipts remain `qualified: false` and omit provider content
and cursors.

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
captures are evidence for those observations, not blanket provider acceptance.

### Optional Slack public-channel read capability

Only the staging selection enables the provider-owned
`echo-slack-public-channel-context-capability-v1` setup option. The existing
`person tools setup --tool slack` workflow creates or updates the same Slack app
and asks for the baseline four bot scopes plus exactly `channels:read` and
`channels:history`. Human Slack consent is still required. Both Nango and Slack
must prove the granted scopes. No second app, setup command or shared-server
Slack-specific route is introduced.

Outstanding cards and person links bind the historical connection state. That
state and its four-scope contract stay unchanged. Under the explicit capability
only, a provider-owned proof helper first reconstructs the actual live
`auth.test` and `bots.info` evidence and requires it to equal the provider's
reported proof. If the live scopes are exactly the baseline plus the two read
scopes, the helper may project that verified proof onto the historical baseline
and must reproduce the stored digest. It still requires the same workspace,
enterprise, app, bot and bot user. Unknown extra scopes, missing baseline scopes
or arbitrary evidence digests are refused. Baseline connections without the
capability keep their exact-proof path.

This explicit extension also applies to lost-Nango-connection rebind while
retaining its old-ID absence check and synchronous local fences. It does not
accept [ADR-0027](../decisions/ADR-0027-rebind-lost-nango-slack-connection.md),
which remains proposed. Channel capture separately proves the read capability
before use; preserved approval state is not evidence that channel consent has
completed.

## Boundaries before activation

The general production profile registers neither shared-capture source in a scheduler.
The explicit staging profile mounts only the bounded observation operation.
The existing meeting approval path remains the production path; a later startup
profile must select a single owner for each source cursor, rather than polling
the same source through both paths. Jira remains production-disabled. Slack bot
approval history is not a personal content read grant.

Malformed or oversized provider items fail the bounded pull without returning a
cursor. Earlier committed captures can be replayed and deduplicate, but a
permanently invalid item still requires intervention. This slice adds no retry
loop, rejection ledger or skip policy. Durable rejection accounting and cursor
progress past bad items must be designed before unattended ingestion. Granola's
transport bounds limit memory use; they do not solve the existing bad-note
retry problem.

Production activation additionally needs accepted capture policy, registered
current read and retention authorities, retention lifecycle/deletion decisions,
capacity checks and live provider qualification. The factories require these
authority ports; they do not synthesize permission from a working credential.

The user-approved next-round Slack addition is a retained message snapshot
alongside its pointer. Only the snapshot addition is deferred; the staging
selection takes pointer intake now. No current Slack adapter retains message text, and no read
grant selects retention. The snapshot round
must also define the policy for provider message edits and deletes, including
which revisions remain retained and when retained snapshots are removed. The
staging selection retains Jira and Slack pointers.

This capture path changes no graph projection, enrichment/learning, Evidence
Desk, retrieval, Ask, release audit or Ask response schema. The separately gated
Jira ticket Ask route and its answer version belong to
[ADR-0026](../decisions/ADR-0026-jira-person-live-evidence-nango.md), not to
capture. Request-only Jira captures disappear with the request. Staging retained
pointers provide durable shared
context but do not yet enrich a graph or feed Ask through this capture path.
The normal production Jira gate is unchanged.

## Granola provider research, verified 2026-10-01

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
