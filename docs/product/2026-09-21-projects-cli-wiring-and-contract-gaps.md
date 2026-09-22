# ECHO home: supported CLI wiring and project contract gaps

Prepared 2026-09-21. The UI work described here is the separate native change
based on main `0857095`, previously installed as build `9f28656`. The combined
PC-00/PC-01 branch includes this scope reference and the project persistence
foundation, but does not include that UI implementation or deploy an application.

UI reference: the founder-supplied `ECHO Projects v1.html` export, containing
nine boards for home, project updates, write, capture, drop, creation, created
state, People and Slack approval. Its source was inspected during implementation.

The new home replaces the separate Ask and Uploads windows. It preserves the
minimal central content area, bottom input bar, write sheet, and collapsible
sidebar. Existing Account and owner-only organization People controls remain.
Ask answers and cited source cards render inside the home.

## What works with existing contracts

| User action | Existing CLI | Native integration |
| --- | --- | --- |
| Ask about approved context | `person ask --question <text>` | Bottom bar submits once; answer, cancellation, copy, and citations stay in the home. There is no project scope and uploads are not part of Ask. |
| Inspect a cited record | `person records --record-sha256 <sha>` | Existing strict source decoder and progressive source reader are reused. |
| Save typed text or a chosen text file | `person updates submit --request-id <uuid> --title <title> --file <snapshot> --visibility <only-me\|team>` | Write, confirm audience, save. The original body, including its first line and whitespace, is preserved. The first line can suggest a separate bounded title. |
| Reconcile an uncertain save | `person updates status --request-id <uuid>` | Check status uses the account-scoped receipt locator. A same-session retry retains the same immutable draft and request ID. |
| Find saved original context | `person updates search --query <text> --limit 10` | Sidebar switches the existing bottom bar to search; permitted matches appear in the central area. |
| Read a search result | `person updates read --context-id <id>` | Read original opens selectable, unchanged text in the home. |
| Account and organization administration | Existing `person status`, account menu, and owner-only People client | Reuse the established clients and their authorization checks. Organization People is not a project roster. |

`uploads.swift` now holds the CLI codecs/client and `UploadSession`, not a
standalone Uploads window. `projects.swift` owns the live home and write sheet.
`main.swift` retains the strict Ask/source clients and an embedded answer
renderer; it no longer creates the old floating Ask panel.

Saving defaults to Only me. Team is an explicit choice. There is no mapping from
an unavailable Project audience to Team. The live window contains no seeded
people, sample projects, fabricated unread counts, or local-only saved notes.
Unfinished project screens remain disconnected from live actions. New project
is unavailable until its server contract exists.
The home and disabled New project action visibly say “Not live yet.” The Ask
empty state identifies saved-note and project-scoped answers as unavailable,
and the write sheet labels project sharing, other attachment types and Undo
as not live yet.

The application retains only the receipt locator across restarts, scoped to the
exact authority and membership. It does not become a local content database.
Unknown save outcomes remain uncertain; starting another note is an explicit
choice. There is no Undo promise after publication because the server has no
withdrawal operation. Original reads/search results are cleared on concealment;
account changes clear drafts, answers, originals and pending UI state, and an
outstanding save prevents ordinary account switching.

## Missing schema and operations

The following are proposed capabilities, not existing CLI flags or endpoints.

### Primary gap: project-scoped context

The founder identified project-scoped context as a main gap after installing
the new home. Treat it as the next end-to-end product capability. The current
organization/private upload audiences and organization-level Ask do not supply
project scope.

The intended journey is: create a project, choose its people, add context,
open its history, and ask questions within that project. That requires three
separate contracts:

- **Association:** which project a context item belongs to. Preserve its stable
  source identity and original content; linking an item must not create another
  copy or silently change its audience.
- **Audience:** who may read the item. Project membership can define an explicit
  project audience. A private item remains private when associated with a
  project, and a person's project role does not override the source's policy.
- **Retrieval scope:** which permitted items a project feed, search, or Ask can
  use. Carry an explicit project ID through the CLI and server. An answer scoped
  to one project must not silently pull in unrelated context from another.

The complete target journey includes project creation and membership, an
explicit project audience, association, permitted history/search/original
reads, and project-scoped Ask with citations. To keep the first change bounded,
deliver project storage and authorized reads/search separately from extending
Ask. Ask over uploaded originals is itself missing today and needs its own
evidence contract; source attribution must distinguish an original note from
an approved decision.

Acceptance includes two projects and different member sets: a permitted member
can read and ask about the selected project's shared context; a nonmember
cannot recover its text, titles, snippets, counts, or citations. Removing a
member must affect subsequent requests and a response still in flight. A
private note associated with the project must not become readable by its other
members. Existing organization-wide content retains its existing audience.

PC-00 fixes member-only project discovery, history-on-join, exact-tenure
membership grants, multiple leads with last-lead conflict, and one association
per original. A second association conflicts until the first is explicitly
removed. The full selected policy and wire boundary are in the
[project context V1 contract](2026-09-21-project-context-v1-contract.md).
Unread badges, broader attachments, and Undo can follow this core journey.
PC-01 now implements the fresh V7 storage and repository ports in the
[persistence handoff](2026-09-21-project-context-pc01-persistence.md).
Project HTTP routes, CLI operations and native project controls remain not live.

### Scope relative to the current runtime

The locally installed UI replacement did not deploy an Authority change.
Project context is a proposed server capability; it cannot be enabled by the
desktop UI alone.

| Scope | Change from the current implementation | Runtime boundary |
| --- | --- | --- |
| Project organization only | Add project identities and context associations; keep existing private/team audiences | Authority state, API, CLI and UI. An association alone does not provide project-only sharing. |
| Shared project workspace | Add project memberships, explicit project audience, permitted history/search/read and membership-change checks | Authority application, persistence, authorization and audits. Requires versioned storage/API changes; can preserve the meeting/approval/approved-record pipeline. |
| Project-filtered Ask over existing approved records | Add record associations and explicit project filtering before result limits, related-source expansion and model handoff | Retrieval and release/revalidation changes. The existing answer-composition algorithm may remain reusable because the evidence type stays the same. Existing record audience rules still apply. |
| Ask over uploaded original context | Admit originals with distinct provenance and citations alongside, or separately from, approved records | Versioned evidence, citation and answer-runtime contracts. Current kernel evidence requires `record_sha256` and admits only the two approved-record Person policies. This is more than adding a project filter. |
| Project-only approved decisions | Introduce project readership into the approved-record policy lineage | Additional policy, publication and derived-retrieval work. Outside the initial original-context workspace scope. |

Recommended first implementation scope: project creation, membership and lead
management, text-context association, explicit project-only sharing, and
authorized history/search/original reads. Keep project-scoped Ask visibly
unavailable until its separate implementation is complete. Unread counts,
binary attachments, audience edits/withdrawal, automatic provider-to-project
routing and new approved-decision policies remain later work.

This first scope is a bounded Authority feature extension, not a promise of
zero kernel-file changes: the pinned Authority database baseline currently
lives in `organization-authority-kernel`. Existing V6 original text, receipts
and other runtime data in staging and production are disposable under the
founder's subsequent direction. Use a fresh versioned schema and explicit
reset/reseed rollout; a state-preserving migration/backfill is no longer in
scope. New writes must still preserve original bytes, receipts and explicit
audience semantics. The current upload authorization checks only organization
membership and the stored private/team choice; project access and a project-state revision must
be checked separately at admission and release. Reuse existing login/session
identity rather than making project selection a new sign-in mechanism.

The meeting ingestion, extraction, approval, signing and record-append flow
can remain intact for this scope. In particular, project leadership does not
grant decision-approval authority, and a project note is not an approved record.

| UI capability | Missing durable state or contract | Missing operations and checks |
| --- | --- | --- |
| List/create/rename projects | Organization-bound project ID, name, lifecycle state and creation provenance | A member-authorized project list/create/read/update API and CLI; idempotent writes and audited changes. Any active org member can create, becoming the first lead. |
| Project People and leadership | Project memberships tied to exact organization membership tenures; project lead roles | Member directory with stable opaque IDs, add/remove membership, transfer leadership, last-lead/departure rules. Current organization People is owner-only and cannot substitute for this. |
| Project audience | Versioned audience binding resolving current project membership at read time | Admission plus authorization for original reads, search, feed, Ask and sources; no client-side filtering as the enforcement boundary. Existing upload visibility is only `only_me` or `team`. |
| Designated individual reader | Explicit reader membership/tenure binding | Share/admit/read policy for a person other than the uploader. Existing `only_me` means the uploader, not an arbitrary named reader. |
| Project association | Context-to-project links, independent of audience, with typed source locators | Associate/dissociate operations with appropriate write authority. One destination in the current UI must not silently redefine the audience or force source duplication. |
| Project update cards | Bounded feed contract covering original uploads and approved records, stable ordering and pagination | List authorized updates and fetch typed details. Upload search requires a real query; it is not an all-items feed. Current record responses and upload responses have different schemas. |
| Unread badges | Per-membership/project read position and a precise definition of new/unread | Advance/read cursor and calculate counts only over currently authorized material. Membership changes must not reveal titles, counts, or placeholders for inaccessible items. |
| Ask inside a project | Explicit project scope in request; typed evidence/release and citation contract for original uploads | Thread scope through CLI, HTTP, retrieval and response release. Admit uploads as originals with their provenance, distinct from approved decisions. Never simulate scope by adding the project name to the question. |
| Revocation during a request | Project-membership/audience revision bound into the authorization snapshot | Revalidate the relevant state at content/model handoff and final release. Current `person_state_sha256` covers organization identity/membership, not projects. Derived indexes and caches must fail closed if their authorization state is stale. |
| Visibility edits, withdrawal, Undo | Explicit versioned audience-change/withdrawal facts with audit and conflict semantics | Separate authorized operations; a successful save cannot be undone by deleting a local card. Define what withdrawal does to subsequent retrieval, without promising to erase already delivered copies. |
| Attachments and drag/drop | Current original carrier accepts one regular UTF-8 text file up to 8 KiB | A text file can use the current chooser. Binary files, multiple attachments, extraction, larger payloads and retained attachment provenance need selected contracts. Drag/drop and selected-text capture need separate client work and interaction validation. |
| Project-scoped approved decisions | New record policy lineage and retrieval segment/fact support | Extend the approved-record pipeline through versioned policy, wire, storage and client compatibility changes. Project membership/leadership does not delegate decision approval. |

## Where the work belongs

- `packages/organization-api/src/person-updates.ts`: strict upload request,
  result and visibility codecs. Unknown project/audience fields are rejected.
- `src/product/person-client/commands.ts`: current finite command/flag surface.
  No project command family or project selector is accepted.
- `services/organization-authority/src/application/person-updates.ts`: current
  upload admission and release checks.
- `services/organization-authority/src/application/person-identity-sessions.ts`:
  current organization identity snapshot; project revisions are absent.
- `services/organization-authority/src/composition/person-answer-route.ts` and
  `person-record-search-route.ts`: record-only Ask and authorized retrieval.
- `packages/organization-retrieval/src/application/readable-search-contracts.ts`:
  organization/reviewer policy types and decision/action/rationale source kinds.
- Authority persistence and approved-record policy baselines: use a fresh
  versioned schema and explicit reset/reseed, since staging and production
  runtime data is disposable for this sprint. No migration/backfill is
  required. Ordinary startup must still validate the exact schema; new writes
  must preserve their source bytes and audience semantics.

## Suggested implementation order

Confirmed intake scope: share the existing Authority intake/custody mechanisms
and serialized worker lifecycle while keeping uploaded originals immediately
readable/searchable. The worker lifecycle is already shared with meeting
processing; their source records and processing/publication rules remain
distinct. Project support does not require routing uploads through meeting
decision extraction or approval.

1. Project identity, member directory, lead/membership operations, and versioned
   authorization state under the frozen history-on-join and member-discovery
   rules.
2. Upload audience plus independent association; direct read/search enforcement;
   bounded permitted feed. Prove removal with an otherwise
   valid organization session, including an in-flight request.
3. Typed original-upload evidence and citations in Ask, then explicit project
   scope. Prove no unauthorized content, counts or citations cross the boundary.
4. Unread cursors, project-scoped approved-record audiences, and later
   named-reader, resharing, withdrawal, larger-file or capture capabilities
   through their own contracts.

The UI can adopt each operation when its server contract lands. It should not
invent a server success, a project ID, a policy or a persisted read cursor to
make an unfinished control appear functional.

The [sprint task breakdown](2026-09-21-project-context-sprint-v1.md) assigns
file ownership, parallel-work gates and acceptance criteria for fresh
schema/persistence, server authorization, HTTP composition, CLI, UI, integration and the separate
Ask follow-up. It also traces the currently wired Write/inbox/worker path and
records the disposable staging/production reset assumption.
