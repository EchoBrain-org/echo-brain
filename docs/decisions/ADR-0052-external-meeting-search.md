---
schema_version: 1
id: ADR-0052
kind: decision
title: Search external meetings independently of extraction and approval
component_ids:
  - CMP-ORGANIZATION-AUTHORITY
  - CMP-PROCESSING-ADAPTERS
  - CMP-PERSON-CLIENT
created_at: 2026-11-12
reviewed_at: 2026-11-12
reviewed_ref: 19dfcc03d2a3ed50ef4c30d05123642ef76a2c3b
status: proposed
supersedes: []
superseded_by: []
updates:
  - ADR-0030
  - ADR-0046
---

# ADR-0052: Search external meetings independently of extraction and approval

## Context and options

A connected Granola account previously supplied browsing and opt-in processing.
Ask could read a retained import, but could not search the connected account's
historical meetings directly. A watch's suggested project controlled review
defaults, not the project's external search scope. This made connection,
search, extraction and approval appear to be one operation.

Importing a historical archive just to make it searchable would duplicate
provider custody and couple discovery to processing. Instead, use the existing
personal live-evidence boundary, already used by Jira and Confluence.

## Decision and consequences

Granola owns the original meeting. ECHO searches notes and transcript passages
under the asker's current personal grant. Global search can read every meeting
that grant permits. Project search requires a separate mapping to one or more
Granola folders. An unmapped project never falls back to global results.

The `granola_meetings` source uses the existing page/section citation contract:
meeting ID, section ID, provider workspace, version, permalink and exact text
digest. Its descriptor identifies it as external meeting evidence, distinct
from ECHO's approved records. Transcript hits are re-read as current provider
chunks before release. Short Unicode-safe sections meet the evidence byte
limit; opening a section continues from that section. Provider passages and
notes are data, never instructions or approval authority.

Only configuration, connection references and digest/coordinate receipts are
persisted by this search path. Meeting bodies remain request-local. Existing
Ask answer retention still applies to the generated answer and its citations;
this is not a promise that no information derived from a meeting is stored.

A project lead saves up to 20 stable folder IDs using compare-and-set revision
checks. The provider workspace is pinned with them (`cloud_id` in the shared
mapping representation). Project members can read the mapping. Each asker
still needs their own provider access. Connection replacement, project grant
or mapping changes invalidate an in-flight read. Folder visibility and cited
meeting membership are checked again before release, including reopening an
earlier citation. Removing a mapping never deletes a meeting at its provider.

Connection makes historical search available; extraction is separately
opted into. A folder mapping creates no watch, import or review. Automatic
extraction retains its existing recent-meeting watch window. Historical
search has no seven-day cutoff. Source connection and extraction status are
shown separately in the desktop.

**Existing extraction retention remains an explicit exception.** Choosing
extraction still authorizes the durable source copy required by the current
review/retry and immutable evidence workflow in ADR-0030 and ADR-0046. This
change does not purge that store or promise that extraction retains only
derived records. Only approved decisions, actions and rationale are published
to the selected projects. Eliminating the processing copy after review needs
a separate retention/migration decision covering retries, old citations and
immutable audit evidence. Existing imported meetings remain readable.

Provider bounds are explicit: metadata list pages have opaque continuations;
search reports truncation and index lag. Transcript search in project scope
first resolves at most 1,000 meeting IDs from the selected folders, then sends
only those IDs in batches of 100. An incomplete or oversized membership
enumeration fails closed. One request has a bounded provider-call budget.
This is live retrieval, not a background sync or a promise of exhaustive
full-text indexing.

## Migration, rollback, and evidence

The only new durable data is a latest-value project mapping table in the
existing private Granola connection database. Existing grants are reused;
watch suggestions are not silently converted into search mappings. The
Person client adds shared meeting-folder mapping commands and the desktop exposes
them in Project → Tools. No new answer wire version is required. Rolling back
leaves the additive mapping table unused; existing extraction is unchanged.

Synthetic proofs cover the pagination-first provider response, historical
notes and transcripts, exact citation hashes, date/timezone filters,
continuation, grant and folder revocation, stale content, lead-only mappings,
CAS conflicts, and absence of source/approval tables in search configuration.
The Authority integration test connects, maps, answers from a historical
transcript and disconnects through HTTP without configuring a watch.
Desktop Playwright covers folder mapping through the shipped CLI and confirms
that it sends no import, watch or review command.

Live validation is reserved for the user after deployment of the reviewed
candidate: connect Granola, map the interview folder in the GTM project's
Tools, ask a question from an older interview, open the Granola citation, and
confirm there is no new review until extraction is explicitly requested.
Deleting access or removing the mapping should prevent subsequent live reads.
