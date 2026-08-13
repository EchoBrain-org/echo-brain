# Organization state

`organization-state-store.ts` defines the installation-local state port, its
value types, and its fail-closed errors. Enrollment orchestration depends on
that contract rather than on a database implementation.

`sqlite-organization-state-store.ts` is the product-database adapter. It owns
authority pin, enrollment evidence, access-state sequence/hash, and
trusted-clock high-watermark invariants. Missing, corrupt, expired,
rolled-back, or divergent state fails closed; revoked state is terminal.

Runtime composition and full `doctor` diagnostics interpret the same
authenticated organization snapshot. Runtime opens and migrates the normal
writable store. Doctor instead reads one query-only SQLite snapshot without
running migrations or changing product rows. SQLite may create or use its
ordinary private WAL coordination files while doing that read; `--local-only`
does not inspect organization state or adapters at all.
