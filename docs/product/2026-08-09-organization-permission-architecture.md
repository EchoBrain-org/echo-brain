# Organization permission architecture: pillars and skeleton (v1)

**Status:** Skeleton approved in founder session 2026-08-09; deliberately
contains no feature. Features (retrieve surface, request/approve flow, intent
affordance, org-chart onboarding) instantiate this document in their own
specs and may not contradict it.
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
  engagement telemetry. Clicks, views, and shares are refused as fields.

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

1. **Canonical envelope** — human-approved, signed, hash-chained. May be
   cited as fact.
2. **Deterministic projection** — the same fact restated by code; verified by
   rebuild digest and record hash; cites rung 1. The test for this rung:
   the row cannot be wrong while the log is right.
3. **Inference** (future interpretive pass) — machine judgment about facts.
   Labeled as such wherever shown, must cite rungs 1–2, may never grant
   access. When entities and semantic edges arrive, the knowledge graph
   becomes a quad; the permission graph remains the triad.
4. **Answer composition** (query time) — ephemeral; must cite upward; "no
   approved decision covers that" is a first-class answer; persisted only in
   the query audit.

## Invariants

1. **Unreachable, not filtered.** Retrieval traverses from the asker.
   Nothing unauthorized is ever selected, held, and then removed; it is
   never reachable. A traversal bug shows less, never more.
2. **Access derives only from facts the organization already maintains for
   other reasons** — employment, team membership, presence in a room, an
   explicit recorded grant. Never a reader list attached to a record.
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
   ever introduced.)
6. **Every failure denies.** Missing data, unresolved identity, ambiguity,
   error — all deny. The asymmetry is deliberate: wrongful denial costs a
   question to a colleague; wrongful disclosure cannot be undone.
7. **Structure obeys the same rules as content.** An edge is visible only
   when both endpoints are. No stubs, no counts of hidden items, no
   "1 restricted result."
8. **No model output can ever widen access.** Inferred nodes and edges
   describe; they never grant. The interpretive linker must be structurally
   incapable of creating a path that confers visibility.
9. **Recording is not sharing.** Entry into the organization record implies
   no readership. What the org may read of a record is decided by the
   permission model, never by the act of recording.
10. **Every visibility decision is auditable afterward:** who asked, what
    was served, by which path. The audit is activity-pillar data,
    organization-central.

## Access as path

Founding facts (v1 vocabulary, both already in the graph):

- `member(person, organization)` — live, from authority memberships.
- `observed-in(person, meeting)` — frozen, from participant observations,
  usable only through the identity bridge below.

Visibility levels:

- **Invisible** — the asker cannot know the item exists.
- **Discoverable** — the asker may see that a decision exists: subject,
  date, and who can grant access. Not its content, not its evidence.
  Discoverable is what makes request-and-approve possible at all, and it
  matches healthy organizational behavior ("there's a pricing decision from
  August; ask Alice") made consistent.
- **Readable** — full content with verbatim evidence and provenance.

**The floor is the one organization-level choice.** At onboarding an
organization chooses what bare membership grants for unmarked content:
invisible, discoverable, or readable. Everything else derives from facts and
recorded acts; nothing else is configurable. The shipped default is
**discoverable**. The floor is a cultural statement about the organization,
which is why it is the single explicit setting rather than one knob among
many.

Reporting lines and roles, when they arrive, are facts access *may* derive
from through stated policy — never automatic grants. Hierarchy is data, not
permission.

## Permission changes are acts

Grants, requests, revocations, identity attestations, and floor changes are
human acts on the same rails as decisions: request → named human approval →
immutable appended record → derived effect. The permission system is the
decision system pointed at itself.

Consequences: grants cannot be forged, silently edited, or deleted; every
grant has a named approver and timestamp; revocation is a new act, never an
erasure; "who granted this and when" is the same query as "who decided this
and when."

Responsibility split: the requester and approver own the judgment; the
system owns that the judgment was **informed** (the approver saw exactly
what the scope contains, not just its name) and **faithfully enforced** (no
wider, no narrower, by an approver with authority). An approval surface that
shows only a scope's name is accountability theater and violates this
document.

## The identity bridge

Content identifies people by observation (an email address seen in a
meeting). The person pillar deliberately holds no emails — display names,
email addresses, and unscoped provider IDs are not canonical identity.
Therefore:

- An observation binds to a principal **only** through an attested identity
  link: a recorded act by an authorized human stating the binding, with its
  verification method named, scoped, and auditable.
- Absent a link, the observation stays unresolved and every path through it
  denies (invariant 6). No fuzzy matching, no display-name guessing, ever.
  If fuzzy assistance is ever added, it may propose links for attestation;
  it may never bind (invariant 8 applied to identity).

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
flag.

**V1 needs only Rule 1.** Rule 2 requires the identity bridge, which ships
as one bundle with the intent affordance and the request/approve flow —
none is meaningful without the others.

**Explicitly deferred by this instantiation:** the identity-attestation
admin flow, request/approve UX, org-chart import and grouping vocabulary,
teams/roles/projects as facts, the query surface itself (retrieve spec),
search and ranking, query-audit schema, interpretive linking, model
composition and grounding, delivery-receipt ("informed") centralization.

## Out of scope of this document

Everything in the deferred list above, plus: MCP tool shapes, FTS indexing,
storage layout of the audit, multi-organization tenancy, and any enforcement
implementation. Feature specs that instantiate this skeleton must cite the
invariants they exercise and may not weaken them.
