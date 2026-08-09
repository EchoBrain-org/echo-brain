# Organization protocol fixtures

`onboarding-access-chain.v1.json` freezes one complete authority descriptor,
installation-signed request, authority-signed receipt, active lease, and
terminal revocation. It records the exact canonical payload/document bytes and
digests used by both sides of the trust boundary.

`organization-record-chain.v1.json` freezes one approval envelope, one
rejection envelope, and the authority-signed receipt for each, with the exact
canonical payload/document bytes and digests. The frozen document digest of an
envelope is the same value its receipt carries as `envelope_sha256`, so the
member and authority sides cannot drift on what "the exact envelope" means.

`organization-record-payload-conformance.v1.json` is the shared pin between
this package's payload contract and core's `DecisionBrief` validator. Core
imports no packages, so this data — not shared code — is what keeps the two
restatements in agreement. Every `valid` case must pass both validators and
every `invalid` case must fail both. `record_only_invalid` enumerates the
deliberate divergence: cases the record contract rejects and core accepts, each
carrying `core_accepts: true`. Both suites assert their half, so tightening
core there fails this fixture rather than drifting silently. The record JSON
Schemas are held to the subset of cases that are wire-shape violations;
cross-signal rules, real-calendar timestamps, and id-level participant
uniqueness stay validator work.

The fixtures contain public keys and signatures only. They contain no private
key, bearer grant, transport DTO, or database representation.
