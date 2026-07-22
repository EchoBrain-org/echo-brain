# Organization authority service

**Status:** Accepted N=2/org=1 onboarding/access deployable boundary; no runtime behavior

This service will be centrally hosted for exactly one organization. It reserves
ownership for the central authority behavior needed by organization
administration, invitation, enrollment acceptance, and membership and
installation revocation. Exact policy, audit, persistence, and transport
representations remain deferred. It will not ingest meetings, decisions,
reasoning state, embeddings, or signed outbox batches in the onboarding/access
slice.

The initial deployment is bound to one configured organization identity. It has
no tenant registry, organization switcher, global operator UI, billing, or
cross-organization query. Multi-organization operation is a later architecture
phase, not a dormant code path here.

A future central presentation may provide organization administration and join
landing/context. Enrollment signing, private-key use, authority-result
verification, and local evidence storage remain installation-owned. Rendering
and transport implementations are not selected by this scaffold.
