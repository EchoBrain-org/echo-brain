# Organization authority decisions

**Status:** Accepted boundaries and promoted onboarding/access protocols; no organization runtime accepted

This register records the choices approved for the N=2/org=1 onboarding/access
slice. A changed choice requires an explicit superseding decision.

1. **ADR-OA-001:** The first central authority serves exactly one organization; multi-organization tenancy is a separate later phase.
2. **ADR-OA-002:** The existing root package remains the installation-local Echo Brain product, while shared contracts and the central deployable use npm workspaces in the same repository.
3. **ADR-OA-003:** Portable canonicalization, public-key descriptors, signature profiles, and signed-document verification belong to `federation-protocol`, which has no product or service dependency.
4. **ADR-OA-004:** Signed organization trust documents and ordinary transport contracts remain separate; `organization-protocol` and `organization-api` reserve those ownership boundaries without selecting a transport, specification format, or code generator.
5. **ADR-OA-005:** Local organization integration lives under `src/product/organization`, outside `src/core`; the Brain receives verified permission output rather than owning organization authorization.
6. **ADR-OA-006:** The organization authority is one modular service with inward-pointing domain, application, adapter, presentation, and composition layers, not a set of microservices.
7. **ADR-OA-007:** A central presentation may provide organization administration and join landing/context, but the local installation owns its private key, signs its enrollment material, and verifies and stores the authority result; rendering and transport implementations remain deferred.
8. **ADR-OA-008:** Stable source never imports `src/experimental/n2`; the pilot remains frozen through the onboarding/access slice and until the later organization-ingest and batch-receipt parity gate passes.
9. **ADR-OA-009:** Central authority persistence and installation-local organization state are separate ownership boundaries; exact records, tables, counts, migrations, and persistence providers remain deferred.
10. **ADR-OA-010:** The live N=2/org=1 onboarding/access and revocation gate passes before the reasoning Brain is integrated behind the federation permission gate; a separate later ingest-and-receipt gate is required before claiming full parity with the experimental pilot.
11. **ADR-OA-011:** Stable enrollment is self-contained: the request carries the installation public signing key and binds the exact pinned authority key; product-local identity-manifest and publication-policy evidence is deferred to the later ingest registration protocol rather than copied from the experiment.
12. **ADR-OA-012:** Current installation access is an authority-signed, per-enrollment monotonic state. Active state is a caller-policy-bounded lease that fails closed on expiry; revoked state is terminal. Administrative transition/audit documents remain a separate deferred contract.
13. **ADR-OA-013:** Organization cryptographic operations require a process-local pinned-authority handle created by comparing the descriptor with an independently authenticated digest. The handle is never serialized or copied; each process reconstructs it from separately retained descriptor and pin inputs.

The federation protocol implements ADR-OA-003, and the organization protocol
implements ADR-OA-004, ADR-OA-011, and ADR-OA-012 with frozen compatibility
vectors and strict JSON Schemas; its downstream API also implements ADR-OA-013.
No organization migration, endpoint, transport specification, generated client,
authentication provider, persistence provider, private-key implementation, or
UI behavior is accepted yet.
