# Server-core migration lean-down plan v4

**Status:** active initial-V1 execution plan, written 2026-08-20 against
`77a212134fce762fdffd30e028f3256ba6e75b42` and checked for product parity
against `main@4665c3a93187095d5d14acbe95e825cd69aaf31e`. Reversible offline
inventory, transport slimming, and additive replacement work may proceed while
the contract packet remains draft/proposed. Live reset, sole-writer cutover,
and compatibility deletion remain blocked until the named decisions and parity
gates are accepted against exact artifacts.

This plan deliberately does not try to finish every byte-level v2 contract in
Phase 0. The first pass preserves main's product behavior and moves exact
schemas, canonical vectors, and negative cases into the phase that implements
their owning boundary. A later iteration may narrow or consolidate behavior,
but only through an explicit delta from main.

**Governing decisions:**
[ADR-0001](../decisions/ADR-0001-organization-operated-server-core.md) and
[ADR-0002](../decisions/ADR-0002-external-oidc-person-sessions.md) are accepted
and binding. This plan narrows their implementation; it does not reopen them.

**Historical context:**
[server-core migration plan v3](2026-08-17-server-core-migration-plan-v3.md)
records how the server-core direction was selected and the earlier migration
sequence. It remains historical decision context, with only a pointer to this
successor added. This document is the active plan for finishing the migration
against the current repository.

**Objective:** remove the installation-era compatibility system and redundant
transport ceremony, leaving one organization-operated Authority per
organization, 1:N human memberships, Person-authenticated reads and controls,
server-owned processing, and the existing permission-aware record and
retrieval foundation.

This is a clean-state migration. The founder-stated planning premise is that
there is no customer state to preserve, but Phase 0 does not treat that premise
as the artifact-bound attestation. The founder state may be reset only after
D0/ADR-0004 is accepted and through the explicit lineage cutover in this plan.
Clean state removes the need for online V1 history serving; it does not
authorize reinterpretation of V1 bytes or deletion of accepted permission
semantics.

## Scope boundary

### In scope

- replace employee-installation identity with Person sessions and one narrow
  internal Authority writer;
- replace installation-bound approval authorization with a server-owned Slack
  approval binding rooted in current human membership and verified provider
  identity;
- make Person HTTP bodies semantic and derive actor, organization, subject,
  route, and operation from authenticated server context;
- start all live databases on an explicit new-state schema lineage;
- delete installation enrollment, access leases, installation signatures,
  installation-signed reads, installation-bound Slack requests, compatibility
  bridges, and their unneeded exports, fixtures, tests, SQL, and documentation;
- retain and reverify the complete Layer 1 through Layer 3 authorization path;
  and
- reduce workspace exports and dependencies to the current runtime closure.

### Out of scope

- Layer 4 answer composition, prompts, retrieval-to-answer orchestration,
  agents, tools, streaming answers, or citation generation;
- a generic policy engine, generalized service-principal framework, or generic
  integration plugin system;
- a multi-tenant Authority, shared cross-organization database, or central
  tenant registry;
- multiple Authority writers, distributed authorization fencing, HA, or a
  database replacement;
- new content policies, membership types, discovery levels, teams, roles,
  direct grants, or caller-selected policy unions; and
- same-principal rehire/new-tenure onboarding, OIDC binding retargeting, or
  principal merge. V4 invitations create a new principal and membership; and
- production hardening unrelated to removal of the compatibility boundary.

## End state in plain English

- One organization runs one Authority. It onboards an owner and any number of
  employees; v4 proves an owner plus at least three employees.
- An administrator creates or revokes memberships, issues one-time human login
  invitations, and connects the organization's Slack and meeting source.
  Humans authenticate through OIDC and link their own Slack identity.
- The server pulls meetings, runs the selected processing adapter, freezes the
  approval card and policy consequence, and accepts an exact human approve or
  reject action. After an approved canonical append, the processing core sends
  the approved snapshot through every configured delivery surface, as on main;
  rejection sends nothing. Source custody never becomes approval authority,
  and delivery configuration never changes Layer-3 reader policy.
- An approved act enters the canonical record through one Authority-owned
  writer. A rejected act is durable and auditable but creates no readable
  content, retrieval entry, delivery, or hidden count.
- Layer 1 is canonical append-only truth; approved records atomically add
  text-free eligibility facts, while rejected records add none. Layer 2 is a
  deterministic, exact-head, rebuildable retrieval generation. Layer 3
  resolves the current Person and membership, scopes candidates before
  content or scoring, rechecks at the final fence, commits one minimized audit,
  and only then releases bytes.
- Both the restricted-reviewer and organization-member-readable policy families
  remain first-class, live, tested paths. Their current `v1` bytes remain
  historical; D2/D3 mint explicit new-lineage contract versions for the Person
  and Authority actor model. Neither family is a fallback for the other.
- The processing core keeps four typed capabilities: source, processor,
  approval, and delivery. Concrete adapters are selected directly by the one
  composition root; there is no generic in-memory plugin registry. Persisted
  adapter identities, instances, provider connections, bindings, and frozen
  versions remain load-bearing identity evidence.
- The current operator surface is one canonical JSON administration API plus a
  thin CLI for the required onboarding and recovery operations. The duplicate
  browser console and installation-management UI are gone.
- Layer 3 has a caller-neutral authorized-result application boundary rather
  than an HTTP-only handoff. The current HTTP release adapter deterministically
  serializes the prepared result into a private immutable buffer, submits that
  exact digest to the final fence/audit, and writes the unchanged bytes only
  after commit. A future Layer 4 would require its own purpose-specific release
  contract and audit; it may never open raw record, projection, or retrieval
  storage.
- Person read surface retains the standalone reviewer-recent operation backed
  by verified Layer-1 facts/canonical rows, plus permission-aware search backed
  by the exact-head Layer-2 generation and the owned exclusion controls. They
  share Person/session resolution, the final authorization fence, and the
  minimized audit machinery, but not their availability substrate. A later
  route consolidation is outside this initial V1.
- No employee machine has an enrollment, signing key, lease, database, outbox,
  worker, provider credential, or record-writer role.

## Plain-English deletion target

The intended deletion is the old way of reaching the product, not the
permission model itself:

1. Delete employee-machine enrollment, keys, leases, signing, local databases,
   background services, outboxes, fleet/update code, and recovery commands.
2. Delete the server's internal loop through those machine contracts: the
   compatibility bridge, signed V1 permission requests, lease refresh, signed
   record-ingest transport, installation-scoped receipts, and their schemas.
3. Delete duplicated caller assertions in Person request bodies. Bearer/session
   state supplies actor, Authority, organization, subject, method, path, and
   operation; bodies contain only operation input.
4. Delete the unused in-memory generic adapter registry and other no-caller
   wrappers. Keep typed ports, `AdapterIdentity`, adapter configuration,
   persisted instance/binding identities, and direct composition.
5. Use the atomic stopped source-activation command that replaced the
   incompatible one-meeting canary, structured-text live orchestration, and
   canary-only store APIs in Phase 2B. Keep structured-text only behind the
   offline replay corpus; move or delete that remaining migration evidence
   only after parity gate D5 closes.
6. Replace the separate file delivery journal with the same pre-call
   attempt/unknown/outcome semantics in SQLite, then delete the file-locking and
   second persistence subsystem.
7. Keep the standalone reviewer-recent behavior and its Layer-1 availability,
   while consolidating duplicated route-specific audit infrastructure into one
   minimized Person-read decision audit after D6 fixes retention and export
   policy. Audit-before-release and both policy reader sets are retained.
8. Delete duplicate exclusion repositories, test-only public store methods,
   unused compatibility presentation branches, one-caller aliases, stale
   exports, dependencies, tests, boundary rules, and docs.
9. Keep the canonical JSON administrator API and a thin CLI; delete the
   browser administrator console only after organization onboarding,
   membership invitation/revocation, Slack onboarding, approval/delivery
   activation, opaque identity-chain inspection, and required recovery all
   have command parity.
10. Start a deliberately new state lineage and replace historical migration
    chains with one exact baseline per retained database role. Never edit old
    migrations in place or open an old database as the new lineage.

At the reviewed commit, the gross candidates include 29 historical SQL files
(5,870 lines), roughly 900 lines of file receipt/locking code, roughly 800
lines of stopped-canary/structured-text production code, several thousand
lines of duplicate audit maintenance, and about 3,500 direct source/test lines
in the browser console. These are inventory figures, not a promised net
deletion: replacement code and retained negative tests count against them.

## Target topology

```text
one organization
  -> one Authority
  -> one immutable organization_id
  -> one owner + N employees, with the v4 fixture proving N >= 3
  -> organization-owned keys, state, and provider connections
  -> Person sessions for each human

meeting source adapter
  -> provider-neutral processing core
  -> approval surface adapter
  -> exact human approve or reject act
  -> Authority record writer
  -> Layer 1 canonical record and approval-only append-atomic facts
       |-> Layer 2 deterministic projection / bounded lexical generation
       |     -> Layer 3 prepare, current-Person fence, audit, release bytes
       `-> delivery surface adapter, for an approved delivery workflow only
```

The v4 deployment and qualification target is exactly one organization and one
Authority. The architecture remains repeatable: a later organization receives
another isolated Authority rather than a tenant selector in this one. A small
foreign-Authority fixture may be used only to prove rejection at the trust
boundary; it is not a second product deployment or a multi-tenant feature.

Within the Authority, membership cardinality is unbounded by product
constants. The acceptance fixture contains one owner and at least three
employees. No policy, schema, route, fixture, or administrator surface may
assume exactly two people.

Approval and delivery remain separate typed capabilities even when Slack
implements both. A successful approval is not proof of delivery; a delivery
receipt is not approval evidence.

## Non-negotiable preserved behavior

### Organization and human identity

- Organization initialization creates one immutable Authority/organization
  binding and an owner membership.
- An owner or authorized administrator can provision any number of `owner` or
  `employee` memberships and revoke an exact membership tenure. Each v4 human
  invitation creates a new principal plus membership; an existing OIDC binding
  is never retargeted to a different tenure.
- A human invitation means a one-time Person login grant for one exact active
  membership, expected OIDC issuer, and approved work-email digest. It does
  not mean an installation enrollment grant.
- OIDC keeps exact issuer/subject binding, state, nonce, PKCE, verified-email
  admission, single-use bootstrap grants, grantless returning login, rotating
  session families, refresh replay closure, and current-membership rechecks.
- Administrator-console sessions remain separate from Person sessions.
- Organization Slack tool onboarding remains an owner-attributed operation.
  A Person Slack challenge links one verified tenant-namespaced Slack human to
  one exact principal and membership.
- One human may use separate Person sessions against separate Authorities.
  No Authority may accept another Authority's session, principal,
  organization, provider connection, or record identifiers.

### Load-bearing adapter-to-ECHO identity spine

[INV-IDENTITY-005](../invariants/INV-IDENTITY-005-adapter-to-echo-identity-chain.md)
is a v4 deletion boundary. Every provider-observed human approve or reject
action that can create a canonical ECHO human act follows one explicit chain:

```text
canonical configured Authority origin / authority_id / organization_id
  -> verified organization provider connection and opaque credential handle
  -> exact capability adapter kind / id / instance / version / binding
  -> frozen provider object, destination, action mapping, and policy contract
  -> tenant-scoped provider actor
  -> active external identity link
  -> exact ECHO principal and membership tenure
  -> explicit approve or reject capability
  -> observed human approve or reject intent
  -> provider-action commitment and integration-audit event ID/hash
  -> exact Authority record-resolution reproof
  -> canonical approve/reject record and append receipt
  -> approval-only append-atomic policy facts
```

No edge implies the next one. In particular:

- a provider connection does not identify a human or grant an adapter action;
- an adapter instance or binding is not a provider account, ECHO principal, or
  permission by itself;
- an external identity link maps one provider issuer/tenant/subject to one
  principal and membership tenure but grants no action;
- a current membership grants organization presence, not approval authority;
- a source adapter identity and owner binding prove custody/provenance, not a
  participant identity, approver, or reader; and
- a bare Slack user ID, email, display name, meeting participant, source owner,
  model output, or matching text never substitutes for an explicit link.

Provider identities are complete, tenant-scoped tuples. For Slack, tool proof
binds workspace, enterprise scope, app, bot, bot user, granted scopes, channel,
opaque secret handle, and verification evidence; human proof binds issuer,
workspace, and user. Repair requires fresh provider proof and one atomic update
across every affected connection and binding. A missing or mismatched tuple
member denies rather than being inferred or backfilled.

| Adapter capability | Identity linked to ECHO                                                                                                                                                                                                           | Authority it may carry                                                                                       |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Meeting source     | Adapter kind/ID/instance/version, organization provider credential and provider account/tenant when authoritatively exposed, external object/canonical/normalizer/provider revision, source binding and custody owner observation | Source provenance and custody only; never approval or read permission                                        |
| Decision processor | Adapter kind/ID/instance/version plus processing/prompt/model contract digest                                                                                                                                                     | Transformation provenance only; never human, policy, or reader identity                                      |
| Approval surface   | Verified tool connection, adapter binding, frozen provider object/destination/action mapping, tenant-scoped human link, exact principal/membership tenure, explicit action capability                                             | One exact approve or reject act under the frozen consequence                                                 |
| Delivery surface   | Distinct delivery adapter kind/ID/instance/configuration, destination, durable attempt, provider object reference, and receipt                                                                                                    | Recoverable publication of an already approved canonical snapshot; never approval evidence or a reader grant |

Shared transport does not merge these rows. A Slack connection may support both
approval and delivery, but each capability retains its own identity and
configuration, authorization basis, idempotency, and receipt meaning.
The lean design does not invent a second human grant for delivery: the approved
record authorizes the workflow, while the configured delivery adapter owns its
external side effect. Approval and delivery Slack channels remain distinct.

Source, processor, and delivery chains do not manufacture the human identity
chain above. Source uses current organization credential/custodian authority;
processor uses frozen transformation provenance; delivery uses the canonical
act plus its own destination, durable attempt, and receipt. None is allowed to
stand in for an approver or reader.

Source custody remains a live pre-record edge. Until the immutable human-action
audit is durably committed, the exact active custodian membership is required
for provider pulls and every pending-work mutation. Revocation known before a
call produces zero new provider calls and pauses pending advancement;
revocation during an in-flight call makes the final custodian fence discard the
result and commit no cursor, candidate, or pending mutation. Resumption requires
one administrator-credential-authorized activation targeting a fresh current principal/membership that
re-verifies the organization credential and references the exact frozen
pipeline contract; it grants no approval/read capability and neither mutates
nor reprocesses frozen candidate bytes. A change to any pipeline or per-meeting
processing-key member creates a different candidate identity. Once the
human-action audit is durable, later custodian revocation does not strand
canonical record resolution or append-receipt recovery.

Permission-aware read begins a separate current chain:

```text
canonical configured Authority origin
  -> server-resolved Authority / organization / state lineage
  -> bearer credential / family / OIDC binding
  -> principal / exact current membership tenure
  -> request-local policy scope
  -> canonical policy fact / exact-head retrieval generation
  -> final current-state fence / minimized audit
  -> bytes
```

The adapter/provider chain proves the historical human act admitted to Layer 1;
it does not become a new reader grant. Restricted-reviewer reads match the
frozen principal and exact membership tenure. Organization-member reads use the
caller's current active owner/employee membership; the approving actor remains
provenance. Layer 3 never authorizes from a live Slack link, adapter binding,
source identity, participant observation, or model inference.

After append, restart verification, deterministic rebuild, and reads reprove
the immutable canonical authorization audit/proof. They do not require the
current Slack connection, external identity link, approval binding, or current
recording configuration to remain active. Rotating or revoking those mutable
edges blocks future provider actions but cannot make an admitted record
unverifiable or silently change its reader policy. Current Person membership is
still rechecked at every read.

### The two retained content-policy families

The restricted-reviewer and organization-member-readable meanings remain two
closed, non-interchangeable policy families. Their current identifiers and
digests are not reusable blindly:

- current `organization-member-readable-v1` consequence bytes explicitly
  require an enrolled installation and unexpired lease, and its policy contract
  pins V1 permission request, authorization-evidence, and envelope schemas;
- current reviewer record authorization also carries installation-era proof;
  and
- changing those bytes under the same identifier would invalidate approval
  presentations, semantic-intent digests, record facts, and qualification.

D2/D3 therefore define explicit new policy/envelope/authorization versions for
the new lineage. Old `v1` bytes keep their old meanings and are rejected by the
new writer. The accepted, human-visible delta is installation/lease identity to
current Person/session identity; the reader sets and policy separation below do
not change.

| Policy                                            | Immutable human consequence                                                                                                                                            | Current read condition                                                                                                                                                                     |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Restricted reviewer, new-lineage version          | The approved record names the exact approving principal and exact approving membership tenure.                                                                         | The current Person principal and exact active membership equal that frozen reviewer tuple. Any different membership ID denies; v4 creates no same-principal replacement-tenure login path. |
| Organization member readable, new-lineage version | The human explicitly approves readability for every Person with a current active owner or employee membership in this organization, including someone who joins later. | The caller currently has an active `owner` or `employee` membership in the record's organization. Revocation denies; a separately invited later employee qualifies.                        |

Every record selects exactly one policy. There is no missing-value default,
fallback, structural guessing, caller-provided policy selector, or conversion
between the families. Read membership is not approval authority. The approval
surface freezes the human-visible consequence, exact policy contract,
presentation, staged content, approving human, and provider evidence before
the Authority writer may append.

### Layer 1 through Layer 3

- **Layer 1:** the canonical append-only record stores the exact human-approved
  or human-rejected act, bounded content or rejection evidence, provenance,
  authorization evidence, policy contract, canonical hash, Authority receipt,
  and hash-chain position. Eligibility facts are text-free and committed in
  the same transaction as the verified record.
- **Layer 2:** deterministic projections and immutable retrieval generations
  remain rebuildable from verified Layer 1 at an exact record head. Facts,
  content, and lexical planes remain physically and logically separated.
  Policy namespaces remain distinct: member-readable segmentation binds the
  organization and exact policy contract, while restricted-reviewer
  segmentation additionally binds the exact principal and membership tenure.
  Candidate selection, term statistics, counts, and scoring operate only
  inside the request-local authorized scope.
- **Layer 3:** every served Person operation authenticates the bearer session,
  resolves exact current Person and membership state, selects through the
  reviewed policy path, rechecks mutable state and pinned heads at the final
  Authority fence, commits minimized allow or deny audit evidence, and only
  then releases bytes.

The constitutional invariants remain binding: authorize candidates before
scoring; never put resolved reader lists in content; keep existence and content
rights separate; return a safe sentence-form witness for every positive path;
keep check and use in one consistency boundary; fail closed; scope structure
and statistics before computation; allow no downstream widening; do not turn
recording into an implicit recipient list; and audit before response without
creating a second disclosure surface. `INV-11A`, `INV-11B`, and `INV-12`
remain in force for their approved scopes.

## Document authority and required dispositions

The documents do not all describe the same point in the migration. The order
of authority for v4 is:

1. accepted ADR-0001 and ADR-0002;
2. the permission constitution, approved append/derive and two-policy designs,
   and the invariant registry;
3. current architecture/component documents checked against code;
4. this execution and deletion plan; then
5. historical migration plans and immutable qualification reports as evidence
   for their exact source/artifact/configuration/state only.

V4 does not silently pick the newest prose. Each conflict below has an explicit
disposition:

| Existing contract or claim                                                                                                                                                                                                                    | Conflict exposed by the sweep                                                                        | V4 disposition                                                                                                                                                                                                   |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Permission architecture](2026-08-09-organization-permission-architecture.md) ordinary reads use an installation and lease, while [ADR-0002](../decisions/ADR-0002-external-oidc-person-sessions.md) and current V2 code use Person sessions. | Person/Authority service-actor semantics are still only a proposed amendment.                        | Close D1 with an accepted narrow amendment before deleting installation authority. Person remains the sole human read actor; the service actor receives no ordinary-read capability.                             |
| [Trusted Layer-2 design](2026-08-11-trusted-permission-aware-searchable-layer-2-design.md) retains the Pilot and separate reviewer path while adding member-readable search.                                                                  | The lean target keeps both approved policies but not the fixed two-person Pilot transport/substrate. | Preserve reviewer and member meanings exactly. Retire Pilot only through D5 and a rebaselined two-policy contract; never reinterpret Pilot rows.                                                                 |
| Reviewer and readable-search designs freeze separate 180-day audit/export/expiry systems.                                                                                                                                                     | Those parallel maintenance systems duplicate one semantic decision fence.                            | Keep audit-before-release. D6 must accept one minimized Person-read audit, explicit retention, whole-row expiry, and an explicit export decision before old audit systems are deleted.                           |
| [Append/derive design](2026-08-07-org-decision-record-append-derive-design.md) and the Layer-2 design freeze separate canonical, derived, facts, content, and lexical storage roles.                                                          | Merging databases looks lean by file count but erases a qualified trust boundary.                    | Preserve the logical and current physical roles in v4. Squash history only within a brand-new lineage; database consolidation is not part of this plan.                                                          |
| ADR-0001 requires frozen pre-record work, approve/edit/reject outcome evidence, a member exclusion valve, and 30-day terminal cleanup.                                                                                                        | Some implementations are currently test-only or unwired and therefore look dead in a caller scan.    | Treat them as missing required behavior: wire a lean report/cleanup path or obtain an explicit superseding decision. Do not delete them as unused code.                                                          |
| ADR-0002 and workspace architecture require old bytes to keep their meaning and old migrations to remain immutable while served.                                                                                                              | A migration squash would otherwise appear to rewrite history.                                        | D0 authorizes a whole-state reset; the new artifact uses new application IDs, manifests, envelope kinds/versions, and genesis, and rejects all old or mixed state. Historical files remain unchanged in history. |
| Existing qualification reports are green for exact old artifacts and two-policy generations.                                                                                                                                                  | Source, schema, adapter, actor, or state-lineage changes invalidate those claims.                    | Mark them historical; never rewrite them. Phase 6 creates a new matrix and exact run for the lean artifact.                                                                                                      |
| Current adapter docs promise four LLM transports and a canary-to-worker flow; current composition selects OpenRouter and cannot resume the structured-text canary candidate.                                                                  | Architectural allowance and operational reality are conflated.                                       | Preserve the provider-neutral processor port. Rebaseline concrete drivers and replace the canary as described below; do not call either old claim current.                                                       |

Any change to an accepted ADR or frozen product decision is a separate
superseding decision, not a cleanup patch. This plan may name and gate that
decision but cannot manufacture its acceptance.

## Deletion classification

The classification is semantic. A file moves to **safe-delete** only when its
runtime callers and unique accepted behavior are both absent. A matching name
or `v1` suffix alone is never deletion evidence.

### Preserve

| Surface                                                                         | Required disposition                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One Authority per organization                                                  | Preserve the immutable Authority and organization binding, isolated keys and databases, and absence of a tenant selector.                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Principals and 1:N memberships                                                  | Preserve provisioning, invitation, current membership lookup, revocation, audit, and arbitrary employee cardinality.                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Person login grants, OIDC bindings, attempts, session families, and credentials | Preserve their exact human identity and revocation meanings. These are the replacement identity foundation.                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Organization Slack tool onboarding                                              | Preserve verified workspace, app, bot, scopes, channel, opaque secret handle, and owner-attributed audit.                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Provider connection attempts and organization tool connections                  | Preserve authoritative provider proof, issuer/tenant/tool tuple, verification digests, stable connection identity, public configuration, opaque credential reference, activation state, and atomic identity repair.                                                                                                                                                                                                                                                                                                                               |
| Person Slack identity links                                                     | Preserve the tenant-namespaced provider-human link ID and its exact issuer, tenant, subject, principal, and membership tenure. The link grants no action by itself.                                                                                                                                                                                                                                                                                                                                                                               |
| Adapter identities and persisted bindings                                       | Preserve capability kind, adapter ID, instance ID, version, connection/binding ID, destination, action mapping, frozen policy/presentation contract, and state needed to resolve pending work. The unused in-memory registry is unrelated.                                                                                                                                                                                                                                                                                                        |
| Approval capabilities and integration audit proof                               | Preserve explicit approve/reject capability edges and the immutable provider-event/identity-link/connection/binding/actor proof consumed by record admission. Replace installation ownership without deleting the semantic chain.                                                                                                                                                                                                                                                                                                                 |
| Source identity and custody binding                                             | Preserve the pipeline contract, organization credential proof, exact active custodian principal/membership, cursor/cutoff lineage, per-meeting external object and revision provenance, and final custodian fence. Before durable human-action audit, known revocation blocks new provider calls and pending advancement; an in-flight result is discarded without mutation. Fresh atomic custody activation may reference the unchanged pipeline/candidate. None confers approval or read authority.                                             |
| Member source and meeting exclusion controls                                    | Preserve Person ownership, current-state checks, server-side admission enforcement, and minimized audit.                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Typed processing ports                                                          | Preserve distinct meeting-source, processing, approval-surface, and delivery-surface capabilities and inward dependency direction.                                                                                                                                                                                                                                                                                                                                                                                                                |
| Canonical record, derive, and retrieval boundaries                              | Preserve append-only truth, canonicalization, hash chain, deterministic derive, immutable retrieval generations, and data-at-rest ports.                                                                                                                                                                                                                                                                                                                                                                                                          |
| Both current policy families                                                    | Preserve exact reviewer-tenure and organization-member semantics, frozen consequences, domain separation, facts, witnesses, and denial behavior. Layer-2 namespaces stay distinct: member segments bind organization plus policy contract; reviewer segments also bind exact principal and membership tenure.                                                                                                                                                                                                                                     |
| Person Authority root                                                           | Preserve the configured canonical Authority origin and the server-resolved Authority/organization/state-lineage binding on every authenticated request. Persisted returned IDs may remain display/correlation metadata, but are not an independently provisioned trust pin. Do not retain old installation pin machinery under that name; adding a descriptor digest pin would be a separate contract.                                                                                                                                            |
| Person response contracts                                                       | Preserve bounded content shapes, policy witnesses, opaque denial behavior, and absence of hidden counts or metadata.                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Audit and consistency fences                                                    | Preserve start/end Person resolution, versioned actor evidence, exact response digest, audit-before-bytes, and failure-denies behavior.                                                                                                                                                                                                                                                                                                                                                                                                           |
| Approval/delivery separation                                                    | Preserve main's separation: approval produces the canonical approved snapshot; the core then sends it through every configured delivery surface, and rejection sends nothing. Approval identity never authorizes delivery and delivery receipts never authorize reads or approval. Slack approval and generic delivery channels remain distinct. The current live composition may configure one Slack surface, but the typed core retains array cardinality and this migration does not redefine delivery audience or bind it to a reader policy. |
| Central integration and record anchors                                          | Preserve organization-scoped provider/record installation anchors that describe central workspaces rather than employee machines.                                                                                                                                                                                                                                                                                                                                                                                                                 |

### Replace before delete

| Legacy surface                                                   | Required replacement and proof                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Server installation compatibility bridge                         | One accepted, narrowly scoped Authority processing actor and one Authority record-writer application port. No generic service impersonation or Person reader.                                                                                                                                                                                                                                                                                                                                             |
| Installation enrollment and access lease root                    | Current membership plus the accepted server approval/writer bindings. No record or approval call site may resolve an enrollment, installation key, or lease.                                                                                                                                                                                                                                                                                                                                              |
| Installation-signed permission checks                            | Server-owned approval authorization that rechecks the exact active membership, Slack identity link, organization tool, approval binding, policy capability, frozen card, and live provider act at action time.                                                                                                                                                                                                                                                                                            |
| Installation-bound Slack approval bindings and grants            | An additive server binding rooted in the exact Authority/organization, verified provider connection, approval adapter identity/instance/version, Person-to-provider identity link, current principal/membership tenure, frozen destination/action mapping, and explicit approve/reject capability. It must not merge approval and delivery or give every reader approval authority. Delete only installation ownership fields/rows; preserve stable provider/adapter/ECHO identity edges and audit proof. |
| Installation-signed record envelope and ingest route             | An accepted Authority-writer envelope and in-process append path retaining the exact human act, policy evidence, canonical bytes, log hash, receipt, and retry semantics.                                                                                                                                                                                                                                                                                                                                 |
| Installation-scoped idempotency and receipt fields               | Organization/Authority writer-scoped semantic idempotency and a new receipt/log version. Reuse with different semantic bytes must deny.                                                                                                                                                                                                                                                                                                                                                                   |
| Installation actor fields in integration and query audits        | A versioned actor binding that distinguishes Person, administrator, provider-observed human, and the one internal processing actor without synthesizing installation or Person identifiers. Provider action evidence must still bind the identity link, connection, adapter binding/instance/version, capability, Authority, organization, and exact principal/membership where material.                                                                                                                 |
| Installation-signed reviewer-recent and readable-search requests | Person bearer reviewer-recent and search routes with semantic request bodies, self-only server context, start/end current-state checks, witnesses, and audits. Reviewer-recent remains verified Layer-1/log-backed and available after append before a search rebuild; readable search remains exact-head Layer-2 and fixed-unavailable while stale.                                                                                                                                                      |
| V1 Slack identity-link transport                                 | The existing Person Slack begin/complete path plus a single server-derived idempotency contract for completion. Stored challenge state, not caller duplication, supplies provider message coordinates.                                                                                                                                                                                                                                                                                                    |
| Machine enrollment invitation UI                                 | A Person invitation UI/API that creates a membership and one-time Person login grant. Human onboarding must be visibly named as such and remain usable before machine enrollment UI is removed.                                                                                                                                                                                                                                                                                                           |
| Compatibility administration counts and pages                    | Person membership, invitation, session, Slack link, and current processing views. Remove installation counts only after no current operation depends on them.                                                                                                                                                                                                                                                                                                                                             |
| Person body identity and route assertions                        | Server-derived request context from bearer/session and matched route. Bodies retain only semantic inputs; spoofed identity/route metadata is rejected as an unknown field.                                                                                                                                                                                                                                                                                                                                |
| Fixed two-person pilot path, if still reachable                  | A recorded retirement disposition and parity through the retained reviewer/member policy paths. It must neither limit organization cardinality nor be silently reinterpreted.                                                                                                                                                                                                                                                                                                                             |

### Safe-delete

These items require a zero-caller/export scan and focused tests, but no new
product meaning:

- client-side installation enrollment, signing, key storage, lease renewal,
  machine database, service manager, JSONL outbox, and fleet updater remnants;
- V1 signed-read request DTOs, request builders, verifiers, HTTP constants,
  client commands, and request-only fixtures after Person parity is recorded;
- unused installation onboarding protocol schemas and fixtures after the
  server compatibility bridge and admin enrollment invitation are gone;
- V1 Slack identity-link request-only DTOs and routes after the Person path and
  approval replacement are complete;
- compatibility-only route registration, error mapping, startup wiring,
  configuration, and dependencies after their last server caller is removed;
- legacy installation tables, indexes, triggers, repository methods, counters,
  migration files, and schema builders from the runtime closure after the
  fresh new-lineage baseline has already proved it never creates them;
- tests that assert only removed transport ceremony, replaced by semantic
  contract, policy, denial, and lineage tests;
- stale exports and package dependencies with no current runtime or test
  importer; and
- compatibility prose that claims installation enrollment or leases are a
  current product mode. Historical decisions and qualification records remain
  unchanged.

Do not delete response validators, policy constants, policy fixtures,
canonical envelope test vectors, record/retrieval facts, denial cases, audit
contracts, or boundary tests merely because a request transport is deleted.

## Adapter and core lean-down ledger

### Seams that remain

- `MeetingSourceAdapter`, `DecisionProcessorAdapter`,
  `ApprovalSurfaceAdapter`, `ApprovalGate`, `DeliverySurfaceAdapter`, and
  `CoreStateStore` remain narrow typed ports. The identity-bearing approval
  surface is the adapter/composition facet; only its narrower `ApprovalGate`
  enters the processing cycle.
- The Authority composition root injects concrete capabilities directly. Core
  code imports no provider SDK, HTTP route, filesystem, SQLite implementation,
  credential loader, or composition module.
- `LlmProviderClient` remains the narrow transport seam for the existing
  preprocessing decision processor and deterministic fakes. That processor is
  not Layer 4 and receives only the source revision supplied to its port. It
  receives no Person credential, retrieval handle, global corpus, permission
  decision, or fallback path.
- Approval and delivery remain separate capabilities even when both use the
  same Slack client. Approval freezes the human act; delivery publishes only a
  previously approved, record-owned snapshot.
- Source activation pulls no meeting. It freezes a pipeline contract containing
  source kind/ID/instance/version, cursor/cutoff lineage, normalizer contract,
  and processor kind/ID/instance/version/configuration digest, plus a separate
  current credential/custodian authorization for that contract. Candidate
  creation later combines the pipeline-contract digest with the actual external
  object ID, canonical revision, `normalizer_version`, and nullable provider
  `source_revision`. Pending work is resumed only by that versioned identity,
  never reinterpreted from current configuration.
- One serialized lifecycle owner coordinates polling, pending work, durable
  side-effect recovery, terminal cleanup, and shutdown.
- One Authority-owned record-resolution port sits between an identity-light
  `ApprovalGate` outcome and terminal processing state. The gate/store carries
  one opaque, monotonic `human_act_resolution_ref` containing the exact
  approval ID, action, policy ID/version, integration-audit event ID and entry
  hash, and new provider-action digest. The port resolves only that reference,
  builds/signs the policy-specific approve or reject envelope, appends through
  the governed record application port, and returns the canonical append
  receipt before core may mark work terminal. It never authorizes from
  `reviewed_by` display text or discovers proof through a descriptive scan.
- One Authority repository/transaction owner opens `authority.sqlite` and
  injects domain capabilities. Session resolution and a membership/exclusion
  mutation share one transaction; no per-request adapter reopens the database
  after authentication and rechecks only a subset of authority state.

### Safe implementation cuts

- Delete `AdapterRegistry`, `adapterInstanceKey`, the unused
  `AdapterInstanceConfig`/`AnyAdapter` types, their exports, boundary rule, and
  registry-only test. Production already composes concrete ports directly.
  This deletes lookup scaffolding, not `AdapterIdentity`, `AdapterConfig`,
  provider connections, persisted adapter instances/bindings, processing keys,
  frozen pending contracts, or identity evidence.
- Inline and delete the one-caller `run-live-meeting-cycle` alias.
- Delete the processing store's duplicate exclusion CRUD and use the one
  Authority transaction-owned exclusion repository.
- Make same-class helpers private and delete public store methods that have no
  production caller once their unique negative tests move to the retained
  application port.

### Replace or prove before cutting

| Current implementation                                                                                                                                                                            | Lean replacement and deletion gate                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `organization_recording_policy_v1` combines decision-processor routing with approval policy/adapter authorization.                                                                                | Split it in the new lineage. Source/pipeline activation owns source adapter identity, processor adapter ID/instance/version, processor/config contract digest, and cutoff. D2 owns policy ID/digest plus approval-surface identity/binding. Candidate creation freezes both; processor identity remains provenance and never becomes human authorization. Delete the overlay only after both contracts exist and exact restart/config-drift tests pass.                                                                                                                        |
| Live Slack delivery reuses approval-instance configuration and a separate file attempt journal.                                                                                                   | Preserve main's typed delivery-surface array and different-channel rule, derive no reader audience from delivery, and keep approval identity from authorizing delivery. Move the existing claim/unknown/outcome recovery semantics into SQLite, preserve deterministic configured-surface fan-out and exact snapshot identity, then delete the file journal. A future persisted delivery-activation contract is a separate product iteration.                                                                                                                                  |
| The current processing key omits the meeting-source adapter version and replay normalization strips it; activation-time identity is also conflated with values learned only after a meeting pull. | Create a no-pull pipeline contract for source kind/ID/instance/version, cursor/cutoff lineage, normalizer contract, and processor kind/ID/instance/version/config digest. The new processing key combines that digest with actual external object ID, canonical revision, `normalizer_version`, and nullable provider `source_revision` learned at candidate creation. Replay must preserve every field. Mutating a pipeline or per-meeting member creates a distinct/conflicting candidate; a newly authorized custodian may resume only the exact unchanged tuple and bytes. |
| `process-one-meeting` staged a `structured-text` processing key, while `serve` selected the OpenRouter `llm` key.                                                                                | Completed in Phase 2B. One stopped, atomic `activate-meeting-source` operation validates the exact Person/member and organization credential, freezes the live-only cutoff without pulling a meeting, and converges under retry/concurrency. The canary, baseline helper, canary-only store APIs, and false handoff runbook are deleted. The offline replay corpus remains isolated until D5.                                                                                                                             |
| The Slack approval adapter multiplexes ordinary, Pilot, reviewer, and member presentation/authorization branches, while live composition currently rejects reviewer mode.                         | Compose both retained policies from the frozen pending contract. Keep reviewer schema-v2 approval, member schema-v3 approval, and the common durable rejection authorization. After a state preflight proves no unresolved ordinary/Pilot card, delete only their new-card branches and compatibility resolvers.                                                                                                                                                                                                                                                               |
| Core marks rejection terminal without the same record-first resolution used for approval.                                                                                                         | Add one narrow record-resolution port for both terminal human outcomes. Freeze and append a bounded rejection act before terminal marking; it creates no approved atom, policy fact, retrieval entry, or delivery. Delete older rejection transport only after retry/restart/race tests pass.                                                                                                                                                                                                                                                                                  |
| Slack delivery previously wrote a pre-call attempt/outcome file while core stored provider receipts in Authority SQLite.                                                                          | Phase 2 now puts the atomic pre-call claim and unknown/delivered outcome in the existing Authority processing store. Concurrent and restarted callers observe the durable unknown marker instead of posting. The file journal and process-file lock are deleted; live cutover still requires proof that no old file entry needs import.                                                                                                                                                                                                                                        |
| `approval-outcome-instrument` and terminal cleanup have no live caller.                                                                                                                           | ADR-0001/v3 still require accept/edit/reject evidence and 30-day terminal deletion. Generate the report deterministically from immutable request/resolution rows and schedule bounded lifecycle-owned cleanup, or explicitly supersede those requirements before deleting either implementation.                                                                                                                                                                                                                                                                               |
| Ollama, OpenAI, Anthropic, and OpenRouter drivers are compiled while current live composition fixes OpenRouter and the processor still has an implicit default/fallback.                          | Keep the processor and provider-client seam. If unused drivers are deleted, require an explicit OpenRouter provider, narrow the union/factory, and make a missing or retired provider fail instead of falling back. Current architecture must stop promising the removed drivers, state preflight must find no binding, their qualification becomes historical, and golden tests must preserve the retained processing-version digest and processing key. This does not add the future read model.                                                                             |
| Migration-only synthetic replay and structured-text parity fixtures ship in the production closure.                                                                                               | Move them under test support or delete them only after D5 closes the real-corpus parity requirement, or after an accepted decision explicitly supersedes ADR-0001's parity gate.                                                                                                                                                                                                                                                                                                                                                                                               |
| Person read services separately authenticate, admit, finalize, and append route-specific audits, causing repeated transactions and historical provenance reloads.                                 | Add one joined current-access query and one shared read/fence service. Keep operation-specific policy evaluation, but commit one minimized audit at the final release boundary. Delete duplicate audit repositories and per-route transaction choreography after D6 and race tests.                                                                                                                                                                                                                                                                                            |
| HTTP handlers return pre-serialized authorized bytes with no reusable application result boundary.                                                                                                | Use an explicit `prepare -> deterministic private serialization -> final fence/audit -> release unchanged bytes` protocol. The HTTP adapter may hold but cannot write or otherwise expose the immutable buffer before commit. Keep HTTP as the sole v4 release adapter; a future Layer-4 consumer requires a separate purpose-specific release/audit contract and is not implemented here.                                                                                                                                                                                     |

### Single-Authority state preflight

Before deleting a compatibility resolver, driver, receipt store, or pending-work
path, inspect the one target Authority and require:

- exactly one Authority/organization binding;
- one active owner and at least three active employees in the qualification
  fixture;
- zero unfinished candidate whose frozen processor identity the retained
  runtime cannot resume;
- every pending approval frozen under reviewer or organization-member mode;
- zero unresolved ordinary/Pilot publication before those branches disappear;
- every file delivery attempt imported into SQLite, or a recorded proof that
  no file attempt exists; and
- no active config, binding, pending row, or receipt naming a removed adapter,
  provider, policy mode, key, or state lineage.

This is a one-state deletion preflight, not a generic migration framework.

## Blocking decisions and evidence gates

No semantic or compatibility deletion tranche begins until gates D1 through
D6 are closed. The small safe implementation cuts named above may land in
Phase 1 before semantic replacement, with a zero-caller/export proof and
focused tests; Phase 0 itself remains documentation and contract-fixture tests
only. D0 controls the one founder-state reset.

Phase 0 closes the decisions by accepting exact contracts, canonical fixture
bytes or preimages where applicable, state-transition tables, and named
verification cases. It does not claim that replacement-runtime, race,
restart, or end-to-end cases already pass before that implementation exists.
Those executable cases are mandatory exit evidence in the implementation
phase named by each decision and again in the final qualification matrix.

### D0 — clean-state reset authorization

**Decision:** record founder authorization to discard the current live founder
Authority, control-plane, record, derived, retrieval, and pre-record state and
to re-onboard from empty state.

**Phase 0 acceptance evidence:** an inventory of state roles and schema
lineages; a list of declarative configuration to re-enter; confirmation that
no customer or irreplaceable record is present; and the exact stop,
snapshot-checksum, no-dual-writer, restore, and rollback protocol.

**Phase 4 entry evidence:** a fresh stopped offline checksummed snapshot and a
named old artifact/state pair that were produced under the accepted protocol.
Phase 0 neither reads nor resets live state.

**Blocks:** Phase 4 cutover. It does not block replacement implementation or
offline rehearsals.

### D1 — service actor amendment

**Decision:** disposition the replacement
`permission-constitution-server-core-amendment-v2` proposed by RFC-0001. The
older `permission-constitution-server-core-amendment-v1` review closed without
acceptance. The accepted text must define the one internal actor, its exact
pre-record, record-resolution-write, and post-record-delivery scopes, the
versioned audit evidence, and the prohibition on ordinary Person reads,
generic delegation, arbitrary record access, or invented human acts.

**Required evidence:** a recorded reviewer/founder disposition bound to exact
proposal bytes and an updated invariant trace. A submitted or validated
document is not acceptance.

**Blocks:** implementation of the final service authorization root, record
writer and delivery-worker activation, and every installation-identity
deletion.

### D2 — provider/adapter/ECHO approval identity binding

**Decision:** accept one server-owned Slack approval identity contract that
implements INV-IDENTITY-005. It must answer:

1. which Authority administrator-credential act binds an approval-surface adapter
   kind/ID/instance/version to the exact verified provider connection, opaque
   credential handle, workspace/app/bot/bot-user tuple, channel, and reaction
   mapping;
2. how a durable `(provider issuer, tenant, subject)` external identity link
   maps the observed Slack actor to one exact ECHO principal and membership
   tenure, and how current Authority state revalidates that mapping;
3. how explicit policy-specific approve/reject capabilities join that
   principal/membership/link to the adapter binding without making a link,
   membership, source owner, or content reader sufficient by itself. Existing
   Person Slack schema-v2 completion remains the link-only operation: it creates
   or reuses no adapter binding or grant; a separate administrator-credential-
   authorized activation creates the action capability, and an owner Person
   session cannot satisfy that gate;
4. which connection, link, binding, adapter instance/version, capability,
   provider object, actor, frozen card, approval-surface destination, action,
   policy consequence, and evidence digests become immutable proof for record
   admission, including a new domain-separated provider-action digest preimage
   containing Authority/organization, provider issuer/tenant/tool/actor,
   connection/binding/capability, adapter identity, provider object/action, and
   frozen policy/presentation. The installation-bearing v1 digest is rejected,
   not shortened in place;
5. which new domain-separated integration-audit chain-entry kind and canonical
   preimage bind Authority, organization, new state lineage, actor class,
   stable external-link/connection/adapter-binding/action-capability IDs,
   canonical event/detail digest, predecessor entry hash, and entry hash. The
   installation-bearing entry version is rejected rather than retained with a
   null installation field. Both retained policies independently reconstruct
   the same semantic, provider-message, provider-action, and chain-entry
   commitments from immutable stored evidence during record reproof; neither
   may substitute selected field comparison or current mutable configuration;
6. how policy-specific approve/reject capabilities are represented without
   making content readability an approval grant, and which new policy ID,
   exact closed Person policy-contract body, consequence bytes, computed
   contract digest, authorization schema, and envelope version replace
   installation-era `v1` without changing it in place;
7. which frozen card, channel, app, bot, reactions, policy consequence, and
   exact `echo-approved-decision-snapshot-v2` body/digest are rechecked at
   action time;
8. how revocation or replacement of any link, membership, connection, binding,
   capability or provider identity, plus conflicting reactions, retries, and
   unknown provider outcomes behave; and
9. how approval remains distinct from source custody, read permission, and
   delivery.

The contract must persist and independently rehash exact closed bodies for the
stable organization-tool identity, its current verification/credential state,
approval binding, and action capability. Credential or implementation rotation
may change delivery configuration/attempt provenance without silently changing
approval identity or reposting a completed attempt.
No unspecified digest, partial field comparison, or caller-supplied digest can
stand in for those bodies.

Initial V1 does not redesign delivery authorization or make destination bytes
part of the human approval contract. It preserves main's typed
`deliverySurfaces` array and ordering: after the canonical approval record and
facts commit, core submits the same approved snapshot to every configured
surface; rejection submits to none. Each surface retains its own adapter
identity/configuration, destination validation, semantic idempotency, durable
attempt/outcome, and receipt. Approval and delivery Slack channels must differ.
The live composition may configure one Slack surface, but the core contract is
not narrowed to one. A future approval-bound destination or provider-audience
contract requires a separate accepted product decision.

**Phase 0 acceptance evidence:** approval/delivery capability separation,
at-least-one configured delivery for an enabled processing cycle, array
cardinality, different-channel enforcement, deterministic fan-out ordering,
durable attempt/retry/restart behavior, and proof that delivery never grants
approval or read authority. Executable adapter and crash tests are Phase 2
exit evidence.

Founder acceptance must explicitly confirm the version break: v4 preserves the
two policy families, reader sets, human-visible consequences except for the
named Person/session identity substitution, and denial behavior; it does not
preserve the literal installation-bearing `*-v1` IDs, bytes, or digests. That
is an intentional new-lineage contract decision, never a cleanup inference.

**Blocks:** removal of V1 permission checks, installation-owned binding/grant
representations and their ownership columns, the compatibility bridge, and V1
Slack approval transport, plus removal of the old approval-instance delivery
coupling. It never authorizes deletion of replacement approval/delivery adapter
bindings, action-capability semantics, stable identity links, or immutable
audit/receipt proof.

### D3 — Authority writer envelope

**Decision:** accept a new, domain-separated canonical record and receipt
contract for Authority writing. It must pin:

- the exact human approval or rejection act and its actor/authorization proof;
- one exact identity-chain commitment without copying mutable provider state:
  the record owns Authority/organization, human principal/membership tenure,
  policy/action, one common `human_act_resolution_ref` containing approval ID,
  action, policy ID/version, authorization audit event ID plus entry hash, and
  the new domain-separated `provider_action_sha256` kind/version, plus the
  authorization proof digest. The immutable integration audit, not optional
  policy-specific record fields, owns the detailed provider
  connection/tenant/tool/actor/link, adapter identity/instance/version,
  binding, and capability tuple;
- source adapter kind/ID/instance/version, external source locator, canonical
  revision, `normalizer_version`, nullable provider `source_revision`,
  decision-processor kind/ID/instance/version and contract digest; these are
  provenance, not actor authority. One closed
  `echo-approved-decision-snapshot-v2` body contains the staged/final content
  digests and exact existing `OrganizationRecordApprovalPayloadV1` bytes under
  literal `organization-record-approval-payload-v1`; its canonical digest is
  the same value bound by the card, provider action, record, and every
  delivery submission;
  the complete body exists only in the closed approval event;
  the closed rejection event forbids approved/candidate content but preserves
  main's bounded `OrganizationRecordRejectionPayloadV1`: exact source locator,
  meeting ID, rejected time, nullable organization-visible reason, and nullable
  `reconsider_after`; none of those fields becomes a readable atom or policy fact;
- exactly one retained policy contract for an approval;
- no reader-policy-derived delivery audience. The approved snapshot is the
  immutable input to separately configured delivery surfaces; rejection
  produces no delivery work. Destination, implementation, credential, and
  attempt provenance remain delivery state rather than human-approval or
  reader-policy meaning;
- the named internal writer actor and Authority signing key;
- organization-scoped semantic idempotency, duplicate, and conflict rules;
- canonicalization, record hash, predecessor, receipt, and
  approval-only append-atomic policy facts; a rejected act appends zero
  eligibility/readable facts. Record and receipt bodies exclude their own
  hash/signature; separately domain-separated signature preimages bind the
  recomputed body digest and Authority signing-key ID;
- versioned log and audit shapes containing no employee installation,
  enrollment, lease, or synthetic Person; and
- the exact structural boundary between `organization-protocol`,
  `organization-record`, and Authority composition.

**Phase 0 acceptance evidence:** accepted contract, canonical fixtures and
preimages, plus named mutation, cross-version, exact-retry, concurrency,
rebuild, restart, revocation, and recovery verification cases. Their
executable proof is Phase 2 exit evidence. In particular, a crash after
integration-audit commit but before core saves the gate outcome must recover
the same `human_act_resolution_ref` and canonical append receipt by exact key,
without a descriptive scan, second human act, or second audit entry; an
unknown or mutated reference denies. Existing admitted acts remain
verifiable; only future actions are blocked.

Layer 1 contains no provider token, credential handle, duplicated live
connection configuration, display identity, or resolved reader list. Record
admission follows the exact audit ID/hash and recomputes the proof; it never
reconstructs identity by loose field matching. Approve and reject work may
become terminal only after this port returns the canonical append receipt. Once
the durable human-action audit exists, source-custodian, provider-connection,
link, binding, or capability revocation cannot strand canonical append/retry;
canonical append-receipt recovery uses only the immutable resolution reference,
audit ID/hash/proof, and frozen record input. Delivery receipt recovery is a
separate post-approval side-effect state machine.

**Blocks:** replacement of `/v1/record-envelopes`, installation-scoped log
dedupe, V1 receipts, installation verification ports, and employee-installation
request-signing keys/verifiers. The Authority record-signing key remains.

### D4 — rejection path

**Decision:** record the current server-owned rejection contract. A rejection
is an immutable human act, not missing approval and not candidate content. The
decision must pin its bounded evidence, idempotency, audit, record treatment,
retry behavior, pre-record **nonterminal** pending/resolution state,
post-append processing terminal state, retention effect, and explicit absence
from approved projections, retrieval, and delivery. No approve or reject row is
terminal until the Authority record-resolution port returns the canonical
append receipt.

**Phase 0 acceptance evidence:** a canonical rejection fixture and named
approve/reject race, conflicting provider-action, retry, restart, and
non-disclosure verification cases, including rejection of every approval-
payload, staged/final-content, policy-fact, rejection-text, candidate-content,
or non-`none` delivery field. Their executable proof is Phase 2 exit evidence.

**Blocks:** record-writer activation and deletion of the old rejection
envelope/ingest path.

### D5 — parity gate

**Decision:** accept the semantic parity report for the replacement path.
Envelope bytes, actor versions, and the explicitly accepted Person-versioned
policy contracts are expected to change. The human-visible policy delta is
that a current Person/session replaces installation plus lease. Reviewer-tenure
and organization-membership reader sets, revocation, later-member behavior,
policy separation, denial, recent-read availability, and non-disclosure may not
change. D6 may separately accept the proposed audit retention and export
changes. Delivery cardinality, destination policy, and route consolidation are
not implicit migration deltas; the initial V1 keeps main behavior unless a
later accepted decision names and proves a change.

The corpus contains one organization with one owner and at least three
employees, multiple source revisions, one approval under each retained policy,
one rejection, one approval/rejection conflict, retries, one revoked former
employee, and a separately invited later-joining employee. A same-principal
OIDC/membership retarget attempt must deny. A separate foreign Authority fixture
supplies only wrong-origin/session/identifier denial cases.

Parity is exact for:

- human outcome and frozen staged bytes;
- mapped policy family, the accepted old-to-new consequence/version delta,
  immutable authorization proof, and identical reader-set semantics;
- admitted Layer 1 facts and excluded rejection facts;
- derived items and immutable retrieval generation contents;
- reviewer exact-tenure visibility;
- organization-member current-membership and later-member visibility;
- reviewer-recent remains backed by verified append-atomic facts and canonical
  records and remains available after append before a Layer-2 rebuild, while
  readable search remains bound to an exact-head Layer-2 generation;
- denial shape, witness, response content, and absence of hidden counts;
- start/end Person state and final head fence behavior;
- audit allow/deny meaning and response digest before day 30; deliberate
  whole-row expiry divergence after day 30; and deliberate absence of every
  old query-audit export path;
- idempotent retry, conflict, restart, and unknown-outcome behavior; and
- separation between approval success and delivery acknowledgement.

**Pass condition:** zero unexplained semantic mismatch after applying only the
accepted identity/policy-version and D6 retention/export mappings. Any other
intentional change requires its own
accepted decision before the report can pass. Comparing only hashes cannot
pass; the report must show the old and new consequence sentences and why their
reader sets are equivalent under Person identity.

**Blocks:** clean-state cutover and all compatibility deletion.

### D6 — shared Person-read audit and retention

**Decision:** accept one audit contract for every retained Person read and
member-exclusion operation. It must pin:

The retained reviewer-recent operation uses a caller-bound Layer-1/log scope.
Readable search uses a caller-bound exact-head Layer-2 scope. Both use the same
current-Person resolution, final fence, audit-before-release ordering, and safe
denial family, but neither may silently inherit the other's availability or
candidate substrate.

- a closed caller binding containing exactly the material current authorization
  resolved: `authority_id`, `organization_id`, `state_lineage_id`,
  `principal_id`, `membership_id`, `membership_type`, OIDC
  `identity_binding_id`, `session_family_id`, `access_credential_sha256`,
  `person_state_sha256`, and `session_state_sha256`;
- operation and request digest without query text, terms, content, titles,
  participants, source identifiers, or caller-supplied identity fields;
- allow/deny, safe reason code, exact closed retrieval or Authority-state scope
  evidence, scope digest, returned opaque bindings, evaluated time, and a
  distinct release digest plus exact released-response digest where protected
  bytes are returned;
- denial rows with no item metadata;
- commit-before-release and failure-denies semantics;
- one explicit retention interval, whole-row expiry action and audit;
  and
- the explicitly proposed export position: deliberately unsupported, with no
  production route, command, file writer, row-selection port, renamed alias,
  or output-path open. A capability query returns only the closed
  `unsupported` result and selects zero rows.

The audit stores `caller_binding_sha256`, `scope_binding_sha256`, and, for an
allow response, `release_binding_sha256` as distinct commitments. It never
overwrites or aliases authenticated caller, pre-search authorization scope, and
post-search release evidence. Finalization re-resolves the caller, rechecks the
scope receipt, computes the release commitment, and commits the outcome at one
fence.

The versioned `scope_binding_sha256` preimage is normative and discriminated.
Every variant contains `caller_binding_sha256`, operation, and request digest.
The retrieval variant additionally contains ordered active policy
IDs/versions/contract digests, retrieval contract, generation ID/manifest,
exact record-head position/hash, and every admitted policy-path/segment ID plus
manifest. The Authority-state variant instead contains the exact Authority
state contract, source activation/binding, current custodian/ownership, owned
resource, exclusion-state, and mutation-command commitments. Keys from the
other variant are forbidden. The scope is created before its protected handle
opens and contains no returned item.

The versioned `release_binding_sha256` similarly contains the caller and scope
commitments, exact response digest, and either ordered returned
`(atom_id, record_hash, policy_id, content_binding_sha256,
provenance_binding_sha256)` tuples or opaque Authority-resource/state
bindings. An uninformative mutation acknowledgement has no release binding;
the mutation and allow audit still co-commit. Neither preimage contains query
or content text. The final fence rechecks the exact scope variant and current
caller state. Mutating any scope or release member, or failing the audit
commit, releases zero bytes.

The release protocol is ordered and non-circular: the application prepares a
typed authorized result; the release adapter deterministically serializes it
once into a private immutable buffer; finalization receives the exact response
digest and opaque result bindings, rechecks the caller and exact scope variant,
and commits the audit plus any Authority-state mutation in the one owning
transaction; only that success authorizes the adapter to write the same buffer.
Serialization is not observation or release. Failure discards the buffer, and
no adapter may reserialize after the audited digest is committed.

The read audit binds canonical authorization/provenance digests but does not
copy live Slack identities or make the read depend on a mutable provider link.
Provider/adapter identity was resolved at human-act admission; Layer 3 resolves
the current Person independently.

**Phase 0 acceptance evidence:** accepted schema, retention/export statement,
canonical preimages, and named allow, deny, revocation-race, stale-head,
audit-outage, exact-response-digest, expiry, and export/unsupported
verification cases for both policies and every retained Person operation.
Their executable proof is Phase 2 exit evidence and is repeated in Phase 6
qualification.

**Blocks:** deletion of reviewer-query, readable-search, member-exclusion, or
generic Person-read audit tables/repositories/CLIs and removal of their frozen
180-day contracts.

## New-state lineage and schema reset

The reset creates a new lineage; it is not a migration that relabels old rows.

### Lineage contract

Every writable database carries a manifest binding at least:

- `state_lineage_id` and exact schema version;
- `authority_id` and `organization_id`;
- database role (`authority`, `control-plane`, `record-log`,
  `record-derived`, `retrieval-facts`, `retrieval-content`, or
  `retrieval-lexical`);
- canonical schema digest; and
- creation time and creating artifact revision.

The new lineage contains no employee installation, enrollment, access lease,
installation key, or installation actor column. Authority startup validates
that every opened database belongs to the same exact Authority, organization,
and lineage before any writable handle, provider call, processing cycle, or
listener is available. A missing, legacy, mixed-role, mixed-organization, or
mixed-lineage manifest fails closed with no automatic upgrade.

The record log begins at a new genesis. Derived and retrieval state is created
empty and must rebuild from that log. Authority and control-plane state is
re-provisioned through current commands; no row-level copying or ID
backfilling is allowed.

### Historical treatment

- Existing V1 databases and envelopes keep their original meanings.
- Existing migration files and decision/qualification documents are not
  edited to look current. They may leave the runtime migration closure only
  after the new lineage is the sole live lineage.
- The old checksummed snapshot is opened only with the matching old artifact
  and only as the rollback pair. New code never guesses, imports, or upgrades
  it.
- No V1 record is copied into the new log, no installation act is relabelled
  as a Person/service act, and no old receipt is presented as a new-lineage
  receipt.

### Reset sequence

1. Stop the Authority and prove the singleton is released.
2. Inventory and checksum every old state file and the exact old artifact.
3. Move the old state directory intact to the named rollback location.
4. Initialize a different empty directory with the new lineage.
5. Recreate the Authority/organization binding and owner membership.
6. Recreate employee memberships and issue Person login grants; complete OIDC
   binding and sessions through normal current flows.
7. Re-onboard the organization Slack tool, complete each Person Slack identity
   link, and configure the accepted server approval binding.
8. Re-enter source, processing, approval, and delivery configuration through
   their current typed adapter configuration paths.
9. Append one reviewer-restricted approval, one organization-member-readable
   approval, and one rejection; rebuild Layer 2 and exercise all Person reads.
10. Record the new lineage manifests, record head, retrieval generation,
    audit heads, and exact artifact digest before enabling the normal cycle.

There is never a dual writer. The old artifact/state pair is stopped before
the new lineage can write.

## Execution phases

### Phase 0 — freeze the initial V1 scope

The working Phase-0 packet is the
[closure ledger](2026-08-20-server-core-migration-phase-0-closure.md),
[test-contract inventory](2026-08-20-server-core-migration-phase-0-test-contract-inventory.md),
[RFC-0001](../rfcs/RFC-0001-server-core-lean-authority-contracts.md), and
proposed [ADR-0003](../decisions/ADR-0003-server-core-lean-authority-contracts.md)
and [ADR-0004](../decisions/ADR-0004-founder-authority-clean-state-reset.md).
Their draft/proposed state is sufficient for reversible offline implementation;
it is not sufficient for live reset, cutover, or compatibility deletion.

**Entry gate**

- ADR-0001 and ADR-0002 remain accepted and unsuperseded.
- This plan is the active migration ledger.
- The branch passes `npm run check` before implementation work begins.

**Work**

1. Produce a symbol, route, table, migration, test, export, dependency, and
   documentation inventory classified by the ledger above.
2. Trace every installation/enrollment/lease field to its last runtime caller.
3. Trace every Authority, organization, OIDC, principal, membership-tenure,
   provider issuer/tenant/tool/human, connection, external link, adapter
   identity/instance/version/binding, source provenance, capability, provider
   object, record-proof, policy-fact, retrieval-scope, and audit identifier from
   authoritative source through final consumer. Record whether each edge is
   current, frozen, revocable, tenant-scoped, and safe to minimize.
4. Record the initial D1 through D4 and D6 contract direction, unresolved exact
   schemas, and owning implementation phase. Keep ADR-0003 proposed until the
   implemented evidence exists.
5. Draft D0/ADR-0004 with the reset scope, secret-free re-entry map, attestation
   fields, and reset/rollback protocol. Accept it only at the Phase 4 entry
   gate, together with the stopped snapshot and rollback pair.
6. Add no compatibility abstraction merely to make later deletion easier.

**Exit gate**

- The initial V1 preserve/replace/delete boundary and every intentional delta
  from main are recorded; unresolved exact contracts have an owning phase.
- D0/ADR-0004 and D1 through D4/D6 remain visibly proposed and are named as
  hard prerequisites for Phase 4 rather than falsely claimed complete.
- Every proposed deletion has an owner, replacement or zero-caller proof, and
  a named verification case.
- INV-IDENTITY-005 has a complete edge inventory with no inferred, duplicated,
  or unowned identity transition.
- The inventory identifies central workspace anchors separately from employee
  installation state.

**Kill gate**

Stop the migration if a proposed replacement collapses Person and service
actors, weakens either policy, merges approval with delivery, makes the
Authority multi-tenant, or requires Layer 4. Re-scope or seek a new decision;
do not code through the conflict.

**Rollback gate**

Phase 0 is documentation and tests only. Revert unaccepted draft artifacts;
no runtime or state change is permitted. Reversible Phase 1 and Phase 2 work
may be reverted without a state downgrade because the old live lineage and
compatibility paths remain untouched.

### Phase 1 — establish semantic Person transport and new lineage offline

**Progress, initial V1 tranche A (2026-08-20):** green. Reviewer-recent and
readable-search bodies dropped duplicated schema/kind/request/Authority/
organization/method/path fields while temporarily retaining the legacy audit's
asserted `subject_principal_id`; Authority/organization now come from server
configuration. Exclusion access resolution, source ownership, and mutation now
share one Authority write transaction; the second SQLite mutation adapter and
duplicate processing-store exclusion CRUD are gone. The zero-caller in-memory
adapter registry and its registry-only types/test are gone while typed ports,
adapter identity/configuration, and direct composition remain. Slack-link
requests also dropped caller and route shadow fields while temporarily retaining
the request ID and provider message coordinate required by the current replay
store. Their replay commitments now bind the server-derived principal,
membership, OIDC binding, and session family, so another employee cannot replay
or receive the first employee's result. Full `npm run check` passed 141 files /
1,398 tests. Phase 1 remains open for the final semantic-body/audit-lineage cut,
the one-organization topology fixture, and the closed offline lineage-manifest
contract. The actual database baselines wait for the schemas that own them. A
proposed joined current-access query was deferred because it added roughly 400
lines of duplicate row validation to optimize an unmeasured no-customer path.

**Entry gate**

- The initial Phase 0 scope, main-parity ledger, and unresolved-contract owner
  list are recorded; formal D0-D6 acceptance is not required yet.
- The semantic Person DTO shapes and lineage manifest have focused review.

**Work**

1. Reduce Person request bodies to semantic inputs. The server builds a typed
   request context from the matched route, bearer credential, session family,
   OIDC binding, principal, membership, Authority, and organization.
2. Reject unknown identity, actor, method, path, schema, or organization fields
   in Person bodies rather than accepting caller shadow state.
3. Use the Slack `challenge_attempt_id` only as the completion lookup and
   correlation key. Preserve a versioned server-derived completion digest as
   the semantic idempotency/conflict contract; load provider message
   coordinates from stored challenge state.
4. Freeze the closed offline lineage-manifest contract and its role-coherence
   negatives without opening SQLite or adding a test-only production module.
   Current migration runners auto-upgrade legacy state and therefore are not a
   valid new-lineage initializer. The actual application IDs, baseline SQL,
   pre-open filesystem guard, and fresh initialization land only after the
   Phase 2 schemas settle and are exercised in Phase 3.
5. Add the one-Authority, one-owner-plus-three-employee fixture and a bounded
   foreign-Authority negative fixture without introducing a cross-organization
   registry.
6. Execute member-exclusion authentication, current credential/family/binding/
   membership resolution, source ownership, and mutation through one Authority
   transaction owner rather than a separately opened SQLite connection. Keep
   the existing read materializers until profiling justifies a larger joined-
   query implementation.

Phase 1 lands this in two green tranches. The first removes duplicated schema,
kind, request ID, Authority, organization, method, and path fields but retains
`subject_principal_id` temporarily because the legacy audit schema requires the
asserted subject. The new-lineage caller/audit context then removes that final
shadow assertion. The final target request bodies are:

| Person operation             | Body                                                                          |
| ---------------------------- | ----------------------------------------------------------------------------- |
| reviewer recent decisions    | `{}`                                                                          |
| readable search              | `{ "query": "..." }`                                                          |
| change member exclusion      | `{ "excluded": true, "selector": { ... } }` (`false` is the only alternative) |
| list member exclusions       | `{ "source_adapter_id": "...", "source_instance_id": "..." }`                 |
| begin Slack identity link    | `{ "challenge_code_sha256": "sha256:..." }`                                   |
| complete Slack identity link | `{ "challenge_attempt_id": "...", "challenge_code": "..." }`                  |

`reviewer recent decisions` preserves main's exact-reviewer-tenure policy and
Layer-1/log-backed availability, including availability after append before a
Layer-2 rebuild. Readable search separately preserves the current organization-
member exact-head Layer-2 path. Both derive caller context server-side and use
the shared final fence/audit mechanism.

`challenge_attempt_id` is only the completion lookup/correlation key. A
versioned server-derived completion digest binds the attempt, challenge-code
digest, stored provider message/thread coordinate, current Person
session/caller-state digest, and exact organization-tool digest. An exact
replay returns the original result; reuse with any changed semantic member is a
conflict. The client does not repeat message coordinates. Unknown fields,
including the old envelope identity and route fields, deny.

**Exit gate**

- Every Person route derives self-only caller and subject from authenticated
  state and performs required start/end rechecks.
- Exclusion mutation resolves the credential/family/binding/membership and
  writes through one Authority transaction; revoking the session family between
  admission and mutation denies even when membership remains active.
- Semantic body validators and clients have no duplicated identity/route
  assertions.
- Slack completion exact replay is deterministic on one challenge attempt;
  mutate-every-field reuse conflicts under the server-derived completion
  digest.
- The reviewed offline lineage contract names exact Authority/organization/
  lineage equality, closed database-role sets, unique role-specific
  application IDs, schema versions/digests, and mixed-role refusal. It has no
  writable runtime entry point yet; executable fresh initialization, restart,
  mixed-state refusal, and rebuild are Phase 3 gates.
- Old runtime behavior remains available and the full suite is green.

**Kill gate**

Stop if server-derived context can disagree with the router or authenticated
session, if a body can select another principal/organization, if a Person
credential crosses Authority origins, or if a new-lineage process opens a
legacy database for writing.

**Rollback gate**

Disable the new-lineage entry point and revert semantic-client/server changes
together. Old schemas and compatibility routes remain untouched, so no state
downgrade is needed.

### Phase 2 — implement server approval and Authority record writing

**Progress, tranches A, B, and C (2026-08-20):** green. Authority SQLite now owns
the pre-call Slack claim and unknown/delivered outcome; the separate file
journal and process lock are gone. A stopped, provider-free
`activate-meeting-source` transaction now creates or exactly replays the
source owner/configuration/live-cutoff tuple. The incompatible
`process-one-meeting` and `baseline-live-source` commands, structured-text live
canary, pending-only delivery, and canary-only query/gate APIs are gone. The
processing key is version 2 and binds source adapter version, canonical
revision, normalizer version, nullable provider revision, and the processor's
configuration-derived identity version. The current exact source custodian is
still immutable and fail-closed: revocation stops future source work. A
replaceable custody activation remains a later Phase-2 contract; this tranche
does not add a second custody system. Structured-text remains only for the
offline replay corpus pending D5.

The initial compatibility writer now appends one canonical approval or
rejection act before any terminal marker or delivery fan-out. Record creation
is no longer disguised as a delivery surface, and rejection still produces no
delivery. Authority startup now runs the terminal-only, exact-source recovery
mode before normal polling. It keyset-paginates bounded pages of complete,
unprocessed terminal acts, reconstructs writer input only from frozen store
facts, and idempotently submits through the normal Record application. It
loads no meeting source, processor, approval, or delivery adapter. Revoked
source custody therefore disables future polling without stranding an already
durable human act; all pre-record operations remain behind active custody, and
a revoked installation is still denied by normal Record authorization. The
completed Phase-2C tree plus the accepted D2 policy-contract candidate passed
the full repository gate on 2026-08-20: 139 test files and 1,401 tests, plus
boundary, documentation, type checking, and lint.

**D2-1 contract checkpoint (2026-08-20):** the control-plane now has one
private, non-live exact-contract module for the organization Slack connection
and current state, tenant-scoped Person link, approval binding, per-policy and
per-action capability, provider observation/message/action, authorization
allow, immutable integration-audit entry, semantic retry input, and durable D2
result locator. Focused mutation and cross-workspace tests keep both accepted
ADR-0005 policy pairs exact and prove that link-only identity, approval
authority, delivery, source custody, Person reads, and D3 record authority do
not collapse into one another. This checkpoint deliberately adds no database
baseline, application ID, initializer/opener, repository, public export, or
live runtime selection. Those storage and executable behaviors remain D2-2,
while fresh genesis and exact database identities remain Phase 3. The retained
D2-1 slice passed the full repository gate: 140 test files and 1,409 tests,
plus boundary, documentation, type checking, and lint.

**D2-2A activation checkpoint (2026-08-20):** one private, non-live
application state machine now owns the exact administrator activation command
and a separate command-ID-free resource commitment. An Authority
administrator credential is the only admitted actor; the coordinator must
provide its current owner tenure and the target link's exact current owner or
employee tenure under one stable authorization fence. The state machine
independently reparses and rehashes the immutable Slack connection and Person
link, checks current connection state, required Slack scopes, link currency,
tenant, channel, reactions, and adapter identity, then atomically creates one
approval binding and the four ordered policy/action capabilities. Exact command
replay returns the same result; distinct command IDs for the same resource
reuse the same binding/capabilities; changed configuration mints a new immutable
resource instead of relabeling the old one. The checkpoint deliberately has no
SQLite schema, opener, public export, provider call, live selection, or claim
of process-restart/cross-database linearization. D2-2B still owns provider
action finalization, audit/result recovery, and the alternate authorizer;
Phase 3 owns concrete persistence and the real shared Authority/control-plane
fence. The retained D2-2A slice passed the full repository gate: 141 test
files and 1,419 tests, plus boundary, documentation, type checking, and lint.

**D2-2B finalization checkpoint (2026-08-20):** one private, non-live
application state machine now accepts only an approval ID, recovers an exact
durable result before consulting current edges, or prepares a server-owned
Slack expectation under an abstract stable Authority/control-plane fence.
Provider observation occurs outside the fence. The final fence independently
reproves the frozen approval, connection/current state, active binding and
adapter surface, exact tenant-scoped Person link and link digest, current
membership tenure, selected policy/action capability, and verified audit-chain
position before atomically saving the provider observation, message, action,
authorization allow, chained integration audit, semantic input, and durable
D2 result. Both policies and both actions share this installation-free shape;
rejection remains a human act but gains no delivery or read authority. Exact
post-audit replay survives later current-edge revocation without another
provider call, while changed provider or frozen semantics conflict. This
checkpoint still uses an injected frozen-approval reproof witness, an abstract
provider observer, an in-memory transaction fake, and an abstract chain/fence
proof. It has no SQLite schema, process-restart claim, public export, live
selection, D3 reference, delivery, read, source, or model authority. Phase 3
owns concrete persistence, the real shared lock, raw card/snapshot body
ownership, and the live Slack observer/composition. The retained D2-2B slice
passed the full repository gate: 142 test files and 1,441 tests, plus boundary,
documentation, type checking, and lint.

**D3-1 human-act leaf checkpoint (2026-08-20):** one private, non-exported
organization-protocol module now freezes the exact approved-snapshot body,
installation-free human-act resolution reference, approved/rejected event
union, event/reference digests, and organization-scoped semantic-idempotency
preimage. The aggregate validator independently canonicalizes and hashes each
body and joins Authority, organization, lineage, approval, action, policy, and
snapshot identity. Approval embeds only the retained exact V1 payload under
the accepted Person-v2 policy tuple. Rejection retains the bounded V1
rejection payload and only candidate/snapshot/card/policy commitments; it
rejects approved content, readable facts, and delivery fields. This checkpoint
does not derive the opaque staged/final-content commitments and does not add an
envelope wrapper, signature, source/processor provenance, receipt, fact
projector, persistence, public export, or live writer. Those remain D3-2,
D3-3, and Phase 3 work. The retained tree passes the full repository gate:
143 test files and 1,447 tests, plus boundary, documentation, type checking,
and lint.

**Entry gate**

- Phase 1 exit is green.
- The relevant D1 through D4/D6 draft section, main-parity expectation, and
  phase-owned focused tests are named before each additive implementation.
- Canonical fixtures are added with the implementation that owns their bytes;
  incomplete future-boundary vectors do not block unrelated reversible work.

**Work**

Phase 2 is six independently green tranches. A later tranche may not make an
earlier red, and compatibility remains selectable until Phase 3 parity.

1. **SQLite delivery attempts — complete.** Replace the separate file journal and process
   lock with an Authority-SQLite `claim -> existing | claimed -> outcome`
   state machine. Commit the unknown claim before the provider call, clear it
   only on a known-no-write failure, and never hold a database transaction over
   the network call. Preserve configured-surface fan-out and delete the file
   and lock subsystems after restart/concurrency/unknown-outcome tests pass.
2. **Atomic source activation and canary retirement — complete for initial V1.** Add one stopped-state
   activation that pulls no meeting and freezes source/custodian/credential,
   cursor/cutoff/normalizer, and processor identity/configuration. Complete the
   processing-key preimage with source/normalizer/provider revisions. After
   this is green, delete `process-one-meeting`, `baseline-live-source`, and
   their structured-text canary orchestration; keep structured-text only where
   the still-required offline replay corpus consumes it.
3. **Canonical act before delivery — complete for compatibility V1.** Add one internal resolved-act writer port
   to the core. Adapt the current compatibility builder/ingest path behind it
   first: approve and reject obtain an idempotent canonical receipt before the
   processing item becomes terminal; only approval then fans the exact snapshot
   to every independently configured delivery surface. Remove the wrapper that
   disguises record append as a delivery adapter. Core retains the static closed
   `delivery_surfaces[]` boundary and does not infer delivery audience from
   either read policy. The current compatibility composition still reuses its
   one Slack approval instance/channel for delivery; replacing that coupling
   with main's distinct approval/delivery channel configuration remains Phase
   2D/D5 work and is not claimed complete here. C-B adds the
   source-free startup executable that reopens only exact terminal acts after
   custody revocation, performs no provider/candidate work, creates or reuses
   the exact frozen canonical envelope, and idempotently submits it through
   normal Record authorization without marking processed or delivering.
4. **Installation-free human-action resolution.** Add the Person/Slack binding
   and action-capability path beside the compatibility bridge. It binds the
   exact provider connection/tenant/tool/object/action, adapter identity and
   binding, Slack-to-Person link, current membership tenure, selected policy,
   frozen presentation, and immutable provider-action audit. Both policies and
   rejection return one stable resolution reference with exact retry/recovery.
   **D2-0 is complete:** ADR-0005 accepts the two exact Person policy IDs,
   reader selectors, consequence bytes, and contract digests. The candidate
   validator remains private and non-live until the isolated fresh-lineage
   identity/action state and later D3 consumer are green.
   **D2-1 is complete as a contract-only candidate:** every identity and audit
   body above has an exact private validator and cross-edge mutation evidence.
   It is not persisted, exported, or selected by the live runtime.
   **D2-2A is complete as an offline activation candidate:** it proves the
   administrator-only orchestration, current-edge reproof, exact
   replay/conflict, and one-resource/one-capability-set rules through an
   abstract stable-fence transaction.
   **D2-2B is complete as an offline finalization candidate:** it proves
   provider observation outside the fence, final current-edge intersection,
   atomic installation-free action/audit/result construction, exact concurrent
   conflict, and post-audit recovery against a verified chain position. Phase
   3 alone owns durable restart proof, concrete cross-role locking and
   persistence, the real Slack observer and live alternate-authorizer
   selection, baseline SQL, application IDs, lineage manifests, and writable
   openers.
5. **Authority envelope, receipt, and Layer-1 facts — D3-1 leaf contracts
   complete.** The private D3-1 checkpoint freezes the snapshot, resolution
   reference, approved/rejected event, and semantic-idempotency leaf graph
   without changing V1-V3 readers. D3-2 adds the exact envelope body/wrapper,
   source/processor provenance, and P-256 signature preimage. D3-3 adds the
   receipt body/wrapper and pure policy-specific fact projector. Phase 3 then
   reproves the exact human-act reference at the Record application boundary,
   appends record and the complete policy-specific text-free facts atomically,
   makes rejection append no readable facts, and wires bounded terminal
   cleanup only after the receipt is durable.
6. **Caller-neutral Person read boundary.** Share current caller resolution,
   final fence, audit-before-release, and immutable response-byte handoff while
   keeping reviewer-recent Layer-1/log-backed and readable search Layer-2/
   exact-head. Reuse current repository materializers; do not add the proposed
   roughly 400-line joined query without profiling. The final single audit
   baseline lands with the accepted D6/new-lineage schema, not as another
   transitional persistence system.

Every tranche selects exactly one writer in tests, can be reverted without a
state downgrade, and has its own focused/full-suite exit record.

**Exit gate**

- Neither new approval authorization nor new record writing reads an
  enrollment, installation key, access state, or lease.
- Both retained policies pass canonical, mutation, cross-policy,
  cross-organization, revocation, different-membership, OIDC-retarget denial,
  and later-member tests.
- INV-IDENTITY-005 passes end to end: bare or cross-tenant provider subjects,
  source owners, display/email matches, wrong links/connections/bindings/
  adapter versions/capabilities, mixed lineage, and different tenures cannot
  produce a durable human-action audit or canonical act. After append, changing
  those historical provider edges does not alter read authorization; tampered
  immutable proof or a failing current Person/policy/fence check denies read.
- Rejections are durable human acts and absent from approved projections,
  retrieval, and delivery.
- Exact retry returns the accepted result; idempotency reuse with changed
  semantic input denies; concurrent append admits once.
- A crash after the immutable integration audit but before core stores its gate
  outcome recovers the same resolution reference and canonical append receipt
  without scanning, duplicating the human act, or appending a second audit;
  unknown or mutated references deny.
- Both policies independently reconstruct the same immutable provider-action
  and integration-audit chain-entry preimages; changing Authority,
  organization, lineage, actor class, link/connection/binding/capability,
  detail digest, or predecessor denies, and the legacy installation-bearing
  versions never cross-admit.
- Record, facts, derive, retrieval, and audit rebuild in isolated test state
  with stable hashes. Fresh-lineage genesis and exact baseline identities are
  Phase 3 work after these schemas settle.
- Approval and delivery tests independently prove their receipts and failure
  states.
- Approval identity never authorizes delivery and a delivery receipt never
  proves approval or read access. Missing or drifted configured destination
  state makes zero provider calls; Slack approval and delivery channels remain
  distinct; exact replay of a record/snapshot/surface key cannot duplicate an
  already delivered artifact after implementation or credential rotation.
- Source activation is side-effect-free and convergent; no structured-text
  canary candidate is handed to an incompatible live processor. Pipeline
  routing and approval authorization are separate persisted contracts; a
  processor change produces a new processing identity rather than inheriting
  an approval capability. Activation contains no per-meeting values. At
  candidate creation, changing the pipeline digest, external ID, canonical
  revision, `normalizer_version`, nullable provider `source_revision`, or
  processor contract produces a new/conflicting key and cannot reuse an old
  candidate or approval.
- Revocation of the exact source-custodian tenure known before polling yields
  zero new provider calls; revocation during a call discards its result without
  mutation; revocation with pending work prevents advancement until fresh
  atomic custody activation against the unchanged pipeline/candidate without
  reinterpreting frozen bytes; revocation after the durable human-action audit
  cannot strand canonical append or append-receipt recovery.
- Delivery attempt recovery proves crashes before the provider call, after a
  provider success, and before the core receipt without blind reposting.
- Terminal cleanup and outcome reporting are owned by the one lifecycle and
  require no second write-only evidence system.

**Kill gate**

Stop on any record without an exact human act, any policy fallback, any
rejection entering readable state, any non-atomic record/fact append, any
cross-organization acceptance, or any service actor path that can read Person
content or impersonate a human.

**Rollback gate**

Remove the new composition binding and discard only new offline/test state.
The old compatibility writer remains the sole live path. Never replay a new
envelope through the old writer or vice versa.

### Phase 3 — prove parity and rehearse reset

**Entry gate**

- Phase 2 exit is green.
- The implemented D6 audit shape is stable enough for the parity comparison;
  formal acceptance remains a Phase 4 entry requirement.
- The parity corpus and comparison rules in D5 are checked in.
- The old and new writer paths can be run only in isolated state directories.

**Work**

1. Build the fresh baselines for the now-settled retained schemas and the
   filesystem pre-open guard. The guard authenticates the root manifest and
   SQLite headers/lineage rows before any writable opener runs; new-lineage
   state is exact-version-only and never auto-upgrades a legacy database.
2. Run the D5 corpus through the old compatibility path and new server path.
3. Compare semantic outcomes, policy facts, projections, visibility, witnesses,
   audits, retries, and delivery independently of expected envelope-version
   changes.
4. Rehearse the full reset sequence on a copy of founder state.
5. Rehearse rollback as an artifact/state pair and prove that mixed pairs are
   rejected.
6. Scan the prospective new runtime closure for installation/enrollment/lease
   dependencies and classify every remaining match.

**Exit gate**

- The D5 report has zero unexplained semantic mismatch and is ready for
  artifact-bound acceptance at the Phase 4 gate.
- Fresh initialization and byte-stable restart pass; missing, duplicated,
  swapped, legacy, wrong-Authority, wrong-organization, wrong-lineage, wrong-
  role, wrong-application-ID, and partial-publish state all refuse before a
  writable database or provider/listener is opened.
- A clean reset and rollback rehearsal both complete without row copying,
  dual writing, or provider side effects against the live organization.
- The new runtime closure has no unclassified installation-era dependency.
- The exact cutover and rollback artifacts and directories are named.

**Kill gate**

Stop on any visibility mismatch, missing audit, different human outcome,
rejection leak, non-idempotent retry, mixed-lineage acceptance, or provider
side effect during an offline rehearsal. Fix and restart the parity run from
empty isolated state.

**Rollback gate**

Delete the rehearsal state only. It contains no authoritative live data. Keep
the live old artifact/state pair unchanged.

### Phase 4 — reset founder state and cut over once

**Entry gate**

- Phases 0 through 3 have exited.
- D0 through D6 are accepted against the exact implemented artifacts,
  contracts, parity report, founder attestation, and reset/rollback pair. This
  is the first phase that requires formal acceptance rather than a draft target.
- The exact old and new artifacts are built and checksummed.
- The cutover begins in a stopped Authority with no pending provider request or
  unknown delivery outcome.

**Work**

Execute the reset sequence exactly once. Re-onboard the organization and
people through the preserved membership, invitation, OIDC, organization Slack,
Person Slack identity-link, approval activation, and typed delivery-surface
configuration flows. Exercise both policies, configured delivery fan-out, and rejection before enabling the
ordinary processing cycle.

**Exit gate**

- The live Authority opens only the new lineage and reports the expected
  Authority/organization binding.
- At least one owner and three employees have distinct active memberships; at
  least two complete OIDC/Person paths and their Slack links are exercised.
- Reviewer-restricted content is visible only to the exact active reviewer
  tenure.
- Organization-member-readable content is visible to every tested current
  owner/employee, including a later-added membership, and denied after
  revocation.
- Rejection, restart, record rebuild, retrieval rebuild, Person read, approval,
  and delivery-receipt checks pass.
- No new live record, audit, approval, or session row contains an employee
  installation, enrollment, lease, or installation key.

**Kill gate**

Stop the new Authority immediately if lineage validation, organization
binding, human onboarding, either policy, rejection, audit, rebuild, or
provider identity verification fails. Do not partially import old state.

**Rollback gate**

Stop the new artifact, preserve its state for diagnosis, and restart only the
checksummed old artifact with the intact old state snapshot. Re-onboarded
provider actions after cutover must be reconciled explicitly before rollback;
never run both artifacts or copy rows between them.

### Phase 5 — delete compatibility in bounded tranches

**Entry gate**

- Phase 4 exit is recorded.
- The new lineage is the sole live lineage.
- Every tranche starts from a green full suite and a zero-current-caller proof.

**Work and tranche order**

1. Remove superseded Person envelope builders/validators, duplicated body
   identity fields, and request-only fixtures. Retain semantic request inputs,
   response contracts, witnesses, policy constants, and negative tests.
2. Remove the remaining one-caller live-cycle alias and no-caller public store
   surface. The generic adapter registry and duplicate exclusion CRUD already
   exited in reversible Phase 1A.
3. Move or remove the remaining structured-text synthetic-replay production
   files after D5 parity replaces their last purpose. The live canary,
   baseline helper, and canary-only store APIs already exited in Phase 2B.
4. Confirm the Phase-2 SQLite Slack attempt migration is active and the live
   state preflight proves zero old file entries or imports them. The file
   journal and process-file lock have already exited the source closure.
5. Preserve the standalone reviewer-recent route/client/DTO and its Layer-1
   availability. Remove only duplicated reviewer/search/exclusion audit
   repositories, maintenance CLIs, exporters, and expiry jobs after all
   retained operations use D6's shared audit and retention action.
6. Remove ordinary/Pilot new-card Slack branches and legacy resolvers after no
   unresolved row uses them. Keep both reviewer and member modes, plus the
   durable rejection path.
7. Remove V1 Slack identity-link request transport and installation-signed
   permission checks after confirming the server approval path owns every
   surviving approval. Retire only installation-specific link/binding/grant
   ownership; do not delete the shared verified tool connection, tenant-scoped
   external human link, adapter identity/binding, action capability, or
   integration-audit proof required by the replacement chain.
8. Remove record-ingest HTTP transport, installation verification, lease
   refresh, compatibility bridge, installation-scoped dedupe/receipt code, and
   old writer composition.
9. Remove machine enrollment/access APIs, protocol schemas, repository
   methods, counters, startup helpers, legacy migration files, and old-schema
   construction code from the runtime closure. The exact fresh baselines were
   created and qualified before Phase 4 and already contain no installation
   objects; Phase 5 must not mutate the live new lineage to achieve its own
   manifest. Do not edit old files to pretend continuity.
10. Complete command parity for organization initialization, membership
    invitation/revocation, Slack/source onboarding, approval/delivery
    activation, provider/link/binding identity inspection, and required
    recovery;
    then delete the browser administrator console and installation-management
    UI while retaining the canonical JSON API and thin CLI.
11. Remove unused concrete model-provider drivers only if their separate
    contract/qualification disposition and configuration preflight are
    complete. Keep the processor and `LlmProviderClient` seam.
12. Remove stale exports, dependencies, configuration, tests, docs, boundary
    rules, and fixture assets; narrow Person and Authority package closures.

Each tranche lands as a reviewable deletion with its own focused tests. Do not
combine a failed semantic replacement with a larger cleanup patch.

**Exit gate**

- No current HTTP route, application service, composition root, core port,
  record path, control-plane path, or Person client references employee
  installation enrollment, installation keys, or access leases.
- The new schema exact-contract tests contain none of the retired tables,
  columns, indexes, or triggers.
- Package public exports contain no retired request or machine-onboarding
  contract.
- Runtime migration and artifact closures contain only the new lineage.
- Remaining installation-related text is limited to immutable historical
  decisions, archived qualification evidence, or explicitly named central
  workspace anchors.
- Every preserve row in this plan has a passing positive and negative test.

**Kill gate**

Stop the current tranche on a red boundary/type/protocol/policy test, a new
compatibility shim, an unexplained remaining caller, a deleted negative test
without replacement, or any change to canonical policy meaning. Restore the
tranche and narrow it.

**Rollback gate**

Revert only the failing deletion tranche. If runtime rollback is required,
use the last green new-lineage artifact with the same new state. Do not use an
old-lineage artifact against new state. The pre-cutover old pair remains a
separate emergency rollback until final acceptance.

### Phase 6 — lean closure and plan exit

**Entry gate**

- All Phase 5 tranches have exited independently.
- The worktree contains no unreviewed functional expansion.

**Work**

1. Run the full verification matrix below from a clean install.
2. Measure package/runtime closure, production LOC, test LOC, SQL objects,
   public exports, and direct dependencies before and after the deletion.
3. Confirm every retained line has a current product behavior, accepted
   invariant, or required negative proof.
4. Rebaseline current architecture, component, invariant-scope, runbook, and
   boundary-manifest documentation in the same tranche as the code it
   describes. Do not rewrite accepted ADR rationale, historical designs, v3,
   or immutable qualification reports.

**Exit gate**

Every exact final exit criterion at the end of this document is satisfied and
the evidence is bound to one commit and one Authority artifact digest.

**Kill gate**

Do not declare the lean-down complete if any compatibility symbol is merely
hidden behind an alias, any policy proof was weakened to make tests pass, any
historical artifact was rewritten, or any Layer 4 dependency entered a Person
read path.

**Rollback gate**

Revert the smallest offending cleanup change and rerun the entire matrix. A
completion label is reversible; record or identity meaning is not.

## Verification matrix

| Boundary                       | Required cases                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Command or evidence                                                                                                                         |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Workspace direction            | Core imports no adapters/vendor/persistence; adapters implement typed ports; approval and delivery remain separate.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `npm run check:boundary`; `npm run test:architecture`; `npm run test:core`                                                                  |
| Protocol/API                   | Canonical new writer fixtures; semantic Person DTOs; unknown-field denial; cross-version and cross-policy rejection; no retired exports.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `npm run test:protocols`                                                                                                                    |
| Person client                  | Login import, private session, refresh rotation/replay, logout, foreign-Authority rejection, semantic requests, no installation state or dependency.                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | `npm run test:person`; `npm run pack:person-client` plus offline artifact smoke                                                             |
| Organization topology          | One target Authority has one owner plus at least three employees; a bounded foreign-Authority fixture proves that foreign IDs, sessions, provider links, records, and search results are rejected.                                                                                                                                                                                                                                                                                                                                                                                                                                 | Authority and integration topology suite with isolated negative-fixture state                                                               |
| Invitations/OIDC               | Provision a new principal and membership, then issue a one-time Person login grant to that exact existing membership; prove exact email/issuer/subject checks, PKCE-S256, state/nonce, redirect/tenant/algorithm/audience/`azp`/`iat`, upstream-token non-persistence, returning login, access/family deadlines, refresh replay/race, revocation, and same-principal/membership retarget denial.                                                                                                                                                                                                                                   | `npm run test:authority`; Person integration suite                                                                                          |
| Slack identity                 | Organization tool verification, opaque credential handle, Person challenge replay keyed for lookup by attempt but semantically bound by the server-derived completion digest, exact tenant human, wrong thread/user/workspace denial, mutate-field replay conflict, and membership revocation.                                                                                                                                                                                                                                                                                                                                     | `npm run test:control-plane`; `npm run test:authority`; integration fake-provider suite                                                     |
| Adapter-to-ECHO identity spine | Exact Authority/org/lineage, issuer/tenant/tool, connection, adapter identity/instance/version/binding, provider object/actor, external link, principal/membership tenure, capability, domain-separated provider-action and integration-audit chain entries, canonical proof, policy fact, and current Person chain; every missing, mismatched, revoked, replaced, cross-tenant, or inferred edge denies at the stage that consumes it. Post-append provider-edge revocation does not become a read-time check.                                                                                                                    | INV-IDENTITY-005 contract suite across control-plane, Authority, record, retrieval, and integration tests                                   |
| Source and processing identity | Activation pulls no meeting and atomically freezes only pipeline contract plus credential/custodian proof. Candidate creation later binds pipeline digest to actual external ID and canonical/normalizer/provider revisions. Exact retry/concurrency and crash/restart hold. Known pre-call revocation makes new calls zero; an in-flight result fails its final fence with no mutation; pending work resumes only after fresh custody activation against the unchanged tuple/bytes; post-audit revocation cannot strand append. Changing a processing-key member cannot resume prior work.                                        | Authority activation, processing-key, replay, source-owner revocation, in-flight race, composition/store suites plus fake source call count |
| Approval binding               | Owner/admin binding, exact approver eligibility, frozen card/policy, live provider recheck, conflict, retry, unknown outcome, revocation, and no delivery coupling.                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Control-plane and Authority capability suites                                                                                               |
| Record writer                  | Exact human act, monotonic resolution reference, Authority signature, canonical bytes, semantic idempotency, conflict/concurrency, crash after audit before gate-save/append, exact reference and append-receipt recovery, no descriptive scan or second act/audit, hash chain, symmetric audit reproof, restart, and no installation fields.                                                                                                                                                                                                                                                                                      | `npm run test:record`; `npm run test:authority`; protocol canonical fixtures                                                                |
| Rejection                      | Immutable rejected act; approve/reject race; retry/restart; nonterminal before canonical append receipt and terminal exactly once after it; zero approval eligibility facts, readable atom/fact, lexical entry, delivery, hidden count, or descriptive denial leak.                                                                                                                                                                                                                                                                                                                                                                | Record, retrieval, Authority, and integration rejection suites                                                                              |
| Delivery identity and recovery | At least one configured surface for enabled processing; deterministic fan-out to every configured surface after either policy approval; rejection creates none; Slack approval and delivery channels differ; approval identity/receipt confer no delivery authority; each surface validates destination/configuration, keys durable attempt state to the exact record/snapshot plus adapter instance/configuration, and covers crash before call, provider success before outcome persistence, ambiguous outcome, known-no-write retry, frozen unknown/delivered recovery, and the core-receipt crash window without blind repost. | Core delivery fan-out, Slack delivery, and SQLite attempt-store suites                                                                      |
| Restricted reviewer            | Only exact current principal and membership tenure reads; a different membership tuple, other employee, other organization, revoked membership, and malformed proof deny.                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `npm run test:record`; `npm run test:authority`; `npm run test:integration`                                                                 |
| Organization member            | Every current owner/employee, including a separately invited later employee, reads; revoked, unknown future membership type, other organization, and malformed proof deny.                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `npm run test:record`; retrieval/Authority/integration policy suites                                                                        |
| Reviewer recent                | The exact current reviewer principal/membership tenure reads from verified append-atomic Layer-1 facts/canonical rows before and after a Layer-2 rebuild; other tenure, other employees, revocation, and foreign Authority deny. An append followed by no rebuild does not make this route unavailable.                                                                                                                                                                                                                                                                                                                            | Authority/API/client parity plus T09, T13, and T14                                                                                          |
| Layer 1                        | Canonical record and approval-only eligibility facts commit atomically; rejection commits no eligibility/readable fact; canonical reproof, predecessor/hash chain, mutation denial, receipt, and stopped rebuild are deterministic.                                                                                                                                                                                                                                                                                                                                                                                                | `npm run test:record`                                                                                                                       |
| Layer 2                        | Exact-head build, immutable generation, separated planes, authorized candidate/statistic scope, distinct member `(organization, policy)` and reviewer `(organization, policy, principal, membership)` segment namespaces, cross-policy substitution denial, fact/content/provenance reproof, stale/corrupt generation denial, stopped rebuild, and restore admission.                                                                                                                                                                                                                                                              | Retrieval workspace tests; `npm run test:integration`                                                                                       |
| Layer 3                        | Start/end Person resolution, self-only caller binding, pre-search caller-bound scope receipt, prepare/private deterministic serialization/finalize/release ordering, post-search release binding, mutation race, exact-head fence, safe witness, minimized allow/deny audit, audit failure discarding the buffer, and only the exact audited bytes written after commit.                                                                                                                                                                                                                                                           | `npm run test:authority`; `npm run test:integration`                                                                                        |
| Audit/retention                | One D6 row shape for every retained Person operation; distinct caller/scope/release digests; no content/query leakage; exact returned opaque bindings and response digest; 30-day whole-row expiry and its audit; a closed unsupported capability result that selects zero rows and opens/writes no file; and zero legacy export route, command, writer, selector, runtime mode, or CLI branch.                                                                                                                                                                                                                                    | Authority audit repository/application/HTTP/CLI tests plus T09 and T13                                                                      |
| Operator surface               | Organization initialization, owner plus three employee invitations, revocation, organization Slack/source onboarding, Person links, approval activation, typed delivery-surface configuration, binding inspection, and required recovery through JSON API and thin CLI without browser-console dependency.                                                                                                                                                                                                                                                                                                                             | Admin API/CLI and fresh-state integration suite                                                                                             |
| Lineage                        | Fresh init, restart, schema digest, legacy refusal, missing manifest refusal, mixed role/org/Authority/lineage refusal, old/new artifact-state mismatch, and no auto-upgrade.                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Exact-schema tests and reset rehearsal report                                                                                               |
| Deletion                       | Zero runtime callers, exports, routes, SQL objects, artifact files, or direct dependencies for retired installation surfaces; historical references allowlisted by path.                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Checked `rg`/manifest scan plus architecture test                                                                                           |
| Full repository                | Build, docs, boundaries, types, lint, all workspace and integration tests from a clean checkout.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `npm run check`                                                                                                                             |
| Layer 4 exclusion              | No new answer-composition route, retrieval-to-model dependency, prompt/answer audit schema, agent/tool path, or streaming response in this change.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Boundary manifest and dependency scan                                                                                                       |

Every negative case must prove both the externally safe result and the absence
of a successful content/provider side effect. A thrown error alone is not
evidence of non-disclosure.

## Exact final exit criteria

The migration lean-down is complete only when all conditions below are true
at the same named commit:

1. ADR-0001 and ADR-0002 remain accepted and unsuperseded, and D0 through D6
   have recorded accepted dispositions bound to exact artifact digests.
2. The live topology is one organization and its one Authority;
   the verification run includes one owner plus at least three employees and a
   bounded foreign-Authority rejection fixture, without a two-person product
   constant or a tenant registry.
3. Organization initialization, membership provisioning/revocation, Person
   invitation grants, OIDC login/refresh/logout, organization Slack onboarding,
   and Person Slack identity linking all pass their positive, semantic-digest
   replay/conflict, revocation, and cross-organization cases.
4. The new-lineage restricted-reviewer contract preserves exact reviewer
   membership-tenure semantics, and the new-lineage
   organization-member-readable contract preserves current owner/employee plus
   later-member semantics. Both use Person identity, every old `v1` contract is
   rejected rather than reinterpreted, and neither policy can satisfy, default
   to, or fall back to the other.
5. Approval and delivery remain separate typed ports with distinct
   activation, authorization, idempotency, outcome, and receipt tests. Every
   external delivery matches the canonical act's exact binding/destination
   intent and stable semantic key; destination drift makes zero calls and
   implementation/credential rotation cannot repost.
6. The Authority writer appends only after an exact verified human approval or
   rejection act. Its current envelope, log, receipt, idempotency key, audit,
   and ports contain no employee installation, enrollment, access lease, or
   installation key meaning. Both policies reprove one new domain-separated
   provider-action and integration-audit chain-entry contract from immutable
   stored evidence and reject every installation-bearing version.
7. Rejection is durable and auditable but creates no approved projection,
   readable fact, retrieval entry, delivery, hidden count, or content leak.
8. Layer 1 append/facts, Layer 2 derive/retrieval, and Layer 3 current-Person
   fence/audit behavior pass the complete matrix, including corruption,
   revocation, restart, rebuild, cross-policy segment substitution, distinct
   member/reviewer namespace semantics, caller-bound scope, release binding,
   audit failure, and cross-organization denials.
9. Every Person request body contains only operation-semantic input. Actor,
   Authority, organization, subject, method, path, and caller binding come
   only from the authenticated server route context.
10. The live state uses the new lineage exclusively. New code refuses legacy
    or mixed state before writes; no old row was copied, relabelled, or
    backfilled into the new lineage.
11. No current runtime route, client, protocol export, server composition,
    repository port, SQL object, migration closure, packaged artifact, or
    direct dependency retains employee installation onboarding, signing,
    leases, permission requests, or record-ingest transport.
12. Historical decisions, V1 meanings, and qualification evidence remain
    unchanged, and central workspace anchors remain correctly scoped.
13. `npm run check`, all focused commands in the verification matrix, the
    single-Authority topology suite, foreign-Authority negative fixture, reset
    rehearsal, and exact live new-lineage smoke are green and recorded against
    the same commit/artifact.
14. The final deletion report shows the before/after production LOC, test LOC,
    runtime SQL objects, public exports, runtime files, and direct dependencies;
    every remaining item has a current behavior or required negative proof.
15. No Layer 4 capability, dependency, route, persisted state, or product claim
    was added by this migration.
16. INV-IDENTITY-005 is satisfied from provider onboarding through adapter
    action, canonical record admission, policy facts, current Person resolution,
    final read fence, and audit. No deletion leaves a dangling, inferred,
    cross-tenant, or synthetic identity edge.
17. Source custody remains a live pre-record edge: custodian revocation before
    a provider call makes new calls zero; revocation during a call discards the
    result without mutation; pending advancement stops until fresh atomic
    custody activation against the unchanged pipeline/candidate; that
    activation cannot alter frozen bytes, and revocation after the durable
    human-action audit cannot strand canonical append or append-receipt
    recovery. The
    processing key binds the pipeline digest and every actual
    source/normalizer/provider-revision member learned at candidate creation.

Until all seventeen are true, the migration may be smaller and cleaner, but it
is not finished.
