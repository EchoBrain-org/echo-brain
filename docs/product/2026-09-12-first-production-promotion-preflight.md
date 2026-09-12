# First staging-to-production promotion: preflight and remaining work

Date: 2026-09-12. Status: blocked before production mutation.

The founder requested the first promotion of the accepted staging release to
the existing production organization. Preserve production identity, memberships,
sessions, provider links and credentials, approvals, and records. No production
SSM command, deployment, reset, infrastructure change, or client account switch
was performed during this preflight.

## Exact candidate

- Release: `clean-v1-20260912-provider-boundary-2f33855`.
- Source: `2f338552c16de80ad73600e86dd66cf78a11af4f`, merged in PR #188.
- CI: [successful merged-source run](https://github.com/EchoBrain-org/echo-brain/actions/runs/34681840261).
- Canonical release SHA-256: `71059f2a1387e163bba1a93d01c8f143a5a8c13907c13a9f7d4b1190026fd3a6`.
- Authority image digest: `sha256:052a76338c9b00ec0f9df4eeb770b3cfca79142dd47cbac28557f1f2f88a2785`.
- Person client SHA-256: `f8c925fa009df2ddfd7109b950308a5542f6c982198ffbf7662cace0f11256be`.
- Runtime profile SHA-256: `123062dfe3c1e3548c7334f3202b7cf1267e2ece56d4398952048479b680f5ac`.

The private staging closeout records successful synthetic approval, exact-client
record and cited-answer checks, explicit final staging authorization, promotion,
and post-promotion runtime checks. This preflight rechecked the three local
artifact hashes and their agreement with that closeout. Reuse those bytes;
staging approval is not production acceptance. Artifact URLs in this release
are offline metadata, not working public download locations.

## Findings

| Area | Evidence | Meaning for this release |
| --- | --- | --- |
| Production availability | EC2 running, SSM online, public descriptor GET returned 200; four existing alarms were OK. | Establishes reachability, not current build, worker health, or data compatibility. |
| Production storage | Encrypted root volume and completed daily recovery points, including today's. | A backup exists; isolated restore and candidate compatibility are not yet qualified. |
| Runtime evidence | Latest available log sample contained six legacy worker-failure markers, last dated September 9, with no build identity. | Neither current failure nor recovery can be concluded from this sample. |
| Remote release lane | The reviewed release CLI and runner are explicitly restricted to staging. | No supported production remote inspection or update action exists in this checkout. |
| Promotion acceptance | The updater requires a candidate-specific synthetic canary receipt; its emitter permits only the staging hostname. | Copying the updater to production does not provide a valid production promotion contract. |
| State compatibility | Candidate requires Authority V4, control-plane V2, record-log V2, and retrieval-facts V2. Authority V3/V4 are expressly fresh-database baselines. | `clean-v1` in a release record is insufficient to prove an upgrade can read existing production state. |
| Historical deployment | ECHO recovered an August 23 deployment at `c186576`, whose source has V1 baselines. | If production still has that lineage, direct replacement is incompatible. Current installed state remains unverified. |

ECHO retrieval was partial: capped discovery, scan-budget-limited searches,
unconsumed cursors, and duplicate historical observations. One truncated
deployment summary was recovered in full. Its then-pre-live reset authorization
does not apply to this operation. The ECHO journal append succeeded.

Private target identifiers, recovery-point references, artifact copies and the
machine-readable preflight are retained in operator evidence outside Git. No
credentials, data files, signing pins or invitations were copied. The public
descriptor was not used to establish pin provenance.

## Execution order

1. **Establish the production host contract.** Review a bounded read-only
   inventory action before executing it. Bind it to the exact account, host,
   volume and environment; verify installed wrapper hashes, accepted canonical
   release, immutable running image/source, Compose directory and mount mapping.
   Return only allowlisted metadata and schema identifiers, never environment
   values, secrets, database contents, or unrestricted subprocess output.
   Do not retarget the staging CLI, use an arbitrary SSM shell, or install over
   unknown tooling. The current playbook does not authorize these shortcuts.
2. **Prove recovery and compatibility.** Follow the existing recovery runbook
   for a concrete quiesced backup and isolated read-only restore qualification.
   Run the exact candidate's state and provider-admission verifiers against the
   restored copy without networking or Authority startup. Record all role/schema
   checks. If incompatible, design and review an explicit migration preserving
   organization bindings and durable records. Rehearse it and its rollback on
   the copy before any production write. Never reset or edit manifests to pass.
3. **Implement production acceptance.** Add a reviewed production operation
   that verifies the exact staging-qualified image/client/profile and separately
   binds the production target, accepted release, recovery proof, compatibility
   result and final decision. Retain staging's hostname/canary restrictions.
   Do not fabricate, transfer or reuse a staging canary as a production event.
   Plan reads of existing approved records and a cited Ask, plus permitted and
   denied access checks with appropriate existing identities. No synthetic
   staging content or new provider-link onboarding belongs in the live org.
4. **Review the concrete cutover.** Present the exact target/artifacts, expected
   service interruption, migration if needed, and rollback limits. The current
   single-host updater can interrupt service; zero downtime is not established.
   A code rollback is safe only when the old image can read every candidate
   write. A restore must explicitly account for writes after the backup.
5. **Execute and accept.** Use reviewed merged tooling from a clean checkout,
   preserve production configuration and trusted identity, verify running image
   and data lineage, perform authenticated exact-client checks and fresh worker
   health checks, then obtain the final production decision for that candidate.
   The Mac's current staging session cannot serve as production authentication.
6. **Close out.** Record production acceptance and runtime evidence, retain the
   rollback artifacts and recovery point for the agreed window, then retire
   temporary transfer objects and obsolete tooling paths only after verified
   replacement. Leave staging evidence and production state intact.

## Source contracts

- [Operator playbook](../operations/PB-OPERATIONS-001-authority-operator-lane.md):
  agents use reviewed repository CLIs for bounded remote actions; other host
  actions remain human-only.
- [Release guide](../../deploy/release/README.md#live-operator-boundary):
  current remote automation excludes production/client-live releases.
- [Updater](../../deploy/organization-authority/update-clean-v1.sh):
  candidate state preflight, staging-only canary, and promotion receipt checks.
- [Candidate lineage verifier](../../packages/organization-authority-kernel/src/composition/verify-authority-state-lineage.ts)
  and [Authority baseline contract](../../packages/organization-authority-kernel/src/adapters/persistence/sqlite/baseline.ts).
- [Recovery floor runbook](../operations/RB-OPERATIONS-002-authority-recovery-floor.md):
  scheduled snapshots do not alone prove a recoverable live application.

The next executable step is a reviewed production inventory, not `stage` or
`promote`. No production compatibility or deployment success is claimed here.

The subsequent schema cleanup (merged source `4cd9401`) introduced Authority
V5/control V3/log V3 baselines and a six-role root, retiring 22 tables and a
redundant index. The one-off converter and predecessor schemas are retained
only in Git history. Production's August 23 lineage remains unverified; the
staging rehearsal does not establish production compatibility. Qualify each
candidate's exact artifacts and inspect production before planning a cutover.

Validation: canonical release validation, all three copied artifact hashes and
their staging-closeout bindings, and `npm run check:docs` passed. No runtime code
was changed. The human operator was asked for the installed updater's `status`
JSON and currently accepted release ID/source SHA, if available, to establish
fresh production evidence without an unreviewed remote command.
