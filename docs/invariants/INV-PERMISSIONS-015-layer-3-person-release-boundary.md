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
normative: MUST
enforcement_status: partial
enforcement_scope: Current-Person Layer 1 listing and Layer 2 exact-generation search release with project audiences and associations, the ADR-0010 related-atom projection boundary, explicit ADR-0017 transcript reads, the ADR-0024 Person list and open-by-reference paths and the mine scope of list and Ask, the ADR-0026 person-bound Jira live evidence path, the ADR-0030 imported meeting notes boundary, the ADR-0032 stored-run view, and the Layer 4 request-local release and citation boundary
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

ADR-0010 adds one non-serving exception to the otherwise model-free lower
layers: during construction of a fresh Layer 2 generation, an Authority-owned
projector may receive only approved atom IDs, kinds, and text from one exact
visibility segment and may propose untyped cross-record pairs. It cannot see a
raw transcript, another segment, current Person state, or a query. Authority
validates and stores only accepted endpoint pairs; neither proposal nor
adjacency confers visibility. The Layer 3 answer path can expand no more than
three released decision anchors with bounded adjacent atoms and makes no model
call for that operation.

## Enforcement and failure behavior

The Authority authenticates and resolves the Person, checks current membership
and the exact content policy, binds Layer 2 to an exact generation and record
head, rechecks the caller at the release fence, commits the minimized response
digest, and only then returns the audited bytes. Missing, stale, mismatched, or
non-Person authority MUST release no content. Search construction MUST NOT be
triggered by a query. Layer 4 receives no lower-layer handles and may pass
citations only after checking that they are a subset of what Layer 3 released
in that request.

ADR-0019, as updated by ADR-0022, permits the V3 route to make bounded desk
calls and at most 24 model calls, including retries and repairs, in one
request. The desk pins the record
snapshot or fixes an explicitly original-only mode when the index starts
behind. Every desk release is audited before bytes leave Layer 3. Revalidate
all released items and metadata, including the upcoming model input, before
each model call and final response. Malformed output permits one repair within
the hard budget and then a deterministic cited-evidence fallback. Unknown or
out-of-part citations never establish support. Authorization, audit, snapshot
and cancellation failures release no answer.

ADR-0026 extends this boundary to Jira live evidence on `POST /v4/person/ask`.
The provider reads as the authenticated Person's current Jira grant. Audits commit
only coordinates, digests and authorization commitments before releasing evidence;
tool bodies and metadata remain request-local and never enter Layer 1 or Layer 2.
Every later model call and final response rechecks all released evidence, the
membership tenure, session and grant. Disconnect, replacement consent, lost
membership, changed permissions, audit failure or cancellation releases no answer.
Project Jira reads MUST use a lead-configured mapping and the asker's own current
connection. The exact ECHO project grant, mapping revision and stable Jira project
ID narrow every read; moved tickets, mapping edits/removal and lost membership
invalidate in-flight evidence. A runtime project fence cannot be widened by a
mapping. The mapping stores configuration coordinates only, never tool content.
Mine and unmapped ECHO projects exclude Jira. Runtime model-content capture is
suppressed once live metadata or text enters a prompt; operational metrics remain.

ADR-0032 extends the same rule to a stored run of an approved record's impact
check. The check runs as the approver with that person's own access, and the
stored run keeps only pointers and ECHO's own judgments, never words read from
outside ECHO. Every view re-releases the stored items through a fresh desk under
the viewer's current session, membership tenure and grants: an item the viewer
can no longer open is hidden and counted, and outside text is read again rather
than stored. Anyone but the approver sees no such run in a list and gets
`not_found` when starting, retrying or viewing it.

For ADR-0015, original-context storage remains behind a Layer 3 release port.
Both original and approved-record citations bind the exact released evidence.
Project scope additionally checks current membership and actual association
without widening audience. Revalidate all evidence supplied to the answerer,
including uncited sources, before response release. A revision or representation
reference is provenance, not continuing permission to read it.

ADR-0017 extends this same boundary to approved meeting transcripts only when
the exact human approval explicitly grants transcript release. The retained
source revision digest must match that grant, and its committed content hash
must verify before release. Current audience and,
when requested, project association are checked before content access and again
at release; a missing, disabled or mismatched grant releases no content. This
does not admit generic meeting snapshots into original-context search or Ask.

ADR-0024's list and open paths call no model and are served outside the
answer-model gate. The server binds principal and membership from the session;
a request chooses only a joined project or mine, and a project it has not
joined gets the same denial as project Ask before any store runs. Notes and
documents are read from custody under the evidence desk's access rule, meetings
from the pinned search generation (list) or the Layer 1 exact read (open), and
a transcript only after that exact read and through the ADR-0017 grant. Each
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

ADR-0024's mine scope on `POST /v3/person/ask` is a caller-selected narrowing
of the same global readable set: the evidence desk pushes it into every store
query, mine with a project is a 400, and mine without the composed approver
projectors is a 503 rather than global. Mine reads no Slack and no shared
transcript. The answer audit and the per-store release audits are unchanged.

## Verification and change procedure

Focused Authority, retrieval, Person-client, architecture, and clean-runtime
integration tests verify the two policy branches, exact-caller scope, final
fence, audit digest, metadata, rejection non-disclosure, model-free Layer 1
and query-serving Layer 3 closures, exact-segment rebuild-time projection,
bounded Layer 3 adjacency, bounded Layer 4 calls, one request snapshot,
request-local citation subsets, list and open allowlists, mine and project
subsets of global, cursor binding, and answer-audit rows. The source boundary
keeps the Layer 4 root narrow and rejects direct lower-layer imports.
The Jira connection, audited live-reader, Agentic Ask V2 and staging HTTP suites
also cover stale grants, revocation at the terminal audit, unsupported scopes,
content-free logging, unchanged capture tables and reuse across restart.
Enforcement remains partial until an exact deployed artifact completes the
two-Person live rehearsal. Any new release path requires an accepted ADR,
explicit enforcement expansion, and negative disclosure tests.
