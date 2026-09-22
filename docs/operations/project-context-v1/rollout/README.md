# Project context V1 candidate evidence preparation

Preparation only. No reset, reseed, build of release candidate artifacts, product installation,
SSM operation or deployment has been executed. This is a candidate evidence
worksheet, not another operator playbook. Exact actions and actors remain in
[PB-OPERATIONS-001](../../PB-OPERATIONS-001-authority-operator-lane.md), the
[release guide](../../../../deploy/release/README.md), and the
[onboarding guide](../../../../deploy/organization-authority/README.md).

## Fresh V7 and recovery gate

The selected foundation requires fresh Authority V7. Normal startup must refuse
V6 without changing it. `stage-v5-to-v6` cannot prepare V7. A synthetic SQLite
reopen proves persistence only, not a host/proxy restart or recovery.

For each environment independently, complete these evidence slots before a
later authorized operation:

| Evidence | Required result | Current state |
| --- | --- | --- |
| Target and operator scope | Private receipt identifies exact environment, Authority, accepted release, datastore inventory and responsible human; approved runtime-disposal scope matches that target | Pending |
| Reset mechanism | Exact reviewed installed wrapper/version/action and its eligibility verified through the operator router | Pending |
| Data boundary | Private inventory separates runtime databases, sessions and derived state from provider configuration, credentials, source checkout and release artifacts; only runtime state is eligible for replacement | Pending |
| Recovery material | Prior release/image/profile/client remain immutable and available; stopped-state archive or applicable qualifying recovery point verified and bound to the prior lineage | Pending |
| Quiescence | Existing shared processing lifecycle is stopped/drained and no pending remote command or operation lock is bypassed | Pending |
| Fresh initialization | Intended fresh organization and Authority lineage; Authority schema V7 and every companion store/root passes current lineage checks | Pending |
| Reseed | Fresh human sign-in and exact organization membership tenures; synthetic projects and context recreated through current application operations | Pending |
| Restart | Authority and proxy lifecycle, private health, external descriptor/no-store behavior and current image/profile independently observed | Pending |
| Recovery rehearsal | Exact prior artifact plus compatible prior state restored together; running health and externally served reachability verified before claiming recovery | Pending |

The existing `replace-rehearsal` lane is limited to an eligible unreleased
rehearsal with an actual no-live-users attestation. The sprint's disposable-data
decision does not establish that eligibility. For staging, the future operator
must confirm it before selecting the router's provider-reuse/reset lane. For a
released production Authority, the current rehearsal wrapper is ineligible:
a separately reviewed production reset/reseed mechanism and exact approval
remain unresolved. Do not infer that ordinary `stage` or a blank-volume flag
can replace that missing operation.

Provider inputs remain under existing custody. The reset plan contains no
provider file deletion, credential retrieval or credential hashes. The later
private input inventory and wrapper eligibility proof must identify protected
paths without copying their contents into this repository. No recursive-delete
command or arbitrary host path is supplied by this worksheet.

A failed candidate must not run the old image against fresh V7 state if that
image expects V6. Recovery binds compatible state and artifacts together. Keep
the failure receipt, prior archive and operation state; an unconfirmed remote
outcome requires reconciliation through the existing router before any retry.
The [recovery floor](../../RB-OPERATIONS-002-authority-recovery-floor.md)
alone is not proof of restored serving capability.

## Matched artifact gate

Record the full committed PC-02/03/04/05 heads, final integration SHA and clean
worktree/build identity. Complete the real cross-layer tests and `npm run check`
before selecting an exact candidate. Later packaging must bind its working
directory and embedded source identity to that candidate. Never substitute
another worktree's dependencies, outputs or archives.

The private candidate receipt must bind server image digest, runtime-profile
digest, release-record digest, Person-client package/archive digest and native
client/CLI source identity. Require a matching supported tuple and reject or
quarantine mismatches. Rebuilding changes exact-artifact qualification. No
release candidate artifact has been built or installed in this PC-06
preparation. Repository tests may package and unpack temporary fixture clients;
those bytes are not release candidates or installed-product evidence.

Preserve configured telemetry and existing meeting/approval/record behavior.
The operator router's canary, human private approval, candidate-client checks
and exact-candidate final decision still apply. Project context originals
never become meeting/approval/record inputs, and project Ask remains unavailable.

## Two-Person verification worksheet

Use conspicuously synthetic text and store bounded IDs, digests, metadata
states, denial codes and timestamps; never store original bodies, sessions or
provider payloads in evidence. Match both Persons' installed clients to the
candidate receipt. Perform each server request after current authentication;
an offline UI observation does not prove central revocation enforcement.

1. Person A creates Alpha and Beta. Person B initially belongs only to Alpha.
   Verify each discovery/roster scope and lead-only directory behavior.
2. A saves a private Alpha-associated original, a team original, an
   Alpha-audience original, and an Alpha-audience original associated with
   Beta. Retain immutable receipt coordinates and request IDs.
3. Before hints finish, verify A's original read/search and B's permitted
   originals. B cannot read A's private note; team originals remain readable
   independently of association; Beta association grants no new audience.
4. Join B to Beta and remove B from Alpha. B can discover Beta but cannot read
   the Alpha-audience original associated there. Its title, excerpt, count and
   cursor must not leak. Rejoin uses a fresh grant; organization-tenure
   replacement does not inherit one.
5. Verify scoped feed/search/read and cross-project identifier/cursor misuse
   through the CLI-bound UI and the same real HTTP composition. Capture exact
   refusal and ensure no global search or Ask fallback.
6. Verify original reads/search after hints succeed and after a controlled
   failure; model completion cannot rewrite original bytes or audience. Any
   deterministic revocation/timeout injection remains a local harness result
   unless a separately approved live mechanism exists.
7. Reconcile a controlled unknown delivery with its original request ID and
   immutable draft. Verify one receipt/work item after authorized restart;
   changed payload conflicts. No V1 retry or project-to-team conversion.
8. Verify unsupported-client behavior: only projects-list is a capability
   probe; individual 404s remain generic missing/inaccessible; unsupported
   project Ask stays disabled. Verify meeting/approval/record behavior remains
   separate using the router's existing release checks.

For each row record `not_run`, `passed` or `failed` with exact candidate,
Person alias, command/UI action, request/receipt coordinate, expected/observed
outcome, sanitized evidence location and UTC time. Local fixture success and
an app installation cannot mark any live row passed.

Use the adjacent [unexecuted evidence template](evidence-template.json) for
staging and production separately. Its null fields and `not_run` results are
intentional missing evidence, never placeholders for assumed success.
