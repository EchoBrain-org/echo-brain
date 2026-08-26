---
schema_version: 1
id: QMAT-CI-EFFICIENCY-V1-001
kind: qualification-matrix
title: Authority CI efficiency V1 measurement matrix
component_ids:
  - CMP-OPERATIONS-RELEASE
created_at: 2026-08-26
reviewed_at: 2026-08-26
reviewed_ref: 67830de61dc3afcf5bcc0cabfdf803d5e6604ec2
matrix_version: 1
assertion_ids:
  - CIEFFV1-001
  - CIEFFV1-002
  - CIEFFV1-003
  - CIEFFV1-004
  - CIEFFV1-005
---

# Authority CI efficiency V1 measurement matrix

## Scope and non-claims

This matrix measures the Authority CI proof on one temporary, non-merged
workflow revision. It does not qualify a production artifact, enable a release,
or change the permanent workflow. It separates runner and BuildKit-cache effects
by holding the source, proof graph, and Authority inputs constant within each
cohort.

| Assertion ID | Assertion |
| --- | --- |
| `CIEFFV1-001` | Five successful x86/QEMU and five successful native-ARM runs complete the same Authority proof with BuildKit cache disabled. |
| `CIEFFV1-002` | The native-ARM five-run Authority-job median is faster than the x86/QEMU median. |
| `CIEFFV1-003` | Five native cold-cache runs use distinct scopes; one successful writer then primes one separate warm scope before five read-only warm-cache runs. |
| `CIEFFV1-004` | The native warm-cache five-run Authority-job median is at least 10 percent lower than the native cold-cache median without a reliability failure. |
| `CIEFFV1-005` | Every measured run retains the full shared check, Person package, Authority image/runtime proof, and aggregate required-check result; the native median active critical path is at or below 185 seconds. |
