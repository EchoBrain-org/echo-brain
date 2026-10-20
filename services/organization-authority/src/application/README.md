# Application

Use cases and their ports live here: Person identity sessions, employee
lifecycle, Person release authorization, documents and document associations,
the Person document source and project-context commands. They depend on ports
and kernel domain rules, never on a concrete adapter. Paginated reads use opaque, typed, bounded
cursors.

These are the use cases behind ports today. Newer Person services (approval,
runs and open items, record search and personal meetings) live in
`../composition/` instead and reach SQLite directly; the
[composition README](../composition/README.md#use-case-services-with-direct-sqlite-access)
lists them.
