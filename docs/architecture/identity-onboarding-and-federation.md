# Identity, onboarding, and federation

**Status:** Founder Live architecture accepted; N=2 direction proposed

Echo uses local processing with durable organization attribution. The local
installation keeps credentials and raw source data, runs the core, freezes facts
when they become knowable, and signs approved records. A future organization
authority owns shared membership, revocation, and ingest acceptance.

```text
employee installation
  -> signed approved-record outbox
  -> organization authority
  -> accepted organization records
```

Federation wraps existing local records. It never rewrites their processing
keys, approval IDs, delivery idempotency keys or semantics, or evidence.

## Durable identity choices

- Organization, principal, membership, device, installation, provider
  connection, and adapter binding are distinct concepts.
- Principal represents the person; membership represents one tenure.
- Installation is the signing and revocation unit. Replacement machines receive
  new installation identities and keys.
- Credentials are not identities. A connection represents a provider account or
  tenant; a binding represents one product capability using it.
- Adapter instance names are local routing labels, not provider identities.
- Meeting participants remain source observations until explicitly resolved.

One local state root represents one organization enrollment and one active
installation profile while retaining immutable history.

## Evidence and assurance

Identity claims are namespaced by issuer, tenant, and subject and carry their
verification method and assurance. Display names, email addresses, token
possession, and unscoped provider IDs are not canonical identity.

Slack actors are workspace-scoped. Granola records only the strongest account
identity its API can prove. Future OIDC fits the same claim model without
upgrading the assurance of older records.

Facts are captured at the moment they exist:

- Source attribution when a meeting revision is observed.
- Processor, model, prompt/configuration, and output attribution at extraction.
- Candidate, policy, and intended surface at approval request.
- Exact presentation and provider connection at publication.
- Namespaced actor, reason, and assurance at resolution.

They are never inferred later from whichever account, model, or policy happens
to be current.

## Signed record boundary

Each approved signal becomes one immutable signed envelope containing bounded
evidence, attribution, approval, and publication policy. Raw provider payloads,
credentials, complete transcripts, and sibling signal bodies stay outside.

The append-only local outbox is the source of records awaiting organization
ingest. Per-installation sequencing and hash chaining make gaps, forks, and
clones detectable when compared with a trusted external head, independent
export, or organization receipt. Exports are repeatable verification artifacts,
not proof of server acceptance.

A `DeliveryReceipt` proves output reached a delivery surface. An
`OrgIngestReceipt` proves a real organization authority accepted or rejected a
record. They remain separate and never mutate the approved envelope.

## Cutover and lifecycle

Pre-cutover and structurally incomplete records are `disposable_test` or, when
already delivered, `legacy_imported_unverified`. They are never promoted, and
neither enters the federated outbox or organization brain. Seed-grade records
require a green strict identity check and a protected, verified independent copy
of the signed outbox until central ingest exists.

Departure ends the membership and revokes its installations and employee-owned
connections as appropriate. A lost device revokes only that installation.
Neither erases history. Rehire creates a new membership. Account changes create
a new connection, bindings, source instance, and cursor lineage unless the
provider proves continuity.

## N=2 direction

The proposed next step is deliberately small: one organization authority, one
database, one enrollment challenge, one local uploader, signed ingest receipts,
and enforced membership and installation revocation. It reuses the current
manifests, envelopes, signatures, outbox, and verification rules.

IdP integration, SCIM, general IAM, admin dashboards, distributed services,
participant resolution, raw-transcript sync, search, and the LLM brain remain
outside that slice. New defensive machinery must protect a non-backfillable
fact, prevent an unauthorized external effect, or cover a qualification failure;
otherwise it waits.

The accepted decision register is
[Founder identity decisions](../decisions/founder-identity-decisions.md).
