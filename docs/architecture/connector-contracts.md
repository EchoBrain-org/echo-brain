# Shared connector contracts

These contracts give connectors a common definition of personal read access
and an audited boundary for live evidence. Provider protocols and transport
remain in their provider workspaces. The contracts are additive: existing Person
tools, Ask responses, source admission and Slack onboarding continue through
their current interfaces.

The [connector/context integration](../product/2026-10-01-connector-context-integration-v1.md)
provides retained Granola capture and live Jira/Slack read verification in the
staging rehearsal. Jira and Slack capture requests are refused, and their
pointers, metadata and bodies are not admitted to Layer 1. Existing provider
capture contracts remain dormant library code; they have no active rehearsal
or production registration. Shared capture types remain in
`organization-processing/core`. A retained meeting capture is a source
observation, never an approved fact.

## Shared connection commands

The Person CLI dispatches `person tools <verb> --tool <id>` through
`PersonToolProviderV1`. Each provider owns its options, public wire schemas and
client fragment, with only the authenticated `PersonToolHostV1` transport supplied
by the product. Slack and Jira use this seam. Jira's client-only workspace keeps
its server dependencies out of the installed Person client.

Provider-owned HTTP applications mount through the Authority's generic
`person_tool_connections` collection. Route collision checks and body/response
bounds remain host-owned; provider authentication, attempt state and grant
verification remain adapter-owned. Client disconnect propagates an abort signal.
Jira's POST status reconciles browser consent and may commit the grant. This
connection step does not pull context or authorize retention. Jira remains
production-disabled pending its proposed ADR and live qualification.

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
   calls `revalidate`. This checks current ECHO authorization and the provider's
   connection and visibility of every released citation, including inventory
   metadata and earlier ticket revisions. A valid token alone is insufficient.

Provider errors become bounded messages without raw bodies or exception
causes. Abort signals reach provider reads and prevent release after
cancellation. Provider implementations must also avoid logging evidence or
credentials, and the Ask composition must keep model content capture off when
live evidence can enter a prompt. The boundary's `team` display visibility
does not authorize release to another person.

## Meeting exports

Meeting ingestion continues to use
[`SourceAdapterV1`](../../packages/organization-processing/src/core/ports/source.ts)
and the
[`MeetingSourceBundleV1`](../../packages/organization-processing/src/ports/meeting-source-bundle-v1.ts)
admission path. The shared access projection can represent `source_export`
without granting live evidence reads. The provider implements the person's
export-equivalent API access, revision identity and cursor behavior; ECHO
continues to bind custody, audience, immutable revisions and approval policy.
An export grant does not automatically authorize retention or sharing.

The current meeting profile selects one organization-owned Granola export
bridge. Its organization credential and canonical owner-email binding are
Authority-only inputs; every exported revision enters the same source-admission
and approval path. There is no Person-client Granola connection flow or
per-person Granola credential in this profile.

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
at `POST /v4/person/ask`, with the durable live-read audit. The Authority mounts
that route only when a Jira ticket-live runtime is selected.
[ADR-0026](../decisions/ADR-0026-jira-person-live-evidence-nango.md) is accepted;
the CLI requires explicit Jira configuration. The staging switch instead reuses
the fixed profile's existing owner grant and bounded project, without tool capture.
Jira is the only live reader. The Slack reader port, `PersonSlackReaderV1`, has
no implementation, and read status is not exposed to clients.

The dispatcher must preserve [ADR-0024](../decisions/ADR-0024-person-list-open-and-mine-scope.md)
scope rules: `mine` excludes live external reads. Provider selection and
bindings are server-owned. Project/channel mappings and any provider-specific
retention rules require their own implementation decisions rather than being
inferred from this generic interface.
