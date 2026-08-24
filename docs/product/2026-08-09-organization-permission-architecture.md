# Organization permission architecture (constitution v1)

**Status:** design-only constitution. It does not claim that a content
gatekeeper is shipped.

**Code baseline:** this constitution is design grounding, not an implementation
baseline. A feature-specific contract and review must establish any current
code baseline.

**Builds on:**
[2026-08-07-org-decision-record-append-derive-design.md](2026-08-07-org-decision-record-append-derive-design.md)
and [org-brain-direction.md](org-brain-direction.md).

## Reading contract

This document uses four status terms deliberately:

- **Landed** means code present at the feature's stated implementation
  baseline.
- **Constitution v1** means a binding design constraint for later permission
  features. It is not a shipped feature.
- **Pilot slice 1** means the absolute-minimum first evaluator described near
  the end of this document.
- **Deferred** means a separate feature spec and review are required before
  implementation.

Industry systems are cited as evidence of a failure mode or a useful
mechanism. A citation does not make the adjacent ECHO policy inevitable. The
research ledger records both what each source supports and what it does not.

## Why this is the product

People put real decisions into a system only when they can predict who will
see them. Predictability reduces self-censorship, and what is in the brain is
what makes the brain useful. The permission model therefore helps create the
asset; it is not merely a guard around it.

Wrong visibility is also unusually quiet. A bad append can reject and a bad
derive can halt, but an over-broad answer can look normal. This architecture
reduces that risk by limiting access to reviewed policy over recorded human
acts and current organization facts. It does not claim to reconstruct what a
person hypothetically “would have done.”

## Glossary and threat boundary

- **Principal** is the Authority's stable organization identity. **Person** is
  the live, effective view of a principal, membership, and valid identity
  links at an evaluation point.
- **Caller** is the authenticated installation making a request. **Subject**
  is the principal whose visibility is being evaluated. Normal product reads
  are self-only: caller and subject must resolve to the same active principal.
- **Record** is a canonical approved or rejected envelope in the organization
  log. **Atom** is a deterministic derived decision, action, or rationale.
  **Item** means an atom or another future permission-addressable projection.
- **Path** is evidence that proves a visibility level. An **explicit grant**
  is one possible path, recorded separately from immutable content. The word
  grant does not mean every derived path.
- **Visibility** is what has been proved: invisible, discoverable, or readable.
  **Determinacy** records whether all policy-relevant inputs needed for a
  higher level were evaluable. The two are not the same.
- **Floor** is the organization policy for valid content carrying no human
  visibility intent. No floor is landed today.
- **Legacy-unmarked** means a valid old envelope whose schema predates human
  intent provenance. **Marked** means a future schema carries explicit human
  provenance for its visibility intent. Missing required fields in that
  future schema are malformed, not legacy-unmarked.

The product gate protects normal application reads. It is not a claim that an
EC2, SSM, root, database, backup, or signing-key custodian lacks technical
access. Those custodians remain inside the trusted computing and operating
boundary. A product-level “no override” means there is no application route
that bypasses traversal policy; it does not erase infrastructure custody.

SQLite triggers and the record hash chain prevent ordinary application
updates and reveal mutation, reordering, and interior deletion. They cannot
detect a valid-prefix tail truncation or restore of an older valid database
without an externally retained checkpoint. The landed verifier states this as
`tail_truncation_detectable: false`. Accordingly:

- “immutable” below means immutable through supported application paths and
  tamper-evident relative to retained receipts or a trusted prior head;
- no claim says a database owner is cryptographically unable to rewrite
  history; and
- until an off-host monotonic Authority-state head exists, a restore must stay
  out of service until memberships, installations, revocations, grants, and
  client-held receipts are reconciled.

## The three pillars

Pillar membership is epistemic, not physical. Different act families may use
different ledgers when their schemas or retention rules differ.

- **Person — who people are at the evaluation point.** Principals, current
  active or revoked memberships, installations, and effective identity-link
  projections. Future teams and roles also belong here. The attestation that
  created an identity link is Activity; its currently effective binding is a
  Person projection.
- **Content — what humans approved or rejected.** Canonical envelopes are the
  authoritative form. Deterministic atoms, meeting snapshots, participant
  observations, and provenance edges are servable projections with no
  independent authority. Corrections are new records, not edits.
- **Activity — accountable acts and system outcomes.** Approval, rejection,
  future permission acts, and future access-decision audits live here. Durable
  governance acts are append-only and superseded by later acts. Query-audit
  entries are immutable during a declared retention period and then expire as
  whole entries or sealed segments under an auditable retention action. They
  do not belong in the forever decision log.

Queries are accountability events, not engagement telemetry. Scrolls,
clicks, views, dwell time, and claims about human attention are not admitted
as fields.

The access sentence is: **a current active person walking a reviewed path
through frozen history.** A person's membership change affects future
evaluations without rewriting content.

## Trust ladder

Authority never transfers merely because data moved downstream. W3C PROV-O's
attribution vocabulary motivates the responsible-agent axis; it does not
prescribe this four-rung taxonomy
([PROV-O](https://www.w3.org/TR/prov-o/)).

1. **Canonical envelope.** Human-approved or human-rejected, installation
   signed, Authority-receipted, and hash-chained. It may be cited as the
   organization's recorded fact.
2. **Deterministic projection.** A pure restatement bound to rung 1 by record
   hash and reproducible under a pinned derive build. The rebuild digest proves
   reproducibility, not that the projection rule was correct; review and golden
   fixtures carry that burden.
3. **Inference.** Machine judgment about facts. It must identify its software
   producer in the persisted row, cite rungs 1–2, and never grant access. EU AI
   Act Article 50(2) is a useful transport precedent for machine-readable
   marking of certain synthetic output, but its legal scope and exceptions
   differ from this taxonomy. Article 50(4)'s editorial-control exception sits
   inside a narrow, specified disclosure duty; it is not a general exception
   for deterministic projections
   ([official EUR-Lex text](https://eur-lex.europa.eu/eli/reg/2024/1689/oj?locale=en)).
   A field on every ECHO row is our architecture choice, not a statutory
   database-row requirement.
4. **Answer composition.** Ephemeral and citation-bound. Every substantive
   claim cites authorized upstream atoms. “No approved decision you are
   authorized to discover or read covers that” is a valid answer. The access
   audit stores decision evidence and a response digest, not a second full copy
   of the prompt and answer by default.

Probabilistic grounding scores do not make rung 4 authoritative. Amazon
Bedrock caps its contextual-grounding threshold below 1, while Google accepts
a citation threshold of 1, but that only controls citation-confidence
filtering rather than proving the answer correct. Neither establishes zero
ungrounded claims
([Bedrock](https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails-contextual-grounding-check.html),
[Google](https://docs.cloud.google.com/generative-ai-app-builder/docs/check-grounding)).
Future implementation must also pin claim-offset semantics: Google's offsets
are UTF-8 byte positions, not character indexes.

## Normative invariants

1. **Authorize the candidate set before scoring or model access.** The logical
   set passed to search, ranking, tools, or a model contains only items the
   caller may traverse. Authorization is not a post-filter. This structure
   reduces leakage, but it does not make all traversal bugs under-disclose;
   adversarial over-disclosure tests remain mandatory. Governed and ungoverned
   sources never share a retrieval corpus unless every source has an explicit
   policy root.
2. **Never stamp resolved reader identities into immutable content.**
   Fact-derived paths use current organization facts maintained independently
   of the item. Explicit grants live as permission-act edges. Frozen participant
   claims may remain content facts, but they are not a current reader list.
3. **Existence and content are separate rights.** Visibility is ordered
   `invisible < discoverable < readable`. Discoverable metadata is its own
   deliberately approved projection; an atom subject, meeting title,
   participant list, evidence span, count, or model summary is never assumed
   safe merely because it is metadata.
4. **Every positive result has a sentence-form witness.** The witness names a
   reviewed policy and facts the caller is allowed to know. If several paths
   exist, policy chooses one deterministically and audit records the exact path
   kind and rule version. An explanation must not reveal a hidden intermediate
   node.
5. **Check and use share one consistency boundary.** One request evaluates a
   coherent Person, permission-effect, content, derive, and policy version and
   scopes all candidate reads to those heads. In the single-process Authority,
   every authorization-relevant mutation — Person or policy change, permission
   act/effect transition, record append, or derive-head transition — and final
   response commitment passes through one Authority-owned read/write fence. A
   mutation holds the write side through its commit and head update. After
   expensive retrieval or model
   work is buffered, a response holds the read side while it rechecks every
   pinned head, commits audit, and hands the response to the HTTP layer. That
   short fenced section is the authorization linearization point: a revocation
   committed before it must deny; one ordered after it affects the next
   request. A changed head causes retry or deny. A positive decision is never a
   reusable authorization token. Model output is buffered until
   citation/grounding checks and audit pass; unchecked output is never streamed
   to the caller. A local access lease authenticates the installation but never
   substitutes for fresh authoritative Person state. Multiple Authority writers
   remain unsupported until a distributed consistency mechanism replaces this
   fence.

   A reviewed, bounded feature contract may preselect independently immutable,
   append-only content outside that fence only after authenticating and
   authorizing the caller before any content access. It must recheck every
   mutable authorization fact and commit its audit in the final
   Authority-owned transaction before sending pre-serialized bytes. A
   concurrently appended row may affect only a later request; it may not alter
   or widen the selected response. This exception neither permits mutable
   projections outside the fence nor substitutes an authorization token for the
   final check.
6. **Failure cannot widen access.** Missing or renamed visibility data,
   unresolved identity, malformed policy state, stale versions, storage errors,
   and audit failures deny the affected path. An unresolved optional path does
   not erase an independently proved lower level: the resolver returns both the
   highest proved visibility and whether higher evaluation was incomplete.
   Ordinary callers receive one opaque not-found/denied shape for nonexistent,
   invisible, and indeterminate items; full diagnostics are governed admin
   data. This is an application authorization rule, not a license for a shared
   network limiter to deny the whole deployment.
7. **Structure and statistics inherit visibility before computation.** An edge
   cannot render above the lower visibility of its endpoints, and required
   provenance caps the item at the lower endpoint. Candidate counts, facets,
   term frequencies, ranking normalization, suggestions, autocomplete,
   highlights, explain/profile output, pagination bounds, cursors, and caches
   must all be computed from the caller-scoped set. No hidden-item stub or
   “restricted result” count is emitted. Every retrieval child or chunk carries
   and validates its parent's visibility binding; missing projection denies.
8. **Models cannot widen access or identity.** Inferred nodes and edges may
   describe but never confer visibility. A model may propose a link or grant to
   a human, visibly labeled and unselected; it may not bind an identity,
   approve, bulk-apply, or choose its own moving rule/tool version.
9. **Recording creates no recipient list.** Ingest does not itself grant a
   reader. The policy already in force may nevertheless make newly recorded
   content immediately readable; that is a policy consequence and must be
   shown on the approval surface before the record is created.
10. **Every response-authorization decision is auditable without creating a
    second disclosure surface.** The pre-response event records an authorized
    response attempt; it does not claim that a network client received the
    bytes. Minimum audit evidence is requester and installation,
    operation, target/citation identifiers or opaque digests, decision,
    path/reason code, Person and policy versions, timestamps, and response
    digest. A denial records no denied-item text, title, URL, participant,
    evidence, or other descriptive metadata. Audit visibility, export, and
    retention are explicit and never inherit the organization content floor.

## Formal evaluation semantics

### Path roots and combination

Every ordinary content path begins with all of:

```text
authenticated enrolled installation
AND current unexpired organization access lease
AND current active membership for the caller's principal
```

Historical attendance, reviewer status, or an explicit grant never keeps a
departed member readable. External readers are not supported by constitution
v1; adding them requires a separate root and threat review.

Each valid path proves one visibility level. Independent positive paths
combine with `max`. Record policy controls which path families are eligible;
it is not implemented as a hidden deny edge. An expired or revoked grant is
simply no longer a valid path.

Constitution v1 has no free-form deny edge. Narrowing comes from ending a live
fact, expiring or revoking an explicit grant, the record's reviewed intent, or
the monotonic floor rule. If a later product need cannot be represented that
way, a deny vocabulary requires its own conflict and explanation design; it is
not smuggled in as a traversal exception.

The internal result separates proof from completeness:

```text
visibility: invisible | discoverable | readable
evaluation: determined | incomplete
reason_code: stable machine code
path_kind: stable machine code | null
person_state_version
policy_version
record_head_position
record_head_hash
derived_cursor
derive_build_id
permission_act_head | null
permission_effect_cursor | null
evaluated_at
```

Only governed diagnostics see `reason_code` for an invisible result.

### Intent states and the visibility table

A future intent affordance requires a new versioned envelope schema. The
landed exact-key v1 schema cannot accept a new `intent_source` field.

| Valid state | Bare active-member path | Additional readable paths |
| --- | --- | --- |
| Legacy-unmarked old envelope | Effective historical floor | Active reviewer, later explicit grant |
| Future explicitly organization-readable | Readable | Not needed |
| Future explicitly restricted | At most `min(effective historical floor, discoverable)` | Active reviewer, verified explicit attendance, later explicit grant |
| Rejection without future intent marker | Effective historical floor | Active rejecting reviewer |
| Malformed, unknown-version, or internally inconsistent | Invisible and incomplete; operator alert | None |

The implementation-ready
[Job B minimum-V1 contract](2026-08-11-trusted-permission-aware-searchable-layer-2-design.md)
now names that future positive state `organization-member-readable-v1` and
defines it as a separate schema-v3 human-approved policy for current active
`owner` and `employee` memberships, including people who join later. It is not
implemented. It does not reinterpret legacy rows, establish a floor, or make
membership alone a path to reviewer-restricted content.

An unresolved participant link may leave discoverability proved while
readability is incomplete. It must not turn a separately proved discoverable
path into invisible, and it must not be treated as readable.

### Floor monotonicity

No floor is landed in the current code. The eventual design default is
discoverable only after the discoverable projection exists; “discoverable” is
not a shipped default.

For unmarked content, lowering visibility applies immediately to history;
raising it never silently reopens history. Formally, a record's effective
floor is the minimum visibility among organization floor acts from its ingest
through the evaluation point. A later higher floor applies only to records
ingested after that act. A floor increase alone never reopens existing
content. Existing content may become newly readable only through a separately
proved path that the pinned policy already defines, such as a later valid
attendance attestation, or through an explicit scoped grant.

Content older than the first recorded floor act has no historical floor and is
therefore invisible through the bare-membership path. A feature rollout is not
itself retroactive consent to disclose legacy history.

This keeps content frozen while making policy changes monotonic toward safety.
It deliberately does not infer per-record policy permanence from vendors that
make only the store's ACL *mode* permanent.

### Discoverable is an approved projection

The requester-facing discoverable surface is closed. It may expose only a
caller-scoped, non-enumerable, non-correlatable request handle, broad item
kind, approval date, and a separately human-approved discovery label when one
exists. It does not expose the raw
atom subject, meeting title, participants, evidence, source identifiers,
counts, scores, or grantor identity. If the policy cannot produce a safe
projection, the item remains invisible. Routing a request to an eligible
grantor does not require naming that person to the requester.

Power BI is only a narrow product precedent: authorized users can mark
promoted or certified semantic models discoverable after tenant configuration.
It demonstrates that existence can be separated from read access; it does not
justify auto-discovering every unmarked record
([Microsoft](https://learn.microsoft.com/en-us/power-bi/collaborate-share/service-discovery)).

### Gatekeeper and introspection shapes

The minimum resolver is an internal `evaluateVisibilityForCaller` operation,
not a public `can(person, item)` oracle. The served retrieve operation must
authenticate, evaluate, read only the authorized set, commit audit, and return
as one check-and-use flow. Responses remain `Cache-Control: no-store`.

- A requester-facing explanation is available only for an item already proved
  discoverable or readable, and only about the authenticated caller.
- Full no-path and identity-resolution diagnostics are admin/auditor data.
- Reverse enumeration (`who`) is deferred, admin-only, audited, bounded, and
  paginated. It cannot promise “everyone” without an explicit completeness
  contract and may never be used as an authorization result. OpenFGA likewise
  separates relationship-tree debugging (`Expand`) from effective reverse
  enumeration (`ListUsers`), whose results are deadline and size bounded
  ([OpenFGA](https://openfga.dev/docs/interacting/relationship-queries)).

The landed `POST /v1/permission-checks` is unrelated: it authorizes one Slack
approve/reject action on an approval surface. Its request and decision shapes
must not be reused for content visibility.

## Access facts and identity

### What is landed

- Current membership exists in Authority state, not in the derived content
  graph.
- Frozen participant observations exist in the derived store. They retain
  source claims and may produce `listed-participant` or `attended-by` edges.
- There is no principal-bound `observed-in(person, meeting)` edge.
- The projector creates `attended-by` only from explicit attended status.
  `listed-participant` includes invitees and no-shows and confers no read access.

### Future identity bridge

An immutable identity-link attestation belongs to Activity. Its effective
interval is a Person projection. Before participant access can ship:

- an observation claim is keyed by issuer or by the exact source adapter and
  instance, claim kind, and normalized value; a raw email/display string is
  never joined globally;
- normalization and tenant rules are exact and versioned;
- `attested_at` is distinct from `effective_from`;
- a link begins no earlier than attestation unless a human approves a bounded,
  evidenced retrospective interval;
- a correction/invalidation act can close a mistakenly attested interval and
  make affected paths fail closed without erasing history;
- the observation timestamp is unambiguous and falls inside the interval;
  absent or ambiguous time denies; and
- current active membership remains a conjunct of the final path.

AWS documents both accidental document-access changes from identity-map
updates and recycled-email risk. That supports treating mapping as privileged
and never equating an email with a principal; ECHO's interval and correction
rules remain our design choices
([AWS Quick](https://docs.aws.amazon.com/quick/latest/userguide/acl-best-practices-kb.html),
[legacy Amazon Q Business](https://docs.aws.amazon.com/amazonq/latest/qbusiness-ug/principal-store-hiw.html)).

Fuzzy assistance may propose an attestation to a human. It never binds.

## Permission changes are separate acts

Future requests, grants, refusals, revocations, identity attestations, and
floor changes use the same propose/confirm discipline as decisions, not the
same table or payload. Keep three narrow families:

1. the landed approval/rejection record log;
2. a future durable permission-act ledger; and
3. a future retention-bounded query-audit ledger.

They cross-reference stable identifiers and digests. The decision log must not
be generalized merely to reuse its chain; landed derive correctly halts on an
unknown event type.

Permission-act rules:

- **Every widening act is human-confirmed.** System timers may append expiry or
  closure outcomes that only narrow access. No model or timer widens access.
- **No self-approval.** A requester cannot approve their own access request.
  Concurrent approvers race through one atomic first-valid-decision rule;
  retries are idempotent.
- **Two-key authority.** A grantor needs both permission-vocabulary authority
  and a readable path to the exact scope. The first vocabulary authority comes
  from a one-time founder bootstrap act authenticated through the landed active
  owner membership. That act needs its own spec and named-human confirmation;
  no grant flow ships before it exists. Restricted-content features also need
  owner succession and a fail-closed orphan state before they ship.
- **Every scope is enumerated and bound.** The surface renders each item and a
  sentence-form resulting path. A scope digest proves that the submitted act
  was bound to the exact system-rendered scope; it does not prove the human
  read or understood every item.
- **Every grant has explicit expiry.** “Never” is a recorded choice. Renewal
  is another human-confirmed act.
- **Revocation is verified.** Appending a revocation is not completion until a
  fresh evaluation proves that act no longer contributes. Other independent
  paths may legitimately remain; an operation whose requested outcome is “no
  access” must enumerate them instead of claiming the one revocation removed
  everything.
- **Permission effects are head-aligned.** The gatekeeper either evaluates the
  durable permission acts directly or requires the effect projection cursor to
  equal the permission-act head. Any lag denies permission-dependent reads: a
  delayed new grant merely under-shares, while a delayed revocation can leak.
- **Every act pins its authorizing policy version.** Decision-capable tools and
  rules may not float to a latest version.
- **Operational credentials are separate.** Enrollment, lease, update, and
  access-recovery administration do not create content-visibility paths. They
  still require a reason, audit, and named operator identity.

Entra and Palantir are mechanism precedents, not guarantees. Entra offers
optional approval, justification, time bounds, and audit, while ECHO makes the
chosen controls mandatory; Palantir action logs record action type version,
timestamp, user, and submission-time context
([Entra PIM](https://learn.microsoft.com/en-us/entra/id-governance/privileged-identity-management/pim-configure),
[Entra approval policy](https://learn.microsoft.com/en-us/entra/id-governance/entitlement-management-access-package-approval-policy),
[Palantir action log](https://www.palantir.com/docs/foundry/action-types/action-log/)).

## Pilot slice 1

The minimum two-member read is defined by the dated
[Permission pilot v1 contract](2026-08-10-permission-pilot-v1-contract.md).
That companion is a bounded implementation contract, not a change to this
constitution or a claim that the feature has landed or shipped.

## Later stages, in dependency order

1. **Explicit intent.** Add a versioned human-provenance schema. Start with
   explicitly restricted content readable only to a current active reviewer;
   others remain invisible. Do not add request/grant machinery yet.
2. **Participant access.** Add scoped interval identity links, correction acts,
   and explicit attendance. Calendar listing remains non-authoritative.
3. **Discoverability and one-item grants.** Add an approved discovery
   projection, one-item requests, two-key approval, expiry, and revocation
   verification. No collection scopes or bulk approval.
4. **Scale only when observed.** Teams, roles, reverse enumeration, safe search
   indexes, statistics, model composition, grounding, interpretive links, and
   an external ReBAC engine remain separate decisions.

## Grounding against landed code

The following is descriptive, not aspirational.

| Area | Landed fact | Design consequence |
| --- | --- | --- |
| Decision rail | Protocol, log CHECK constraints, and derive accept only approval/rejection; authorization evidence uses `allowed: true` to prove the reviewer was authorized for either action. | A refusal remains an authorized semantic event. Permission acts need a separate family; they must not make `allowed: false` appendable evidence. |
| Record integrity | Update/delete triggers and chain verification protect normal paths and detect interior tampering; verification explicitly cannot detect valid-prefix truncation or rollback. | Absolute “cannot be deleted” claims are invalid without an external head. |
| Derived graph | Atoms, meeting snapshots, participant observations, and provenance edges exist; `supports` edges cannot cross an approval group. | Reuse deterministic provenance boundaries, but do not infer principal identity or readers. |
| Intent | Envelope v1 pins `{restricted: true, reconsider_after: null}` and exact keys; no human provenance exists. | All current records are legacy-unmarked for permission purposes. `intent_source` requires a new schema version. |
| Existing permission check | `/v1/permission-checks` authenticates Slack `approve`/`reject` actions and returns an unsigned, TLS-authenticated one-request decision. | It is not content visibility and is not a reusable authorization receipt. |
| Existing permission grants | `organization_permission_grants` are adapter-action grants such as view/approve/reject, bound to an approval-surface integration. | Future content-read grants need a distinct schema and name. |
| Person state | Membership and installation revocation plus audit append occur in one SQLite transaction. Authority audit is not chained, and membership status is mutable. | Preserve atomicity; before served reads, add a trustworthy Person-state version and restore reconciliation. A local chain alone does not solve rollback. |
| Provider authorization | Slack authorization rechecks the candidate and Authority state after external provider I/O. | Reuse the recheck-after-external-work pattern for response commitment. |
| HTTP | Authority JSON responses already send `Cache-Control: no-store`. | Pin this in future retrieve tests and ensure the Cloudflare edge never caches the route. |

The access-recovery skipped-head behavior is documented in the Authority
README as well as tests. The remaining operator-attribution gap is that one
shared administrator bearer credential yields only `actor_kind: admin`, not a
named human operator.

Deployment evidence is tracked separately from code grounding: the EC2 host is
the sole live Authority owner, the old Mac connector is disabled, and an
isolated restore of the reviewed image passed. That evidence lived in the
then-current EC2 runbook, which the clean lineage has since replaced with the
[clean deployment runbook](../../deploy/organization-authority/README.md).
Any production restore still requires Person-state reconciliation before
visibility service.

## Primary-source research ledger (checked 2026-08-09)

The ledger separates a source's useful evidence from ECHO's own decision.

| Source | What it supports | Trap or limit ECHO records |
| --- | --- | --- |
| [W3C PROV-O](https://www.w3.org/TR/prov-o/) | Attribution relates entities to responsible agents. | It does not define ECHO's trust ladder. |
| [EU AI Act, official text](https://eur-lex.europa.eu/eli/reg/2024/1689/oj?locale=en) | Article 50 includes machine-readable marking and disclosure duties for specified synthetic output. | Its editorial-control exception sits inside a narrowly defined disclosure duty; it is not a generic deterministic-projection exemption. |
| [Zanzibar](https://research.google/pubs/zanzibar-googles-consistent-global-authorization-system/) | Consistent snapshots and causal freshness address stale authorization. | It does not justify banning every cache; any cache must state and enforce a freshness contract. |
| [Google data-source access control](https://docs.cloud.google.com/generative-ai-app-builder/docs/data-source-access-control) | Expanded ACLs have a 3,000-reader limit and access-control mode is chosen at store creation. | This Preview feature does not prove per-record policy should be frozen. |
| [Microsoft Graph external items](https://learn.microsoft.com/en-us/graph/connecting-external-content-manage-items) | Group expansion can cause many item updates; deny takes precedence in that ACL model. | It demonstrates stamped-ACL costs, not that all external relationship tuples are wrong. |
| [Elastic document/field security](https://www.elastic.co/docs/deploy-manage/users-roles/cluster-or-deployment-auth/controlling-access-at-document-field-level) and [connector DLS](https://www.elastic.co/docs/reference/search-connectors/es-dls-overview) | Correct document filtering can still leak global terms/counts; an explicitly empty access field hides a document. | Omitting one DLS query or ACL field can grant broad access, and role queries combine with OR. Missing/renamed/default-role semantics must deny in ECHO. |
| [Bedrock ACL-aware retrieval](https://docs.aws.amazon.com/bedrock/latest/userguide/kb-test-retrieve-acl.html) | Missing user context and missing ACL metadata return no results. | Third-party identity credentials may be cached, permission changes are eventually consistent, and non-ACL sources in a mixed knowledge base remain available. ECHO partitions by policy mode. |
| [AWS Quick ACL guidance](https://docs.aws.amazon.com/quick/latest/userguide/acl-best-practices-kb.html) | Shared-email ambiguity denies and identifier recycling can expose a predecessor's documents. | Case-insensitive and plus-address handling reinforce that email is not a canonical principal. |
| [Power BI discovery](https://learn.microsoft.com/en-us/power-bi/collaborate-share/service-discovery) | Existence can be exposed without read access to support access requests. | Only promoted/certified semantic models are deliberately marked discoverable; this is not a default for unmarked content. |
| [OpenFGA relationship queries](https://openfga.dev/docs/interacting/relationship-queries) | Check, Expand, ListObjects, and ListUsers are separate operations. | Expand is a debugging tree; ListUsers is bounded. Neither makes an unrestricted `who` oracle safe. |
| [Purview Copilot audit](https://learn.microsoft.com/en-us/purview/audit-copilot) | Per-resource audit can record policy details and success/failure. | It may also store resource IDs, URLs, readable names, and sensitivity labels; ECHO adopts stricter minimization. |
| [Bedrock grounding](https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails-contextual-grounding-check.html) and [Google check grounding](https://docs.cloud.google.com/generative-ai-app-builder/docs/check-grounding) | Vendors expose probabilistic grounding/citation controls and input limits. | Threshold semantics differ; neither turns composed output into authoritative fact or guarantees zero unsupported claims. |
| [Entra approval policy](https://learn.microsoft.com/en-us/entra/id-governance/entitlement-management-access-package-approval-policy), [PIM](https://learn.microsoft.com/en-us/entra/id-governance/privileged-identity-management/pim-configure), and [access-review recommendations](https://learn.microsoft.com/en-us/entra/id-governance/review-recommendations-access-reviews) | Approval questions, no self-approval, optional approval/time bounds, audit, and stale review snapshots are shipped mechanisms. | Several safeguards are optional and review state can be snapshotted; ECHO must mandate and revalidate its chosen controls. |
| [Palantir action log](https://www.palantir.com/docs/foundry/action-types/action-log/) and [tool execution](https://www.palantir.com/docs/foundry/chatbot-studio/tools) | Actions can record action type version and submission context; tools may require confirmation. | Function tools may float to the latest version unless pinned; ECHO refuses moving authorization code and automatic widening. |
| [Azure AI Search sensitivity labels](https://learn.microsoft.com/en-us/azure/search/search-indexer-sensitivity-labels) | A label-aware path disables autocomplete/suggest where labels cannot be enforced and audits elevated reads. | It is a preview, label-specific path, not a general production break-glass precedent; child chunks missing label projection are not filtered correctly. |

## Field-admission rule

A new field or edge must answer:

1. Which pillar owns its meaning?
2. Is it a current fact, frozen content, durable act, or retention-bounded audit?
3. If it automatically grants access, is it maintained independently for a
   legitimate organization purpose and does it have freshness/correction
   semantics?
4. Can a sentence-form path or provenance citation use it without revealing a
   hidden item?
5. What exact failure, missing-field, restore, and version behavior applies?

Fields that exist only to prove an explicit permission act, its reason,
expiry, or audit are allowed; the “maintained for another reason” test applies
to facts that grant access automatically.

## Out of scope

This constitution does not specify MCP tools, UI, FTS layout, model prompts,
database layout for future ledgers, multi-organization tenancy, or an external
authorization engine. Feature specs must cite the invariants they exercise,
state their policy and Person-state versions, include over-disclosure tests,
and may not weaken the restore or infrastructure threat boundary by omission.
