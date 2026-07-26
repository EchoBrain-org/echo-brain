# Phase 5 one-machine rehearsal

**Status:** non-qualifying `darwin/x64` rehearsal; physical Phase 5 gate remains open

This runbook exercises one exact organization-authority artifact and two exact
employee-artifact installations on one Mac. It proves the runnable N=2/org=1
flow as far as one machine can: isolated state and keys, enrollment and exact
retry, access refresh, restart, corruption rejection, and installation and
membership revocation.

It is deliberately not the final Phase 5 qualification. The release cell is
`darwin/arm64`; this runner accepts only `darwin/x64` and requires an explicit
unsupported-host acknowledgement. That acknowledgement permits the rehearsal
installer to cross the platform fence. It does not waive the fence or turn x64
evidence into arm64 evidence.

## Preconditions

Run from the repository root with:

- Node `22.22.1` and npm `10.9.4`;
- a `darwin/x64` Node process;
- the intended Phase 5 sources committed at `HEAD`;
- dependencies installed and the repository-local `.npm-cache` populated; and
- a new absolute output path whose parent is writable.

Prepare dependencies before freezing the commit if necessary:

```sh
npm ci --cache .npm-cache
node --version
npm --version
git status --short
```

The version checks must print `v22.22.1` and `10.9.4`. The ceremony does not
load workspace or repository build output: its small organization HTTP contract
surface and rehearsal-only fault injector are tracked ceremony sources. Review
a non-empty Git status before running. All Phase 5, artifact-builder,
release-boundary, and report-schema files must be committed; unrelated work may
remain only when it does not overlap those files. The ceremony driver verifies
its reviewed, statically declared repository module closure byte-for-byte
against the supplied source SHA and refuses recognized runtime-loader
capabilities; this is source-integrity evidence, not a sandbox for hostile
JavaScript. Employee runtime modules are loaded only from artifacts built from
that materialized commit and verified before use.

The rehearsal uses npm's cache-only mode and preflights npm, Node headers,
Python, Make, and Clang before rebuilding the native SQLite dependency. This is
reproducibility evidence for this host, not OS-enforced network-isolation
evidence: lifecycle scripts are not placed in a separate network sandbox.
`P5-NET-001` therefore remains blocked regardless of cache-only success.

## Run the rehearsal

Choose a nonexistent absolute output directory. This example retains all
outputs under private temporary storage:

```sh
PHASE5_SOURCE_SHA="$(git rev-parse HEAD)"
PHASE5_OUTPUT="/private/tmp/echo-phase5-one-machine"

node tools/phase5/run-one-machine.mjs \
  --version 0.1.0-dev.phase5-one-machine.1 \
  --source-sha "$PHASE5_SOURCE_SHA" \
  --out-dir "$PHASE5_OUTPUT" \
  --acknowledge-unsupported-host
```

The runner refuses a SHA other than the current `HEAD`, an existing output
directory, an uncommitted ceremony driver, a non-x64 host, or omission of the
acknowledgement flag. It builds both artifacts from Git objects, not mutable
worktree source. The employee artifact still excludes the authority; the
authority is a separate artifact with its own manifest and checksum.

A successful command prints one JSON line with this shape:

```json
{
  "ok": true,
  "result": "rehearsal_passed",
  "phase5_gate": "incomplete",
  "run_id": "p5r_<uuid>",
  "passing_checks": 23,
  "blocked_checks": 5,
  "report": "evidence/one-machine-report.v1.json"
}
```

Progress messages go to stderr. They contain phase labels, not credentials or
raw protocol bodies.

## Output and verification

Success atomically publishes the output directory with this durable shape:

```text
artifacts/
  employee/                       manifest, tarball, checksum
  authority/                      manifest, tarball, checksum
installs/
  employee-a/                     isolated exact-artifact install
  employee-b/                     isolated exact-artifact install
  authority/                      isolated exact-artifact install
private-state/
  authority/
  installation-a/
  installation-b/
  divergent/                      consumed-grant negative check
  corrupt-copy/                   corruption negative check
evidence/
  one-machine-evidence.v1.json    hash-bound check observations
  one-machine-report.v1.json      bounded, secret-scanned report
```

Treat the whole directory as sensitive: it contains development private keys
and live SQLite state even though the report contract rejects secrets, network
locations, local paths, and free-form error text. Directories are `0700` and
private files are `0600`.

Validate the sealed report independently:

```sh
PHASE5_REPORT="$PHASE5_OUTPUT/evidence/one-machine-report.v1.json"
node tools/phase5/validate-report.mjs --report "$PHASE5_REPORT"
```

Success prints:

```json
{ "ok": true, "errors": [] }
```

The report binds the employee artifact, authority artifact, ceremony driver,
source SHA, two distinct installation identities, and every check result. Keep
the exact artifact directories and report together for the physical follow-up;
never transfer `private-state/` between machines.

## Interpreting 23 pass and five blocked

The 28 checks form one closed vector. A valid one-machine report has exactly 23
passes and these five declared blocks; `unexpected_skip_count` remains zero.

| Check group | Passes | What the one-machine run proves                                                                     |
| ----------- | -----: | --------------------------------------------------------------------------------------------------- |
| Artifact    |      4 | Exact employee and authority bytes, common source SHA, manifests, checksums, and build identities   |
| Isolation   |      2 | Separate install/state roots and distinct principals, memberships, installations, and software keys |
| Edge        |      1 | Three authenticated proxy identities, spoofed-header overwrite, and employee/admin route separation |
| Enrollment  |      3 | A lost-response exact retry, independent B enrollment, and consumed-grant rejection                 |
| Access      |      3 | Monotonic refresh, tampered signed-state rejection, and stale-state recovery                        |
| Restart     |      3 | Durable authority identity/state, fresh local processes, and post-restart refresh                   |
| Storage     |      1 | Corrupt retained state fails closed without changing the valid installation                         |
| Revocation  |      4 | Installation revocation, terminal persistence, unaffected peer access, and membership revocation    |
| Security    |      2 | Private filesystem modes and scans excluding known bearer material from retained evidence           |

The five blocked checks are not failures hidden as skips:

| Check          | Required evidence that one machine cannot provide                              |
| -------------- | ------------------------------------------------------------------------------ |
| `P5-PLAT-001`  | Execution in the declared `darwin/arm64` release cell                          |
| `P5-KEY-001`   | Installation keys protected by Secure Enclave rather than development files    |
| `P5-PHY-001`   | Two genuinely separate physical employee machines                              |
| `P5-NET-001`   | A production authenticated TLS terminator rather than loopback rehearsal edges |
| `P5-TRUST-001` | Authority-pin delivery over an independent trusted channel                     |

The schema fixes `result` to `rehearsal_passed` and `phase5_gate` to
`incomplete`. The validator rejects changing a blocked check to pass, deleting
one, adding a waiver, or relabeling the result as qualified. Never edit the
report to close Phase 5.

## Failure, recovery, and cleanup

Before publication, all work occurs in a private sibling directory. On a
normal error the runner stops the loopback edges and authority, removes that
staging directory, and leaves the requested output path absent. Correct the
cause and rerun with a fresh output path; do not reuse partial state or create a
replacement report manually.

If the terminal disconnects, inspect the requested output path:

- If it is absent, no rehearsal result was published.
- If it exists, do not rerun into it. Validate its report. A valid report is a
  completed rehearsal even if the final stdout line was lost; an invalid or
  missing report means the directory must be quarantined as incomplete.
- An abrupt process kill can leave a hidden sibling staging directory. Do not
  reuse it. Move it to restricted quarantine until no authority or edge process
  remains, then dispose of it through the machine's normal secure-trash policy.

After retaining the two artifact directories and validated report in approved
restricted storage, move the remaining output to encrypted quarantine or the
machine's Trash. Do not casually archive or share development keys, enrollment
state, grants, administrator credentials, or proxy credentials.

## What remains for physical Phase 5 completion

The final gate must reuse the exact artifact bytes and source SHA recorded by
the rehearsal, then produce a separate physical-gate report. It must:

1. install the employee artifact on two independent `darwin/arm64` Macs using
   the ordinary release platform fence, with no unsupported-host override;
2. create an independent Secure Enclave installation key on each Mac;
3. run the authority on persistent company-controlled storage behind the real
   authenticated TLS terminator;
4. deliver and verify the authority pin through a channel independent of the
   authority endpoint;
5. repeat enrollment, refresh, restart, corruption, and both revocation paths
   across the real network; and
6. pass the five currently blocked checks without changing the one-machine
   report.

Only that physical evidence can change Phase 5 from incomplete to complete.
The reasoning Brain remains out of scope until then.
