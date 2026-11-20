import type Database from 'better-sqlite3';
import type { AuthorityPersonMembershipBinding } from '@echo-brain/organization-authority-kernel/application/ports/authority-repository';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
/**
 * Storage bounds on what a person retains: each family (documents' original bytes, notes' text bytes) holds at most
 * 250 MiB per member and 25 GiB per organization. Bytes alone bound them; a person may keep any number of each.
 */
export const PERSON_DOCUMENT_MEMBER_QUOTA_BYTES = 250 * 1024 * 1024;
export const PERSON_DOCUMENT_ORGANIZATION_QUOTA_BYTES = 25 * 1024 * 1024 * 1024;
type PersonRetainedContentFamilyV1 = 'document' | 'legacy_text';

/** Same transaction as admission. Each family's stored bytes, with the incoming ones, stay within its storage bound. */
export function assertPersonDocumentCapacityV1(database: Database.Database, actor: AuthorityPersonMembershipBinding, incomingBytes: number, family: PersonRetainedContentFamilyV1 = 'document'): void {
  const stored = (family === 'document'
    ? database.prepare(`SELECT coalesce(sum(original_size),0) AS bytes,coalesce(sum(CASE WHEN membership_id=? THEN original_size ELSE 0 END),0) AS member_bytes
        FROM authority_person_documents_v1 WHERE organization_id=?`)
    : database.prepare(`SELECT coalesce(sum(length(CAST(text AS BLOB))),0) AS bytes,coalesce(sum(CASE WHEN membership_id=? THEN length(CAST(text AS BLOB)) ELSE 0 END),0) AS member_bytes
        FROM authority_person_updates_v2 WHERE organization_id=?`)
  ).get(actor.membership_id, actor.organization_id) as { bytes: number; member_bytes: number };
  if (stored.bytes + incomingBytes > PERSON_DOCUMENT_ORGANIZATION_QUOTA_BYTES || stored.member_bytes + incomingBytes > PERSON_DOCUMENT_MEMBER_QUOTA_BYTES) {
    throw new AuthorityOperationError(family === 'document' ? 'quota_exceeded' : 'rate_limited', 'Retained content capacity reached');
  }
}
