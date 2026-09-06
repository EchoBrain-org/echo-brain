# Federation protocol fixtures

`signed-document-p256-rfc8785.v1.json` is the immutable compatibility vector for
the first promoted protocol profile. It includes the logical payload, exact
canonical UTF-8 bytes, SHA-256 digests, a fixed P-256 public key, both low-S and
high-S forms of one signature, an alternate P-256 key-binding attack vector, a
wrong-curve descriptor vector, and the RFC 8785 UTF-16 key ordering example. Its
`signed_document` and `canonical_signed_document_*` fields are the frozen vector
of the generic signed-document layer retired on 2026-09-06; they stay in the
file unchanged and no test reads them.

The private key is intentionally absent. Tests verify the fixed signature with
the public key. Changing an expected byte requires an explicit protocol-version
decision, not a fixture refresh.
