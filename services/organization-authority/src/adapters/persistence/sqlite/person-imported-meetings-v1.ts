import { meetingEvidenceDatesV1, type EvidenceDatesV1 } from "@echo-brain/organization-authority-kernel/shared/temporal-query-v1";
import type Database from 'better-sqlite3';
import { canonicalSha256, type Sha256Digest } from '@echo-brain/federation-protocol';
import { canonicalSourceContentV1, sourceContentSha256V1, sourceItemIdV1, assertCanonicalMeetingDocument, type MeetingDocument } from '@echo-brain/organization-processing/core';
import type { PersonAccessAuthorization } from '@echo-brain/organization-authority-kernel/application/ports/person-access-authorization';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import type { PersonImportedMeetingReviewV1 } from '@echo-brain/organization-api';
import type { PersonListStoreScopeV1 } from '../../../application/ports/person-list-v1.js';
import type { PersonAskScopeV2 } from '../../../application/ports/person-original-context-retrieval-v1.js';
import { personOriginalGrantedProjectIdsV1 } from './person-original-access-v1.js';

/** Imported source notes, always their importer's alone: a suggested project grants no read (ADR-0046). */
interface ImportedMeetingTextV1 {
  readonly dates: EvidenceDatesV1;
  readonly api_version: 0; readonly context_id: `cap_${string}`; readonly title: string; readonly text: string;
  /** Immutable source heading for cited packets, independent of the display title. */
  readonly packet_title: string;
  readonly received_at: string;
  readonly source_id: string; readonly revision_id: string; readonly source_sha256: Sha256Digest; readonly representation_sha256: Sha256Digest;
  readonly source_content_sha256: string; readonly manifest_json: string; readonly source_content_json: string;
}
interface SourceRow {
  context_id: `cap_${string}`; source_id: string; revision_id: string; captured_at: string; revision_sha256: string; content_sha256: string; manifest_json: string; content_json: string;
  adapter_id: string; instance_id: string; external_id: string;
}
/** A staged review candidate of one revision, by its staging position. */
interface ReviewCandidateRow {
  readonly position: number; readonly candidate_id: string; readonly admission: string; readonly lineage: string; readonly semantic: string;
  readonly disposition: 'actionable' | 'coalesced' | 'no_signals';
}
function invalid(): never { throw new AuthorityOperationError('unavailable', 'Imported meeting is unavailable'); }
/**
 * What the importer reads of their own meeting source. Transcripts stay out of every person's reads:
 * only extraction uses them, and only approved records leave a meeting (ADR-0046).
 */
export function importedMeetingTextV1(meeting: MeetingDocument): string {
  return meeting.content.filter(block => block.kind !== 'transcript').map(block => block.text).join('\n\n');
}
/**
 * The v1 packet format, retained byte-for-byte for saved citations. This historical heading describes
 * raw source material, never review state. Only the immutable source revision's title enters it;
 * presentation labels and live review status must not change packet boundaries or anchor hashes.
 */
export function importedMeetingPacketTitleV1(meeting: MeetingDocument): string {
  return `Imported meeting (unapproved): ${meeting.title ?? 'Untitled'}`;
}
/**
 * Read view over existing custody. There is no second meeting body or derived-content table.
 * Imported notes remain source material readable by their importing person only, in global scope
 * (ADR-0046), and so are in the list's Only me (ADR-0049). A suggested project only pre-ticks the
 * review's destinations; project scope never includes imported notes. Approval publishes separate
 * records for project members, so the source label describes provenance rather than review status.
 */
export class SqlitePersonImportedMeetingsV1 {
  constructor(private readonly database: Database.Database) {
    database.function('echo_imported_meeting_id_v1', { deterministic: true }, (source, revision) => `cap_${canonicalSha256({ source, revision }).slice(7)}`);
  }
  rows(actor: PersonAccessAuthorization, scope: PersonAskScopeV2 | PersonListStoreScopeV1, exact?: { readonly source_id: string; readonly revision_id: string } | { readonly ids: readonly string[] }): readonly ImportedMeetingTextV1[] {
    if (scope.kind === 'project') {
      if (!personOriginalGrantedProjectIdsV1(this.database, actor).includes(scope.project_id)) throw new AuthorityOperationError('unauthorized', 'Project access unavailable');
      return [];
    }
    const revision = exact ? ('ids' in exact ? `AND echo_imported_meeting_id_v1(s.source_id,r.revision_id) IN (${exact.ids.map(() => '?').join(',') || 'NULL'})` : 'AND s.source_id=? AND r.revision_id=?') : `AND NOT EXISTS (SELECT 1 FROM authority_source_revisions_v1 newer WHERE newer.organization_id=r.organization_id AND newer.source_id=r.source_id
      AND (newer.captured_at>r.captured_at OR (newer.captured_at=r.captured_at AND newer.revision_id>r.revision_id)))`;
    const rows = this.database.prepare(`SELECT echo_imported_meeting_id_v1(s.source_id,r.revision_id) AS context_id,s.source_id,s.adapter_id,s.instance_id,s.external_id,r.revision_id,r.captured_at,r.revision_sha256,r.content_sha256,r.manifest_json,c.content_json
      FROM authority_person_meeting_sources_v2 p JOIN authority_live_source_admission_v2 a ON a.source_key=p.source_key
      JOIN authority_sources_v1 s ON s.organization_id=a.organization_id AND s.adapter_id=a.source_adapter_id AND s.instance_id=a.source_adapter_instance_id
        AND s.custody_ref=('person:' || a.membership_id) AND s.access_policy_ref=('personal-meeting:' || p.source_key)
      JOIN authority_source_revisions_v1 r ON r.organization_id=s.organization_id AND r.source_id=s.source_id
      JOIN authority_source_contents_v1 c ON c.organization_id=r.organization_id AND c.source_id=r.source_id AND c.revision_id=r.revision_id
      WHERE a.organization_id=? AND a.membership_id=? AND a.principal_id=?
      ${revision} ORDER BY r.captured_at DESC,context_id LIMIT 1001`).all(actor.organization_id, actor.membership_id, actor.principal_id, ...(exact ? ('ids' in exact ? exact.ids : [exact.source_id, exact.revision_id]) : [])) as SourceRow[];
    if (rows.length > 1000) invalid();
    return rows.map(row => {
      const content = JSON.parse(row.content_json) as Omit<MeetingDocument, 'provenance'> & { provenance: Omit<MeetingDocument['provenance'], 'observed_at'> };
      const manifest = JSON.parse(row.manifest_json) as Record<string, unknown>;
      const { captured_at: _captured, ...immutable } = manifest;
      if (canonicalSourceContentV1(content) !== row.content_json || sourceContentSha256V1(content) !== row.content_sha256 || sourceContentSha256V1(immutable) !== row.revision_sha256 ||
        manifest.source_id !== row.source_id || manifest.revision_id !== row.revision_id || manifest.content_sha256 !== row.content_sha256) invalid();
      const meeting = { ...content, provenance: { ...content.provenance, observed_at: row.captured_at } };
      assertCanonicalMeetingDocument(meeting, { kind: 'meeting-source', adapter_id: row.adapter_id, instance_id: row.instance_id, version: meeting.provenance.source.version });
      if (sourceItemIdV1(meeting.provenance.source, row.external_id) !== row.source_id || meeting.provenance.external_id !== row.external_id || meeting.provenance.canonical_revision !== row.revision_id || !/^source:[a-f0-9]{64}$/.test(row.source_id)) invalid();
      const text = importedMeetingTextV1(meeting);
      return { dates: meetingEvidenceDatesV1(meeting.time), api_version: 0, context_id: row.context_id, title: `Imported meeting: ${meeting.title ?? 'Untitled'}`, text, packet_title: importedMeetingPacketTitleV1(meeting),
        received_at: row.captured_at,
        source_id: row.source_id, revision_id: row.revision_id, source_sha256: `sha256:${row.revision_sha256}`, representation_sha256: canonicalSha256({ kind: 'imported-meeting-notes-v1', text }),
        source_content_sha256: row.content_sha256, manifest_json: row.manifest_json, source_content_json: row.content_json };
    });
  }

  /**
   * The review of this exact retained revision, after a successful original proof read. Processing makes one card per
   * review: a revision whose review material (title, participants and items) matches the lineage's current card when it
   * arrives is coalesced and gets no card of its own, so that card reviews it; a revision with no decision or action gets
   * no card and has nothing to review. Reviewed means the reviewing card has an approve or reject decision. Each lookup
   * is bound to the importer's own admission, custody and source.
   */
  reviewState(actor: PersonAccessAuthorization, source: Pick<ImportedMeetingTextV1, 'source_id' | 'revision_id' | 'source_content_json'>): PersonImportedMeetingReviewV1 {
    const meeting = JSON.parse(source.source_content_json) as MeetingDocument;
    const cited = this.database.prepare(`SELECT c.rowid AS position,c.candidate_id,c.admission_semantic_input_sha256 AS admission,c.review_lineage_id AS lineage,c.review_semantic_sha256 AS semantic,c.disposition
      FROM authority_sources_v1 s
      JOIN authority_live_source_admission_v2 a ON a.organization_id=s.organization_id AND a.source_adapter_id=s.adapter_id AND a.source_adapter_instance_id=s.instance_id
      JOIN authority_live_source_candidates_v2 c ON c.admission_semantic_input_sha256=a.semantic_input_sha256
      WHERE s.organization_id=? AND s.source_id=? AND a.membership_id=? AND a.principal_id=?
        AND s.custody_ref=('person:' || a.membership_id) AND s.access_policy_ref=('personal-meeting:' || a.source_key)
        AND json_extract(c.meeting_json,'$.provenance.source.adapter_id')=s.adapter_id
        AND json_extract(c.meeting_json,'$.provenance.source.instance_id')=s.instance_id
        AND json_extract(c.meeting_json,'$.provenance.source.version')=?
        AND json_extract(c.meeting_json,'$.provenance.external_id')=s.external_id
        AND json_extract(c.meeting_json,'$.provenance.canonical_revision')=? LIMIT 1`)
      .get(actor.organization_id, source.source_id, actor.membership_id, actor.principal_id, meeting.provenance.source.version, source.revision_id) as ReviewCandidateRow | undefined;
    // Never staged: still waiting, held after a failed extraction, or passed over once a newer revision was staged.
    if (cited === undefined) return 'not_reviewed';
    // Candidates are never updated or deleted, so rowid is their staging order. A coalesced revision's card is its lineage's
    // head when it arrived: the latest earlier candidate of the same admission and lineage that was not itself coalesced.
    const reviewing = cited.disposition !== 'coalesced' ? cited : this.database.prepare(`SELECT rowid AS position,candidate_id,admission_semantic_input_sha256 AS admission,review_lineage_id AS lineage,review_semantic_sha256 AS semantic,disposition
      FROM authority_live_source_candidates_v2 WHERE admission_semantic_input_sha256=? AND review_lineage_id=? AND disposition<>'coalesced' AND rowid<?
      ORDER BY rowid DESC LIMIT 1`).get(cited.admission, cited.lineage, cited.position) as ReviewCandidateRow | undefined;
    if (reviewing === undefined || reviewing.semantic !== cited.semantic) return 'not_reviewed';
    if (reviewing.disposition === 'no_signals') return 'nothing_to_review';
    const decided = this.database.prepare(`SELECT 1 FROM authority_live_approval_outbox_v2 o JOIN authority_approval_decisions_v1 d ON d.approval_id=o.approval_id
      WHERE o.candidate_id=?`).get(reviewing.candidate_id);
    return decided === undefined ? 'not_reviewed' : 'reviewed';
  }
}
