import type Database from 'better-sqlite3';
import { sha256Digest } from '@echo-brain/federation-protocol';
import { canonicalSourceContentV1, sourceItemIdV1, type SourceEnvelopeV1, type SourceAdmissionScopeV1 } from '@echo-brain/organization-processing/core';
import { PERSON_SOURCE_IDENTITY_V1 } from '../../../application/person-document-source-v1.js';

type CustodyRow = { organization_id:string;principal_id:string;membership_id:string;membership_type:string;audience_kind:'only_me'|'team'|'project';audience_project_id:string|null;received_at:string };
type DocumentRow = CustodyRow & { document_id:string;filename:string;original_sha256:string;original_size:number;detected_media_type:string };
type TextRow = CustodyRow & { context_id:string;title:string;text:string;payload_sha256:string };
function equal(a:unknown,b:unknown):boolean{return canonicalSourceContentV1(a)===canonicalSourceContentV1(b);}

/** Rebind adapter output to accepted originals and current private eligibility inside the store transaction. */
export function assertPersonSourceAdmissionV1(database:Database.Database,source:SourceEnvelopeV1,scope:SourceAdmissionScopeV1):void {
  if(!database.inTransaction)throw new Error('Person source admission requires its owning transaction');
  if(!equal(source.item.adapter,PERSON_SOURCE_IDENTITY_V1))throw new Error('Person source adapter identity mismatch');
  const content=source.content as Record<string,unknown>;
  let row:CustodyRow|undefined;let revision:string;let expected:unknown;let artifact:unknown;
  if(content.kind==='person-document'){
    const document=database.prepare('SELECT * FROM authority_person_documents_v1 WHERE organization_id=? AND document_id=?').get(scope.organization_id,source.item.external_id) as DocumentRow|undefined;
    if(!document)throw new Error('Person document source is not in accepted custody');
    row=document;revision=document.original_sha256;
    expected={schema_version:1,kind:'person-document',document_id:document.document_id,filename:document.filename,original_sha256:document.original_sha256,original_size:document.original_size,media_type:document.detected_media_type};
    artifact={artifact_id:document.document_id,media_type:document.detected_media_type,sha256:document.original_sha256.slice(7),byte_length:document.original_size};
  }else if(content.kind==='person-text'){
    const version=content.original_api_version;
    if(version!==1&&version!==2)throw new Error('Person text source version is invalid');
    const projection=version===1?'organization_id,principal_id,membership_id,membership_type,received_at,context_id,title,text,payload_sha256,visibility AS audience_kind,NULL AS audience_project_id':'*';
    const text=database.prepare(`SELECT ${projection} FROM authority_person_updates_v${version} WHERE organization_id=? AND context_id=?`).get(scope.organization_id,source.item.external_id) as TextRow|undefined;
    if(!text)throw new Error('Person text source is not in accepted custody');
    row=text;revision=text.payload_sha256;
    expected={schema_version:1,kind:'person-text',original_api_version:version,context_id:text.context_id,title:text.title,text:text.text};
    artifact={artifact_id:text.context_id,media_type:'text/plain',sha256:sha256Digest(text.text).slice(7),byte_length:Buffer.byteLength(text.text)};
  }else throw new Error('Person source content kind is unsupported');
  const expectedScope:SourceAdmissionScopeV1={organization_id:row.organization_id,custody_ref:row.audience_kind==='project'?`project:${row.audience_project_id}`:row.audience_kind==='team'?`organization:${row.organization_id}`:`membership:${row.membership_id}`,access_policy_ref:`${content.kind==='person-document'?'document':'person-text'}-audience:${source.item.external_id}`,analysis_policy:'on_request'};
  if(!equal(scope,expectedScope)||!equal(content,expected)||source.item.source_id!==sourceItemIdV1(PERSON_SOURCE_IDENTITY_V1,source.item.external_id)||source.revision.revision_id!==revision||source.revision.captured_at!==row.received_at||!equal(source.revision.contributor,{principal_id:row.principal_id,membership_id:row.membership_id})||!equal(source.revision.artifact_refs,[artifact])||source.revision.representation_refs.length!==0)throw new Error('Person source differs from accepted custody');
  if(row.audience_kind==='only_me'&&!database.prepare("SELECT 1 FROM authority_memberships WHERE organization_id=? AND principal_id=? AND membership_id=? AND membership_type=? AND status='active'").get(row.organization_id,row.principal_id,row.membership_id,row.membership_type))throw new Error('Private Person source processing eligibility changed');
}
