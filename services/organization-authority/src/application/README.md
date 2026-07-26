# Application

Commands and capability-shaped ports live here. The authority application owns
transaction-sized membership, grant, enrollment, lease, and revocation
workflows without exposing table CRUD. It uses domain rules and ports but no
concrete adapter.

Phase 2 adds bounded org-scoped overview/list queries and retry-safe membership
and invitation commands. Query cursors are opaque, typed, and bounded;
client-generated invitation material reaches the application only as a digest.
