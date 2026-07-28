# Application

Commands and capability-shaped ports live here. The authority application owns
transaction-sized membership, grant, enrollment, lease, and revocation
workflows without exposing table CRUD. It uses domain rules and ports but no
concrete adapter.

Bounded organization-scoped overview/list queries and retry-safe membership and
invitation commands use opaque, typed, bounded cursors;
client-generated invitation material reaches the application only as a digest.
