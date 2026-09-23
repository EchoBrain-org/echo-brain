import type Database from 'better-sqlite3';
import { canonicalSha256, sha256Digest } from '@echo-brain/federation-protocol';
import { validatePersonUpdateSubmitV1, validatePersonUpdateSubmitV2 } from '@echo-brain/organization-api';
import { sourceContentSha256V1, sourceItemIdV1 } from '@echo-brain/organization-processing/core';
import type { PersonTextSourceInboxV1, PersonTextSourceContentV1 } from '../../../application/ports/person-text-source-v1.js';
import { PERSON_SOURCE_IDENTITY_V1 } from '../../../application/person-document-source-v1.js';

type TextRow = { api_version:1|2; organization_id:string;principal_id:string;membership_id:string;request_id:string;context_id:string;title:string;text:string;payload_sha256:string;audience_kind:'only_me'|'team'|'project';audience_project_id:string|null;project_id:string|null;received_at:string };

/** Pull accepted editor notes into the same Person source; their read indexes already exist. */
export class SqlitePersonTextSourceInboxV1 implements PersonTextSourceInboxV1 {
  constructor(private readonly database:Database.Database) {}
  next(): ReturnType<PersonTextSourceInboxV1['next']> {
    const row=this.database.prepare(`SELECT * FROM (
      SELECT 1 AS api_version,organization_id,principal_id,membership_id,request_id,context_id,title,text,payload_sha256,visibility AS audience_kind,NULL AS audience_project_id,NULL AS project_id,received_at FROM authority_person_updates_v1
      UNION ALL
      SELECT 2 AS api_version,organization_id,principal_id,membership_id,request_id,context_id,title,text,payload_sha256,audience_kind,audience_project_id,project_id,received_at FROM authority_person_updates_v2
    ) u WHERE NOT EXISTS (SELECT 1 FROM authority_sources_v1 s WHERE s.organization_id=u.organization_id AND s.adapter_id=? AND s.instance_id=? AND s.external_id=u.context_id)
    AND (u.audience_kind!='only_me' OR EXISTS(SELECT 1 FROM authority_memberships m WHERE m.organization_id=u.organization_id AND m.principal_id=u.principal_id AND m.membership_id=u.membership_id AND m.status='active'))
    ORDER BY received_at,context_id LIMIT 1`).get(PERSON_SOURCE_IDENTITY_V1.adapter_id,PERSON_SOURCE_IDENTITY_V1.instance_id) as TextRow|undefined;
    if (!row) return undefined;
    const audience=row.audience_kind==='project'?{kind:'project',project_id:row.audience_project_id}:{kind:row.audience_kind};
    const request=row.api_version===1
      ?validatePersonUpdateSubmitV1({schema_version:1,kind:'echo-person-update-submit-v1',request_id:row.request_id,title:row.title,text:row.text,visibility:row.audience_kind})
      :validatePersonUpdateSubmitV2({schema_version:2,kind:'echo-person-update-submit-v2',request_id:row.request_id,title:row.title,text:row.text,audience,project_id:row.project_id});
    const coordinates={organization_id:row.organization_id,membership_id:row.membership_id,request_id:row.request_id};
    const id=`ctx_${canonicalSha256(row.api_version===1?coordinates:{schema_version:2,kind:'echo-person-update-source-v2',...coordinates}).slice(7)}`;
    if (id!==row.context_id || canonicalSha256(request)!==row.payload_sha256) throw new Error('Person text source integrity failed');
    const content:PersonTextSourceContentV1={schema_version:1,kind:'person-text',original_api_version:row.api_version,context_id:row.context_id,title:row.title,text:row.text};
    const sourceId=sourceItemIdV1(PERSON_SOURCE_IDENTITY_V1,row.context_id);
    return {
      source:{item:{schema_version:1,source_id:sourceId,adapter:PERSON_SOURCE_IDENTITY_V1,external_id:row.context_id},revision:{schema_version:1,source_id:sourceId,revision_id:row.payload_sha256,captured_at:row.received_at,content_sha256:sourceContentSha256V1(content),contributor:{principal_id:row.principal_id,membership_id:row.membership_id},artifact_refs:[{artifact_id:row.context_id,media_type:'text/plain',sha256:sha256Digest(row.text).slice(7),byte_length:Buffer.byteLength(row.text)}],representation_refs:[]},content},
      scope:{organization_id:row.organization_id,custody_ref:row.audience_kind==='project'?`project:${row.audience_project_id}`:row.audience_kind==='team'?`organization:${row.organization_id}`:`membership:${row.membership_id}`,access_policy_ref:`person-text-audience:${row.context_id}`,analysis_policy:'on_request'},
    };
  }
}
