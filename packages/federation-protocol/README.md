# Federation protocol

**Status:** Promoted portable trust primitives

This package owns portable trust primitives shared by the organization
Authority, protocol workspaces, and retained V1 compatibility validators:

- RFC 8785 canonical JSON bytes and SHA-256 digests;
- federation identifier and UTC timestamp validation;
- the ECDSA P-256 DER low-S signature profile, strict DER compatibility
  encode/decode helpers, and fingerprints over canonical uncompressed
  named-curve SPKI public keys; and
- public installation-key descriptor verification.

The Node 22 API is deliberately OS-, deployment-, and key-provider-neutral; it
does not claim browser portability. This package never loads or stores a
private key. The frozen fixture exported at
`@echo-brain/federation-protocol/fixtures/signed-document-p256-rfc8785.v1.json`
fixes the canonical bytes, digests, key ID, and signature encoding shared by
every consumer.

The generic signed-document creation and verification layer was retired on
2026-09-06; no workspace consumed it. `organization-protocol` owns the signed
receipt and record-envelope documents built on the primitives above, and each
protocol validates its own document schema. Descriptor protection and assurance
fields are checked for internal consistency but are metadata claims, not
hardware attestation.

It owns no filesystem store, private-key provider, macOS implementation,
database, HTTP transport, UI, schema, or organization-specific document or
workflow. The repository root has no runtime exports. Private-key lifecycle
and capability-specific behavior belong to the Authority or to the protocol
consumer that uses these primitives. Installation-key helpers remain only for
server-side V1 compatibility; the Person client has no installation signer.

The package has no workspace dependencies. `src/index.ts` is its only public
code entry point; modules are separated by protocol responsibility rather than
collected in a general `shared` or `utils` directory.

The federation package owns the global identifier-prefix registry. Reserving an
organization-related prefix there defines only its canonical identifier syntax;
it does not promote an organization document or workflow.
