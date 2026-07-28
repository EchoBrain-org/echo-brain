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

Runtime ownership uses an authenticated kernel guard, so an unrelated process
occupying a stale guard port cannot impersonate a live authority.
