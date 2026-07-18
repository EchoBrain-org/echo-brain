# Product qualification

This directory defines the private, DEV-only release candidate for the standalone `echo-brain` product. Passing these checks proves that one pinned commit can produce a self-contained, checksum-bound artifact and an honest qualification report. It does not by itself advance the artifact to FOUNDER LIVE, QUALIFIED, or CLIENT LIVE.

## Local qualification flow

Run from a clean, committed checkout with Node `22.22.1` and npm `10.9.4`:

```sh
npm ci
npm run product:check-boundary
npm run test:qualification
npm run product:prepare-offline-deps -- --out-dir /absolute/path/to/support
npm run product:build-artifact -- \
  --version 0.1.0-dev.1 \
  --source-sha "$(git rev-parse HEAD)" \
  --out-dir /absolute/path/to/artifact
```

The builder reads source bytes from the supplied Git commit, never from mutable worktree files. It refuses a SHA other than `HEAD`, refuses to overwrite an output lineage, builds once, and emits:

- the private npm tarball;
- `artifact-manifest.json`, binding version, source SHA, dependency lock and package contents;
- a SHA-256 sidecar for the tarball.

The artifact includes both canonical runtime schemas: `meeting-context.v1.schema.json` and `runtime-config.v1.schema.json`. The root `npm-shrinkwrap.json` is the authoritative dependency lock. A runtime-only shrinkwrap is derived from it while staging the artifact; no second checked-in lock can drift.

`prepare-offline-deps.mjs` makes a separate, hashed support bundle containing the exact runtime dependency cache, matching Node headers, synthetic data, and the scripts and schemas needed to verify, install and assess the tarball without a repository checkout. The installer forces npm offline and points proxies at a dead local port, but the hosted runner is not yet under OS-level egress denial; network-isolation/security cells therefore stay pending.

## Qualification records

The versioned matrix is `schemas/product/qualification-matrix.v1.json`; the report contract is `schemas/product/qualification-report.v1.schema.json`.

CI may create only a `ci-draft` report at maturity `DEV` with result `incomplete`. Machine cells must carry evidence. Founder and independent-reviewer cells stay visibly pending. The schema reserves a future `qualified-release` shape, but the current validator deliberately rejects it: authenticated founder/reviewer evidence sealing and ancestry checks do not exist yet, so structurally valid JSON cannot grant release authority.

The workflow uploads evidence even after a red cell, then runs a terminal gate last. This preserves an honest report without converting a failure into success.

## Deliberate limits

This machinery performs no tag, GitHub Release, registry publication, protected-environment approval, credential change, real meeting, client installation, or release authorization. It does not claim a team delivery adapter exists. Those remain separate evidence and human-authority gates.

The active order is:

1. keep the standalone product boundary and hermetic qualification tests green;
2. qualify the implemented onboarding, lifecycle, backup, and state-restore path
   on the declared macOS arm64 target;
3. add and drill a managed exact-artifact upgrade plus matching-state rollback;
4. run the exact artifact in an isolated FOUNDER LIVE lane;
5. complete independent review and founder authorization for QUALIFIED;
6. install the same bytes for CLIENT LIVE acceptance.

No test retry, packaging success, or repository merge substitutes for a missing stage.
