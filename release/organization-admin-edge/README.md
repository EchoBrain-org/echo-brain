# Organization administrator edge exact artifact

This release boundary packages the organization administrator HTTPS edge as a
deployable distinct from both the employee-machine ECHO artifact and the
single-organization authority artifact. The edge terminates authenticated TLS,
sanitizes the public request boundary, and forwards the bounded administrator
console surface to the authority's loopback listener. It owns no organization
authorization, membership, enrollment, lease, or persistence behavior.

Build one immutable candidate from the exact checked-out commit:

```sh
node tools/organization-admin-edge/build-artifact.mjs \
  --version 0.1.0-dev.admin-edge \
  --source-sha "$(git rev-parse HEAD)" \
  --out-dir /absolute/path/to/admin-edge-artifact
```

The output directory contains exactly one npm tarball, its SHA-256 sidecar,
and `artifact-manifest.json`. The tarball bundles the organization API
workspace and its two protocol dependencies. It has no external runtime npm
packages.

The artifact contains executable code and public documentation only. Runtime
configuration, public TLS certificate chain, private TLS key, trusted
administrator client CA material, authority trusted-proxy credential, logs,
and service-supervisor state must all live outside the immutable installation
prefix. No certificate, credential, organization state, or deployment
configuration is generated or packaged by this builder.

The packaged `echo-organization-admin-edge` binary remains a foreground
process. The deployment supervisor owns installation, external runtime
material, start/stop, rotation, and restart. The edge may connect only to the
configured loopback authority origin. It must preserve the configured public
host for the console's HTTPS Origin/Host check, strip caller-supplied ECHO
proxy identity headers, inject the authenticated loopback-hop credential and a
canonical privacy-preserving client identity, and keep private authority
ownership routes off the public surface.

`declared_platform` records the accepted release cell. Building or inspecting
the artifact on another host does not qualify that host as the target runtime.
