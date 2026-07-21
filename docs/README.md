# Echo Brain documentation

These documents record durable design choices. Code and schemas remain the
authority for exact fields, paths, commands, and implementation details.

## Current architecture

- [Core and adapters](architecture/core-and-adapters.md): the portable pipeline
  and its replaceable tool boundaries.
- [Product runtime](architecture/product-runtime.md): how one local installation
  hosts, persists, and operates that pipeline.
- [Identity, onboarding, and federation](architecture/identity-onboarding-and-federation.md):
  how records remain attributable across people, tools, and installations.
- [Organization authority foundation](architecture/organization-authority-foundation.md):
  the experimental N=2 enrollment, revocation, ingest, and receipt boundary.

## Runbooks

- [Manual N=2 pilot](runbooks/manual-n2-pilot.md): the artifact-bound two-role
  ceremony for the experimental organization-authority walkthrough.

## Direction and decisions

- [Organization brain direction](product/org-brain-direction.md): the intended
  shared context and retrieval boundary; it is not current implementation.
- [Founder identity decisions](decisions/founder-identity-decisions.md): the
  accepted Founder Live identity decision register.

## Documentation rule

Each concept has one maintained home. Current architecture, future direction,
and accepted decisions stay visibly separate. Historical proposals,
implementation diaries, and duplicated explanations belong in Git history,
not alongside current documentation.
