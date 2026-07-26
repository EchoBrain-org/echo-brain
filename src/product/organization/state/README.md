# Organization state

`organization-state-store.ts` defines the installation-local state port, its
value types, and its fail-closed errors. Enrollment orchestration depends on
that contract rather than on a database implementation.

`sqlite-organization-state-store.ts` is the product-database adapter. It owns
authority pin, enrollment evidence, access-state sequence/hash, and
trusted-clock high-watermark invariants. Missing, corrupt, expired,
rolled-back, or divergent state fails closed; revoked state is terminal.
