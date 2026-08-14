# Failure-pattern registry

A failure pattern is a reusable explanation of how a system or trust boundary
can fail. It is not a raw incident transcript and not an unresolved-work list.

## Origin and evidence

| Origin | Meaning |
| --- | --- |
| `live` | Discovered against a real provider or live ECHO boundary |
| `test` | Discovered in deterministic automated or manual testing |
| `review` | Discovered through design, code, security, or adversarial review |

Record evidence strength separately as `hypothesized`, `scenario-defined`,
`reproduced`, or `observed-live`. Review findings must not be presented as
reproduced bugs merely because a plausible scenario exists.

Correct fail-closed behavior belongs in an invariant and qualification
assertion, not in the failure registry. This keeps controls such as rejecting
the wrong human actor from looking like defects requiring mitigation.

## Status

| Status | Meaning |
| --- | --- |
| `observed` | Confirmed and not yet prevented |
| `mitigating` | Repair exists but required proof is incomplete |
| `mitigated` | Repair and linked regression or qualification proof exist |
| `accepted-risk` | Explicitly accepted residual risk with decision and review date |
| `retired` | Boundary no longer exists; history remains searchable |

## Index

The private founder-live adapter qualification ledger seeded these sanitized
records. Its source-custody trap is represented by `INV-PERMISSIONS-014` and
the `ADP-A01` negative qualification case because the observed behavior was a
correct rejection, not a product failure. Raw provider payloads, credentials,
private infrastructure identifiers, and meeting content were not copied.

| ID | Failure mode | Status |
| --- | --- | --- |
| [`FP-ADAPTERS-001`](FP-ADAPTERS-001-provider-transport-fidelity.md) | Provider success envelope hides a wire-contract mismatch | mitigating |
| [`FP-IDENTITY-001`](FP-IDENTITY-001-asymmetric-provider-proof.md) | Enrollment and authorization derive different provider identities | mitigating |
| [`FP-ADAPTERS-002`](FP-ADAPTERS-002-acknowledgement-not-stored-state.md) | Provider acknowledgement differs from stored state | mitigating |
| [`FP-RUNTIME-001`](FP-RUNTIME-001-followup-outlives-cycle.md) | Durable resolution is not followed by a fresh bounded sweep | mitigating |
| [`FP-PERMISSIONS-001`](FP-PERMISSIONS-001-current-config-reinterprets-pending-work.md) | Current configuration reinterprets frozen pending work | mitigating |
| [`FP-ADAPTERS-003`](FP-ADAPTERS-003-model-execution-channel.md) | Model spends the output budget outside the visible answer channel | mitigating |
| [`FP-ADAPTERS-004`](FP-ADAPTERS-004-model-authors-evidence.md) | Model is required to reproduce evidence bytes | mitigating |
| [`FP-IDENTITY-002`](FP-IDENTITY-002-unversioned-lease-change.md) | Lease duration changes without protocol negotiation | mitigating |
| [`FP-IDENTITY-003`](FP-IDENTITY-003-revocation-window-overclaim.md) | Central revocation is described as immediate on an offline Mac | mitigating |
| [`FP-IDENTITY-004`](FP-IDENTITY-004-blind-identity-backfill.md) | Missing provider identity is repaired by blind backfill | mitigating |
| [`FP-RELEASE-001`](FP-RELEASE-001-wrong-worktree-artifact.md) | Packaging builds a different worktree than the claimed source | observed |
| [`FP-OPERATIONS-001`](FP-OPERATIONS-001-stale-shared-namespace.md) | Dependency restart leaves a proxy in a stale shared namespace | mitigating |

Use the [failure-pattern template](../_templates/failure-pattern.md). A
`mitigated` pattern must link at least one deterministic regression test or
exact qualification assertion. An `accepted-risk` pattern must link the risk
decision, state the residual risk, and name its next review date.
