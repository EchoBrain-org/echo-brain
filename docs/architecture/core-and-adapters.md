# Core and adapter architecture

**Status:** Current

ECHO has a provider-neutral processing core surrounded by replaceable server
adapters. Vendors may shape transport and mapping, but never canonical records
or processing rules.

## Dependency direction

```text
provider API -> server adapter -> processing contracts <- processing cycle
                                           ^                 |
                                           |                 v
                                  Authority composition -> durable server state
```

- `services/organization-authority/src/processing/core/` imports no adapters,
  vendor SDKs, Authority composition, or persistence implementation.
- `processing/adapters/` implement typed core ports and own provider transport.
- `processing/storage/` owns Authority processing durability.
- `processing/live/` composes one bounded server cycle.
- Authority composition selects concrete adapters, credentials, organization
  policy, and stores.

`npm run check:boundary` enforces these rules for every owned source file, not
only today's entry-point closure. Processing tests live beside the Authority;
cross-workspace checks remain under `tests/integration/`.

## Canonical flow

```text
meeting source
  -> canonical meeting revision
  -> decision processor
  -> canonical signals and evidence
  -> exact approval snapshot
  -> delivery surface
  -> acknowledged delivery receipt
```

The server owns source cursors, processing state, pending approvals, delivery
receipts, and organization-record submission. The Person client owns none of
that state and cannot load provider adapters.

## Typed capabilities

- A **meeting source** pulls changed meetings and returns canonical documents
  plus an opaque cursor.
- A **decision processor** turns one canonical revision into decisions,
  actions, rationales, and source-linked evidence.
- An **approval surface** presents the exact staged brief and records an
  explicit human outcome.
- A **delivery surface** publishes an approved destination-neutral envelope
  and returns a provider receipt.

Approval and delivery remain separate capabilities even when they share a
provider or channel.

## Cross-capability invariants

- Source identity includes adapter, instance, external ID, and revision.
  Processing identity also includes processor adapter, instance, and version.
- Repeating the same source, processing, approval, or delivery operation is
  idempotent.
- A cursor returns only to the exact source instance and version that issued
  it.
- Pending approval pins its source revision and staged brief.
- Delivery uses the stored approved snapshot, never regenerated content.
- Provider acknowledgement is required before success is recorded.
- Unknown remote outcomes remain unknown and retry conservatively.
- Authentication, invalid input, rejection, rate limiting, temporary failure,
  and unknown outcome remain distinguishable.
- Calls are bounded and cancellable.
- Only explicit permanent rejection becomes a dead letter.

## Adapter responsibilities

Each adapter must:

- state the strongest provider account or tenant identity it can prove;
- keep credentials out of URLs, records, logs, and Person responses;
- refuse redirects where they could cross an authentication boundary;
- validate success bodies rather than trusting HTTP status alone;
- map available facts without inventing missing portable data;
- preserve source revisions and exact evidence locations; and
- define retry, crash, concurrency, and reconciliation behavior.

The bundled `llm` decision processor owns one canonical prompt/output/evidence
contract. Its Ollama, OpenAI, Anthropic, and OpenRouter drivers own only
provider authentication, wire translation, capability checks, response
extraction, and error normalization.

Slack approval and delivery adapters share a narrow transport but retain
separate authorization, idempotency, and receipt semantics. Slack actors are
tenant-namespaced `(team_id, user_id)` subjects, never bare user IDs.

## Extension rule

A new integration begins as a typed capability, not a generic plugin. It keeps
vendor types behind its adapter boundary, declares identity and failure
semantics, supplies deterministic fakes, and passes capability-level tests.
The processing core must still compile and test when that adapter is absent.
