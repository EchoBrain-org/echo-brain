# Next round: ECHO UI and Ask refinements

Recorded: 2026-09-23.

Status: implementation authorized on 2026-09-23 after the scope decisions below. Work proceeds in an isolated branch for review; release qualification remains separate.

## 1. Global Ask with optional project scope; remove Find saved context

Remove the separate **Find saved context** UI entry/flow. The user explicitly chose Ask as the retrieval experience and does not require a file-browsing interface for now. Do not introduce a replacement My uploads page as a requirement for this round. Preserve stored context and the underlying authorized retrieval capabilities.

Ask defaults to **All accessible context**: retrieve relevant evidence from the person's personal context, organization context they may read, and projects they belong to. Retrieval should select and combine the best evidence across these scopes without requiring the person to locate files or choose a project first.

Offer an explicit project scope so the person can ask within one selected project. The selected scope must be visible; project-scoped retrieval should stay within readable context associated with that project rather than silently falling back to unrelated projects or personal material.

The founder clarified that project Ask includes project information and related personal information. For this implementation, related personal information means the current person's own private notes or documents explicitly associated with the selected project. Unassociated personal context, other people's private context, and unrelated organization or other-project information are excluded. Broader relatedness rules are deferred to search and answer refinement.

Global means the person's authorized context, not unrestricted organization access. Enforce current permissions before evidence is supplied to the answering model, and on cited-source access. Project association does not widen audience. Membership removal must revoke future retrieval without removing the project's retained context.

Include usable saved text and extracted document content as well as approved records. Cite the evidence used, distinguish source content from approved decisions, and acknowledge missing or conflicting evidence. Answering from a saved document must not automatically run decision/action extraction or publish an approved record; the existing requested-only analysis and human approval rules remain.

This is retrieval functionality to implement in the next round, not a claim about the installed Ask capability. The current approved-record-only Ask cannot fulfill it through UI changes alone.

## 2. Improve Ask submission

When the user presses Enter to submit a question, display the submitted question with its answer and clear the input bar for the next question. The old question should not remain in the composer after submission. This does not by itself specify a persistent chat history or conversational memory.

Make the pending response visible and keep the submitted question available if an error requires retrying.

## 3. Select organization people inside project invitations

The project invitation flow should show the organization's people for selection. The user should be able to choose people there without going to a separate organization directory in the sidebar.

Remove the organization People entry from the sidebar.

In person rows, show only the person's name for this round. Do not show email addresses, internal IDs, role/title/team, or technical metadata in those rows. The user explicitly deferred professional profile metadata and its editing workflow to a later round.

## Scope

These are the three refinement areas requested for the next round. The clarified Ask behavior includes retrieval/API work as well as UI changes. The separately diagnosed staging latency issues remain tracked in the staging investigation; this note neither resolves nor replaces them.

## Pre-implementation validation

Read-only source review and inspection of the installed app on 2026-09-23 found the following. No code changes or membership mutations were made, and the source-level failure paths below were not reproduced against live memberships.

### Confirmed dependencies and gaps

1. **Global Ask needs new retrieval integration.** The Find saved context screen searches both saved text and file documents. Ask currently answers from approved records, not these originals. The user resolved the browsing choice: remove the dedicated screen without a replacement file browser, and make authorized saved context accessible through global/project Ask. The removed reader also supplies an existing UI route for associating a saved original with a project; retain correct project/audience selection during capture, without introducing browsing as a prerequisite for this round.
2. **Ask submission retains the input by omission.** `askSubmitted()` copies the composer string and calls `onAsk` without clearing it. The answer controller retains its own question, so the composer can clear once validation and request handoff succeed. A later submission currently cancels and replaces an active request. The same composer currently performs project search in project mode; the next design must make it explicit when it performs project-scoped Ask and bind each submitted question to its selected scope.
3. **The people API is search-only today.** The project directory includes active owner and employee memberships, but requires a nonempty query and returns at most 10 results per page. The current picker has neither initial all-people loading nor directory pagination. Showing all organization people needs a bounded browse contract and complete UI pagination, not only a visual change. Existing authorization restricts the directory and member additions to project leads.
4. **Name-only display fits the existing directory data.** The directory exposes name and membership ID. The user resolved the metadata choice by selecting name-only person rows for now. Keep IDs internal for correct selection and defer new role/title/team fields and profile editing. Existing access roles must still govern authorization even though they are not displayed as person metadata.
5. **Adding an existing member can change their role.** Directory results currently include existing project members; the Add action always sends the `member` role. The server treats this as a role update for an existing lead. With another lead present it can demote that person; last-lead protection rejects the sole-lead case. The next Add flow must preserve existing roles even with stale directory results or partially loaded rosters.
6. **Organization administration still needs an entry point.** The sidebar People screen supports inviting employees, reissuing invitations, and revoking organization access. Removing its sidebar row can preserve the existing menu-bar Organization → People entry. The owner-only employee administration roster excludes the owner and is not a substitute for the project directory.

### Proposed acceptance checks for the next round

| Area | Check |
| --- | --- |
| Ask submit | Return submits one valid question exactly once, shows that question with its pending/answer state, and clears/focuses the composer. Empty or invalid input remains editable with a clear explanation. |
| Ask pending and retry | A second Return does not silently cancel/replace the running request. Suggested behavior: allow drafting, disable another submission until completion, and provide explicit cancellation/retry. A late response must not overwrite a newer question or draft. |
| Global Ask | A general question can retrieve and combine relevant personal, readable organization, and joined-project evidence, including saved text and usable PDF/DOCX extraction, without file browsing. Cite the actual source revisions used. |
| Project Ask | Selecting a project visibly narrows retrieval to that project's readable context. Each request/response retains its submitted scope even if the user changes the current selection while it is running. No silent fallback to other scopes. |
| Permission boundaries | Exercise another person's private material, unjoined projects, association without audience access, and revoked membership. Unauthorized content must not enter model context or leak through answers or citations. New authorized project members can retrieve retained project history. |
| Evidence quality | Unapproved source material may support an answer without being labeled an approved decision. Unsupported completion claims, conflicting evidence, and unusable extraction receive accurate treatment. Asking does not trigger automatic decision/action publication. |
| Navigation removal | Find saved context is absent. No replacement file browser is required. A person can upload to an intended audience/project and later ask about accessible content. |
| People completeness | Exercise more than 10 people, including the owner, repeated names, current project members, and revoked memberships. All eligible active people are reachable through pagination/search. Selection uses stable internal identity, never display name alone; duplicate names must not merge into one person or cause the wrong membership to be added. |
| Safe Add | Existing members are shown as already added or excluded from selection. Re-adding, double-clicking, stale results, or partial rosters cannot demote a lead or duplicate membership. Access checks remain enforced server-side. |
| Person presentation | Rows display only names. Internal IDs remain internal; email, role/title/team, and technical metadata are not displayed. No new profile fields or profile editor are required for this round. |
| Administration | Owner can still invite/reissue/revoke organization membership through the retained organization administration entry point. Ordinary members do not gain administrative powers through the picker. |

These are proposed acceptance criteria, not test results for an implemented refinement.

### Resolved product choices

- Remove Find saved context without adding a replacement file browser. Global Ask with optional project scope is the retrieval experience.
- Show names only in the people picker. Professional role/title/team metadata and who maintains it are deferred.
- Project Ask includes the selected project's readable context and the person's own related private context. Explicit project association defines relatedness initially.

### Follow-up: related personal context in search and answers

Before expanding beyond explicit association, define what evidence establishes
that a personal item relates to the selected project, how ambiguous or
multi-project items are handled, and how the answer explains the connection.
Test unrelated personal/org/project distractors alongside related private
notes. Relevance must operate inside current permissions; it must never grant
access to another person's private material or introduce a silent global
fallback.

### Integration addendum: navigation and upload targeting

The implementation candidate integrates the navigation work with the refined Ask flow:
named Back destinations, keyboard/mouse Back, restoration of project feed
pages and scroll position, a consistent sheet close control, unsent-draft
discard confirmation, and reliable Create submission during a background
reload. The removed saved-context browser and organization sidebar entry stay
removed. Back from a covering Sources pane returns to its answer before
leaving the Ask page. This does not add Undo of completed mutations.

Global upload already allows choosing a specific accessible project through
the **To** selector. The independent **Project** association selector does not
change audience. This round preserves the current defaults. The selectors
currently include only loaded project pages; independent picker pagination
or search is a follow-up, not a promise of this candidate.

### Original source anchors (pre-implementation)

- `product/echo-overlay/projects.swift`: `askSubmitted` near line 3763; global search near 3530 and 3770; picker/Add near 2318 and 2399; navigation near 3892.
- `product/echo-overlay/main.swift`: approved-record-only Ask scope near 747; submission/cancellation near 780 and 845; retained Organization → People menu near 1597.
- `packages/organization-api/src/project-context-v1.ts`: directory contract near 67.
- `services/organization-authority/src/adapters/persistence/sqlite/project-context-v1.ts`: directory query near 304; existing-member role mutation and last-lead guard near 367.
