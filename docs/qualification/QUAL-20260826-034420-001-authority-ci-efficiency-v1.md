---
schema_version: 1
id: QUAL-20260826-034420-001
kind: qualification
title: Authority CI efficiency V1 measurement qualification
component_ids:
  - CMP-OPERATIONS-RELEASE
created_at: 2026-08-26
reviewed_at: 2026-08-26
reviewed_ref: 67830de61dc3afcf5bcc0cabfdf803d5e6604ec2
run_status: completed
result: passed
stop_reason: not-applicable
source_commit: 67830de61dc3afcf5bcc0cabfdf803d5e6604ec2
artifact_digest: not-applicable
configuration_identity: opaque:CI-EFFICIENCY-MEASUREMENT-20260826-001
state_identity: not-applicable
started_at: 2026-08-26T03:10:38Z
completed_at: 2026-08-26T03:44:20Z
matrix_id: QMAT-CI-EFFICIENCY-V1-001
matrix_version: 1
assertion_ids:
  - CIEFFV1-001
  - CIEFFV1-002
  - CIEFFV1-003
  - CIEFFV1-004
  - CIEFFV1-005
evidence_ids:
  - EVID-CI-EFFICIENCY-20260826-001
---

# Authority CI efficiency V1 measurement qualification

## Scope, identities, and preconditions

All measured workflows used source and workflow revision
`67830de61dc3afcf5bcc0cabfdf803d5e6604ec2`, an unmerged temporary branch
based on sprint revision `0d39fdc38c7d27cd7c59990386ff57492ca9af02`. The
temporary revision adds manual-dispatch controls only: runner selection and
cache mode/scope. It preserves the existing three proof jobs and the `CI
required checks` aggregate. It is evidence tooling only and must not merge into
the sprint branch.

The 20 measured workflows all completed successfully. One successful
native/no-cache smoke run preceded them, and one successful native cache-writer
run primed the shared warm scope. Neither control run is part of a median.
There were no cancelled, failed, or infrastructure-excluded measured runs.

The x86 label was `ubuntu-24.04` with the pinned ARM64 QEMU setup action. The
native label was `ubuntu-24.04-arm` without QEMU. All image builds targeted
`linux/arm64` and retained the Authority architecture, OCI revision, Node
version, runtime-profile, release-record, Compose/Caddy, synthetic reset,
in-container descriptor, HTTPS Caddy descriptor, and actual Person-client
proofs.

## Results

| Assertion | Outcome | Evidence |
| --- | --- | --- |
| `CIEFFV1-001` | passed | `EVID-CI-EFFICIENCY-20260826-001` |
| `CIEFFV1-002` | passed | `EVID-CI-EFFICIENCY-20260826-001` |
| `CIEFFV1-003` | passed | `EVID-CI-EFFICIENCY-20260826-001` |
| `CIEFFV1-004` | passed | `EVID-CI-EFFICIENCY-20260826-001` |
| `CIEFFV1-005` | passed | `EVID-CI-EFFICIENCY-20260826-001` |

`active critical path` is the longest duration among `check`, Person package,
and Authority container, plus `CI required checks`. `wall` is workflow
creation-to-completion time. `total runner` is the sum of the four job active
times. All durations are seconds.

| Cohort | Run | Runner label | Cache condition | Check | Person | Authority | Required | Active critical path | Wall | Total runner |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| QEMU | [32925466133](https://github.com/EchoBrain-org/echo-brain/actions/runs/32925466133) | `ubuntu-24.04` | off | 163 | 28 | 173 | 2 | 175 | 183 | 366 |
| QEMU | [32925692202](https://github.com/EchoBrain-org/echo-brain/actions/runs/32925692202) | `ubuntu-24.04` | off | 172 | 29 | 205 | 4 | 209 | 216 | 410 |
| QEMU | [32925999962](https://github.com/EchoBrain-org/echo-brain/actions/runs/32925999962) | `ubuntu-24.04` | off | 161 | 19 | 203 | 4 | 207 | 214 | 387 |
| QEMU | [32926366217](https://github.com/EchoBrain-org/echo-brain/actions/runs/32926366217) | `ubuntu-24.04` | off | 160 | 24 | 189 | 3 | 192 | 201 | 376 |
| QEMU | [32926375043](https://github.com/EchoBrain-org/echo-brain/actions/runs/32926375043) | `ubuntu-24.04` | off | 137 | 23 | 208 | 6 | 214 | 222 | 374 |
| Native | [32926645117](https://github.com/EchoBrain-org/echo-brain/actions/runs/32926645117) | `ubuntu-24.04-arm` | off | 176 | 34 | 54 | 2 | 178 | 187 | 266 |
| Native | [32926650615](https://github.com/EchoBrain-org/echo-brain/actions/runs/32926650615) | `ubuntu-24.04-arm` | off | 182 | 26 | 63 | 4 | 186 | 195 | 275 |
| Native | [32926656041](https://github.com/EchoBrain-org/echo-brain/actions/runs/32926656041) | `ubuntu-24.04-arm` | off | 174 | 28 | 59 | 4 | 178 | 188 | 265 |
| Native | [32926660825](https://github.com/EchoBrain-org/echo-brain/actions/runs/32926660825) | `ubuntu-24.04-arm` | off | 169 | 22 | 62 | 3 | 172 | 179 | 256 |
| Native | [32926666866](https://github.com/EchoBrain-org/echo-brain/actions/runs/32926666866) | `ubuntu-24.04-arm` | off | 167 | 29 | 54 | 2 | 169 | 177 | 252 |
| Cold | [32926926500](https://github.com/EchoBrain-org/echo-brain/actions/runs/32926926500) | `ubuntu-24.04-arm` | unique `measure-cold-20260826-01` | 180 | 38 | 78 | 4 | 184 | 192 | 300 |
| Cold | [32926932242](https://github.com/EchoBrain-org/echo-brain/actions/runs/32926932242) | `ubuntu-24.04-arm` | unique `measure-cold-20260826-02` | 166 | 34 | 97 | 3 | 169 | 177 | 300 |
| Cold | [32926938603](https://github.com/EchoBrain-org/echo-brain/actions/runs/32926938603) | `ubuntu-24.04-arm` | unique `measure-cold-20260826-03` | 163 | 30 | 67 | 2 | 165 | 173 | 262 |
| Cold | [32926946904](https://github.com/EchoBrain-org/echo-brain/actions/runs/32926946904) | `ubuntu-24.04-arm` | unique `measure-cold-20260826-04` | 172 | 28 | 92 | 3 | 175 | 183 | 295 |
| Cold | [32926952883](https://github.com/EchoBrain-org/echo-brain/actions/runs/32926952883) | `ubuntu-24.04-arm` | unique `measure-cold-20260826-05` | 121 | 24 | 86 | 2 | 123 | 131 | 233 |
| Warm | [32927368589](https://github.com/EchoBrain-org/echo-brain/actions/runs/32927368589) | `ubuntu-24.04-arm` | reader `measure-warm-20260826` | 181 | 27 | 40 | 2 | 183 | 193 | 250 |
| Warm | [32927376466](https://github.com/EchoBrain-org/echo-brain/actions/runs/32927376466) | `ubuntu-24.04-arm` | reader `measure-warm-20260826` | 168 | 21 | 46 | 4 | 172 | 181 | 239 |
| Warm | [32927383486](https://github.com/EchoBrain-org/echo-brain/actions/runs/32927383486) | `ubuntu-24.04-arm` | reader `measure-warm-20260826` | 173 | 29 | 38 | 2 | 175 | 183 | 242 |
| Warm | [32927389609](https://github.com/EchoBrain-org/echo-brain/actions/runs/32927389609) | `ubuntu-24.04-arm` | reader `measure-warm-20260826` | 161 | 24 | 40 | 4 | 165 | 174 | 229 |
| Warm | [32927396099](https://github.com/EchoBrain-org/echo-brain/actions/runs/32927396099) | `ubuntu-24.04-arm` | reader `measure-warm-20260826` | 159 | 39 | 41 | 3 | 162 | 170 | 242 |

The unmeasured controls were [native/off smoke 32925022875](https://github.com/EchoBrain-org/echo-brain/actions/runs/32925022875), which passed before the cohorts, and [native/writer 32927155215](https://github.com/EchoBrain-org/echo-brain/actions/runs/32927155215), which passed and populated `measure-warm-20260826`. The five readers supplied only `cache-from`, never `cache-to`. Their logs show the expected scope and cached Docker steps.

| Cohort | Authority median | Active-critical-path median | Wall median | Total-runner median | Decision |
| --- | ---: | ---: | ---: | ---: | --- |
| QEMU, cache off | 203 | 207 | 214 | 376 | Baseline only; revert QEMU |
| Native, cache off | 59 | 178 | 187 | 265 | Keep native runner |
| Native, unique cold scopes | 86 | 169 | 177 | 295 | Baseline only |
| Native, shared warm read-only scope | 40 | 172 | 181 | 242 | Keep cache design |

Native ARM reduced the Authority-job median by 70.9 percent from the QEMU
baseline. The warm BuildKit scope reduced the native Authority-job median by
53.5 percent from the unique-scope cold median. Both improvements exceed the
required thresholds. The retained native median active critical path is 178
seconds: below the 185-second target and the 204-second no-regression ceiling.

## Result and non-claims

Keep the native ARM runner and separately scoped BuildKit cache design from the
sprint workflow. Revert the temporary `workflow_dispatch` runner/cache controls
after this evidence is carried into the sprint branch. This record does not
claim that shared-check time is optimized, that this one sample predicts every
future queue delay, or that the temporary experiment branch is mergeable.
