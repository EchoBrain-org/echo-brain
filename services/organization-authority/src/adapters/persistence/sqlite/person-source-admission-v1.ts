import type Database from 'better-sqlite3';
import { canonicalJson, canonicalSha256, sha256Digest } from '@echo-brain/federation-protocol';
import { validatePersonUpdateSubmitV3, validatePersonUploadAudienceV3, type ProjectIdV1 } from '@echo-brain/organization-api';
import { canonicalSourceContentV1, sourceItemIdV1, type SourceEnvelopeV1, type SourceAdmissionScopeV1 } from '@echo-brain/organization-processing/core';
import { PERSON_SOURCE_IDENTITY_V1 } from '../../../application/person-document-source-v1.js';

type CustodyRow = { organization_id:string; principal_id:string; membership_id:string; membership_type:string; audience_kind:'only_me'|'team'|'project'|'projects'; audience_project_id:string|null; audience_project_ids_json?:string|null; submitted_association_project_ids_json?:string|null; received_at:string };
type DocumentRow = CustodyRow & { document_id:string; filename:string; original_sha256:string; original_size:number; detected_media_type:string };
type TextRow = CustodyRow & { context_id:string; title:string; text:string; payload_sha256:string; request_id:string; request_version?:number };
function equal(a:unknown,b:unknown):boolean{return canonicalSourceContentV1(a)===canonicalSourceContentV1(b);}

function canonicalIds(json: string | null | undefined): readonly ProjectIdV1[] {
  if (typeof json !== 'string') throw new Error('Person projects custody is absent');
  let value: unknown;
  try { value = JSON.parse(json); } catch { throw new Error('Person projects custody is invalid'); }
  if (!Array.isArray(value) || canonicalJson(value) !== json) throw new Error('Person projects custody is invalid');
  const audience = validatePersonUploadAudienceV3({ kind: 'projects', project_ids: value });
  if (audience.kind !== 'projects') throw new Error('Person projects custody is invalid');
  return audience.project_ids;
}

function audienceIds(row: CustodyRow): readonly ProjectIdV1[] {
  if (row.audience_kind === 'projects') return canonicalIds(row.audience_project_ids_json);
  if (row.audience_kind === 'project' && row.audience_project_id !== null) {
    const ids = [row.audience_project_id as ProjectIdV1];
    if (typeof row.audience_project_ids_json === 'string' && canonicalJson(ids) !== row.audience_project_ids_json) throw new Error('Person project audience custody is invalid');
    return ids;
  }
  return [];
}
function assertAudienceLinks(database: Database.Database, table: 'text'|'document', id: string, organizationId: string, row: CustodyRow): readonly ProjectIdV1[] {
  const ids = audienceIds(row);
  if (ids.length === 0 || (database.pragma('user_version', { simple: true }) as number) < 9) return ids;
  const joins = table === 'text'
    ? database.prepare('SELECT project_id FROM authority_person_update_audience_projects_v1 WHERE context_id=? AND organization_id=? ORDER BY project_id').pluck().all(id, organizationId)
    : database.prepare('SELECT project_id FROM authority_person_document_audience_projects_v1 WHERE document_id=? AND organization_id=? ORDER BY project_id').pluck().all(id, organizationId);
  if (canonicalJson(joins) !== canonicalJson(ids)) throw new Error('Person projects audience links differ from immutable custody');
  return ids;
}

function custodyRef(database: Database.Database, table: 'text'|'document', id: string, row: CustodyRow): string {
  const ids = assertAudienceLinks(database, table, id, row.organization_id, row);
  if (row.audience_kind === 'projects') return `projects:${canonicalSha256(ids)}`;
  if (row.audience_kind === 'project') return `project:${row.audience_project_id}`;
  return row.audience_kind === 'team' ? `organization:${row.organization_id}` : `membership:${row.membership_id}`;
}

/** Rebind adapter output to accepted originals and current private eligibility inside the store transaction. */
export function assertPersonSourceAdmissionV1(database:Database.Database,source:SourceEnvelopeV1,scope:SourceAdmissionScopeV1):void {
  if(!database.inTransaction)throw new Error('Person source admission requires its owning transaction');
  if(!equal(source.item.adapter,PERSON_SOURCE_IDENTITY_V1))throw new Error('Person source adapter identity mismatch');
  const content=source.content as Record<string,unknown>;
  let row:CustodyRow|undefined;let revision:string;let expected:unknown;let artifact:unknown;let table:'text'|'document';let external:string;
  if(content.kind==='person-document'){
    const document=database.prepare('SELECT * FROM authority_person_documents_v1 WHERE organization_id=? AND document_id=?').get(scope.organization_id,source.item.external_id) as DocumentRow|undefined;
    if(!document)throw new Error('Person document source is not in accepted custody');
    row=document;table='document';external=document.document_id;revision=document.original_sha256;
    expected={schema_version:1,kind:'person-document',document_id:document.document_id,filename:document.filename,original_sha256:document.original_sha256,original_size:document.original_size,media_type:document.detected_media_type};
    artifact={artifact_id:document.document_id,media_type:document.detected_media_type,sha256:document.original_sha256.slice(7),byte_length:document.original_size};
  }else if(content.kind==='person-text'){
    const version=content.original_api_version;
    if(version!==1&&version!==2&&version!==3)throw new Error('Person text source version is invalid');
    const projection=version===1?'organization_id,principal_id,membership_id,membership_type,received_at,context_id,title,text,payload_sha256,visibility AS audience_kind,NULL AS audience_project_id,NULL AS audience_project_ids_json,NULL AS submitted_association_project_ids_json,NULL AS request_version,request_id':'*';
    const text=database.prepare(`SELECT ${projection} FROM authority_person_updates_v${version === 1 ? 1 : 2} WHERE organization_id=? AND context_id=?`).get(scope.organization_id,source.item.external_id) as TextRow|undefined;
    if(!text || (version !== 1 && (database.pragma('user_version', {simple:true}) as number) >= 9 && text.request_version !== version))throw new Error('Person text source is not in accepted custody');
    row=text;table='text';external=text.context_id;revision=text.payload_sha256;
    if (version === 3) {
      const audience = text.audience_kind === 'projects'
        ? validatePersonUploadAudienceV3({ kind: 'projects', project_ids: canonicalIds(text.audience_project_ids_json) })
        : text.audience_kind === 'project' && text.audience_project_id !== null ? { kind: 'project' as const, project_id: text.audience_project_id as ProjectIdV1 }
        : text.audience_kind === 'only_me' || text.audience_kind === 'team' ? { kind: text.audience_kind } : undefined;
      if (!audience) throw new Error('Person text audience is invalid');
      const associations = (() => { const raw = text.submitted_association_project_ids_json; if (typeof raw !== 'string') throw new Error('Person associations are absent'); const parsed = JSON.parse(raw); if (!Array.isArray(parsed) || canonicalJson(parsed) !== raw) throw new Error('Person associations are invalid'); return parsed; })();
      const request = validatePersonUpdateSubmitV3({ schema_version:3, kind:'echo-person-update-submit-v3', request_id:text.request_id, title:text.title, text:text.text, association_project_ids:associations, audience });
      const context=`ctx_${canonicalSha256({schema_version:3,kind:'echo-person-update-source-v3',organization_id:text.organization_id,membership_id:text.membership_id,request_id:text.request_id}).slice(7)}`;
      if (canonicalSha256(request)!==text.payload_sha256 || context!==text.context_id) throw new Error('Person text V3 custody integrity failed');
    }
    expected={schema_version:1,kind:'person-text',original_api_version:version,context_id:text.context_id,title:text.title,text:text.text};
    artifact={artifact_id:text.context_id,media_type:'text/plain',sha256:sha256Digest(text.text).slice(7),byte_length:Buffer.byteLength(text.text)};
  }else throw new Error('Person source content kind is unsupported');
  const expectedScope:SourceAdmissionScopeV1={organization_id:row.organization_id,custody_ref:custodyRef(database,table,external,row),access_policy_ref:`${content.kind==='person-document'?'document':'person-text'}-audience:${source.item.external_id}`,analysis_policy:'on_request'};
  if(!equal(scope,expectedScope)||!equal(content,expected)||source.item.source_id!==sourceItemIdV1(PERSON_SOURCE_IDENTITY_V1,source.item.external_id)||source.revision.revision_id!==revision||source.revision.captured_at!==row.received_at||!equal(source.revision.contributor,{principal_id:row.principal_id,membership_id:row.membership_id})||!equal(source.revision.artifact_refs,[artifact])||source.revision.representation_refs.length!==0)throw new Error('Person source differs from accepted custody');
  if(row.audience_kind==='only_me'&&!database.prepare("SELECT 1 FROM authority_memberships WHERE organization_id=? AND principal_id=? AND membership_id=? AND membership_type=? AND status='active'").get(row.organization_id,row.principal_id,row.membership_id,row.membership_type))throw new Error('Private Person source processing eligibility changed');
}
