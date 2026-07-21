# Identity, onboarding, and federation

**Status:** Founder Live architecture accepted; experimental N=2 trust outcome pilot-qualified

Echo uses local processing with durable organization attribution. The local
installation keeps credentials and raw source data, runs the core, freezes facts
when they become knowable, and signs approved records. The organization
authority foundation owns shared membership, revocation, and ingest acceptance
when an installation is explicitly enrolled into it.

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
`OrganizationBatchReceipt` proves how a real organization authority disposed of
one exact ingest batch. They remain separate and never mutate an approved
envelope.

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

## N=2 pilot

The experimental N=2 prototype is deliberately small: one organization
authority, one-time invitation grants, installation-signed enrollment requests,
authority-signed enrollment receipts, manual batch handoff and receipt
acceptance, one signed receipt per atomic ingest batch, exact signed
publication-policy evaluation, and enforced membership and installation
revocation. It reuses the current manifests, policies, envelopes, signatures,
outbox, and verification rules without rewriting historical evidence.

The first registration protocol supports one exact manifest/key/policy epoch
per installation. Pending outbox history that refers to earlier key epochs or a
cross-manifest source/processor lineage remains locally verifiable but is not
yet centrally ingestible; upload fails closed until a future authority lineage
registration protocol can verify that closure. See
[Organization authority foundation](organization-authority-foundation.md).

IdP integration, SCIM, general IAM, admin dashboards, distributed services,
participant resolution, raw-transcript sync, search, and the LLM brain remain
outside that slice. New defensive machinery must protect a non-backfillable
fact, prevent an unauthorized external effect, or cover a qualification failure;
otherwise it waits.

The July 20, 2026 two-Mac walkthrough qualified the narrow trust outcome: both
installations advanced independently, revoking A stopped A, and B continued.
The walkthrough used the earlier wire format, so it is not evidence that the
later lean request and batch-receipt bytes ran on those machines. The bounded
evidence and protocol limits are recorded in
[Organization authority foundation](organization-authority-foundation.md).

The organization authority and installation keys remain ordinary development
files and artifact exchange remains manual. A synthetic record path exercises
enrollment, signed batch receipts, local cursor advancement, and
per-installation revocation without claiming that the normal product runtime
has adopted the employee identity. The exact ceremony is in the
[Manual N=2 pilot runbook](../runbooks/manual-n2-pilot.md).

The accepted decision register is
[Founder identity decisions](../decisions/founder-identity-decisions.md).
