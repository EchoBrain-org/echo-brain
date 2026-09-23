import type Database from 'better-sqlite3';
import type { AuthorityPersonMembershipBinding } from '@echo-brain/organization-authority-kernel/application/ports/authority-repository';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
export const PERSON_DOCUMENT_MEMBER_QUOTA_BYTES = 250 * 1024 * 1024;
export const PERSON_DOCUMENT_ORGANIZATION_QUOTA_BYTES = 25 * 1024 * 1024 * 1024;
type PersonRetainedContentFamilyV1 = 'document' | 'legacy_text';

/** Same transaction as admission. Count limits span all retained Person originals; byte limits apply only to document blobs. */
export function assertPersonDocumentCapacityV1(database: Database.Database, actor: AuthorityPersonMembershipBinding, incomingBytes: number, family: PersonRetainedContentFamilyV1 = 'document'): void {
  const version=database.pragma('user_version',{simple:true}) as number;
  const sources=[`SELECT organization_id,membership_id,length(CAST(text AS BLOB)) AS original_size FROM authority_person_updates_v1`];
  if(version>=7)sources.push(`SELECT organization_id,membership_id,length(CAST(text AS BLOB)) AS original_size FROM authority_person_updates_v2`);
  if(version>=8)sources.push(`SELECT organization_id,membership_id,original_size FROM authority_person_documents_v1`);
  const retained=database.prepare(`SELECT count(*) AS count,coalesce(sum(CASE WHEN membership_id=? THEN 1 ELSE 0 END),0) AS member_count FROM (${sources.join(' UNION ALL ')}) WHERE organization_id=?`).get(actor.membership_id,actor.organization_id) as {count:number;member_count:number};
  const documentBytes=version>=8
    ? database.prepare(`SELECT coalesce(sum(original_size),0) AS bytes,coalesce(sum(CASE WHEN membership_id=? THEN original_size ELSE 0 END),0) AS member_bytes FROM authority_person_documents_v1 WHERE organization_id=?`).get(actor.membership_id,actor.organization_id) as {bytes:number;member_bytes:number}
    : {bytes:0,member_bytes:0};
  const incomingDocumentBytes=family==='document'?incomingBytes:0;
  const countFull=retained.count>=1000||retained.member_count>=100;
  const bytesFull=family==='document'&&(documentBytes.bytes+incomingDocumentBytes>PERSON_DOCUMENT_ORGANIZATION_QUOTA_BYTES||documentBytes.member_bytes+incomingDocumentBytes>PERSON_DOCUMENT_MEMBER_QUOTA_BYTES);
  if(countFull||bytesFull)throw new AuthorityOperationError(family==='document'?'quota_exceeded':'rate_limited','Retained content capacity reached');
}
