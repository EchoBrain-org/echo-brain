# Organization authority exact artifact

This release boundary packages the centrally hosted, single-organization
authority separately from the employee-machine ECHO artifact. The authority is
never an employee-product bundle dependency.

Build one immutable candidate from the exact checked-out commit:

```sh
node tools/organization-authority/build-artifact.mjs \
  --version 0.1.0-dev.phase5 \
  --source-sha "$(git rev-parse HEAD)" \
  --out-dir /absolute/path/to/authority-artifact
```

The output directory contains exactly one npm tarball, its SHA-256 sidecar,
and `artifact-manifest.json`. The tarball bundles the three shared protocol/API
workspaces. `better-sqlite3` remains an integrity-locked external runtime
dependency for the separate runtime-install step.

The artifact contains code and migrations only. The authority database,
signing keys, administrator credential, trusted-proxy credential, and runtime
configuration must live outside the immutable installation prefix. The
included file signer remains development-only.

`declared_platform` records the accepted release cell. Building or inspecting
the artifact on another host does not qualify that host as the target runtime.
