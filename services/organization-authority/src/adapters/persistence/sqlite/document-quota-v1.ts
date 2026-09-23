import type Database from 'better-sqlite3';
import type { AuthorityPersonMembershipBinding } from '@echo-brain/organization-authority-kernel/application/ports/authority-repository';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
export const PERSON_DOCUMENT_MEMBER_QUOTA_BYTES = 250 * 1024 * 1024;
export const PERSON_DOCUMENT_ORGANIZATION_QUOTA_BYTES = 25 * 1024 * 1024 * 1024;
/** Same transaction as admission; aggregate metadata sizes, never retained binary payloads. */
export function assertPersonDocumentCapacityV1(database: Database.Database, actor: AuthorityPersonMembershipBinding, incomingBytes: number): void {
  const version=database.pragma('user_version',{simple:true}) as number;
  const sources=[`SELECT organization_id,membership_id,length(CAST(text AS BLOB)) AS original_size FROM authority_person_updates_v1`];
  if(version>=7)sources.push(`SELECT organization_id,membership_id,length(CAST(text AS BLOB)) AS original_size FROM authority_person_updates_v2`);
  if(version>=8)sources.push(`SELECT organization_id,membership_id,original_size FROM authority_person_documents_v1`);
  const quota=database.prepare(`SELECT count(*) AS count,coalesce(sum(original_size),0) AS bytes,coalesce(sum(CASE WHEN membership_id=? THEN 1 ELSE 0 END),0) AS member_count,coalesce(sum(CASE WHEN membership_id=? THEN original_size ELSE 0 END),0) AS member_bytes FROM (${sources.join(' UNION ALL ')}) WHERE organization_id=?`).get(actor.membership_id,actor.membership_id,actor.organization_id) as {count:number;bytes:number;member_count:number;member_bytes:number};
  if(quota.count>=1000||quota.member_count>=100||quota.bytes+incomingBytes>PERSON_DOCUMENT_ORGANIZATION_QUOTA_BYTES||quota.member_bytes+incomingBytes>PERSON_DOCUMENT_MEMBER_QUOTA_BYTES)throw new AuthorityOperationError('rate_limited','Document capacity reached');
}
