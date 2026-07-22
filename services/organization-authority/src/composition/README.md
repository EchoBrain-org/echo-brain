# Composition

Configuration parsing and concrete wiring belong here. This is the only layer
allowed to assemble application ports with persistence, signing,
authentication, HTTP, and web implementations.

Serving composition is deliberately stricter than direct repository tests: it
requires a persistent database path and an authenticated loopback-proxy client
identity contract. Missing proxy credentials, an invalid proxy token, or
SQLite `:memory:` aborts startup before the authority opens its database.
