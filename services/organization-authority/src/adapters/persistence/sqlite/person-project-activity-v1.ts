import type Database from 'better-sqlite3';
import { AUTHORITY_BASELINE_SCHEMA_VERSION, isCurrentAuthorityState } from '@echo-brain/organization-authority-kernel/adapters/persistence/sqlite/baseline';
import type { PersonAccessAuthorization } from '@echo-brain/organization-authority-kernel/application/ports/person-access-authorization';
import {
  PERSON_ORIGINAL_NOTE_CUSTODY_V1,
  PERSON_ORIGINAL_NOTE_NOT_QUARANTINED_V1,
  personOriginalAclV1,
  personOriginalGrantedProjectIdsV1,
} from './person-original-access-v1.js';
import { publishedRecordsOfApproverV1 } from './published-approval-records-v1.js';

/** A stored time as canonical UTC milliseconds, so the newest is the greatest string; SQLite reads a time with no offset as UTC. */
const canonical = (column: string) => `strftime('%Y-%m-%dT%H:%M:%fZ', ${column})`;

/**
 * The project activity read's Authority rows (Ask timeline v1, C2): when a note or a document was last filed into each of a
 * person's projects by someone else, and the records the person's own approvals published. It reads only inside the read's
 * own read transaction, which it never opens or ends, and writes no audit row: nothing it reads is released.
 */
export class SqlitePersonProjectActivityV1 {
  constructor(private readonly database: Database.Database) {
    if (!isCurrentAuthorityState(database)) {
      throw new Error(`Project activity requires Authority V${AUTHORITY_BASELINE_SCHEMA_VERSION} with foreign keys enabled`);
    }
  }

  /**
   * For each of these projects, when a note or a document was last filed into it by someone other than this person, of the
   * ones this person reads now under the person list's own ACL (`personOriginalAclV1` with their current grants), a
   * quarantined note left out as the list leaves it out. A note's association names who filed it. A document is filed only by
   * its uploader (an upload files it as theirs, and an association by anyone else is refused), so its uploader is who filed
   * it, as the association's receipt would say. A project with neither has no entry.
   */
  originals(actor: PersonAccessAuthorization, projectIds: readonly string[]): ReadonlyMap<string, string> {
    this.assertInTransaction();
    const latest = new Map<string, string>();
    if (projectIds.length === 0) return latest;
    const grants = personOriginalGrantedProjectIdsV1(this.database, actor);
    const notes = personOriginalAclV1('u', actor, grants);
    const documents = personOriginalAclV1('d', actor, grants);
    // One project at a time, each read from its association index (CROSS JOIN keeps the association first, so SQLite never
    // scans the organization's notes or documents instead). A note's newest comes first in its project's feed index, whose
    // times its repository writes canonical; a document's association index has no time, so its project's rows are all read.
    const note = this.database.prepare(`SELECT ${canonical('association.associated_at')}
      FROM authority_project_context_associations_v1 AS association
      CROSS JOIN ${PERSON_ORIGINAL_NOTE_CUSTODY_V1} u ON u.context_id = association.context_id AND u.organization_id = association.organization_id
      WHERE association.project_id = ? AND association.organization_id = ?
        AND association.associator_membership_id != ? AND ${notes.sql} AND ${PERSON_ORIGINAL_NOTE_NOT_QUARANTINED_V1}
      ORDER BY association.associated_at DESC LIMIT 1`).pluck();
    const document = this.database.prepare(`SELECT MAX(${canonical('association.associated_at')})
      FROM authority_person_document_associations_v1 AS association
      CROSS JOIN authority_person_documents_v1 d ON d.document_id = association.document_id AND d.organization_id = association.organization_id
      WHERE association.project_id = ? AND association.organization_id = ? AND d.membership_id != ? AND ${documents.sql}`).pluck();
    for (const projectId of new Set(projectIds)) {
      const times = [
        note.get(projectId, actor.organization_id, actor.membership_id, ...notes.args),
        document.get(projectId, actor.organization_id, actor.membership_id, ...documents.args),
      ].filter((time): time is string => typeof time === 'string').sort();
      if (times.length > 0) latest.set(projectId, times.at(-1)!);
    }
    return latest;
  }

  /** The records this person's own published approvals name: theirs, so never news to them. */
  approvedRecords(actor: PersonAccessAuthorization): ReadonlySet<string> {
    this.assertInTransaction();
    return publishedRecordsOfApproverV1(this.database, actor);
  }

  private assertInTransaction(): void {
    if (!this.database.inTransaction) throw new Error('The project activity read reads inside its own read transaction');
  }
}
