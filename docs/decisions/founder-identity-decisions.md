# Founder identity decisions

**Status:** Accepted

This is the compact register for the approved Founder Live identity direction.
A changed choice requires an explicit superseding decision.

1. **ADR-FL-IDENTITY-001:** One Echo `state_dir` represents exactly one organization enrollment and one active installation profile, while retaining immutable historical installation manifests and chain heads.
2. **ADR-FL-IDENTITY-002:** Founder Live mints opaque immutable provisional organization, principal, membership, device, installation, connection, binding, claim, policy, event, and record IDs that a future control plane registers but never rewrites.
3. **ADR-FL-IDENTITY-003:** Principal and membership remain distinct identities even when their first records share one local manifest.
4. **ADR-FL-IDENTITY-004:** Device is a nested installation field for Founder Live, while installation remains the signing and revocation unit and replacement machines always receive new IDs and keys.
5. **ADR-FL-IDENTITY-005:** Each installation signs canonical bytes with the locked P-256/low-S profile and a device-bound key excluded from state, configuration, exports, and backups; every record states actual key-protection assurance.
6. **ADR-FL-IDENTITY-006:** Human identity claims are namespaced issuer/tenant/subject assertions with verification method and assurance; a Slack-originating challenge is `provider_challenge_observed`, while email, display name, token possession, and unnamespaced Slack IDs are never canonical identity.
7. **ADR-FL-IDENTITY-007:** `ToolConnection` and `AdapterBinding` remain distinct; provider/credential changes create explicit generations or new connections/bindings and new source-instance/cursor lineage rather than inheriting `instance_id` state.
8. **ADR-FL-IDENTITY-008:** Source and processor attribution are frozen respectively at meeting observation and decision extraction and cannot be inferred or replaced during approval/export.
9. **ADR-FL-IDENTITY-009:** Identity-enabled approval fails closed while the request freezes candidate/tool/policy context, publication freezes presentation, and resolution freezes namespaced actor/tool assurance, without changing approval IDs or `reviewed_by` semantics.
10. **ADR-FL-IDENTITY-010:** Each approved signal receives one immutable signed envelope around unchanged local IDs containing only that signal, meeting context, bounded evidence, and approval-group digests; raw meeting and sibling signal content are not copied into it.
11. **ADR-FL-IDENTITY-011:** The SQLite outbox is an append-only source of pending organization records with per-installation sequence/hash chaining; manual exports are repeatable and never imply server acceptance.
12. **ADR-FL-IDENTITY-012:** `DeliveryReceipt` and `OrganizationBatchReceipt` are separate outcomes, and no `OrganizationBatchReceipt` exists until a real organization authority issues it.
13. **ADR-FL-IDENTITY-013:** Meeting participants remain unresolved source observations during Founder Live; future resolutions are append-only central facts and never rewrite envelopes.
14. **ADR-FL-IDENTITY-014:** Pre-cutover and structurally incomplete records are disposable or explicitly `legacy_imported_unverified`/`founder_attested_retrospective`; Echo never upgrades them to native attribution.
15. **ADR-FL-IDENTITY-015 (approved amendment):** Seed-grade cutover and every record after it require both a green strict identity check and a protected, verified independent copy of the signed outbox until central ingest exists; disposable pre-cutover rehearsals do not.
16. **ADR-FL-IDENTITY-016:** Slack approval envelopes preserve publication and reaction-observation tool snapshots separately; different credential generations are permitted only when validation proves the same enrolled Slack workspace, connection, adapter identity and configuration, and provider identity.
17. **ADR-FL-IDENTITY-017:** A federated export includes the complete identity-manifest verification closure required by the export: every manifest referenced by an exported event or included signed policy, the manifest binding the key that signs the export manifest, and every transitive predecessor of those manifests. Files are stored under `identity-manifests/identity-manifest.<manifest_id>.v1.json`. Every manifest ID and digest reference must resolve to exactly one matching exported file; missing, conflicting, or unreferenced manifest artifacts fail verification. The closure is minimal and deterministic: duplicate IDs, one ID resolving to different digests, unrelated manifests, and non-deterministic artifact ordering are forbidden.

The current cutover does not promote retrospective founder attestations.
Pre-cutover records are only disposable or already-delivered unverified local
evidence, and neither enters the federated outbox.

The experimental N=2 trust outcome is pilot-qualified, but its protocol does
not amend the Founder Live decisions above.
