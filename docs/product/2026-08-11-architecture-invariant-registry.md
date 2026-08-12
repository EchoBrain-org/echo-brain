# Architecture invariant registry

**Status:** local code-grounded registry. It consolidates invariant statements
from the product architecture documents and records the permission-pilot
baseline plus locally committed Job A baseline
`03167cfd66fa0b5fe983abbf266271178548efb8`, alongside locally committed Job B
baseline `588b42828d5c811a4ae51b21e881139109e7e46d` and integrated pre-push
hardening `c0a498f7aebca9a5f067cc9a808a967297ff7d9d`. Authority container closure
and retrieval-migration execution are pinned at
`2da11a04f45ff503978dd6594fe2677964c93a9e`. Final local gates passed.
Remote source publication does not constitute merge, deployment,
founder-live qualification, client-live qualification, or release.

This registry does not approve a proposal, prove a deployment, or replace the
normative source documents. Code and schemas remain authoritative for current
behavior.

## Source hierarchy

1. The ten canonical permission invariants come from
   [Organization permission architecture](2026-08-09-organization-permission-architecture.md#normative-invariants).
2. The eight append/derive constraints come from the approved
   [append and derive design](2026-08-07-org-decision-record-append-derive-design.md#design-principles-settled).
   That document calls them settled design principles rather than normative
   permission invariants; this registry gives them stable `AD-*` identifiers.
3. The founder-confirmed reviewer implementation contract adopts `INV-11A`
   and `INV-12` in
   [A: Reviewer permission V1](2026-08-11-reviewer-permission-v1-log-facts-design.md#invariant-trace-and-adopted-additions).
4. The founder-directed Job B implementation contract adopts `INV-11B` for
   one bounded lexical operation in
   [B: Permission-aware lexical Layer 2 minimum V1](2026-08-11-trusted-permission-aware-searchable-layer-2-design.md#invariant-trace).
5. The permission-pilot and A/B conformance tables restate the canonical
   invariants. They do not create additional invariants. Acceptance matrices,
   build orders, and failure tests are gates, not separate invariants.
6. [Approval surface v2](2026-08-10-approval-surface-v2-direction.md)
   contains future product rules, not formally adopted invariants. They are
   recorded separately below.

## Status model

Normative and implementation status are independent:

| Field | Values used here | Meaning |
| --- | --- | --- |
| Normative status | `constitution`, `approved design`, `approved implementation contract`, `proposal` | Whether the rule governs architecture or is awaiting acceptance |
| Enforcement scope | `general primitive`, `bounded pilot`, `supporting foundation`, `none` | Where code currently enforces the rule |
| Implementation status | `implemented at baseline`, `implemented at Job A baseline`, `implemented at Job B local baseline`, `partially implemented`, `not implemented` | Static code/test status at the named baseline |
| Live status | `not assessed` | This registry does not infer merge, deployment, or current production state |

“Landed” below means present in code and tests at the named baseline. It does
not mean merged to another branch, deployed, founder-live qualified, or client
live.

## Canonical permission invariant catalog

These headings are copied exactly from the normative constitution. The status
tables below reference their stable IDs rather than redefining them.

| ID | Canonical invariant |
| --- | --- |
| `INV-01` | **Authorize the candidate set before scoring or model access.** |
| `INV-02` | **Never stamp resolved reader identities into immutable content.** |
| `INV-03` | **Existence and content are separate rights.** |
| `INV-04` | **Every positive result has a sentence-form witness.** |
| `INV-05` | **Check and use share one consistency boundary.** |
| `INV-06` | **Failure cannot widen access.** |
| `INV-07` | **Structure and statistics inherit visibility before computation.** |
| `INV-08` | **Models cannot widen access or identity.** |
| `INV-09` | **Recording creates no recipient list.** |
| `INV-10` | **Every response-authorization decision is auditable without creating a second disclosure surface.** |

## Landed in code at the baseline

### Append and derive constraints

| ID | Settled constraint | Code status | Evidence and limit |
| --- | --- | --- | --- |
| `AD-01` | Append, derive, and retrieve are separate logical machines communicating through data at rest. | Implemented at baseline | Ingest, follower, and the bounded pilot reader are separate application paths. The [source-boundary manifest](../../services/organization-record/source-boundary.v1.json) constrains imports. This does not provide general retrieval. |
| `AD-02` | The log records human facts; deterministic interpretation is derived; retrieval-time scoring/search is not derive output. | Implemented for record v1 | [Record append](../../services/organization-record/src/log/record-log-store.ts) owns canonical rows; [projection](../../services/organization-record/src/derive/projection.ts) derives atoms/provenance. No search index exists. |
| `AD-03` | Content stores frozen provenance/intent facts, never resolved reader lists; effective access uses current Person state at query time. | Partially implemented | V1 content does not contain current reader lists, and the pilot rechecks current Authority state. The general gatekeeper, identity resolution, and policy resolver are not implemented. The pilot's immutable two-member marker is a reviewed bounded policy outside content, not proof of the general rule. |
| `AD-04` | The log unit is the complete package the human approved; atoms are a rebuildable projection. | Implemented at baseline | The protocol stores the bounded `DecisionBrief`; [derive](../../services/organization-record/src/derive/projection.ts) creates atom rows. |
| `AD-05` | Rejections are immutable human acts, not candidate content; the rejected package stays local. | Implemented at baseline | The protocol and log admit rejection envelopes while the projection creates rejection facts rather than approved atoms. |
| `AD-06` | Raw transcripts/vendor payloads stay local; only the bounded approved brief, evidence spans, source locator, or bounded rejection reason crosses the organization boundary. | Implemented at baseline | The [organization protocol](../../packages/organization-protocol/src/contracts.ts) defines the bounded shared shapes; the member submitter builds those shapes rather than transmitting raw custody. |
| `AD-07` | Derive v1 is deterministic and log-only: no live Authority state, principal binding, models, or inferred links. | Implemented at baseline | The [pure projector](../../services/organization-record/src/derive/projection.ts), [follower](../../services/organization-record/src/derive/follower.ts), and boundary rules enforce the current dependency shape. |
| `AD-08` | Organization-record signing and hashing use the shared RFC 8785 canonicalization only. | Implemented at baseline | Protocol creation and record hashing use the federation canonical JSON/signed-document primitives; tests pin stable hashes. |

Additional landed integrity primitives support those constraints:

- `record-log.sqlite` has contiguous position/predecessor rules, hash-chain
  verification, and update/delete denial triggers.
- Record append uses `BEGIN IMMEDIATE` and commits an immutable record once.
- Each derive step commits rows, edges, and cursor in one derived transaction;
  projection failure rolls back and halts rather than skipping.
- Ordered logical content digests and stopped-state rebuild tests prove
  deterministic replay for the current derived contract.
- The stopped rebuild path refuses a live Authority and preserves the prior
  derived target on failure.

These are strong foundations. They are not by themselves a complete content-
permission system.

### Permission invariants landed only in the fixed pilot

The canonical invariants are constitutional globally. The code baseline
implements the following only for the exact
`pilot-member-readable-v1` two-membership operation. No row in this table is a
claim of general enforcement.

| ID | Baseline enforcement | Negative boundary |
| --- | --- | --- |
| `INV-01` | Bounded pilot implemented: active marker membership is checked before the canonical-log loader, and only notice-qualified immutable pointers can be candidates. | No search, scoring, model, general candidate scope, or reusable policy engine exists. |
| `INV-03` | Bounded pilot implemented: there is one closed readable result and no discovery, target lookup, hidden count, or general metadata surface. | No approved discoverable projection or general invisible/discoverable/readable resolver exists. |
| `INV-04` | Bounded pilot implemented with one fixed policy/witness literal. | No multi-path witness selection or general explanation engine exists. |
| `INV-05` | Bounded pilot implemented through the constitution's reviewed immutable-content exception plus final transaction-owned Person recheck, exact-response audit, and byte handoff. | The general cross-head Authority fence for mutable projections, effects, search, or models is not implemented. |
| `INV-06` | Bounded pilot implemented: invalid marker/index/evidence, projection, storage, or audit state returns fixed unavailable/deny behavior and no content. | This has not been proved across future policy paths or search/model failures. |
| `INV-07` | Bounded pilot implemented by absence and bounds: fixed pointer/item/byte caps, no cursor/count/facet/rank/cache/model context. | Candidate-scoped search statistics, ANN traversal, graph structure, and caches are not implemented. |
| `INV-09` | Bounded pilot implemented: activation fixes the pair, Slack shows/verifies the audience notice, and append eligibility requires the immutable proof. | There is no general intent surface, floor, participant path, or grant policy. |
| `INV-10` | Bounded pilot implemented: authenticated allow/deny decisions commit minimized evidence and exact response digest before bytes; audit failure denies. | General audit retention/export/admin-isolation governance is not established for all future response types. |

Pilot evidence is concentrated in:

- [pilot log migration](../../services/organization-record/migrations/log/0002_permission_pilot.sql);
- [pilot reader](../../services/organization-record/src/retrieve/permission-pilot-reader.ts);
- [Authority recent-decision flow](../../services/organization-authority/src/application/organization-authority.ts);
- [record pilot tests](../../services/organization-record/test/permission-pilot.test.ts); and
- [full acceptance test](../../tests/integration/permission-pilot-full-acceptance.test.ts).

Two constitutional invariants are not classified as pilot-enforced controls:

- `INV-02` has a supporting foundation: current content does not stamp live
  reader lists, but the pilot uses a separately reviewed immutable named-pair
  marker. That is not the future fact-derived general model.
- `INV-08` is not exercised: the pilot has no model path. Absence of a model is
  not a landed control proving that future models cannot widen access or bind
  identity.

## Not yet implemented globally

### Global permission constitution

No canonical permission invariant is globally implemented across a general
retrieval/search/model surface. The bounded pilot evidence above must not be
generalized. Job B is locally committed at
`588b42828d5c811a4ae51b21e881139109e7e46d` for the bounded lexical-search
contract over two explicit policies, and final local gates passed. It remains
neither pushed, merged, deployed, founder-live qualified, client-live, nor
released, and its controls must not be claimed for any other operation. In
particular:

| ID | Missing general implementation |
| --- | --- |
| `INV-01` | A general caller-scoped candidate-set API that all search, ranking, tool, and model paths must use. |
| `INV-02` | Current fact/identity/effect resolution independent of immutable content, with no frozen resolved-reader lists. |
| `INV-03` | A deliberately approved discoverable projection and exact invisible/discoverable/readable resolver. |
| `INV-04` | Deterministic path selection and safe witnesses across multiple policy paths. |
| `INV-05` | One Authority-owned fence across Person, permission effects, content/derive heads, policy, retrieval generation, final audit, and response commitment. |
| `INV-06` | Complete fail-closed behavior across optional independent paths, restore, search/index corruption, model/tool faults, and diagnostics. |
| `INV-07` | Caller-scoped lexical/vector statistics, graph closure, facets, cursors, ranking, caches, and model context. |
| `INV-08` | Enforced model/tool boundaries preventing access widening, identity binding, moving policy versions, or automated widening acts. |
| `INV-09` | Versioned human intent and policy-consequence surfaces beyond the fixed pilot notice. |
| `INV-10` | Query-audit visibility, retention, export, expiry, and minimization covering every future served operation without becoming a reverse disclosure surface. |

### Adopted feature invariants and the next reviewed contract

| ID | Invariant | Normative status | Current implementation |
| --- | --- | --- | --- |
| `INV-11A` | **Reviewer reads start from append-atomic, text-free facts.** Select only immutable facts co-committed with the verified Layer 1 record; release content only through a request-local binding after current-Person resolution; missing fact/reprojection/binding or broad-store bypass denies. | Approved implementation contract in A; founder-confirmed 2026-08-11 | Implemented at Job A baseline `03167cfd`: closed reviewer-v2 append, co-committed immutable facts, startup admission, exact indexed selection, request-local binding, canonical reprojection, final current-Person recheck, separate query audit, signed route/client/CLI, and restart lifecycle tests. Not merged or live-qualified. |
| `INV-12` | **Content-visibility approval binds consequence.** Human-visible consequence, exact actor principal/membership, complete presented release draft, and provider evidence are cryptographically bound over Authority semantic bytes and verified before append. | Approved implementation contract for `restricted-reviewer-v1` in A and the separate `organization-member-readable-v1` extension in B | Implemented for the reviewer policy at Job A baseline `03167cfd`: deterministic release draft and presentation, frozen Slack contract, credential/card verification, signed schema-v2 permission request, Authority semantic/message proof, immutable integration audit, append capability, and cross-layer agreement tests. The organization-member-readable consequence/schema-v3 extension is implemented at Job B baseline `588b428`, with shared pre-push hardening at `c0a498f`; final local gates passed. It is not merged, deployed, founder-live qualified, client-live, or released. |
| `INV-11B` | **Permission-aware derived retrieval begins with text-free, rebuildable facts.** Layer 2 creates a request-local scope over provenance-bound facts; protected content/search/embeddings/statistics/cross-record projections require that scope and one versioned generation contract. | Approved implementation contract in Job B; founder-directed 2026-08-12 | Implemented at Job B local baseline `588b428`: one local lexical operation over only `restricted-reviewer-v1` and `organization-member-readable-v1`, with append-atomic admission facts, physically isolated fact/content/lexical segment planes, an immutable exact-head generation, request-local scope, per-item term-frequency scoring, final Authority fence, and isolated audit. Final local gates and independent acceptance/security review passed. No vector, graph, discovery, cache, model, external provider, or general policy engine is included; operational restore reconciliation and founder-live gates remain outstanding. |

`INV-11A` and `INV-11B` are distinct, complementary invariants for sequenced
serving stages, not a fork or two numbers for the same implementation. A uses
a Layer 1 append-side physical index for one per-record reviewer operation. B
governs a later mutable, searchable, cross-record Layer 2 corpus and does not
supersede A. `INV-12` is the upstream admission rule either can consume, but
its current implementation claim remains reviewer-only until Job B's distinct
organization-member-readable admission family lands and passes review.

### Approval-surface v2 rules not yet implemented

These are directional product rules rather than adopted invariant numbers:

1. Human edits must be visible as edits and preserve the machine-draft digest.
2. Evidence quotes are immutable; a bad attachment may be removed, but quoted
   words cannot be rewritten, and a claim without evidence cannot ship.
3. The installation signature covers the final edited bytes.
4. One-tap approval remains the clean-case default; intent, links, and editing
   are exception paths.

The current reaction surface still does not implement that general workbench.
Job A implements only its approved narrow reviewer-policy approval mode.

### Other architecture explicitly deferred

- verified attendee identity and correction/effect projections;
- discoverability, requests, grants, expiry/revocation effects, teams, roles,
  collections, and reverse `who`;
- lexical retrieval beyond Job B's fixed local term-frequency operation,
  vector retrieval, embeddings, graph-wide interpretation, facets/cursors,
  shared statistics, query caches, and online retrieval generations;
- model composition, citations/grounding enforcement, agent/tool release, and
  Layer 4; and
- multi-writer/distributed authorization fencing.

## Revalidation rule

Update this registry whenever any of these change:

- an envelope, policy, Person/effect, or retrieval-generation schema version;
- a new content-reading route, search/index, model, agent, tool, cache, or
  discovery surface;
- restore/reconciliation or multi-writer behavior;
- audit visibility, retention, export, or expiry;
- the code baseline used for an implementation claim; or
- founder-live/client-live promotion evidence.

An invariant may move to **globally landed** only when merged code at a named
baseline, adversarial coverage across every relevant serving surface, and
current deployment evidence all exist. Until then, record the narrower
enforcement scope explicitly.
