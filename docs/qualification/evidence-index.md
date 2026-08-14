---
schema_version: 1
id: EVID-INDEX-001
kind: evidence-index
title: Founder-live Job A and Job B sanitized evidence index
component_ids:
  - CMP-ADAPTERS
  - CMP-LOCAL-RUNTIME
  - CMP-CENTRAL-ORGANIZATION
  - CMP-IDENTITY-ACCESS
  - CMP-PERMISSIONS
  - CMP-OPERATIONS-RELEASE
created_at: 2026-08-13
reviewed_at: 2026-08-14
reviewed_ref: add08da02e98c6f3c6aaad71a07141c95887c93d
---

# Founder-live Job A and Job B sanitized evidence index

This index identifies private immutable evidence without disclosing its real
filename, path, storage key, infrastructure identifiers, provider identifiers,
or personal content. The resolver mapping remains in the founder-controlled
evidence system.

| Evidence ID | SHA-256 | Bounded purpose | Access class |
| --- | --- | --- | --- |
| `EVID-JOB-AB-LEDGER-001` | `a464f6b95b8d27fa90998652d68a9ee2cb3a5099ac85facaf098f2d2762cb4c8` | Sanitized private synthesis of 13 reusable traps and the initial adversarial matrix | founder-private |
| `EVID-JOB-A-STOPPED-001` | `dd64788ed7931f93842244c4989e10c5185f096b58b9cfb06e065cb8300da1e4` | Exact stopped-state record, audit, retrieval, recovery, and restart assertions | founder-private |
| `EVID-QWEN-OUTPUT-GAP-001` | `bbaa9e3159e53939fdd4664ee74f0c698175c1bf7bc1d07f93b437b3106c6cb2` | Real-model thinking-channel and empty-final-output observation | founder-private |
| `EVID-LLM-GROUNDING-RETRY-001` | `69ff87e5d252de501ca60da2a6fb48d0812dcf516497bb246ea80c4c44011eff` | Real-model grounding retry after byte-copy evidence failure | founder-private |
| `EVID-CANDIDATE-IDENTITY-001` | `f0debc1952d573040504e8daefe33507a3cf771e89fed0c0d412515a9436557b` | Candidate source and artifact identity receipt | founder-private |
| `EVID-ACTOR-SEPARATION-001` | `dc797e26643b3cc902007ec2cb618d429b7f6d71b01fc5264125780701ac38b5` | Negative human-actor/read assertion for the bounded permission mode | founder-private |
| `EVID-AUTHORITY-RESTART-001` | `4796bf2046fa9f476132875cbc4435f9f266064c088ad5317b483d5c1866fe23` | Focused Authority restart and topology evidence | founder-private |
| `EVID-JOB-B-ACTIVE-MEMBER-001` | `c75e10bf9ab58ecb97828a9771726c46935d035411f4cb18e0c2fe72e82a60dd` | Schema-V3 append, exact-head rebuild, active-owner read, cross-machine active-employee read, and central audit proof | founder-private |

## Verification rule

An evidence consumer with private access resolves the opaque ID, recalculates
SHA-256 over the exact bytes, and compares it with this index before reading
the assertions. A hash match proves byte identity, not the truth of assertions
outside that receipt's declared scope.

This index was verified on 2026-08-14 by the Codex founder-live qualification session.
