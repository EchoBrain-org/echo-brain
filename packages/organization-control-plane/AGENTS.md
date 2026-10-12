# Organization control-plane contributor instructions

Read `README.md` and
`../../docs/architecture/organization-control-plane.md` before changing this
workspace.

The minimum-v1 schema is closed by default:

- Do not add speculative persisted state.
- A new table, column, enum branch, index, or trigger must implement a named
  externally observable milestone behavior and include a failing-then-passing
  behavior test in the same change.
- Every schema shape change must update the pinned baseline and schema
  digests in `test/control-plane-baseline.test.ts`, and the change must name
  the behavior each new table serves.
- Explain why an existing table or non-persistent implementation cannot
  support the behavior.
- “Future-proofing,” “enterprise readiness,” and possible later use are not
  sufficient reasons.

Authority remains the sole principal, membership, role, installation, and
revocation source. Do not add local membership mirrors without an explicitly
approved offline-authorization milestone.

Do not persist provider tokens, authorization codes, raw OAuth state/nonce/PKCE
material, product meetings, transcripts, or decisions. SQLite may store only
opaque customer secret-store handles.

Groups, quorum, candidate snapshots, projections, authorization receipts,
service workloads, signing delegation, recovery epochs, HA, and offline
authorization are deferred. Do not implement them unless a later accepted
milestone explicitly requires their observable behavior.
