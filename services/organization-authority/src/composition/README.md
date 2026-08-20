# Composition

Configuration parsing and concrete wiring belong here. This is the only layer
allowed to assemble application ports with persistence, signing,
authentication, HTTP, and web implementations.

The operator lifecycle also belongs here, but not its concrete storage and
security mechanisms. `cli.ts` owns strict command parsing, `operator-config.ts`
owns the secret-free versioned file contract, `operator-state.ts` coordinates
explicit initialization and read-only state verification, `status.ts` probes
the instance-bound loopback runtime proof, and `runtime.ts` wires the
foreground server. `admin-cli.ts` owns the separate HTTP-only organization
administrator command surface and verifies the runtime ownership proof before
using credentials. Concrete key, credential, invitation-file, lock, proof, and
SQLite behavior remains in `adapters/`.

`process-one-meeting.ts` is the bounded stopped-state source-provisioning and
canary gateway in minimum V1. It owns the singleton and fixed private credential
boundary, then invokes one processing-module cycle with a hard limit of one.
When a source binding and its exact policy-surface Slack capability exist,
`meeting-processing-runtime.ts` wires `serve` to one immediate serialized,
limit-1 cycle and another 30 seconds after each prior cycle completes. No cycles
overlap, and processing has no HTTP route.

Serving composition is deliberately stricter than direct repository tests: it
requires a persistent database path and an authenticated loopback-proxy client
identity contract. Missing proxy credentials, an invalid proxy token, or
SQLite `:memory:` aborts startup before the authority opens its database.
Config-backed `serve` additionally requires a complete initialized state and
an exact match between the requested config path/config contents and the
private initialization manifest published with that state. It opens both the
signer and database without any identity-creation path. The process owns a
singleton state-directory lock until graceful SIGINT/SIGTERM shutdown. Its
health proof is pinned to a fingerprint of the exact canonical database/key
files, listener, credentials, and access policy.

Runtime ownership uses an authenticated, filesystem-visible Unix-socket guard.
The Docker deployment places the socket and lock in a shared native
coordination volume; direct process deployments default them to the state
directory. The same ownership proof is therefore visible across container
network namespaces without depending on a shared TCP namespace. An unrelated
process cannot impersonate a live authority by occupying an abandoned socket
pathname.
