# Adapters

The authority provides the central SQLite repository, system clock/random
sources, constant-time admin bearer authentication, and an explicitly enabled
development-file signer. Migrations remain with this central deployable and
never enter the local product artifact.

An outbound loopback administrator HTTP client and a private-file invitation
adapter publish a pending secret-bearing envelope
before registration, allowing an ambiguous network result to be retried with
the same command and grant without ever sending raw grant bytes to the central
authority.
