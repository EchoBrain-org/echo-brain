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

The private founder-live adapter qualification ledger is the seed source for
this registry. Its reusable patterns will be converted into sanitized
`FP-ADAPTER-*`, `FP-IDENTITY-*`, `FP-RUNTIME-*`, and `FP-RELEASE-*` records.
Raw provider payloads, credentials, private infrastructure identifiers, and
meeting content will not be copied.

Use the [failure-pattern template](../_templates/failure-pattern.md). A
`mitigated` pattern must link at least one deterministic regression test or
exact qualification assertion. An `accepted-risk` pattern must link the risk
decision, state the residual risk, and name its next review date.
