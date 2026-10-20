# Shared connector contracts

These contracts give connectors a common definition of personal read access
and an audited boundary for live evidence. Provider protocols and transport
remain in their provider workspaces. The contracts are additive: existing Person
tools, Ask responses, source admission and Slack onboarding continue through
their current interfaces.

The [connector/context integration](../product/2026-10-01-connector-context-integration-v1.md)
retains shared capture contracts and personal live-read verification. The
organization Granola capture route is retired. Jira and Slack capture requests
are refused, and their
pointers, metadata and bodies are not admitted to Layer 1. Existing provider
capture contracts remain dormant library code; they have no active rehearsal
or production registration. Shared capture types remain in
`organization-processing/core`. A retained meeting capture is a source
observation, never an approved fact.

## Shared connection commands

The Person CLI dispatches `person tools <verb> --tool <id>` through
`PersonToolProviderV1`. Each provider owns its options, public wire schemas and
client fragment, with only the authenticated `PersonToolHostV1` transport supplied
by the product. Slack, Jira and Confluence use this seam through client-only
workspaces that keep their server dependencies out of the installed Person
client; the Person client composes the Granola and staging synthetic meeting
tools itself.

Provider-owned HTTP applications mount through the Authority's generic
`person_tool_connections` collection. Route collision checks and body/response
bounds remain host-owned; provider authentication, attempt state and grant
verification remain adapter-owned. Client disconnect propagates an abort signal.
Jira's POST status reconciles browser consent and may commit the grant. This
connection step does not pull context or authorize retention.
[ADR-0026](../decisions/ADR-0026-jira-person-live-evidence-nango.md) is
accepted; runtime selection stays explicit and live qualification is still
open.

## Personal access

[`PersonConnectorAccessV1`](../../packages/organization-api/src/person-connector-access-v1.ts)
separates identity linking from read authorization. A linked Slack identity used
for approval delivery can have `read_status: not_connected`. A provider may
establish both through one OAuth flow after verifying that its authorized
subject and tenant match the ECHO person's identity link.

| Field | Meaning |
| --- | --- |
| `tool_id` | Stable connector identity, independent of its display name |
| `identity_status` | Whether this external account is linked to the ECHO person |
| `external_scope_id` and `external_subject_id` | Provider-verified coordinates of the linked account; the scope can be null for accounts without a tenant |
| `read_status` | Whether a separate read grant is usable, missing, revoked, unavailable, or needs reauthorization |
| `read_capabilities` | ECHO permissions: `live_evidence`, `source_export`, or both |

Only a connected read grant exposes capabilities. Revoked or unlinked identities
expose no subject or tenant. A read reconnect may preserve the identity link;
revoking the identity invalidates reads through that identity too. OAuth scope
names and Nango connection references belong in provider state, rather than
this status projection. The validator owns immutable copies and rejects
unknown fields, duplicate capabilities and inconsistent state.

Only the schema and validator exist: no endpoint exposes this status, and the
Person tools responses report identity link status, not read status. Slack's
owner-only organization setup state remains independent of this personal read
state.

## Live evidence

[`PersonLiveEvidenceReaderV1`](../../packages/organization-authority-kernel/src/shared/person-live-evidence-v1.ts)
defines `search`, `open`, `list` and `revalidate` for one authenticated person.
Provider composition constructs the reader from trusted ECHO state before
building a desk. Its binding fixes the organization, principal, membership,
tool, external tenant/subject and immutable read-grant digest. Methods cannot
select another actor or connection and never accept or return credentials.

The provider returns normalized items with citations, bounded text, labels and
optional inventory metadata. It validates its own API payload, tenant URL and
item coordinates. The shared boundary checks the citation's tenant/tool,
verifies the digest of released text and owns all handles visible to the desk.
A tool container's citation commits to no text
([ADR-0042](../decisions/ADR-0042-research-tool-contract.md)), so the
boundary checks that digest for every other citation, and the audit commits a
container's released value instead.
A Slack reader, when adapted, uses the existing typed message citation; ticket
tools use
[`PersonTicketCitationV1`](../../packages/organization-api/src/person-ticket-citation-v1.ts),
whose coordinates include the tool, tenant and ticket identity. Neither changes
the citation union of `PersonAnswerResponseV4`; ticket citations reach Ask only
through `PersonAnswerResponseV5`.

[`createAuditedPersonLiveEvidenceSourceV1`](../../packages/organization-authority-kernel/src/shared/audited-person-live-evidence-v1.ts)
implements the common release boundary:

1. Require a connected personal `live_evidence` grant and a reader with exactly
   the same binding. An identity link or organization bot installation alone
   cannot satisfy this precondition.
2. Check current ECHO membership, identity and grant before each read, after the
   read, and after the audit commits. Grant replacement or revocation stops the
   operation. An authorization implementation must check authoritative state;
   the status projection is not proof of permission.
3. Validate and copy the page before asynchronous auditing. Bounds are 50
   items, 3 KiB per text, 1 KiB per label and 64 KiB per released result.
4. Commit an audit containing the binding, operation and citations/digests.
   It contains no query, text, label, attributes, provider handle or cursor.
   Empty and metadata-only pages also receive a receipt. Audit failure prevents
   release. Revocation after audit may leave a receipt for an unreleased read.
5. Keep evidence and provider handles only in request memory. Opening requires
   an item id issued in that request. List continuations are request-owned and
   bound to the original container and dates; provider cursors remain internal.
6. Before every later model call and the final response, the composing desk
   calls `revalidate`. Every call checks current ECHO authorization and the
   provider's connection. Before the final response it also checks the
   visibility of every released citation, including inventory metadata and
   earlier ticket revisions; before a model call it checks only the citations
   released since the previous successful check
   ([ADR-0038](../decisions/ADR-0038-incremental-access-check-before-model-calls.md)).
   A valid token alone is insufficient.

Provider errors become bounded messages without raw bodies or exception
causes. Abort signals reach provider reads and prevent release after
cancellation. Provider implementations must also avoid logging evidence or
credentials, and the Ask composition must keep model content capture off when
live evidence can enter a prompt. The boundary's `team` display visibility
does not authorize release to another person.

Two selected diagnostic paths are explicit exceptions to that capture rule:

- **Person diagnostics.** A person may select a one-use capture of their own
  Ask or run. It stays in Authority process memory, only that person can read
  it, every terminal read revalidates source access, and known revocation
  erases it (see the
  [observability runbook](../operations/RB-OPERATIONS-001-authority-observability.md#follow-a-research-execution-and-select-private-payload-capture)).
- **Staging LangSmith tracing.** An operator-selected, staging-only exporter
  sends each selected research run's model prompts and outputs and its tool
  arguments and results, including live Jira and Confluence text and generated
  JQL, to an external LangSmith project. Nothing revalidates or erases what it
  has sent. The Authority refuses to start with a tracing selection on any
  other origin, and the onboarding wrapper refuses non-staging Authorities (see
  [LangSmith staging tracing](../../deploy/organization-authority/README.md#langsmith-staging-tracing)).

Ask progress is not a capture path. A streamed Ask
([ADR-0039](../decisions/ADR-0039-ask-progress-names-after-the-access-check.md)) may name a live ticket, page or message, or on
`/v7` a Jira project or Confluence space, while it runs, but only after the access check before the model call that reads
it, and only by the citation projection its answer citation would carry:
coordinates, kind, label, visibility and checked link. It never sends the
item's body, a generated Jira query or the model's search terms, and it names
a live tool only by its tool id.

## Source capabilities and containers

[ADR-0042](../decisions/ADR-0042-research-tool-contract.md) makes what a
connector's source can do data. Each registration in
`services/organization-authority/src/composition/person-live-connector-registry-v1.ts`
declares `capabilities` beside its descriptor: the filters it takes, its date
fields with what each means, `any_date`, and the link names its items carry.
Descriptions say only what a source holds. Ask shows research the
capabilities and refuses, before the reader, a filter value or date field a
source does not declare. The registry's test holds the Jira and Confluence
readers to the dates their sources declare.

- **Any date.** The boundary passes every date field and `any` in shape; the
  reader applies the one asked for or refuses it. Jira issues declare
  `created`, `updated` and `due`, and Confluence pages `created` and
  `updated`, each with `any_date`. On `any`, Jira sends one JQL OR of the
  window on its three dates (a site-wide read keeps a created restriction
  beside it) and never stops paging early; Confluence sends one CQL OR on
  `created` and `lastmodified`. Neither declares filters or links yet.
- **Tool containers.** A connector may register a source of kind
  `tool_container` for its containers. `jira_projects` and
  `confluence_spaces` register at minimum response version 8, so only the V8
  answer binds and cites them, and the registry refuses a container without
  capabilities. They declare no filters, dates or links, and refuse a date
  window. A tool's items and containers share one runtime
  (`sharePersonLiveRuntimeV1` in the registry). Each person connection's
  `containerSource` binds behind the same fences as its item source and
  through the same audited boundary, pinned in a project scope to the mapped
  containers; an unmapped project reads none. The shared reader
  (`providers/shared/src/person-tool-container-reader-v1.ts`) keeps handles
  and cursors in the request, labels a container by its name with its key and
  tool as attributes, cites it with its permalink, and rechecks every distinct
  release. A row that fails validation is left out and counted, and the result
  carries a notice that some could not be shown; a credential rejection fails
  the read, and only "not found" leaves a container out.
- **Project names.** A container names the mapped ECHO projects the asker
  can see, from the optional `project_names` its connector opens with, read
  locally with no provider call; each connection pins and fences them
  (`containerProjects` in `providers/shared/src/person-project-mapping-v1.ts`).

Slack registers no containers: no Slack reader is composed.

## Meeting exports

Meeting ingestion continues to use
[`SourceAdapterV1`](../../packages/organization-processing/src/core/ports/source.ts)
and the per-person
[`PersonMeetingProviderV1`](../../services/organization-authority/src/composition/person-meeting-runtime-v1.ts)
admission path. The shared access projection can represent `source_export`
without granting live evidence reads. The provider implements the person's
export-equivalent API access, revision identity and cursor behavior; ECHO
continues to bind custody, audience, immutable revisions and approval policy.
An export grant does not automatically authorize retention or sharing.

The ordinary runtime no longer selects an organization Granola export bridge
or requires its credentials. Generic source admission and the approval core
remain, as does the staging-only synthetic personal meeting source. Meetings
enter only through a person's own sources; no organization meeting source
exists. Personal Granola OAuth and
selected-folder intake are specified by the
[Personal Granola sprint](../product/2026-10-05-personal-granola-sprint-v1.md)
and implemented through [ADR-0030](../decisions/ADR-0030-personal-meeting-custody-and-review.md).
The shared personal connection lifecycle, bounded JSON/MCP transport, Authority
source processing, native review and original-context readers own the workflow.
Granola supplies verified account/workspace, folder enumeration and meeting
normalization. Imported notes are labeled unapproved; transcript release still
requires an explicit approval choice. This is separate from the dormant general
capture routes.

Granola network cost is explicit: home uses 3 MCP calls; folder browse uses 4;
a transient preview uses 3; an explicit background import uses 4. Watch setup
uses 4 calls to validate account and folder access, then saves a pending baseline
for the existing worker. A full background baseline or unchanged scan of N
meetings uses `7 + ceil(N/10) + N` MCP calls
(account, folder membership before/after, batched notes and individual transcripts).
Each MCP call also uses one existing Nango connection lookup with current tag
verification. A changed scan stops at its first differing meeting and a later
worker turn continues. No request-level token cache hides remote revocation.
Current limits and live qualification remain in the sprint brief.

## Ownership and Nango

| Work | Owner |
| --- | --- |
| OAuth transport, token storage/refresh and reconnect mechanics selected for a connector | Nango, through the provider's implementation |
| External subject/tenant verification, required OAuth scopes, API parsing, URLs and item permission checks | Provider workspace |
| Person membership, identity linkage, grant commitments and revocation | ECHO authoritative state and provider state through explicit ports |
| Audit before release, common item bounds and request-owned handles | Shared live evidence boundary |
| Meeting custody/audience/admission and final approval | Existing ECHO source and approval contracts |
| Organization API versions, desk source registration and Authority composition | Shared integration work |

These contracts require no Nango SDK or Proxy. A provider may fetch a token
from Nango and call its API directly. Nango Functions, syncs and webhook
forwarding are separate implementation choices; they cannot replace ECHO's
authorization, admission or audit checks.

## Current integration

Connectors implement the reader, authorization and audit ports and run fixture
conformance tests independently. Meeting work uses the existing admission ports.
The provider-neutral tests exercise the common release boundary with both Slack
and ticket fixtures; they do not call either service.

Ticket evidence reaches Ask through Evidence Desk V2 and `PersonAnswerResponseV5`
at `POST /v4/person/ask`, and live page evidence through `PersonAnswerResponseV6`
at `POST /v5/person/ask`, `PersonAnswerResponseV7` at `POST /v6/person/ask`
(which also reads ECHO's follow-ups, ADR-0040) and `PersonAnswerResponseV8`
at `POST /v7/person/ask` (which also reads the asker's workspace and their
tools' Jira projects and Confluence spaces, ADR-0042), all with the durable
live-read audit. The Authority mounts these routes whenever an answer model is bound; ticket or page evidence
appears only when the matching Jira or Confluence live runtime is selected.
[ADR-0026](../decisions/ADR-0026-jira-person-live-evidence-nango.md) is accepted
and [ADR-0034](../decisions/ADR-0034-confluence-person-live-page-evidence.md) is
proposed; the CLI requires explicit Jira or Confluence configuration. On staging,
`ECHO_STAGING_JIRA_ASK_V1` and `ECHO_STAGING_CONFLUENCE_ASK_V1` take the fixed
connector profile's Atlassian site (Jira also takes its integration; Confluence
uses the `confluence` integration). Each Person reads under their own grant, with
no initial-owner or fixed-project restriction and without tool capture; the
rehearsal's owner and fixed-project limits apply only to its diagnostic reads.
Jira (tickets, and Jira projects for V8) and Confluence (pages, and spaces
for V8) are the live readers. No live Slack reader
is composed, the V3 desk reads no Slack, and read status is not exposed to
clients.

The dispatcher must preserve [ADR-0024](../decisions/ADR-0024-person-list-open-and-mine-scope.md)
scope rules: `mine` excludes live external reads. Provider selection and
bindings are server-owned. Project/channel mappings and any provider-specific
retention rules require their own implementation decisions rather than being
inferred from this generic interface.
