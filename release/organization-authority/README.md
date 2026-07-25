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
initialization manifest, signing keys, administrator credential, trusted-proxy
credential, and runtime configuration must live outside the immutable
installation prefix. The manifest binds the state to its exact external config
path and complete runtime configuration. The included file signer remains
development-only.

After a runtime installation resolves the integrity-locked native dependency,
the packaged authority is self-contained from the employee product. The
`echo-organization-authority` binary owns initialization, status, and serving;
its operator flow is
`init-development --config ... --state-dir ... --organization-name ...`,
`status --config ...`, and foreground `serve --config ...`. Ctrl-C/SIGTERM or
the deployment supervisor owns stopping it.

The same exact artifact includes `echo-organization-admin`, an HTTP-only
org-scoped operator client for overview/list/create/invite/revoke commands. It
first verifies the private runtime ownership proof, then uses the configured
loopback API; it never opens SQLite. Invitation creation requires the separate
employee-reachable public HTTPS authority origin and atomically publishes a
private retry-safe invitation envelope. The raw one-time grant exists only in
that `0600` file, never in the authority API or database.

The server-rendered `/admin` console is part of the same authority listener and
database boundary. It requires the separately packaged organization
administrator HTTPS edge and keeps only short-lived in-memory sessions. That
edge supplies the non-secret employee authority locator used by browser-created
invitations; it remains a different exact artifact and is never bundled here.
The authority artifact intentionally does not include a daemon, PID-file
controller, launchd/systemd unit, TLS terminator, global multi-organization
control plane, or production signer.

The internal `/_echo/runtime-status` ownership-proof route is for the private
loopback hop and must not be forwarded by either the administrator edge or any
employee-facing TLS terminator.

`declared_platform` records the accepted release cell. Building or inspecting
the artifact on another host does not qualify that host as the target runtime.
