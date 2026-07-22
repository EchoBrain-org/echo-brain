# Organization authority decisions

**Status:** Phase 4 onboarding/access runtime accepted; Phase 5 one-machine
rehearsal accepted as non-qualifying evidence; physical gate pending

This register records the choices approved for the N=2/org=1 onboarding/access
slice. A changed choice requires an explicit superseding decision.

1. **ADR-OA-001:** The first central authority serves exactly one organization; multi-organization tenancy is a separate later phase.
2. **ADR-OA-002:** The existing root package remains the installation-local Echo Brain product, while shared contracts and the central deployable use npm workspaces in the same repository.
3. **ADR-OA-003:** Portable canonicalization, public-key descriptors, signature profiles, and signed-document verification belong to `federation-protocol`, which has no product or service dependency.
4. **ADR-OA-004:** Signed organization trust documents and ordinary transport contracts remain separate; `organization-protocol` owns durable signed facts while `organization-api` owns transport DTOs and authenticated API commands.
5. **ADR-OA-005:** Local organization integration lives under `src/product/organization`, outside `src/core`; the Brain receives verified permission output rather than owning organization authorization.
6. **ADR-OA-006:** The organization authority is one modular service with inward-pointing domain, application, adapter, presentation, and composition layers, not a set of microservices.
7. **ADR-OA-007:** The central presentation provides narrow organization administration and onboarding HTTP routes, but the local installation owns its private key, signs its enrollment material, and verifies and stores the authority result; a polished UI remains deferred.
8. **ADR-OA-008:** Stable source never imports `src/experimental/n2`; the pilot remains frozen through the onboarding/access slice and until the later organization-ingest and batch-receipt parity gate passes.
9. **ADR-OA-009:** Central authority persistence and installation-local organization state are separate ownership boundaries. Phase 4 uses eight central SQLite tables and adds three organization tables to the existing installation SQLite database.
10. **ADR-OA-010:** The live N=2/org=1 onboarding/access and revocation gate passes before the reasoning Brain is integrated behind the federation permission gate; a separate later ingest-and-receipt gate is required before claiming full parity with the experimental pilot.
11. **ADR-OA-011:** Stable enrollment is self-contained: the request carries the installation public signing key and binds the exact pinned authority key; product-local identity-manifest and publication-policy evidence is deferred to the later ingest registration protocol rather than copied from the experiment.
12. **ADR-OA-012:** Current installation access is an authority-signed, per-enrollment monotonic state. Active state is a caller-policy-bounded lease that fails closed on expiry; revoked state is terminal. Administrative transition/audit documents remain a separate deferred contract.
13. **ADR-OA-013:** Organization cryptographic operations require a process-local pinned-authority handle created by comparing the descriptor with an independently authenticated digest. The handle is never serialized or copied; each process reconstructs it from separately retained descriptor and pin inputs.
14. **ADR-OA-014:** Access refresh is an installation-signed API command bound to the prior accepted state digest. Exact command retries return the exact prior result; stale heads do not advance authority sequence state.
15. **ADR-OA-015:** Enrollment grants are 32 random bytes, live for at most seven days, travel only in the enrollment authorization header, and are stored centrally only as SHA-256 digests. A grant is consumed once, with exact-request retry semantics.
16. **ADR-OA-016:** Active access leases last at most five minutes. The authority clock and local trusted-time high-watermarks are monotonic; clock rollback fails closed, and revoked access is terminal.
17. **ADR-OA-017:** The built-in authority HTTP server binds only to loopback behind an authenticated TLS terminator. Administrator mutations require a bearer token; bodies, headers, request age, and authenticated-client request rates are bounded. The proxy-origin and administrator credentials are distinct.
18. **ADR-OA-018:** The local product artifact bundles exactly `federation-protocol`, `organization-protocol`, and `organization-api` from its materialized commit. It never bundles the central authority deployable.
19. **ADR-OA-019:** Phase 4 includes only an explicitly enabled, 0600 development-file authority signer. Hosted key protection is implemented later through the existing signer port without changing domain or protocol code.
20. **ADR-OA-020:** The Phase 5 one-machine rehearsal is a closed, non-qualifying evidence lane. A valid report contains exactly 23 passing checks and five blocked target/physical checks, records `phase5_gate: incomplete`, and cannot waive or relabel those blocks. Phase 5 completes only with the same exact artifact bytes on two physical `darwin/arm64` installations using Secure Enclave keys, production authenticated TLS termination, and an independent authority-pin handoff.

The shared protocols retain frozen compatibility vectors and strict schemas.
The Phase 4 runtime now implements the narrow single-organization enrollment,
lease, and revocation path with SQLite adapters and bounded HTTP transport. It
does not accept multi-organization tenancy, a polished UI, Brain integration,
organization ingest, meetings, decisions, embeddings, or reasoning state.
