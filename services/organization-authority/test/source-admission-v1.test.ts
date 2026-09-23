import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalJson, canonicalSha256, sha256Digest } from '@echo-brain/federation-protocol';
import { applyAuthorityBaselineV8, applyAuthorityBaselineV9 } from '@echo-brain/organization-authority-kernel/adapters/persistence/sqlite/baseline';
import { MeetingSourceBridgeV1, pullAndAdmitSourceBatchV1, sourceContentSha256V1, type MeetingDocument } from '@echo-brain/organization-processing/core';
import { SqliteSourceAdmissionStoreV1 } from '../src/adapters/persistence/sqlite/source-admission-v1.js';
import { PersonSourceAdapterV1 } from '../src/adapters/sources/person-source-v1.js';
import { personDocumentSourceEnvelopeV1 } from '../src/application/person-document-source-v1.js';
import type { DocumentExtractionClaimV1 } from '../src/application/ports/document-v1.js';
import { SqlitePersonTextSourceInboxV1 } from '../src/adapters/persistence/sqlite/person-text-source-v1.js';
import { PersonDocumentProcessingV1 } from '../src/composition/person-document-processing-v1.js';
import { assertPersonSourceAdmissionV1 } from '../src/adapters/persistence/sqlite/person-source-admission-v1.js';

const at='2026-09-23T00:00:00.000Z';
const dbs: Database.Database[]=[];
afterEach(()=>{for(const db of dbs.splice(0)) db.close();});
function fixture() {
  const db=new Database(':memory:'); dbs.push(db); db.pragma('foreign_keys=ON'); applyAuthorityBaselineV8(db);
  db.prepare("INSERT INTO authority_metadata VALUES (1,'oau_fixture','org_fixture','Fixture','{}',?,?)").run(at,at);
  return {db,store:new SqliteSourceAdmissionStoreV1(db)};
}
function claim(): DocumentExtractionClaimV1 {
  const bytes=Buffer.from('MRD hardware handoff');
  return {document_id:`doc_${'a'.repeat(64)}`,lease_token:'lease',bytes,filename:'MRD.md',source_sha256:sha256Digest(bytes),authorization_sha256:sha256Digest('authorization'),source_scope:{organization_id:'org_fixture',custody_ref:'project:scout',access_policy_ref:'document-audience:fixture',analysis_policy:'on_request'},received_at:at,contributor:{principal_id:'prn_pm',membership_id:'mem_pm'},media_type:'text/markdown'};
}
function meeting(): MeetingDocument {
  return {schema_version:1,id:'meeting-1',provenance:{source:{kind:'meeting-source',adapter_id:'meeting',instance_id:'connection',version:'1'},external_id:'meeting-1',canonical_revision:'revision-1',observed_at:at,normalizer_version:'1'},capture:{state:'complete',components:[]},participants:[],artifacts:[],content:[{id:'note-1',kind:'note',text:'Hardware needs a software interface.'}]};
}

describe('durable common source admission',()=>{
  it('admits a departed contributor V3 projects note with a project-set custody commitment', async () => {
    const db = new Database(':memory:'); dbs.push(db); db.pragma('foreign_keys=ON'); applyAuthorityBaselineV9(db);
    const actor={organization_id:'org_fixture',principal_id:'prn_pm',membership_id:'mem_11111111-1111-4111-8111-111111111111',membership_type:'owner'} as const;
    const first='prj_11111111-1111-4111-8111-111111111111'; const second='prj_22222222-2222-4222-8222-222222222222';
    db.prepare("INSERT INTO authority_metadata VALUES (1,'oau_fixture','org_fixture','Fixture','{}',?,?)").run(at,at);
    db.prepare("INSERT INTO authority_project_authorization_state_v1 VALUES ('org_fixture',0,?)").run(at);
    db.prepare("INSERT INTO authority_principals VALUES (?,?,'PM',?)").run(actor.principal_id,actor.organization_id,at);
    db.prepare("INSERT INTO authority_memberships(membership_id,organization_id,principal_id,membership_type,status,provisioned_at) VALUES (?,?,?,?,'active',?)").run(actor.membership_id,actor.organization_id,actor.principal_id,actor.membership_type,at);
    for (const project of [first,second]) db.prepare('INSERT INTO authority_projects_v1(project_id,organization_id,name,created_at,creator_principal_id,creator_membership_id,creator_membership_type) VALUES (?,?,?,?,?,?,?)').run(project,actor.organization_id,project,at,actor.principal_id,actor.membership_id,actor.membership_type);
    const request={schema_version:3 as const,kind:'echo-person-update-submit-v3' as const,request_id:'33333333-3333-4333-8333-333333333333',title:'Cross-project note',text:'shared systems evidence',association_project_ids:[first],audience:{kind:'projects' as const,project_ids:[first,second]}};
    const context=`ctx_${canonicalSha256({schema_version:3,kind:'echo-person-update-source-v3',organization_id:actor.organization_id,membership_id:actor.membership_id,request_id:request.request_id}).slice(7)}`;
    db.prepare(`INSERT INTO authority_person_updates_v2(organization_id,principal_id,membership_id,membership_type,request_id,request_version,context_id,payload_sha256,title,text,audience_kind,audience_project_id,submitted_association_project_ids_json,audience_project_ids_json,project_id,received_at) VALUES (?,?,?,?,?,?,?,? ,? ,? ,'projects',NULL,?,?,NULL,?)`).run(actor.organization_id,actor.principal_id,actor.membership_id,actor.membership_type,request.request_id,3,context,canonicalSha256(request),request.title,request.text,JSON.stringify(request.association_project_ids),JSON.stringify(request.audience.project_ids),at);
    db.prepare("INSERT INTO authority_person_update_work_v2(context_id,state,retry_at) VALUES (?,'pending',?)").run(context,at);
    db.prepare('INSERT INTO authority_person_update_audience_projects_v1 VALUES (?,?,?)').run(context,first,actor.organization_id);
    db.prepare('INSERT INTO authority_person_update_audience_projects_v1 VALUES (?,?,?)').run(context,second,actor.organization_id);
    db.prepare("UPDATE authority_memberships SET status='revoked',revoked_at=?,revocation_reason='fixture' WHERE membership_id=?").run(at,actor.membership_id);
    const pulled=new SqlitePersonTextSourceInboxV1(db).next()!;
    expect(pulled.scope.custody_ref).toBe(`projects:${canonicalSha256([first,second])}`);
    const store=new SqliteSourceAdmissionStoreV1(db,(source,scope)=>assertPersonSourceAdmissionV1(db,source,scope));
    expect(await store.admitSourceRevision(pulled)).toBe('admitted');
    expect(db.prepare('SELECT custody_ref,content_json FROM authority_sources_v1 JOIN authority_source_contents_v1 USING(source_id)').get()).toEqual({custody_ref:`projects:${canonicalSha256([first,second])}`,content_json:canonicalJson(pulled.source.content)});
  });
  it('pulls editor notes through the same Person identity without a model or decoder, including departed shared contributors',async()=>{
    const {db}=fixture();
    const store=new SqliteSourceAdmissionStoreV1(db,(source,scope)=>assertPersonSourceAdmissionV1(db,source,scope));
    const actor={organization_id:'org_fixture',principal_id:'prn_pm',membership_id:'mem_11111111-1111-4111-8111-111111111111',membership_type:'owner'};
    db.prepare("INSERT INTO authority_principals VALUES (?,?,'PM',?)").run(actor.principal_id,actor.organization_id,at);
    db.prepare("INSERT INTO authority_memberships(membership_id,organization_id,principal_id,membership_type,status,provisioned_at) VALUES (?,?,?,?,'active',?)").run(actor.membership_id,actor.organization_id,actor.principal_id,actor.membership_type,at);
    const project='prj_11111111-1111-4111-8111-111111111111';
    db.prepare('INSERT INTO authority_projects_v1(project_id,organization_id,name,created_at,creator_principal_id,creator_membership_id,creator_membership_type) VALUES (?,?,?,?,?,?,?)').run(project,actor.organization_id,'SCOUT',at,actor.principal_id,actor.membership_id,actor.membership_type);
    const one={schema_version:1,kind:'echo-person-update-submit-v1',request_id:'11111111-1111-4111-8111-111111111111',title:'Team note',text:'hardware handoff',visibility:'team'};
    const two={schema_version:2,kind:'echo-person-update-submit-v2',request_id:'22222222-2222-4222-8222-222222222222',title:'Project note',text:'software interface',audience:{kind:'project',project_id:project},project_id:project};
    const oneId=`ctx_${canonicalSha256({organization_id:actor.organization_id,membership_id:actor.membership_id,request_id:one.request_id}).slice(7)}`;
    const twoId=`ctx_${canonicalSha256({schema_version:2,kind:'echo-person-update-source-v2',organization_id:actor.organization_id,membership_id:actor.membership_id,request_id:two.request_id}).slice(7)}`;
    db.prepare('INSERT INTO authority_person_updates_v1 VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(actor.organization_id,actor.principal_id,actor.membership_id,actor.membership_type,one.request_id,oneId,canonicalSha256(one),one.title,one.text,one.visibility,at);
    db.prepare('INSERT INTO authority_person_updates_v2 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(actor.organization_id,actor.principal_id,actor.membership_id,actor.membership_type,two.request_id,twoId,canonicalSha256(two),two.title,two.text,two.audience.kind,project,project,at);
    db.prepare("UPDATE authority_memberships SET status='revoked',revoked_at=?,revocation_reason='fixture' WHERE membership_id=?").run(at,actor.membership_id);
    const texts=new SqlitePersonTextSourceInboxV1(db);
    let decodes=0;const worker=new PersonDocumentProcessingV1({sourceAdmission:store,claimExtraction:()=>undefined,completeExtraction:()=>{throw new Error('text must not use file completion');}},async()=>{decodes++;throw new Error('text must not use decoder');},texts);
    const signal=new AbortController().signal;
    await worker.runOnce(signal);await worker.runOnce(signal);await worker.runOnce(signal);
    expect(decodes).toBe(0);expect(texts.next()).toBeUndefined();
    expect(db.prepare('SELECT adapter_id,instance_id,analysis_policy,custody_ref FROM authority_sources_v1 ORDER BY custody_ref').all()).toEqual([
      {adapter_id:'person',instance_id:'authority-inbox',analysis_policy:'on_request',custody_ref:'organization:org_fixture'},
      {adapter_id:'person',instance_id:'authority-inbox',analysis_policy:'on_request',custody_ref:`project:${project}`},
    ]);
    expect(db.prepare('SELECT content_json FROM authority_source_contents_v1').pluck().all().join(' ')).toContain('software interface');
  });
  it('durably skips a malformed retained text row and admits the next shared note without retaining corrupt content',async()=>{
    const {db}=fixture();
    const store=new SqliteSourceAdmissionStoreV1(db,(source,scope)=>assertPersonSourceAdmissionV1(db,source,scope));
    const actor={organization_id:'org_fixture',principal_id:'prn_pm',membership_id:'mem_11111111-1111-4111-8111-111111111111',membership_type:'owner'};
    db.prepare("INSERT INTO authority_principals VALUES (?,?,'PM',?)").run(actor.principal_id,actor.organization_id,at);
    db.prepare("INSERT INTO authority_memberships(membership_id,organization_id,principal_id,membership_type,status,provisioned_at) VALUES (?,?,?,?,'active',?)").run(actor.membership_id,actor.organization_id,actor.principal_id,actor.membership_type,at);
    const poison={schema_version:1,kind:'echo-person-update-submit-v1',request_id:'11111111-1111-4111-8111-111111111111',title:'Poison title',text:'poison body',visibility:'team'};
    const valid={schema_version:1,kind:'echo-person-update-submit-v1',request_id:'22222222-2222-4222-8222-222222222222',title:'Valid title',text:'valid shared body',visibility:'team'};
    const context=(request_id:string)=>`ctx_${canonicalSha256({organization_id:actor.organization_id,membership_id:actor.membership_id,request_id}).slice(7)}`;
    const poisonId=context(poison.request_id); const validId=context(valid.request_id);
    db.prepare('INSERT INTO authority_person_updates_v1 VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(actor.organization_id,actor.principal_id,actor.membership_id,actor.membership_type,poison.request_id,poisonId,`sha256:${'0'.repeat(64)}`,poison.title,poison.text,poison.visibility,at);
    db.prepare('INSERT INTO authority_person_updates_v1 VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(actor.organization_id,actor.principal_id,actor.membership_id,actor.membership_type,valid.request_id,validId,canonicalSha256(valid),valid.title,valid.text,valid.visibility,'2026-09-23T00:00:01.000Z');
    const observed:unknown[]=[];
    const worker=new PersonDocumentProcessingV1({sourceAdmission:store,claimExtraction:()=>undefined,completeExtraction:()=>{throw new Error('text must not use file completion');}},async()=>{throw new Error('text must not use decoder');},new SqlitePersonTextSourceInboxV1(db,()=>at),{on_failure:event=>observed.push(event)});
    expect(await worker.runOnce(new AbortController().signal)).toBe('admitted');
    expect(observed).toEqual([{stage:'text_source_admission',error_code:'invalid_retained_text'}]);
    expect(db.prepare('SELECT api_version,context_id,disposition,recorded_at FROM authority_person_text_source_failures_v1').all()).toEqual([{api_version:1,context_id:poisonId,disposition:'invalid_retained_text',recorded_at:at}]);
    expect(db.prepare('SELECT content_json FROM authority_source_contents_v1').pluck().all().join(' ')).toContain('valid shared body');
    expect(db.prepare('SELECT content_json FROM authority_source_contents_v1').pluck().all().join(' ')).not.toContain('poison body');
    expect(()=>db.prepare("INSERT INTO authority_person_text_source_failures_v1 VALUES ('org_fixture',1,'ctx_missing','invalid_retained_text',?)").run(at)).toThrow('must bind');
    expect(()=>db.prepare("INSERT INTO authority_person_text_source_failures_v1 VALUES ('org_fixture',2,?,'invalid_retained_text',?)").run(poisonId,at)).toThrow('must bind');
    expect(()=>db.prepare("UPDATE authority_person_text_source_failures_v1 SET disposition='invalid_retained_text'").run()).toThrow('immutable');
    expect(()=>db.prepare('DELETE FROM authority_person_text_source_failures_v1').run()).toThrow('denied');
  });
  it('rechecks private note eligibility atomically after pull and rejects forged policy bindings',async()=>{
    const {db}=fixture();
    const member='mem_11111111-1111-4111-8111-111111111111';
    db.prepare("INSERT INTO authority_principals VALUES ('prn_pm','org_fixture','PM',?)").run(at);
    db.prepare("INSERT INTO authority_memberships(membership_id,organization_id,principal_id,membership_type,status,provisioned_at) VALUES (?,'org_fixture','prn_pm','owner','active',?)").run(member,at);
    const request={schema_version:1,kind:'echo-person-update-submit-v1',request_id:'11111111-1111-4111-8111-111111111111',title:'Private note',text:'private evidence',visibility:'only_me'};
    const id=`ctx_${canonicalSha256({organization_id:'org_fixture',membership_id:member,request_id:request.request_id}).slice(7)}`;
    db.prepare("INSERT INTO authority_person_updates_v1 VALUES ('org_fixture','prn_pm',?,'owner',?,?,?,?,?,?,?)").run(member,request.request_id,id,canonicalSha256(request),request.title,request.text,request.visibility,at);
    const pulled=new SqlitePersonTextSourceInboxV1(db).next()!;
    const store=new SqliteSourceAdmissionStoreV1(db,(source,scope)=>assertPersonSourceAdmissionV1(db,source,scope));
    await expect(store.admitSourceRevision({...pulled,scope:{...pulled.scope,custody_ref:'organization:org_fixture'}})).rejects.toThrow('accepted custody');
    db.prepare("UPDATE authority_memberships SET status='revoked',revoked_at=?,revocation_reason='fixture' WHERE membership_id=?").run(at,member);
    await expect(store.admitSourceRevision(pulled)).rejects.toThrow('eligibility changed');
    expect(db.prepare('SELECT count(*) n FROM authority_sources_v1').get()).toEqual({n:0});
    expect(new SqlitePersonTextSourceInboxV1(db).next()).toBeUndefined();
  });
  it('admits Person originals and meeting content through the same port without storing document bytes in metadata',async()=>{
    const {db,store}=fixture(); const accepted=claim(); const person=new PersonSourceAdapterV1({claimExtraction:()=>accepted});
    const documents=await pullAndAdmitSourceBatchV1({source:person,request:{limit:1},admission:{store,scope:value=>person.scopeFor(value)}});
    expect(documents.admissions).toEqual(['admitted']); expect(person.claimFor(documents.sources[0]!)).toBe(accepted);
    const value=meeting();const source=new MeetingSourceBridgeV1({identity:value.provenance.source,validateConfig:()=>({ok:true,errors:[]}),healthCheck:async()=>({status:'healthy',checked_at:at}),pull:async()=>({meetings:[value],next_cursor:'next'})});
    await pullAndAdmitSourceBatchV1({source,request:{limit:1},admission:{store,scope:{organization_id:'org_fixture',custody_ref:'organization:org_fixture',access_policy_ref:'meeting-admission:fixture',analysis_policy:'automatic'}}});
    expect(db.prepare('SELECT adapter_id,analysis_policy FROM authority_sources_v1 ORDER BY adapter_id').all()).toEqual([{adapter_id:'meeting',analysis_policy:'automatic'},{adapter_id:'person',analysis_policy:'on_request'}]);
    const contents=db.prepare('SELECT content_json FROM authority_source_contents_v1').pluck().all() as string[];
    expect(contents.join(' ')).toContain('Hardware needs a software interface.');
    expect(contents.join(' ')).not.toContain('MRD hardware handoff');
    expect(db.prepare('SELECT count(*) n FROM authority_live_source_candidates_v2').get()).toEqual({n:0});
  });
  it('deduplicates observation retries and rejects same-revision changed content or custody',async()=>{
    const {db,store}=fixture();const accepted=claim();const source=personDocumentSourceEnvelopeV1(accepted);const scope=accepted.source_scope;
    expect(await store.admitSourceRevision({scope,source})).toBe('admitted');
    expect(await store.admitSourceRevision({scope,source:{...source,revision:{...source.revision,captured_at:'2026-09-23T01:00:00.000Z'}}})).toBe('duplicate');
    const content={...source.content,filename:'changed.md'};
    await expect(store.admitSourceRevision({scope,source:{...source,content,revision:{...source.revision,content_sha256:sourceContentSha256V1(content)}}})).rejects.toThrow('conflicts');
    await expect(store.admitSourceRevision({scope:{...scope,custody_ref:'project:other'},source})).rejects.toThrow('custody conflict');
    expect(db.prepare('SELECT count(*) n FROM authority_source_revisions_v1').get()).toEqual({n:1});
    expect(()=>db.prepare('UPDATE authority_source_contents_v1 SET content_json=?').run('{}')).toThrow('immutable');
  });
  it('retains richer representations without changing source identity or original revision',()=>{
    const {db,store}=fixture();const accepted=claim();const source=personDocumentSourceEnvelopeV1(accepted);
    store.admit({scope:accepted.source_scope,source});
    const before=db.prepare('SELECT * FROM authority_sources_v1').all();
    const input={organization_id:accepted.source_scope.organization_id,source_id:source.item.source_id,revision_id:source.revision.revision_id};
    const first=store.recordRepresentation({...input,processor_version:'extractor-1',content:{text:'requirements'}});
    expect(store.recordRepresentation({...input,processor_version:'extractor-1',content:{text:'requirements'}})).toBe(first);
    const richer=store.recordRepresentation({...input,processor_version:'extractor-2',content:{text:'requirements',sections:['hardware']}});
    expect(richer).not.toBe(first);expect(db.prepare('SELECT count(*) n FROM authority_source_representations_v1').get()).toEqual({n:2});
    expect(db.prepare('SELECT * FROM authority_sources_v1').all()).toEqual(before);
    expect(db.prepare('SELECT count(*) n FROM authority_source_revisions_v1').get()).toEqual({n:1});
    expect(()=>db.prepare('DELETE FROM authority_source_representations_v1').run()).toThrow('immutable');
  });
  it('runs authorization guard inside admission transaction and retains nothing after revocation',async()=>{
    const {db}=fixture();let active=true;
    const store=new SqliteSourceAdmissionStoreV1(db,()=>{expect(db.inTransaction).toBe(true);if(!active)throw new Error('admission revoked');});
    const accepted=claim();const person=new PersonSourceAdapterV1({claimExtraction:()=>{active=false;return accepted;}});
    await expect(pullAndAdmitSourceBatchV1({source:person,request:{limit:1},admission:{store,scope:value=>person.scopeFor(value)}})).rejects.toThrow('revoked');
    expect(db.prepare('SELECT count(*) n FROM authority_sources_v1').get()).toEqual({n:0});
    expect(db.prepare('SELECT count(*) n FROM authority_source_contents_v1').get()).toEqual({n:0});
  });
  it('rolls source identity back if durable content persistence fails',()=>{
    const {db,store}=fixture();const accepted=claim();
    db.exec("CREATE TRIGGER fail_content BEFORE INSERT ON authority_source_contents_v1 BEGIN SELECT RAISE(ABORT,'content storage unavailable'); END;");
    expect(()=>store.admit({scope:accepted.source_scope,source:personDocumentSourceEnvelopeV1(accepted)})).toThrow('storage unavailable');
    expect(db.prepare('SELECT count(*) n FROM authority_sources_v1').get()).toEqual({n:0});
    expect(db.prepare('SELECT count(*) n FROM authority_source_revisions_v1').get()).toEqual({n:0});
  });
});
