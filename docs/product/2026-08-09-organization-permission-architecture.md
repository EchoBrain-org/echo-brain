# Organization permission architecture: pillars and skeleton (v1)

**Status:** Skeleton approved in founder session 2026-08-09; industry
cross-reference pass 2026-08-09 (three-agent primary-source review; see
"Industry cross-reference"); deliberately contains no feature. Features
(retrieve surface, request/approve flow, intent affordance, org-chart
onboarding) instantiate this document in their own specs and may not
contradict it.
**Builds on:**
[2026-08-07-org-decision-record-append-derive-design.md](2026-08-07-org-decision-record-append-derive-design.md)
(the shipped append/derive substrate and its industry deep-dives),
[org-brain-direction.md](org-brain-direction.md).

## Why this is the product

People put real decisions into a system only when they can predict who will
see them. Predictability — not merely correctness — is what prevents
self-censorship, and what is in the brain is what the brain is worth. The
permission model therefore produces the asset; it does not guard it. It is
also the one component that can fail silently: every other layer fails loudly
(bad append rejected, bad derive halts), while a wrong visibility answer
looks like a normal answer. This document exists to make that failure
structurally hard rather than procedurally avoided.

The gate philosophy is one idea applied twice: a human act decides what
enters the record, and a human's real-world context decides who sees it. The
system never exceeds what a person did or would do.

## The three pillars

All authoritative pillar data is organization-central, held by the authority
process. Pillar membership is epistemic, not physical — classify rows by what
they are, not by which database file holds them.

- **Person — who people are now.** Principals, memberships (owner/employee,
  active/revoked), installations, provider identity links, and — when they
  exist — groupings of principals (teams, roles, org-chart structure). This
  is the only pillar the gatekeeper reads live. It is current state with its
  own audit history, not an append-only log.
- **Content — what humans approved.** The canonical envelopes in the log are
  the authoritative form; the deterministic projections (atoms, meeting
  snapshots, participant observations, provenance edges) are the same content
  in servable shape, carrying zero independent authority and verifiable
  against the log by hash. Content is frozen forever. Nothing enters by
  type or by crawling; things enter by being approved.
- **Activity — what humans did.** Approvals, rejections, grants, requests,
  identity attestations, queries. Append-only, never edited. In this system
  activity is primary: the log is the activity pillar, and person-facts and
  content are downstream of recorded acts. Activity records what humans
  chose, never what they glanced at — an accountability ledger, not
  engagement telemetry. A query is an act (a stated question and a served
  answer, auditable under invariant 10); a scroll, click, view, or dwell is
  a glance, and glances are refused as fields.

Access in one sentence: **a live person walking a path through frozen
history.** When the person changes (leaves, switches teams), the person end
of every derived path changes with them — zero writes to content, zero
curation.

The pillars are closed; the edge vocabulary is open. Every future need —
teams, projects, contractor scoping — is a new relationship among existing
pillars, never a new pillar. (Precedent: Glean, Microsoft Graph, and
Atlassian's Teamwork Graph independently converged on this triad at
enterprise scale; the relationship-derivation discipline is Zanzibar's. See
the append/derive design's knowledge-graph permission deep-dive for
citations.)

## The trust ladder

Authority never transfers downstream. Derivation preserves content but not
authority; inference produces neither.

Rungs 2 and 3 are indistinguishable by lineage — both derive from rung 1.
What separates them is **attribution**: rung 1 is attributed to a person who
bears responsibility; rungs 2 and 3 to software, and rung 2 alone is
redeemable by rebuild digest. PROV-O draws exactly this axis — "Attribution
is the ascribing of an entity to an agent," where an agent "bears some form
of responsibility" ([PROV-O](https://www.w3.org/TR/prov-o/)) — so labeling
must key off the responsible agent, never off lineage.

1. **Canonical envelope** — human-approved, signed, hash-chained. May be
   cited as fact.
2. **Deterministic projection** — the same fact restated by code; verified by
   rebuild digest and record hash; cites rung 1. The test for this rung:
   the row cannot be wrong while the log is right.
3. **Inference** (future interpretive pass) — machine judgment about facts.
   The machine-judgment marking is **a field on the row, not a rendering
   convention**, so it survives export, API access, and clients we do not
   write (EU AI Act Art. 50(2) requires machine-readable marking of
   machine-generated output; its Art. 50(4) exemption for content with
   "human editorial review or responsibility for publication" is a
   regulator's version of rungs 1–2:
   [Art. 50](https://artificialintelligenceact.eu/article/50/)). Inference
   must cite rungs 1–2 and may never grant access. When entities and
   semantic edges arrive, the knowledge graph becomes a quad; the permission
   graph remains the triad.
4. **Answer composition** (query time) — ephemeral; must cite upward; "no
   approved decision covers that" is a first-class answer; persisted only in
   the query audit. Binding rules, each inverting a shipped vendor default
   (citations in the cross-reference section): every claim cites — there is
   no self-certified exemption (Google's `groundingCheckRequired: false`
   affordance is refused by name); support aggregates AND across cited
   atoms, never any-chunk-passes; nothing streams to the asker before its
   verdict resolves; verification is per cited atom, which also respects
   vendor input ceilings. No shipped grounding check permits a threshold of
   1.0 — zero ungrounded claims cannot be guaranteed — which is the standing
   argument for rung 4 remaining ephemeral and citing upward. Abstention is
   stronger here than in the precedents: "no approved decision covers that"
   is a statement about the organization's record, and it is the answer that
   makes request-and-approve possible.

## Invariants

1. **Unreachable, not filtered.** Retrieval traverses from the asker.
   Nothing unauthorized is ever selected, held, and then removed; it is
   never reachable. A traversal bug shows less, never more. Scoping happens
   **before scoring**: an index or ranking computed over the whole corpus
   and then trimmed is a filter with extra steps.
2. **Access derives only from facts the organization already maintains for
   other reasons** — employment, team membership, presence in a room, an
   explicit recorded grant. Never a reader list attached to a record.
   (Forced, not preferred: content is frozen, so a per-record reader list
   would make every membership change a rewrite of immutable records.
   Vendors document both failure axes of stamped lists: Google caps
   `acl_info` at "3000 readers … per document"
   ([Google](https://docs.cloud.google.com/generative-ai-app-builder/docs/data-source-access-control));
   Microsoft warns that group expansion into item ACLs causes "a high
   volume of item updates"
   ([Microsoft](https://learn.microsoft.com/en-us/graph/connecting-external-content-manage-items)).
   The early-binding camp — snapshot readers at approval time — fails the
   same way: a frozen reader list cannot follow a person who changes teams,
   which is the entire "live person walking a path through frozen history"
   claim.)
3. **Existence and content are separate rights** (traverse vs read). The
   visibility vocabulary is three-valued: invisible, discoverable, readable.
4. **Every grant is a path, expressible as one sentence to the person
   affected.** "You can see this because you were in that meeting." A rule
   that cannot be said that way does not enter the system. The path is also
   the explanation: there is no access the system cannot explain, because
   access is the explanation.
5. **Every visibility answer is computed against current reality.** No
   cached, replicated, or snapshotted permission state. Revocation is
   immediate by construction. (Zanzibar's new-enemy problem binds the moment
   this is violated; freshness tokens are the named remedy if caching is
   ever introduced. The alternative is a documented staleness window:
   Amazon Quick synchronizes permissions "every 24 hours by default";
   Moveworks runs a daily full pass with incrementals "every 15 minutes";
   Azure AI Search warns "a timing lag occurs" before permission changes
   are recognized. Any future proposal to cache permission state is a
   proposal to adopt a window of that order and must state its number.)
6. **Every failure denies.** Missing data, unresolved identity, ambiguity,
   error — all deny. The asymmetry is deliberate: wrongful denial costs a
   question to a colleague; wrongful disclosure cannot be undone. This
   holds because denial here is **per-query and self-healing** — the next
   query recomputes; the principle licenses no bulk revocation event.
   (Shipped precedent both ways: Amazon Quick "returns no documents rather
   than unfiltered results" when it cannot evaluate permissions, and denies
   everyone on a shared email "to prevent accidentally granting document
   access to the wrong person"
   ([AWS](https://docs.aws.amazon.com/quick/latest/userguide/acl-best-practices-kb.html));
   Elastic makes an empty access-control field mean "the document will be
   effectively invisible"
   ([Elastic](https://www.elastic.co/docs/reference/search-connectors/es-dls-overview)).)
7. **Structure and statistics obey the same rules as content.** An edge is
   visible only when both endpoints are. No stubs, no counts of hidden
   items, no "1 restricted result" — **and no statistic derived from
   content the asker cannot traverse**: term frequencies, corpus totals,
   ranking normalization, and pagination bounds computed over hidden
   content are themselves disclosures. Elastic, which filters documents
   correctly, still concedes a restricted user "could … count how many
   inaccessible documents contain a given term"
   ([Elastic](https://www.elastic.co/docs/deploy-manage/users-roles/cluster-or-deployment-auth/controlling-access-at-document-field-level));
   this invariant binds the index, not just the renderer.
8. **No model output can ever widen access.** Inferred nodes and edges
   describe; they never grant. The interpretive linker must be structurally
   incapable of creating a path that confers visibility — and its **read
   scope is itself declared and bounded**, so it cannot observe across
   audiences it must not link (Palantir's read authorization is "an
   additional upper bound on the data an action can read during execution"
   ([Palantir](https://www.palantir.com/docs/foundry/action-types/read-write-authorizations/))).
   A machine recommendation shown on any approval surface is rung-3
   inference: labeled as such, never pre-selected, never defaulted, never
   bulk-applied — a recommender whispering "approve" to a human relay is a
   widening path (Entra ships ML deny/approve recommendations and a bulk
   "Accept recommendations" button; both affordances are refused:
   [Entra](https://learn.microsoft.com/en-us/entra/id-governance/review-recommendations-access-reviews)).
9. **Recording is not sharing.** Entry into the organization record implies
   no readership. What the org may read of a record is decided by the
   permission model, never by the act of recording.
10. **Every visibility decision is auditable afterward** — who asked, what
    was served, by which path, and where a traversal terminated at a deny,
    that a deny occurred and by which rule, recorded without the denied
    item's content (the shape Purview ships: per-resource access records
    with policy details for blocked access:
    [Purview](https://learn.microsoft.com/en-us/purview/audit-copilot)).
    **The query audit is itself a governed record with its own visibility
    rule and retention horizon, stated at onboarding alongside the floor —
    it is never resolved by the floor.** The audit is a transitive map of
    who asks about what; under a readable floor it would otherwise be the
    design's largest silent disclosure.

**The gatekeeper is queryable, in three forms, all v1:** `can(person, item)`
returns readable / discoverable / invisible; `why(person, item)` returns the
path as its sentence, or the absence of one; `who(item)` returns everyone
with a path today, each with their sentence. All three distinguish
**granted / denied-for-lack-of-path / undeterminable** (identity unresolved)
— collapsing the last two hides exactly the identity-bridge failures
invariant 6 exists to catch. (Precedent: Amazon Quick's permission checker
returns has-access / no-access / "No access control list found"
([AWS](https://docs.aws.amazon.com/quick/latest/userguide/sync-reports-observability.html));
OpenFGA splits Check from Expand, the latter "to understand why a user has a
particular relationship with a specific object"
([OpenFGA](https://openfga.dev/docs/interacting/relationship-queries)).)

## Access as path

Founding facts (v1 vocabulary, both already in the graph):

- `member(person, organization)` — live, from authority memberships.
- `observed-in(person, meeting)` — frozen, from participant observations,
  usable only through the identity bridge below.

When groupings arrive, a `member(team)` path is preferred over enumerating
`observed-in` wherever both are true — per-attendee enumeration at a
60-person all-hands has the fan-out shape of the flat reader lists
invariant 2 forbids.

Visibility levels:

- **Invisible** — the asker cannot know the item exists.
- **Discoverable** — the asker may see that a decision exists: its subject,
  its date, and who can grant access. That surface is **exhaustive and
  closed** — specifically not participant lists (which would leak who met
  with whom), not evidence, not counts. Discoverable is what makes
  request-and-approve possible at all. This level is a **deliberate
  departure** from enterprise-KG practice, where restricted items are
  uniformly trimmed to invisible; the one shipped precedent is Power BI's
  discoverability state, added for exactly our reason: without it, users
  "don't know it exists, so they can't even request access"
  ([Microsoft](https://learn.microsoft.com/en-us/power-bi/collaborate-share/service-discovery)).
  Incumbents inherit source-system ACLs and cannot safely do this; we own
  the record and can.
- **Readable** — full content with verbatim evidence and provenance.

**The floor is the one organization-level choice.** At onboarding an
organization chooses what bare membership grants for unmarked content:
invisible, discoverable, or readable. Everything else derives from facts and
recorded acts; nothing else is configurable. The shipped default is
**discoverable**. The floor is a cultural statement about the organization,
which is why it is the single explicit setting rather than one knob among
many.

**A floor change is prospective only.** Each record resolves against the
floor act in force at that record's ingest — exactly as the dated policy
treats the restricted flag. A floor may be lowered for the future; it may
never be raised over the past. Raising visibility of existing records is
not configuration but disclosure, and takes the form of explicit grant acts
with a named approver. (Google, Amazon Q Business, and Amazon Quick all make
the access-control mode of a store permanent at creation — "You can't turn
this setting on or off for an existing data store"; "Document-level ACL
configuration is permanent"; "Once you turn ACL and identity crawling on
you won't be able to turn them off." We permit the change but bind it to
the future — the weakest form of the same protection, and the strongest
compatible with the floor being a choice at all.)

A projection whose resolution is determinable and merely **unmarked**
resolves by the floor — a policy choice. A projection whose intent flag is
unreadable, absent, or corrupt is **invisible**, not floor-defaulted
(invariant 6): unmarked and unknown are different things.

Reporting lines and roles, when they arrive, are facts access *may* derive
from through stated policy — never automatic grants. Hierarchy is data, not
permission.

## Permission changes are acts

Grants, requests, revocations, identity attestations, and floor changes are
human acts on the same rails as decisions: request → named human approval →
immutable appended record → derived effect. The permission system is the
decision system pointed at itself. (Palantir states the same identity from
the other side: "Submission criteria support encoding business logic into
data editing permissions" — the business rule *is* the permission
([Palantir](https://www.palantir.com/docs/foundry/action-types/submission-criteria/));
Entra PIM ships grants as approval-gated, justified, audited acts
([Microsoft](https://learn.microsoft.com/en-us/entra/id-governance/privileged-identity-management/pim-configure)).)

Consequences: grants cannot be forged, silently edited, or deleted; every
grant has a named approver and timestamp; revocation is a new act, never an
erasure; "who granted this and when" is the same query as "who decided this
and when."

Rules of the rail:

- **The grant-granting right is first-class and two-key.** A grant act is
  valid only when the approver holds authority over the permission
  vocabulary (itself established by a recorded act) *and* a path to the
  scope being granted; neither implies the other. V1 rule: the approver of
  a decision is its grantor of record, and the discoverable level's "who
  can grant access" is computed by that rule and nothing else. (Precedent:
  Databricks requires `ASSIGN` on the governed certification tag *and*
  apply rights on the object
  ([Databricks](https://learn.microsoft.com/en-us/azure/databricks/data-governance/unity-catalog/certify-deprecate-data));
  Fabric binds certification to admin-defined security groups plus item
  write permission
  ([Microsoft](https://learn.microsoft.com/en-us/fabric/admin/endorsement-certification-enable)).)
- **Every grant carries an expiry; "never" is a recorded choice, not an
  absent field.** Extension and renewal are new acts requiring the same
  approval as the original; never automatic, never silent. (Entra: expiry
  on date / days / hours / never, with "Require approval to grant
  extension"
  ([Microsoft](https://learn.microsoft.com/en-us/entra/id-governance/entitlement-management-access-package-lifecycle-policy));
  symmetry: rejections already carry `reconsider_after`.)
- **The approval surface contract.** It renders the full scope enumerated
  as items (never a name or count), the requester's stated reason, and the
  sentence-form path the grant would create (invariant 4). It offers no
  action that decides anything the approver has not opened — bulk accept
  does not exist. Approver justification is mandatory and visible to the
  requester. The scope is digested at render and re-checked at submit; if
  the digest changed, the approval is refused and re-presented
  (compare-and-swap on scope — the informed-approver requirement made
  enforceable). The grant act records that digest, so "the approver saw
  exactly what the scope contains" is verifiable afterward rather than
  asserted (Palantir's action log stores "the state of the world when
  decisions are made"
  ([Palantir](https://www.palantir.com/docs/foundry/announcements/2022-10/index.html));
  Entra requester questions "shown to approvers to help them make a
  decision," justification "visible to other approvers and the requestor"
  ([Microsoft](https://learn.microsoft.com/en-us/entra/id-governance/entitlement-management-access-package-approval-policy)).)
- **No out-of-band grant path exists.** A grant that did not occur as an
  appended act does not exist, even if a human said yes in a hallway.
  (Power BI's default routes access requests to *email*, making the system
  record optional
  ([Microsoft](https://learn.microsoft.com/en-us/power-bi/connect-data/service-datasets-build-permissions));
  that affordance is refused.)
- **An unanswered request never auto-approves.** Expiry of a request is
  itself an appended act with a stated duration, so the record
  distinguishes refused from ignored (Entra: "If a request isn't approved
  within this time period, it's automatically denied").
- **Revocation targets explicit grants only.** Access derived from a live
  fact has no grant to revoke — it ends when the fact ends (membership
  revoked, link interval closed). This is the acknowledged/revocable
  distinction identity governance draws: automatically-derived access "the
  certifier can only acknowledge"
  ([SailPoint](https://documentation.sailpoint.com/saas/help/certs/completing_campaigns.html)).
  Consequence stated positively: derived paths make standing-access
  recertification largely structurally unnecessary — access expires when
  facts change — so periodic re-review, when it arrives, is scoped to
  explicit grants alone.
- **Every act records the version of the rule under which it was
  authorized**, not only the grant it used. The dated policy is this
  mechanism in prose, and prose does not survive a second policy change
  (Palantir's action log carries the action-type version per entry:
  [Palantir](https://www.palantir.com/docs/foundry/action-types/action-log/)).
- **No permission-family act auto-runs.** Model- or rule-initiated
  submission without a human gate is refused even as a configuration
  (Palantir permits actions "to run automatically"; declined here — a
  configurable gate is not a gate).

Responsibility split: the requester and approver own the judgment; the
system owns that the judgment was **informed** (enforced by the surface
contract above) and **faithfully enforced** (no wider, no narrower, by an
approver holding both keys).

## The identity bridge

Content identifies people by observation (an email address seen in a
meeting). The person pillar deliberately holds no emails — display names,
email addresses, and unscoped provider IDs are not canonical identity.
Therefore:

- An observation binds to a principal **only** through an attested identity
  link: a recorded act by an authorized human stating the binding, with its
  verification method named, scoped, and auditable. (AWS reaches the same
  governance conclusion for its User Store: treat identity-mapping updates
  as "a privileged operation" behind "a documented approval process"
  ([AWS](https://docs.aws.amazon.com/amazonq/latest/qbusiness-ug/principal-store-hiw.html));
  Atlassian's published 1P↔3P user mapping is the same interposition
  ([Atlassian](https://developer.atlassian.com/platform/teamwork-graph/permissions-and-access-control-lists/)).)
- **An identity link is an interval, not a permanent equation.** An
  observation resolves through the link that was valid at the observation's
  timestamp — never through a link attested later for a later holder of the
  same address. Revocation ends the interval without erasing it. An
  identifier that has ever been bound is never silently rebound: a new
  attestation over it must name the binding it succeeds, and its interval
  begins at attestation, never earlier. This closes the recycled-identifier
  trap AWS documents — "the new employee may temporarily access documents
  intended for the previous employee" — which is worse here because our
  observations are frozen: one careless rebinding would grant a stranger a
  predecessor's entire meeting history
  ([AWS](https://docs.aws.amazon.com/quick/latest/userguide/acl-best-practices-kb.html)).
- Absent a link interval covering the observation, the path denies
  (invariant 6). No fuzzy matching, no display-name guessing, ever. AWS
  ships the same rule for ambiguity: a shared email "denies access to
  everyone using that shared email." If fuzzy assistance is ever added, it
  may propose links for attestation; it may never bind (invariant 8 applied
  to identity).

## The field-admission rule

The pillars never grow; fields and edge types grow only through this gate.
A proposed field must answer:

1. **Which pillar?** If not clearly one, it is not a field but a confusion.
2. **Does the organization already maintain it for other reasons?** A field
   requiring new curation is rot on arrival (invariant 2).
3. **Can a one-sentence access path or provenance citation use it?** If
   neither, it does not belong in the graph.
4. **Live or frozen?** Person fields are live; content and activity fields
   are frozen. A field that wants both is two fields.

## Industry cross-reference (2026-08-09)

Three parallel reviewers (Opus 5) tested this document against the
precedent atlas and primary sources — AWS Q Business/Quick, Elastic,
Google Vertex AI Search, Microsoft Graph connectors / Azure AI Search /
Entra ID Governance / Power BI / Purview, Atlassian Teamwork Graph
developer docs, Moveworks, OpenFGA, Palantir Foundry, Google
check-grounding, Bedrock Guardrails, PROV-O, EU AI Act. Amendments are
folded inline above; this section records the standing stances and source
corrections.

### Recorded stances

- **Break-glass: there is no override.** Elevated read for investigations
  (Azure ships "elevated read requests for auditable investigations") may
  only ever be an ordinary grant act — named approver, stated scope,
  expiry, sentence: "you can see this because the organization granted you
  investigative access on [date], approved by [name]." An override
  implemented as traversal bypass violates invariants 1 and 4
  simultaneously and is the silent-failure mode this document exists to
  prevent. Built under incident pressure is exactly how it would otherwise
  arrive; hence recorded now.
- **No deny primitive.** Nothing in the graph subtracts; paths only grant.
  The only negative control is pre-ingest exclusion, which is deliberately
  *before* the log: a member decides what never becomes organization
  content, and that decision is not an organization act because it concerns
  material the organization never received. Consequence recorded honestly:
  exclusion is invisible to the organization, not org-centrally auditable,
  and therefore **not a permission mechanism** — it must never be described
  as one. If exclusion ever needs org review, it becomes an act and moves
  inside the log; it does not become a deny edge. (Industry is split:
  Microsoft ACLs carry deny-takes-precedence; Atlassian is additive-only.
  We choose additive because a deny edge cannot be a one-sentence *grant*
  path and because revocation-of-derived-access has a cleaner answer: end
  the fact.)
- **Staleness lives in the human layer too.** An approval surface that
  computes its scope at render and applies it at submit reproduces
  invariant 5's problem inside the approval; hence the scope-digest
  compare-and-swap in the surface contract (Entra's decision helpers are
  "determined when the review begins and … not updated while the review is
  in-progress" — the trap, shipped).
- **Grounding vendor defaults are inverted deliberately** (rung 4): no
  self-certified exemption (`groundingCheckRequired: false` refused), AND
  across cited atoms not any-chunk-passes, no streaming before verdict,
  per-atom verification. No vendor publishes a safe threshold and 1.0 is
  structurally unavailable — the recorded argument for rung 4's ephemerality.

### Source corrections (atlas and prior doc)

- **Veza is withdrawn as the invariant-10 precedent.** Its reachable pages
  are marketing without a data model; the documented precedents for
  "effective access, explained" are OpenFGA's Expand and Amazon Quick's
  three-valued permission checker, cited above.
- **The atlas overstated Palantir's agent bounding.** No first-party doc
  says AIP agents "can only act through action types" — Agent Studio ships
  non-Action tools including arbitrary Functions. The verifiable claim,
  cited above, is that agentic activity is governed by "the same security
  policies that govern human usage" with staged-then-human-reviewed edits.
  Invariant 8 leans only on the verifiable form.
- **Power BI has no built-in request-certification flow** (atlas claim):
  the button is greyed out with a documentation link, or routes to email.
  The real routed-request precedents are Glean's request-verification-with-
  reason and Power BI's *discoverability → request access* path — a
  different feature, and the one cited for the discoverable level.
- **Diligent's trust root is an officer's attestation** ("have not been
  amended, rescinded or modified … as of the date of this certification"),
  not record immutability. Cited only for the certified-resolution concept;
  our hash chain is the stronger mechanism and the two must not be framed
  as convergent.
- **Atlassian is promoted from "principle only" to mechanical precedent**:
  developer docs publish the permission object shape, four principal types
  including a workspace-wide principal (a floor primitive), additive
  AND/OR evaluation, and the 1P↔3P user mapping. The append/derive doc's
  "architecture-thin" note is corrected in place.
- **Coveo remains unverifiable** (503s on all doc fetches); nothing in this
  document rests on it.

## Appendix A — first instantiation (pilot)

Proof the skeleton carries load, stated as paths.

The floor is per-organization: the pilot organization (n=2, both founders)
sets its floor to **readable**; the shipped default for new organizations
remains **discoverable**. Both are the same rule with a different org
choice:

- **Rule 1 (floor):** asker → `member` → org → unmarked atom ⇒ the org's
  floor level (pilot: readable). Sentence: "You can see this because you
  are a member of the organization."
- **Rule 2 (restricted):** asker → identity link → observation →
  `observed-in` → source meeting → atom ⇒ readable; approver always
  readable via the approval act. Sentence: "You can see this because you
  were in that meeting (or approved it)."

**Dated policy — the first written policy of the gatekeeper:** records
ingested before the approval surface offers an intent control provably carry
no human intent behind their `restricted` flag (the flag is a protocol
default; no affordance exists). Such records resolve by the floor. Records
ingested after the affordance ships mean what they say: restricted resolves
by Rule 2. The frozen flag never changes; only its interpretation is dated.
This is the stone/gatekeeper split in first use, and the policy text itself
is auditable.

Practical consequence for the pilot: until the affordance ships, every
recorded decision resolves readable to both members. Anything that must not
be org-visible belongs on the member-side exclusion list, not behind the
flag. The query audit does **not** resolve by the pilot's readable floor
(invariant 10); its readership is the org owners until stated otherwise.

**V1 needs only Rule 1.** Rule 2 requires the identity bridge, which ships
as one bundle with the intent affordance and the request/approve flow —
none is meaningful without the others.

**Explicitly deferred by this instantiation:** the identity-attestation
admin flow, request/approve UX, org-chart import and grouping vocabulary,
teams/roles/projects as facts, the query surface itself (retrieve spec),
search and ranking, query-audit schema and its retention horizon,
interpretive linking, model composition and grounding, delivery-receipt
("informed") centralization, periodic re-review of explicit grants.

## Out of scope of this document

Everything in the deferred list above, plus: MCP tool shapes, FTS indexing,
storage layout of the audit, multi-organization tenancy, and any enforcement
implementation. Feature specs that instantiate this skeleton must cite the
invariants they exercise and may not weaken them.
