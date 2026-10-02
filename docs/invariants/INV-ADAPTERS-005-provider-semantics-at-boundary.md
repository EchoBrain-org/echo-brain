---
schema_version: 1
id: INV-ADAPTERS-005
kind: invariant
title: Provider semantics terminate at the adapter boundary
component_ids:
  - CMP-PROCESSING-ADAPTERS
  - CMP-MEETING-PROCESSING-CORE
created_at: 2026-08-29
reviewed_at: 2026-09-07
reviewed_ref: 52652d26dab3d753333ce489f866e1e7d0d1f4aa
normative: MUST
enforcement_status: partial
enforcement_scope: Complete production module ownership, inward workspace edges, explicit bootstrap modules, and shared deployment source assemblies
failure_pattern_ids:
  - FP-ADAPTERS-005
---

# INV-ADAPTERS-005: Provider semantics terminate at the adapter boundary

## Rule, scope, and rationale

Provider-specific payloads, cursor grammar, credential and custody checks,
owner discovery, lifecycle rules, interaction signatures, transport metadata,
and presentation identifiers MUST terminate inside the provider adapter or its
selecting composition bundle. Provider-neutral processing, orchestration,
canonical durable contracts, approval policy, retrieval, answer composition,
and approved-record policy projection consume only canonical contracts,
immutable adapter commitments, and opaque provider references.

The allowed selecting composition bundles are explicit: meeting source,
decision processor, Layer 4 generation, approval/interaction surface, and
Person external identity. Those bundles may select Granola, OpenRouter, Slack,
or a future external-capability provider. The shared runtime must receive only
their ports, identity/configuration commitments, generic presentation
references, and approved-record policy projectors.

The opt-in [context capture integration](../product/2026-10-01-connector-context-integration-v1.md)
adds a declared selecting module, `provider-context-intakes-v1.ts`, for the
versioned source capture capability. It selects Granola/Jira adapters into the
provider-neutral intake; all classification, API parsing and cursor grammar stay
in providers. Authority fixes organization and disposition independently of
returned data. This module does not register a production source or scheduler.
The disposable local rehearsal profile may select these already-declared
adapters only through that module. Its retained Granola observation is governed
by a separate owner-scoped policy and does not move the legacy meeting cursor;
its Jira observation is request-only. It has no automatic scheduler or
production Jira enablement.

The explicit staging connector rehearsal is a separate versioned selecting
composition. It mounts the same intake factories and provider-owned connection
commands through a neutral HTTP runtime capability; the shared API does not
parse provider state. It preserves ordinary processing and its cursor ownership,
requires the current initial owner and exact release/profile binding, and keeps
the normal Jira release gate and ticket Ask selection closed. Its private Jira
sidecar is rehearsal state with an explicit recovery boundary, not an extension
of canonical Authority storage. The staging selection and receipts are specified
in the linked integration design.

The explicit V2 staging selection adds the Slack provider's fixed-public-channel
pointer source and selects retained Jira pointers through the same neutral
intake. Authority owns the initial-owner custody policy and synchronous
admission fences; provider credentials and opaque author references do not
grant retention or identity. Slack channel parsing and optional read-scope
proof remain provider-owned. V2 preserves the V1 profile and connection
sidecar, proves their predecessor binding before reuse, and changes the capture
wire only through a new version. It does not widen ordinary production or V1
rehearsal behavior, canonical connection contracts, signed bytes or SQL
baselines.

This invariant is about external-capability providers. The current local
platform still deliberately selects SQLite, file-backed keys, Node crypto and
clock implementations, and the OIDC protocol in Authority composition. An
OIDC issuer is configuration-swappable; a persistence engine, key-custody
scheme, runtime primitive, or non-OIDC authentication protocol is not claimed
to be bundle-swappable by this revision.

Adding or replacing any active provider must not require a provider branch in
the shared processing path, live worker, canonical state, approval policy,
retrieval, answer composition, or record-policy projector. A provider may add
its own adapter, provider-owned persistence, onboarding configuration,
composition bundle, and capability-level tests.

This rule does not prohibit a deliberate revision to a canonical contract when
a new source exposes a genuine domain capability. Such a revision must be
designed and tested as a provider-independent contract change rather than
introduced as a conditional for one vendor.

## Enforcement and failure behavior

Each provider owns one repository-root `providers/<provider>/` folder and one
or more real workspaces when client/server artifact boundaries require a split.
Every production JavaScript/TypeScript module is classified by registered
workspace ownership. Explicit bootstrap modules may select providers. Neutral
modules may reach neither providers nor bootstrap; providers may reach neither
other providers nor composing services. Neutral libraries cannot depend on
applications. Public package exports are explicit and source-resolvable, and
workspace cycles are rejected.

The single architecture gate traverses whole modules, including type imports
and inline import types, side effects, namespaces, unused barrel exports and
literal dynamic imports. Runtime assets follow the same ownership direction.
The native Swift app is retired, and the gate rejects any Swift source under
`product/` or `providers/`. The Explorer's assembly binds the exact bundled modules, provider-owned
historical vocabulary assets, and exact external/builtin import allowlists.
Both its builder and the gate reject computed imports and loader acquisition.
Checks inspect source instead of stale emitted code. Architecture mutation tests cover each mechanism with
positive controls, and an isolated build removes all provider/application
workspaces before compiling the neutral packages.

Provider-name regex discovery, symbol-selected traversal, scattered provider
roots and coupled exceptions are retired. Unsupported manifest fields fail the
gate. Loader acquisition defenses remain independent of ownership enforcement.

A provider identity, runtime commitment, interaction, cursor, or presentation
reference that does not match its admitted boundary fails closed before it can
change canonical state. Shared state must not parse provider cursors, message
timestamps, signed interaction payloads, or provider-specific identity facts.

Changing an approval presentation surface is a controlled restart boundary.
Before work resumes, the selected surface MUST prove ownership of every
outstanding external presentation. It may adopt pristine queued work only.
The approved-record policy-projector registry is additive across such a
change: it MUST retain projectors for historical record protocols as well as
the selected surface's new protocol. The optional approver-metadata projector
uses an explicit retained composite too: unsupported or multiply matched records
omit metadata. Projection runs after read authorization and cannot grant access.

The approval-state port is synchronous and is called only when both authority
connection owners are outside transactions. The runtime guards its handle and
the provider guards its own before every port call. Each operation commits before
the next owner runs. The provider's stable approval fence uses its own authority
handle while committing the separate control-plane database; it must not call
back through the state port inside that fence. Both handles retain DELETE journal
mode and existing durability settings; this is an ordering contract, not a
cross-database atomic transaction.

Provider bundles are trusted, reviewed composition code rather than an
independently installable plugin surface. The runtime enforces that the
ownership preflight runs before the bundle opens; review and qualification
must establish that a new bundle's proof is complete.

## Verification and change procedure

The reviewed source is covered by:

- `services/organization-authority/source-boundary.v1.json`;
- `product/source-boundary.v1.json`;
- `tests/architecture/workspace-boundaries.test.ts`;
- `services/organization-authority/test/admitted-meeting-source-schema.test.ts`;
- `packages/organization-processing/test/admitted-meeting-processing/meeting-processing-cycle-v1.test.ts`;
- `services/organization-authority/test/organization-authority-private-approval-runtime.test.ts`;
- `providers/openrouter/test/openrouter-decision-processor-bundle-v1.test.ts`;
- `providers/openrouter/test/openrouter-answer-composition-generation-bundle-v1.test.ts`;
- `packages/organization-record/test/record-log-v4-append.test.ts`;
- `providers/synthetic-demo/test/source/synthetic-demo-meeting-source-v1.test.ts`; and
- `providers/synthetic-demo/test/synthetic-demo-pre-slack-evaluator-v1.test.ts`.

The Phase-1 replay corpus, quality CLI and its adapter/evaluator tests are
retired. Their former corpus-validation behavior is no longer claimed as
enforcement. Exact source tombstones reject those removed files, and the
workspace boundary test rejects replacement files under `src/quality/`
because that directory no longer has a layer rule.

The active synthetic-demo lane remains separate. Its source adapter and
pre-Slack evaluator use canonical meeting documents and the production
processing port; their tests cover the four-meeting fixture and extraction
defect classes without live provider calls. The external `demo/` rehearsal
graders and deterministic core-runtime checkpoint remain available.

Structural enforcement covers ownership, dependency direction and build inputs.
Semantic enforcement remains partial: a reviewed, generically named module can
still encode a provider assumption without importing its implementation. Static
checks are not a hostile-code sandbox and cannot prove arbitrary runtime code
generation or data flow. Shared-contract review, meaningful substitution tests
and provider qualification remain necessary.

The V1 setup and service CLIs deliberately select the fixed
Granola/OpenRouter/Slack product profile. Setup status, planning and finalization
require Slack and are not provider-swappable. Provider neutrality covers the
shared runtime and contracts, not this stopped-state bootstrap workflow. A
non-Slack setup profile needs an explicit versioned bootstrap design and its own
qualification; changing only the runtime bundle is insufficient. Historical
persisted vocabulary remains supported; the Nango Slack profile retires the old
host-side Slack credential flags and uses `person tools setup --tool slack`.
provider verification and wire/state interpretation are delegated to their
provider folders. Adding a provider can require a new versioned domain capability,
but cannot silently widen an existing canonical contract. V2 Person compatibility
and historical Slack V4 codecs remain explicit provider-owned selections, with
no permissive fallback. Historical signed bytes and SQL baselines remain unchanged.

CODEOWNERS covers the provider tree, public contracts, bootstrap/source manifests,
application code, and architecture tests. Changes to provider facts in shared
contracts require invariant review and an explicit versioned design decision
when the canonical contract changes.
