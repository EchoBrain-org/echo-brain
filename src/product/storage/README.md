# Product storage

This directory owns the installation-scoped ECHO Brain SQLite database.
`open-product-database.ts` is the shared opening, security, pragma, and migration
boundary. Domain stores keep their SQL and invariants in their domain modules.

The migration sequence is intentionally linear because all installation state
shares one SQLite file and one `PRAGMA user_version`. Migrations `0001`
through `0003` are retained as historical upgrade steps; `0003` created the
founder-federation tables of the retired local lane, and
`0008_remove_federated_founder_identity.sql` drops those four tables now that
the capability and every reader of them are deleted. Migration
`0004_remove_legacy_events.sql` removes the retired generic `CaptureEvent`
table. Migration `0005_organization_access.sql` adds the three local
organization trust, enrollment, and access high-watermark tables. Migration
`0006_organization_authority_connection.sql` adds the write-once authority
connection table, and `0007_organization_authority_rebind.sql` permits an
authority origin relocation without changing the pinned identity. The applied
sequence leaves the installation schema at version 8 with ten tables. Existing
numbered migrations must not be rewritten; schema changes are appended as the
next contiguous migration.
