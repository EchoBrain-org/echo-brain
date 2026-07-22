# Adapters

Phase 4 provides the central SQLite repository, system clock/random sources,
constant-time admin bearer authentication, and an explicitly enabled
development-file signer. Migrations remain with this central deployable and
never enter the local product artifact.
