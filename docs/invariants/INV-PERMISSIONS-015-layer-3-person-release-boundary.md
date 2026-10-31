---
schema_version: 1
id: INV-PERMISSIONS-015
kind: invariant
title: Layer 3 is the sole Authority content-release boundary
component_ids:
  - CMP-PERMISSIONS
  - CMP-IDENTITY-ACCESS
  - CMP-ORGANIZATION-AUTHORITY
created_at: 2026-08-22
reviewed_at: 2026-10-03
reviewed_ref: 254d5ddcbdbc1c7881e7a4ba541f5383ab19af59
decision_ids:
  - ADR-0006
  - ADR-0007
  - ADR-0010
  - ADR-0015
  - ADR-0017
  - ADR-0019
  - ADR-0022
  - ADR-0023
  - ADR-0024
  - ADR-0026
  - ADR-0030
  - ADR-0032
  - ADR-0033
  - ADR-0034
  - ADR-0036
  - ADR-0038
  - ADR-0039
  - ADR-0040
  - ADR-0042
  - ADR-0044
  - ADR-0046
  - ADR-0047
  - ADR-0049
normative: MUST
enforcement_status: partial
enforcement_scope: Current-Person Layer 1 listing and Layer 2 exact-generation search release with project audiences and associations, the ADR-0024 Person list and open-by-reference paths and the mine scope of list and Ask, the ADR-0026 person-bound Jira live evidence path, the person-bound Confluence live page path whose decision record (ADR-0034) is proposed and not yet accepted, the ADR-0030 imported meeting notes boundary as narrowed by ADR-0046 (their importer only), the ADR-0032 stored-run view as widened by ADR-0033, the ADR-0033 open-item reads and the ADR-0040 follow-ups Ask source over them, the ADR-0036 change check (digests only), the ADR-0039 Ask progress stream (names only after the access check before a model call), the ADR-0042 workspace sources (the asker's projects, people and tools) and tool containers (Jira projects and Confluence spaces) of the V8 Ask, and the Layer 4 request-local release and citation boundary
---

# INV-PERMISSIONS-015: Layer 3 is the sole Authority content-release boundary

## Rule, scope, and rationale

Layer 3 MUST be the sole Authority content-release boundary. No consumer above
Layer 3 may read Layer 1 records or Layer 2 retrieval generations directly.
Layer 4 is only a Layer 3 client: it has no privileged or lower-latency path to
either lower layer, record storage, retrieval storage, or an Authority
database.

A model, agent, adapter, service, or provider identity has no read authority.
It may read only under an authenticated Person principal's scope, with that
Person's active organization membership. An agent has no membership and MUST
never be granted one. Any synthesized answer may cite only atom references
that Layer 3 actually released to that exact caller in that exact request; it
MUST NOT re-retrieve under a different scope, accumulate atoms across requests,
or cite an atom that was not released. A model may propose bounded query text,
but Layer 3 MUST derive all identity and policy facts and execute every query
in the one request under one authenticated Person and one pinned snapshot.

Layer 2 holds content across all policy segments. A consumer that reads it
directly can see every restricted-reviewer record in the organization. This is
the confused-deputy failure that a latency shortcut would create. The rule
prevents provenance, execution identity, provider custody, or service
possession from being mistaken for human permission. It covers clean V1 Layer 1
listing, Layer 2 search, and the composed Layer 4 `ask` path. ADR-0015 extends
that bounded path to authorized Person originals and optional project scope;
it does not grant generic raw-meeting access or permit a privileged model read.
ADR-0024 adds model-free Person list and open-by-reference paths over the same
readable set; their project and mine scopes only narrow it.

ADR-0010 once let an Authority-owned projector, while a fresh Layer 2
generation was built, propose cross-record pairs from one visibility
segment's approved atoms.
[ADR-0044](../decisions/ADR-0044-search-rebuilds-make-no-model-call.md)
removed it: the readable-search generation is built from approved records
alone, with no model call, and a desk open releases only the anchor's own
record.

## Enforcement and failure behavior

The Authority authenticates and resolves the Person, checks current membership
and the exact content policy, binds Layer 2 to an exact generation and record
head, rechecks the caller at the release fence, commits the minimized response
digest, and only then returns the audited bytes. Missing, stale, mismatched, or
non-Person authority MUST release no content. Search construction MUST NOT be
triggered by a query. Layer 4 receives no lower-layer handles and may pass
citations only after checking that they are a subset of what Layer 3 released
in that request.

ADR-0019, as updated by ADR-0022, permits the `/v7` Ask to make bounded desk
calls and at most 24 model calls, including retries and repairs, in one
request; a background trigger on the same loop (an impact check or a sweep)
may make at most 48. The desk pins the record
snapshot or fixes an explicitly original-only mode when the index starts
behind. Every desk release is audited before bytes leave Layer 3. Before each
model call, repairs included, recheck every item and metadata released since
the previous successful check, together with the session, membership tenure,
grants, each live connection and the snapshot pin
([ADR-0038](../decisions/ADR-0038-incremental-access-check-before-model-calls.md)).
An item is checked at the first check after its release, not when it reaches a
prompt. An item that passed an earlier check is not re-read before later model
calls in that request, so an item revoked after that check may still enter
model input for the first time, or stay in it, until the request ends. Before
the final response, recheck all released items and metadata; only that check
keeps such an item out of a response. Malformed output permits one
repair within the hard budget and then a deterministic cited-evidence fallback. Unknown or
out-of-part citations never establish support. Authorization, audit, snapshot
and cancellation failures release no answer.

[ADR-0039](../decisions/ADR-0039-ask-progress-names-after-the-access-check.md)
adds one release path before the final response: a streamed Ask names an item
only after the access check before the model call that reads it, by its
citation projection alone, and only the final check keeps a since-revoked item
out of the answer and its receipt. What an event may carry, the terminal error
and the audit are ADR-0039's
[Decision and consequences](../decisions/ADR-0039-ask-progress-names-after-the-access-check.md#decision-and-consequences).
Only `/v7` streams, in progress V3: every Ask route before it is retired
([ADR-0047](../decisions/ADR-0047-ask-timeline.md)).

ADR-0026 extends this boundary to Jira live evidence, added on `POST /v4/person/ask`
and read on `POST /v7/person/ask` since ADR-0047 retired the routes before it.
The provider reads as the authenticated Person's current Jira grant. Audits commit
only coordinates, digests and authorization commitments before releasing evidence;
tool bodies and metadata remain request-local and never enter Layer 1 or Layer 2.
Every later model call rechecks the evidence released since the previous
successful check, the membership tenure, session, grant and connection; the final response
rechecks all released evidence (ADR-0038). Disconnect, replacement consent, lost
membership, changed permissions, audit failure or cancellation releases no answer.
Project Jira reads MUST use a lead-configured mapping and the asker's own current
connection. The exact ECHO project grant, mapping revision and stable Jira project
ID narrow every read; moved tickets, mapping edits/removal and lost membership
invalidate in-flight evidence. A runtime project fence cannot be widened by a
mapping. The mapping stores configuration coordinates only, never tool content.
Mine and unmapped ECHO projects exclude Jira.

Update, 2026-10-11: Confluence page evidence, added on `POST /v5/person/ask`
(V6 answers) and read on `POST /v7/person/ask` now, runs through the same audited live-evidence
path, under the asker's own Confluence grant and, in a project, only the
lead-mapped spaces; Mine and unmapped projects exclude it. Its decision record,
[ADR-0034](../decisions/ADR-0034-confluence-person-live-page-evidence.md), is
proposed, not accepted, so this path does not yet meet the accepted-ADR
requirement of the change procedure below. Its negative disclosure tests are
`providers/confluence/test/confluence-person-live-evidence-reader-v1.test.ts`
and `services/organization-authority/test/confluence-person-ask-integration.test.ts`.

Runtime model-content capture is
suppressed once live metadata or text enters a prompt, except for the selected
diagnostic paths that
[connector contracts](../architecture/connector-contracts.md#live-evidence)
name (the person's own one-use capture and the operator-selected, staging-only
LangSmith exporter); operational metrics remain.

ADR-0032 extends the same rule to a stored run of an approved record's impact
check. The check runs as the approver with that person's own access, and the
stored run keeps only pointers and ECHO's own judgments, never words read from
outside ECHO. Every view re-releases the stored items through a fresh desk under
the viewer's current session, membership tenure and grants: an item the viewer
can no longer open is hidden and counted, and outside text is read again rather
than stored. Anyone but the approver sees no such run in a list and gets
`not_found` when starting or retrying it. ADR-0033 widens viewing: anyone who
can read the decision may view the run's card, rebuilt the same way under that
viewer's access; anyone else gets `not_found`.

ADR-0033 applies the same rule to open items. A row keeps pointers, ECHO's own
`expected` phrase, member ids and the latest check's verdict, never words read
from outside ECHO. Every item read opens the item again through a fresh desk as
the viewer, and only a viewer who can open it live gets its title, text or
current details. Who sees a row and who may act on it comes from one access
policy. A sweep acts as the person who asked and stores only verdicts and
the ECHO ids of the items it could not read, never words read from outside
ECHO. It names a decision in what it hands research only when the policy shows that
person the decision, and records a verdict only on an item that person still
sees as the sweep finishes. That check runs just before the finishing
transaction, not inside it: access another process revokes in that instant is
not seen, a known gap of open items and Home v1.

[ADR-0040](../decisions/ADR-0040-follow-ups-as-ask-evidence.md) adds open
items to Ask as follow-ups, first on V7 answers served by `POST /v6/person/ask`
and now on the V8 answers of `POST /v7/person/ask`. The follow-ups source releases exactly what the
open-items policy shows the asker, and each check puts the follow-ups released
since the last one through that policy again. Who sees what, its audit and its
checks are ADR-0040's
[Decision and consequences](../decisions/ADR-0040-follow-ups-as-ask-evidence.md#decision-and-consequences),
and its negative disclosure tests are listed under
[Migration, rollback, and evidence](../decisions/ADR-0040-follow-ups-as-ask-evidence.md#migration-rollback-and-evidence).

[ADR-0042](../decisions/ADR-0042-research-tool-contract.md) adds the asker's
workspace and their tools' containers to Ask on V8 answers, served by the
additive `POST /v7/person/ask`, which streams under the ADR-0039 rules above
in progress V3. Who sees what, its audit and its checks are ADR-0042's
[Permissions, audit and checks](../decisions/ADR-0042-research-tool-contract.md#permissions-audit-and-checks),
and its negative disclosure tests are listed under
[Migration, rollback, and evidence](../decisions/ADR-0042-research-tool-contract.md#migration-rollback-and-evidence).

For ADR-0015, original-context storage remains behind a Layer 3 release port.
Both original and approved-record citations bind the exact released evidence.
Project scope additionally checks current membership and actual association
without widening audience. An item its owner keeps for themself may still be
filed in projects ([ADR-0049](../decisions/ADR-0049-only-me-is-a-lock.md)):
a note or document with an `only_me` audience, or a meeting item its reviewer
kept privately under the restricted reviewer policy (its record shape is under
[Current composition](../architecture/meeting-processing-core-and-adapters.md#current-composition));
it is admitted to its owner alone and then narrowed by association like any
other item, so no other member of the project lists, finds or cites it.
Revalidate all evidence supplied to the answerer, including uncited sources,
before response release. A revision or representation reference is
provenance, not continuing permission to read it.

ADR-0017 once extended this boundary to the meeting transcripts an approver
explicitly released.
[ADR-0046](../decisions/ADR-0046-private-meetings-and-item-routing.md) removed
that release: no approval shares a transcript, the record log keeps no
transcript grant, and no Person path reads one. A meeting's unapproved notes
are readable by their importer only, never in project scope, and generic
meeting snapshots never enter original-context search or Ask.

ADR-0024's list and open paths call no model and are served outside the
answer-model gate. The server binds principal and membership from the session;
a request chooses only a joined project or mine, and a project it has not
joined gets the same denial as project Ask before any store runs. Notes and
documents are read from custody under the evidence desk's access rule, meetings
from the pinned search generation (list) or the Layer 1 exact read (open). Each
store audits exactly the rows it released after its own fence; the route then
revalidates every store release, the session and the grant set before one page
audit and the response. Rows and open responses carry only allowlisted fields:
never the envelope, a log position, an uploader identity, an approver id, or
an unjoined project. The only approver attribution is open meeting's first
page naming the final approver by current directory display name
(`approved_by`), as `person records` does, and the only count is a split
atom's `part.count`. A cursor holds only positions the caller already
received and is bound to the operation, scope, organization and membership.
An open of anything the caller cannot read is one fixed `not_found`, and list
holds meetings only when a record the reader can read in that scope (under
mine, one the reader approved) is waiting to be indexed.

ADR-0024's mine scope, on `POST /v7/person/ask` now (it began on `/v3`), is a caller-selected narrowing
of the same global readable set: the evidence desk pushes it into every store
query, mine with a project is a 400, and mine without the composed approver
projectors is a 503 rather than global. The answer audit and the per-store release audits are unchanged.

## Verification and change procedure

Focused Authority, retrieval, Person-client, architecture, and clean-runtime
integration tests verify the two policy branches, exact-caller scope, final
fence, audit digest, metadata, rejection non-disclosure, model-free Layer 1
and query-serving Layer 3 closures, desk opens bounded to the anchor's own
record, bounded Layer 4 calls, one request snapshot,
request-local citation subsets, list and open allowlists, mine and project
subsets of global, cursor binding, and answer-audit rows. The source boundary
keeps the Layer 4 root narrow and rejects direct lower-layer imports.
The Jira connection, audited live-reader, Agentic Ask V2 and staging HTTP suites
also cover stale grants, revocation at the terminal audit, unsupported scopes,
content-free logging, unchanged capture tables and reuse across restart.
Enforcement remains partial until an exact deployed artifact completes the
two-Person live rehearsal. Any new release path requires an accepted ADR,
explicit enforcement expansion, and negative disclosure tests.
