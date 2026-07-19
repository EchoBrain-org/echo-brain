# Core and adapter architecture

Echo Brain is the tool-agnostic connection and processing layer between team
surfaces. Meeting tools, model providers, chat systems, project-management
tools, and engineering tools are replaceable adapters around a stable core.
No vendor defines the core domain model.

## Dependency direction

The dependency rule is one-way:

```text
external tool SDK / API
          |
          v
        adapter  --->  core contracts
                           ^
                           |
                    core orchestration
```

- `src/core/**` must never import `src/adapters/**` or a vendor SDK.
- Adapters may import core contracts and shared, vendor-neutral utilities.
- Adapters must not import or orchestrate sibling adapters.
- The composition root chooses adapter instances and supplies them to the core.
- Core tests use conforming fakes and contain no vendor identifiers.

This rule makes the core independently testable and keeps changing an external
tool from changing the processing pipeline.

## Canonical flow

```text
meeting-source adapter
  -> canonical meeting document and opaque cursor
  -> revision persistence and stabilization
  -> decision-processor adapter
  -> canonical decisions, actions, rationale, and evidence
  -> destination-neutral brief
  -> durable explicit approval of an exact brief snapshot
  -> delivery-surface adapter(s)
  -> durable delivery receipt(s)
```

The core owns the normalization contract, revision tracking, processing
eligibility, approval state, delivery orchestration, retry policy, storage,
provenance, and observability. An adapter owns authentication, its external API,
pagination, rate-limit handling, error translation, and the actual mapping from
its provider payload at the canonical boundary.

## Adapter contracts

All adapters share a small lifecycle vocabulary: stable adapter identity,
capability identity, configuration validation, and health reporting. They do
not share one vague `execute` operation. Each direction has a typed capability:

- A meeting-source adapter pulls changed meetings and returns canonical meeting
  documents plus an opaque continuation cursor.
- A decision-processor adapter transforms one canonical meeting revision into a
  canonical decision set with evidence.
- An approval-surface adapter presents the exact staged brief snapshot and
  returns an explicit approval decision without becoming a delivery surface.
- A delivery-surface adapter publishes an approved, destination-neutral
  delivery envelope and returns a delivery receipt.

The interfaces and canonical records live in `src/core/**`. Adapter packages
implement those contracts; they cannot extend the canonical record with fields
that the core must understand. Tool-specific values belong in bounded
`extensions`, bounded metadata, or adapter-owned configuration.

## Meeting-context baseline

The public contract is
[`schemas/meeting-context.v1.schema.json`](../../schemas/meeting-context.v1.schema.json)
and the matching TypeScript/runtime contract is `src/core/contracts/meeting.ts`.
The former narrow shape has been removed; there is no legacy union or ingress
migrator. The richer contract is the baseline `schema_version: 1`.

Every canonical meeting has the same small envelope:

```text
schema_version + id + provenance + capture
  + participants[] + content[] + artifacts[]
```

Title, description, lifecycle, time, normalized meeting context, governance,
and extensions are optional. Textual source material uses evidence-addressable
typed content blocks such as summary, note, agenda, transcript, caption, chat
message, chapter, provider action item/decision, artifact text, or other.
Provider decisions and action items remain source context—not Echo's extracted
outputs. Non-text source material uses artifact references. A processor must tolerate any valid combination,
including empty collections.

The common envelope does not mean every meeting tool supplies identical data.
It means every adapter reports what was available, unavailable, pending,
forbidden, or not provided without inventing missing source facts. An adapter
may retain uncommon provider data in `extensions`, but portable processors must
depend only on canonical fields.

Future project-management and engineering integrations should introduce typed
capability contracts for the operations they actually support. They should
reuse the common lifecycle, identity, provenance, idempotency, error, and health
shapes rather than being forced through a meeting or messaging interface.

## Configuration ownership

Core configuration identifies a capability, adapter, instance, credential
reference, and opaque adapter settings. The core may select and route an
adapter, but it must not understand concepts such as a workspace, Slack
channel, Granola note, Jira project, or GitHub repository.

- The adapter validates its own `settings` object.
- A host-level credential resolver turns a credential reference into runtime
  credentials; secrets are not persisted in canonical records.
- Destination identifiers remain opaque to the core.
- Cursor formats remain opaque to the core and are returned unchanged to the
  adapter instance that issued them.
- Tool names must not become top-level core configuration fields.

Configuration failures are detected before pipeline work begins and are
reported using the shared adapter error taxonomy.

## Identity, idempotency, and provenance

External identifiers are unique only inside their adapter instance. Canonical
source identity therefore includes the capability, adapter ID, instance ID,
external ID, and source revision. A processor run also records its adapter ID,
implementation version, input fingerprint, and canonical schema version.

The following invariants apply across every adapter:

1. Pulling the same source revision does not create a second canonical revision.
2. A changed source revision is preserved rather than mutating historical
   evidence.
3. Every extracted claim retains evidence that resolves to its exact source
   revision and location.
4. Processing the same input fingerprint with the same processor version is
   idempotent.
5. Delivery uses an idempotency key scoped to the approved artifact revision and
   destination instance.
6. A successful delivery stores the adapter's external receipt. A retry never
   fabricates success when the external outcome is unknown.
7. Authentication, rate limiting, invalid input, temporary availability, and
   permanent rejection remain distinguishable errors.
8. A pending approval pins the source cursor. Delivery uses the stored approved
   brief snapshot, never a newly generated retry artifact.
9. Decision caches are scoped to the full source adapter instance, external
   identity, source revision, and processor identity. Canonical IDs from two
   source adapters can never alias one another.
10. Opaque cursors are version-scoped. Upgrading an adapter implementation
    resets its cursor unless that adapter explicitly migrates the old format.
11. Each operation receives an `AbortSignal` and is wrapped in a host deadline.
    Ignoring cancellation cannot make the core or CLI wait forever.
12. Only an explicit, non-retryable rejected receipt is an artifact-level dead
    letter. Auth, config, transport, timeout, and unknown outcomes remain pinned
    even when an adapter reports that operator intervention is required.

## Folder rules

```text
src/
  core/
    contracts/                 canonical records and shared lifecycle shapes
    ports/                     typed adapter capabilities
    processing/                vendor-neutral pipeline logic
    approval/                  review and approval state
    delivery/                  publication orchestration and receipts
    storage/                   tool-neutral persistence port
    runtime/                   composition-independent lifecycle
  adapters/
    meeting-sources/
      <adapter-id>/
        index.ts               adapter's public entry point
    decision-processors/
      <adapter-id>/
        index.ts
    approval-surfaces/
      <adapter-id>/
        index.ts
    delivery-surfaces/
      <adapter-id>/
        index.ts
  product/
    paths.ts                    sole authority for configured product-state paths
  infrastructure/
    filesystem/
      atomic-write.ts           path-agnostic durable file replacement
```

An adapter directory may contain its API client, config parser, mapper, and
error translation. Only `index.ts` is public. Vendor SDK types must stop at the
adapter boundary. Shared logic graduates to the core only after it is expressed
entirely in canonical terms.

Infrastructure contains vendor-neutral mechanisms, not product or path policy.
Callers supply concrete destinations and security requirements to the atomic
writer. `state_dir`, resolved through `src/product/paths.ts`, is the sole
authority for current product state; product code must not discover an ambient
`ECHO_HOME`.

The Granola namespace exposes a canonical `MeetingSourceAdapter` bridge with
deterministic revisions, evidence-addressable blocks, opaque cursors,
configuration validation, health, and shared error classification. Its HTTP
client and provider types live directly under the Granola adapter
(`granola-api-client.ts` + `meeting-source-adapter.ts`). The top-level
`src/capture/**` and `src/enrich/**` architectures, and the Granola
raw-event compatibility surface, have been removed. Product code enters
Granola only through the canonical meeting-source adapter.

The package includes two vendor-neutral reference implementations:

- `structured-text` extracts only explicitly labeled decision, action, and
  rationale lines. It demonstrates the processor contract without pretending
  to provide semantic extraction.
- `jsonl-outbox` provides durable, idempotent local delivery. It demonstrates
  delivery receipt and retry behavior without becoming a team integration.

The bundled `slack` delivery surface is the first external team integration.
It consumes the same destination-neutral `DeliveryEnvelope`, renders an
approved brief for one configured Slack channel, and returns the acknowledged
channel/message identity in a canonical `DeliveryReceipt`. Its configuration,
rendering, state, and behavior remain independent from the `slack-reactions`
approval surface; the two share only capability-neutral Slack HTTP plumbing.
Confirmed deliveries replay from durable idempotency state across retries and
restarts. A timeout or crash that makes the remote outcome ambiguous is pinned
as unknown and is not automatically posted again.

## Conformance requirements

Each adapter capability gets a shared conformance suite. A real adapter and its
test fake must pass the same contract fixtures. At minimum, the suite verifies:

- stable identity and declared capability;
- valid and invalid configuration without exposing secrets;
- healthy, degraded, unavailable, and unauthorized health outcomes;
- canonical mapping with stable external identity and source revision;
- duplicate calls and retry idempotency;
- opaque cursor or destination round trips;
- provenance and evidence preservation;
- rate-limit and transient-failure classification;
- bounded retries, cancellation, and timeouts;
- no vendor-shaped values leaking into canonical required fields.

The core end-to-end suite uses only fakes for meeting input, processing, and
delivery. A vendor-specific end-to-end test is an adapter qualification
test, not a core test.

## Extension checklists

### Meeting source

- State the strongest account/tenant identity this provider's API can prove,
  and the assurance recorded when it cannot.
- Map every available source component into canonical context blocks, artifacts,
  participants, time, and context without fabricating absent values.
- Report capture coverage explicitly, including empty, pending, forbidden,
  failed, and not-provided components.
- Define a deterministic revision and stable external identity.
- Preserve speaker, participant, timestamp, and evidence locations when known.
- Implement incremental pull with an opaque cursor and safe first-run bounds.
- Translate authentication, pagination, timeout, and rate-limit failures.
- Honor the operation `AbortSignal`; do not keep network resources alive after
  the host abandons a pull.
- Pass the meeting-source conformance suite.

### Decision processor

- State the strongest account/tenant identity this provider's API can prove,
  and the assurance recorded when it cannot.
- Accept only canonical meeting documents, never a meeting-tool payload.
- Emit canonical decisions, actions, rationale, confidence, and evidence.
- Declare implementation and model version without making a provider core state.
- Make results repeatable by input fingerprint and processor version.
- Bound timeouts/retries and fail loudly on malformed output.
- Honor the operation `AbortSignal` and make late results disposable.
- Pass the decision-processor conformance suite.

### Approval surface

- State the strongest account/tenant identity this provider's API can prove,
  and the assurance recorded when it cannot.
- Present the exact first-staged brief and policy snapshot; never regenerate a
  pending approval from current source, processor, or policy state.
- Retain a stable provider publication reference and a digest of the exact
  rendered approval presentation.
- Resolve only an explicit, unambiguous action by an enrolled or allowlisted
  actor; incomplete rosters and conflicting actions remain pending.
- Namespace every approval actor by the provider tenant/account. For Slack,
  actor identity is at least `(team_id, user_id)` and never a bare user ID.
- Retain review time, reason, provider evidence, and identity assurance while
  keeping the existing `reviewed_by` field display-only.
- Remain independent from delivery even when approval and delivery share a
  provider connection or destination.
- Honor the operation `AbortSignal` and host timeout without turning an unknown
  provider outcome into an approval or rejection.
- Pass the shared adapter lifecycle conformance suite plus capability-specific
  approval fixtures.

### Delivery surface

- State the strongest account/tenant identity this provider's API can prove,
  and the assurance recorded when it cannot.
- Accept only approved, destination-neutral delivery envelopes.
- Keep channel/workspace/thread identifiers inside adapter-owned destinations.
- Honor the supplied idempotency key and return a durable external receipt.
- Distinguish rejection, unknown outcome, rate limiting, and temporary failure.
- Never mark an artifact delivered before external acknowledgement.
- Honor the operation `AbortSignal`; retain idempotency when a timeout makes the
  external outcome unknown.
- Pass the delivery-surface conformance suite.

### Project-management surface

- State the strongest account/tenant identity this provider's API can prove,
  and the assurance recorded when it cannot.
- Start with a typed capability proposal (for example issue creation or status
  synchronization); do not overload the delivery-surface interface.
- Define canonical command and receipt shapes without tool-specific fields.
- Specify conflict, update, and reconciliation semantics before implementation.
- Reuse common identity, provenance, idempotency, health, and error contracts.
- Add a capability conformance suite before adding a vendor adapter.

### Engineering surface

- State the strongest account/tenant identity this provider's API can prove,
  and the assurance recorded when it cannot.
- Define the precise capability (for example change reference, build status, or
  deployment observation) rather than a generic engineering adapter.
- Separate read observations from state-changing commands.
- Preserve repository, revision, and external evidence as opaque references.
- Specify authorization and human-approval boundaries for mutating operations.
- Reuse the shared lifecycle and add capability-specific conformance tests.

### Review gate for every new adapter

- The core compiles and tests with the adapter directory removed.
- The adapter imports core contracts; the core does not import the adapter.
- Tool-specific configuration and SDK types do not cross the boundary.
- Identity, revision, evidence, retry, and delivery semantics are explicit.
- A conforming fake exists and the shared capability suite passes.
- The adapter is selected only at the composition root or registry boundary.
