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
- `install-release.mjs` requires the artifact SHA-256 from an independent
  operator channel, verifies the artifact before mutation, extracts it into a
  new versioned release, rejects links, special files, hard links, and
  unmanifested entries, re-hashes the extracted tree, and seals the release
  read-only. Repeating the same install verifies and returns the existing exact
  release; it never replaces one.
- `prepare-launchd.mjs` runs only on the declared `darwin/arm64` Node 22.22.1
  cell. It re-verifies one sealed release, runs that exact release's no-bind
  preflight, captures a durable secret-free record in a unique private attempt,
  and stages a LaunchAgent plist containing only `serve --config`. It does not
  write into `~/Library/LaunchAgents`, load the service, or open a listener.
- `create-founder-live-plan.mjs` binds that preparation record, the exact
  private-VPN L4 forwarding policy, the fixed acceptance sequence, and the
  declared recovery identity into an immutable plan before live access starts.
- `verify-founder-live-activation.mjs` re-verifies the sealed release and every
  committed plan input immediately before activation, including config, Node,
  plist, VPN policy/procedure, and recovery preparation bytes.
- `validate-founder-live-evidence.mjs` validates the closed Founder Live
  evidence record against the exact plan without external npm dependencies or
  a caller-selected schema. Install and preflight success remain
  `DEV/incomplete`; only a chronologically valid record with every live
  acceptance and recovery check may report `FOUNDER LIVE/pass`.

Certificates, keys, credentials, configuration, logs, and mutable state are
deployment inputs and are deliberately absent from this release lane.
After verifying and extracting an artifact, use its packaged
`echo-organization-admin-edge preflight --config <absolute-path>` command to
validate the declared runtime cell, external private-file boundary, and local
TLS material without opening a listener. Artifact verification and runtime
preflight are intentionally separate: neither substitutes for live deployment
or network qualification.
