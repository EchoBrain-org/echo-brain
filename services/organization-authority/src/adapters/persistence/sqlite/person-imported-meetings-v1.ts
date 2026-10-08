import type Database from 'better-sqlite3';
import { canonicalSha256, type Sha256Digest } from '@echo-brain/federation-protocol';
import { canonicalSourceContentV1, sourceContentSha256V1, sourceItemIdV1, assertCanonicalMeetingDocument, type MeetingDocument } from '@echo-brain/organization-processing/core';
import type { PersonAccessAuthorization } from '@echo-brain/organization-authority-kernel/application/ports/person-access-authorization';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import type { PersonAskScopeV2 } from '../../../application/ports/person-original-context-retrieval-v1.js';
import { personOriginalGrantedProjectIdsV1 } from './person-original-access-v1.js';

export interface ImportedMeetingTextV1 {
  readonly api_version: 0; readonly context_id: `cap_${string}`; readonly title: string; readonly text: string;
  readonly received_at: string; readonly visibility: 'only_me'; readonly project_id: null;
  readonly source_id: string; readonly revision_id: string; readonly source_sha256: Sha256Digest; readonly representation_sha256: Sha256Digest;
  readonly source_content_sha256: string; readonly manifest_json: string; readonly source_content_json: string; readonly lexical_score: number;
}
interface SourceRow {
  context_id: `cap_${string}`; source_id: string; revision_id: string; captured_at: string; revision_sha256: string; content_sha256: string; manifest_json: string; content_json: string;
  adapter_id: string; instance_id: string; external_id: string;
}
function invalid(): never { throw new AuthorityOperationError('unavailable', 'Imported meeting is unavailable'); }
export function importedMeetingTextV1(meeting: MeetingDocument): string {
  // Transcript access remains exclusively in the existing approved transcript grant reader.
  return meeting.content.filter(block => block.kind !== 'transcript').map(block => block.text).join('\n\n');
}
/**
 * Read view over existing custody. There is no second meeting body or derived-content table.
 * Unapproved imported notes are readable by their importing person only: a project chosen on import
 * is a review suggestion, not an audience. Approval decides who else reads the meeting.
 */
export class SqlitePersonImportedMeetingsV1 {
  constructor(private readonly database: Database.Database) {
    database.function('echo_imported_meeting_id_v1', { deterministic: true }, (source, revision) => `cap_${canonicalSha256({ source, revision }).slice(7)}`);
  }
  rows(actor: PersonAccessAuthorization, scope: PersonAskScopeV2, exact?: { readonly source_id: string; readonly revision_id: string } | { readonly ids: readonly string[] }): readonly ImportedMeetingTextV1[] {
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
      return { api_version: 0, context_id: row.context_id, title: `Imported meeting (unapproved): ${meeting.title ?? 'Untitled'}`, text,
        received_at: row.captured_at, visibility: 'only_me', project_id: null,
        source_id: row.source_id, revision_id: row.revision_id, source_sha256: `sha256:${row.revision_sha256}`, representation_sha256: canonicalSha256({ kind: 'imported-meeting-notes-v1', text }),
        source_content_sha256: row.content_sha256, manifest_json: row.manifest_json, source_content_json: row.content_json, lexical_score: 0 };
    });
  }
}
