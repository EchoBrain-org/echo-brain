# Core and adapter architecture

**Status:** Current

Echo Brain has a tool-neutral core surrounded by replaceable adapters. Vendors
may shape an adapter, but never the product's canonical records or processing
rules.

## Dependency direction

```text
provider API -> adapter -> core contracts <- core orchestration
                    |                 ^
                    v                 |
         narrow infrastructure   product composition
                                      |
                 machine ports + local stores + retirement fence
```

- Core never imports adapters or vendor SDKs.
- Adapters implement core ports and do not orchestrate sibling adapters.
- Product composition selects concrete adapters, credentials, and stores.
- Core tests use vendor-neutral fakes.

These directions are executable policy, not naming conventions:

- `src/core/**` may import only core.
- `src/adapters/**` may import adapters, core contracts, and specifically
  declared infrastructure primitives.
- `src/infrastructure/**` is product-independent.
- `src/product/storage/**` implements core ports over narrow infrastructure.
- `src/product/machine/**` owns operating-system and installation-bound
  capabilities such as the private-key lifecycle.
- `src/product/update/**` owns internal-live release application.
- Local organization code receives the machine signer port and product database
  opener; portable trust primitives come from the shared
  `@echo-brain/federation-protocol` workspace, and no product-local federation
  implementation exists to import.

`npm run check:boundary` enforces these rules. Test directories mirror the same
ownership, with deliberate crossings confined to `tests/integration/`.
Every root layer rule independently allowlists relative imports, runtime
packages, and Node builtins; a dependency being available to the overall
product does not make it available to core, adapters, infrastructure, storage,
or machine code. Local organization also has its own non-workspace
source-boundary manifest.

## Canonical flow

```text
meeting source
  -> canonical meeting revision
  -> decision processor
  -> canonical decisions, actions, rationales, and evidence
  -> exact approval snapshot
  -> delivery surface
  -> delivery receipt
```

Core owns the canonical records, pipeline semantics, and persistence ports.
Product owns concrete durable state, approval history, local identity and the
retired-founder cutover fence, and runtime lifecycle. Adapters own provider authentication, API behavior,
mapping, pagination, and error translation.

## Typed capabilities

- A **meeting source** pulls changed meetings and returns canonical meeting
  documents plus an opaque cursor.
- A **decision processor** turns one canonical meeting revision into a canonical
  decision set with evidence.
- An **approval surface** presents the exact staged brief and records an explicit
  human decision.
- A **delivery surface** publishes an approved, destination-neutral envelope and
  returns a receipt.

Approval and delivery are separate capabilities even when they use the same
provider, connection, or channel.

## Canonical boundary

Canonical contracts live under `src/core`. Provider-specific values stay in
adapter configuration or bounded extensions. Missing provider facts remain
missing; adapters never invent portable data.

Every extracted claim retains evidence resolving to an exact meeting revision
and source location. Source revisions are preserved rather than overwritten.
Processor identity and input fingerprint make extraction repeatable and
auditable.

Host configuration may select adapters, but core does not understand provider
concepts such as workspaces, channels, notes, projects, or repositories.
Cursors, destinations, and adapter settings remain opaque outside their owning
adapter.

## Cross-capability invariants

- Canonical source identity includes capability, adapter, instance, external ID,
  and source revision. Processing identity additionally includes processor
  adapter, instance, and version. Durable provider identity comes from
  connection, tenant, and account evidence.
- Repeating the same source, processing, approval, or delivery operation is
  idempotent.
- An opaque cursor returns only to the source instance and version that issued
  it; version changes reset it unless that adapter explicitly migrates it.
- Pending approval pins source progress and always refers to its original brief.
- Delivery uses the stored approved snapshot, never regenerated content.
- Provider acknowledgement is required before a delivery is called successful.
- Unknown remote outcomes remain unknown and retry conservatively.
- Authentication, invalid input, rejection, rate limiting, temporary failure,
  and unknown outcome stay distinguishable.
- Calls are bounded and cancellable.
- Only explicit permanent rejection becomes a dead letter.

## Capability checklists

### Meeting source

- State the strongest provider account or tenant identity the API can prove and
  the assurance recorded when it cannot.
- Define stable source identity, deterministic revisions, and an opaque cursor.
- Map available material without fabricating unavailable content.
- Preserve participants, speakers, timestamps, and evidence locations when
  known.

### Decision processor

- State the strongest provider account or tenant identity the API can prove and
  the assurance recorded when it cannot.
- Accept only canonical meetings and emit only canonical signals with evidence.
- Declare processor identity and, when model-backed, model and
  prompt/configuration version, so runtime records can distinguish which
  processor produced a result. The retired standalone processor-attribution
  wire contract and schema are not part of the minimum product.
- Reject malformed output and bound retries and execution time.

The bundled `llm` processor is one semantic adapter with narrow provider
drivers. The shared processor owns the prompt, canonical structured-output
schema, parsing, decision validation, and verbatim evidence gate. Ollama,
OpenAI, Anthropic, and OpenRouter drivers own only authentication, wire-format
translation, model capability checks, response extraction, and error
normalization. A provider driver must not weaken or specialize the semantic
prompt or evidence rules for an individual vendor or model.

### Approval surface

- State the strongest provider account or tenant identity the API can prove and
  the assurance recorded when it cannot.
- Present and resolve the exact staged snapshot; never regenerate it.
- Record the presentation, provider reference, actor, reason, and observation.
- Resolve only an explicit, unambiguous action by an enrolled or allowlisted
  actor; missing or conflicting provider observations remain pending.
- Namespace actors by provider tenant. Slack actors are at least
  `(team_id, user_id)`, never a bare user ID.
- Treat reviewer labels as display-only; the authoritative actor is the
  tenant-namespaced provider subject with captured assurance.
- Remain independent from delivery.

### Delivery surface

- State the strongest provider account or tenant identity the API can prove and
  the assurance recorded when it cannot.
- Accept only approved destination-neutral envelopes.
- Keep provider destinations adapter-owned.
- Honor idempotency and retain acknowledged external receipts.
- Distinguish rejection, retryable failure, and unknown outcome.

## Extension rule

A new integration begins as a typed capability, not a generic adapter. It must
keep vendor types behind its boundary, declare identity and failure semantics,
provide a conforming fake, and pass capability-level contract tests. The core
must still compile and test when that adapter is removed.
