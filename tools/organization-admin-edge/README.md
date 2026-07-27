# Organization administrator edge release tools

These tools build and verify the administrator edge as a separate exact-commit
runtime artifact.

- `sync-shrinkwrap.mjs` derives the runtime-only npm lock from the repository's
  authoritative shrinkwrap. It permits exactly the three bundled
  organization API/protocol workspaces and no external runtime package.
- `build-artifact.mjs` requires the supplied full source SHA to equal `HEAD`,
  materializes that commit with `git archive`, compiles the edge workspace
  inside the materialized source, stages only packaged runtime files, and
  atomically publishes one tarball, checksum sidecar, and manifest.
- `verify-artifact.mjs` validates the output directory, artifact identity,
  complete archive file set, per-file hashes, packaged shrinkwrap, bundled
  dependency set, checksum, and build identity.

Certificates, keys, credentials, configuration, logs, and mutable state are
deployment inputs and are deliberately absent from this release lane.
After verifying and extracting an artifact, use its packaged
`echo-organization-admin-edge preflight --config <absolute-path>` command to
validate the declared runtime cell, external private-file boundary, and local
TLS material without opening a listener. Artifact verification and runtime
preflight are intentionally separate: neither substitutes for live deployment
or network qualification.
