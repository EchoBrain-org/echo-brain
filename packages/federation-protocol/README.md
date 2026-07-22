# Federation protocol

**Status:** Accepted workspace boundary; no promoted implementation

This package will own the portable trust primitives that the local product and
organization authority must execute identically: canonical JSON, federation
identifiers, public installation-key descriptors, signature profiles, and
signed-document verification.

It owns no filesystem stores, private-key provider, macOS implementation,
database, HTTP transport, UI, or organization-specific workflow. Pure behavior
will be extracted from `src/product/federation/foundation/` only after golden
fixtures prove that the existing signed bytes and digests do not change.

The package has no workspace dependencies. `src/index.ts` is its only public
code entry point; internal modules will be added by responsibility rather than
through a general `shared` or `utils` directory.
