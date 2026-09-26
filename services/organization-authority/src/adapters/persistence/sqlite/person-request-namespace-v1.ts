import type Database from 'better-sqlite3';
import type { AuthorityPersonMembershipBinding } from '@echo-brain/organization-authority-kernel/application/ports/authority-repository';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';

/** Each operation owns its replay codec, but the account's request namespace is shared. */
export function assertPersonRequestNamespaceV1(database: Database.Database, actor: AuthorityPersonMembershipBinding, requestId: string, family: 'document' | 'document_association' | 'project'): void {
  const version = database.pragma('user_version', { simple: true }) as number;
  const otherTables = [
    'authority_person_updates_v1',
    ...(family !== 'project' && version >= 7 ? ['authority_project_command_receipts_v1'] : []),
    ...(family !== 'document' && version >= 8 ? ['authority_person_document_receipts_v1'] : []),
    ...(family !== 'document_association' && version >= 8 ? ['authority_person_document_association_receipts_v1'] : []),
  ];
  for (const table of otherTables) {
    if (database.prepare(`SELECT 1 FROM ${table} WHERE organization_id=? AND membership_id=? AND request_id=?`).get(actor.organization_id, actor.membership_id, requestId)) {
      throw new AuthorityOperationError('conflict', 'Request belongs to a different operation');
    }
  }
}
