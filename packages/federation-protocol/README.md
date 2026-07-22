# Federation protocol

**Status:** Promoted portable trust primitives

This package owns the portable trust primitives that the local product and
organization authority must execute identically:

- RFC 8785 canonical JSON bytes and SHA-256 digests;
- federation identifier and UTC timestamp validation;
- the ECDSA P-256 DER low-S signature profile and public-key fingerprints;
- public installation-key descriptor verification; and
- generic signed-document creation and verification.

The Node 22 API is deliberately OS-, deployment-, and key-provider-neutral; it
does not claim browser portability. A caller supplies signing bytes to its own
private-key provider, and this package never loads or stores a private key. The
frozen fixture exported at
`@echo-brain/federation-protocol/fixtures/signed-document-p256-rfc8785.v1.json`
fixes the canonical bytes, digests, key ID, signature encoding, and verification
behavior shared by every consumer.

Callers validate a capability-specific document schema before using the generic
integrity verifier. The verifier intentionally ignores unknown payload and
integrity fields so schema ownership remains with the protocol defining that
document. Descriptor protection and assurance fields are checked for internal
consistency but are metadata claims, not hardware attestation.

It owns no filesystem store, private-key provider, macOS implementation,
database, HTTP transport, UI, schema, or organization-specific document or
workflow. The root product remains on its compatibility implementation until a
later artifact-staging cutover can package this workspace dependency exactly.

The package has no workspace dependencies. `src/index.ts` is its only public
code entry point; modules are separated by protocol responsibility rather than
collected in a general `shared` or `utils` directory.

The federation package owns the global identifier-prefix registry. Reserving an
organization-related prefix there defines only its canonical identifier syntax;
it does not promote an organization document or workflow.
