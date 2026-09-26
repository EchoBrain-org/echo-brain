import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { canonicalSha256, sha256Digest } from '@echo-brain/federation-protocol';
import { validatePersonDocumentMetadataV1, validatePersonDocumentTextV1, validatePersonDocumentSearchResultV1, type PersonDocumentUploadMetadataV1 } from '@echo-brain/organization-api';
import { SqlitePersonDocumentRepositoryV1 } from '../src/adapters/persistence/sqlite/document-v1.js';
import { createPersonDocumentApplicationV1 } from '../src/application/document-v1.js';
import { extractDocument } from '../src/adapters/documents/document-extraction.js';
import { SqliteProjectContextRepositoryV1 } from '../src/adapters/persistence/sqlite/project-context-v1.js';
import { createProjectContextApplicationV1 } from '../src/application/project-context-application-v1.js';
import { OWNER, MEMBER, RETURNED_MEMBER, PROJECT_ALPHA, PROJECT_BETA, PROJECT_CONTEXT_NOW, addMembership, authorization, insertLegacyTextV1, revokeMembership } from './fixtures/project-context-sqlite.js';
import type { AuthorityPersonMembershipBinding } from '@echo-brain/organization-authority-kernel/application/ports/authority-repository';
const databases: Database.Database[]=[];
afterEach(()=>databases.splice(0).forEach(d=>d.close()));
function setup(){
 const db=new Database(':memory:');databases.push(db);db.pragma('foreign_keys=ON');db.exec(readFileSync(new URL('../../../packages/organization-authority-kernel/baselines/authority-baseline-v9.sql',import.meta.url),'utf8'));
 db.prepare(`INSERT INTO authority_metadata(singleton,authority_id,organization_id,organization_display_name,descriptor_json,created_at,last_observed_at) VALUES (1,'oau_documents',?,'Document fixture','{}',?,?)`).run(OWNER.organization_id,PROJECT_CONTEXT_NOW,PROJECT_CONTEXT_NOW);
 db.prepare(`INSERT INTO authority_project_authorization_state_v1(organization_id,revision,updated_at) VALUES (?,0,?)`).run(OWNER.organization_id,PROJECT_CONTEXT_NOW);
 addMembership(db,OWNER,'Owner',null);addMembership(db,MEMBER,'Member','member@example.test');
 for(const project of [PROJECT_ALPHA,PROJECT_BETA]){db.prepare(`INSERT INTO authority_projects_v1(project_id,organization_id,name,created_at,creator_principal_id,creator_membership_id,creator_membership_type) VALUES (?,?,?,?,?,?,?)`).run(project,OWNER.organization_id,project,PROJECT_CONTEXT_NOW,OWNER.principal_id,OWNER.membership_id,OWNER.membership_type);grant(db,project,OWNER);}
 grant(db,PROJECT_ALPHA,MEMBER);
 let time=PROJECT_CONTEXT_NOW;
 const repository=new SqlitePersonDocumentRepositoryV1(db,()=>time);
 const app=createPersonDocumentApplicationV1({repository,authenticate:token=>authorization(token==='member'?MEMBER:token==='returned'?RETURNED_MEMBER:OWNER)});
 return {db,repository,app,setTime:(value:string)=>{time=value;}};
}
function grant(db:Database.Database,project:string,actor:AuthorityPersonMembershipBinding){db.prepare(`INSERT INTO authority_project_memberships_v1(project_membership_id,project_id,organization_id,principal_id,membership_id,membership_type,role,status,granted_at) VALUES (?,?,?,?,?,?,?,'active',?)`).run(`pgm_${randomUUID()}`,project,actor.organization_id,actor.principal_id,actor.membership_id,actor.membership_type,actor===OWNER?'lead':'member',PROJECT_CONTEXT_NOW);}
function input(bytes:Uint8Array,changes:Partial<PersonDocumentUploadMetadataV1>={}):PersonDocumentUploadMetadataV1{return {schema_version:1,kind:'echo-person-document-upload-v1',request_id:randomUUID(),filename:'SCOUT-PRD.md',title:'SCOUT product requirements',content_length:bytes.byteLength,sha256:sha256Digest(bytes),audience:{kind:'team'},project_id:PROJECT_ALPHA,...changes};}
function search(project_id:typeof PROJECT_ALPHA|null=null,query=''){return {schema_version:1,kind:'echo-person-document-search-v1',project_id,query,limit:20,cursor:null};}
function result(claim:{source_sha256:string},text:string){return {status:'ready' as const,sourceSha256:claim.source_sha256,extractorVersion:'fixture-1',chunks:[{anchor_kind:'paragraph' as const,anchor_start:1,text}],message:null};}
describe('Document custody and retrieval V1',()=>{
 it('retains an ordinary >8KiB PRD, exact download, immutable receipt replay and paged end-of-document search',()=>{
  const {app,repository,db}=setup();const bytes=Buffer.from('SCOUT requirement '.repeat(1600)+'terminal-needle');const request=input(bytes);const receipt=app.upload('owner',request,bytes);
  expect(app.upload('owner',request,bytes)).toEqual(receipt);expect(app.original('member',receipt.document_id).bytes).toEqual(bytes);
  const claim=repository.claimExtraction()!;expect(claim.bytes).toEqual(bytes);const text=bytes.toString(),chunks=Array.from({length:Math.ceil(text.length/3072)},(_,index)=>({anchor_kind:'paragraph' as const,anchor_start:index+1,text:text.slice(index*3072,(index+1)*3072)}));expect(repository.completeExtraction(claim,{...result(claim,'x'),chunks})).toBe(true);
  const page=validatePersonDocumentTextV1(app.text('member',receipt.document_id));expect(page.next_cursor).not.toBeNull();let cursor=page.next_cursor,remaining='';while(cursor!==null){const next=app.text('member',receipt.document_id,{cursor});remaining+=next.chunks.map(c=>c.text).join('');cursor=next.next_cursor;}expect(remaining).toContain('terminal-needle');
  const found=validatePersonDocumentSearchResultV1(app.search('member',search(PROJECT_ALPHA,'terminal-needle')));expect(found.documents[0]?.document_id).toBe(receipt.document_id);expect(found.documents[0]?.anchor).toEqual({kind:'paragraph',start:chunks.length});expect(app.upload('owner',request,bytes)).toEqual(receipt);
  expect(()=>app.upload('owner',{...request,title:'changed'},bytes)).toThrow(expect.objectContaining({code:'conflict'}));
  const audit=db.prepare(`SELECT body_json FROM authority_person_document_read_audit_v1`).all() as {body_json:string}[];expect(audit.length).toBeGreaterThan(3);expect(audit.every(x=>!x.body_json.includes('terminal-needle')&&!x.body_json.includes('SCOUT requirement'))).toBe(true);
 });
 it('filters private/project audiences before search and treats association independently',()=>{
  const {app}=setup();const bytes=Buffer.from('private needle');
  const privateDoc=app.upload('owner',input(bytes,{audience:{kind:'only_me'}}),bytes);
  const hidden=app.upload('owner',input(bytes,{audience:{kind:'project',project_id:PROJECT_BETA},project_id:PROJECT_ALPHA}),bytes);
  const team=app.upload('owner',input(bytes,{project_id:PROJECT_BETA}),bytes);
  expect(()=>app.read('member',privateDoc.document_id)).toThrow(expect.objectContaining({code:'not_found'}));expect(()=>app.original('member',hidden.document_id)).toThrow(expect.objectContaining({code:'not_found'}));
  expect(app.search('member',search(PROJECT_ALPHA)).documents).toEqual([]);expect(app.search('member',search()).documents.map(x=>x.document_id)).toEqual([team.document_id]);expect(app.read('member',team.document_id).project_id).toBeNull();
  expect(()=>app.search('member',{...search(),project_id:PROJECT_BETA})).toThrow(expect.objectContaining({code:'not_found'}));
 });
 it('requires exact active tenure and current project grants, including before upload commit',()=>{
  const {app,repository,db}=setup();const bytes=Buffer.from('tenure');const doc=app.upload('member',input(bytes,{audience:{kind:'only_me'}}),bytes);
  revokeMembership(db,MEMBER);addMembership(db,RETURNED_MEMBER,'Returned','member@example.test');expect(()=>app.read('member',doc.document_id)).toThrow(expect.objectContaining({code:'unauthorized'}));expect(()=>app.read('returned',doc.document_id)).toThrow(expect.objectContaining({code:'not_found'}));
  const before=(db.prepare('SELECT count(*) n FROM authority_person_documents_v1').get() as {n:number}).n;
  expect(()=>repository.upload(authorization(OWNER),input(bytes),bytes,()=>authorization(OWNER,{session_state_sha256:canonicalSha256('revoked')}))).toThrow(expect.objectContaining({code:'stale_access_state'}));expect((db.prepare('SELECT count(*) n FROM authority_person_documents_v1').get() as {n:number}).n).toBe(before);
 });
 it('cancels release and its audit atomically if session or membership changes after selection',()=>{
  const {app,repository,db}=setup();const bytes=Buffer.from('audit release');const doc=app.upload('owner',input(bytes),bytes);
  expect(()=>repository.read(authorization(MEMBER),{operation:'original',document_id:doc.document_id},()=>authorization(MEMBER,{person_state_sha256:canonicalSha256('changed')}))).toThrow(expect.objectContaining({code:'stale_access_state'}));
  expect(db.prepare('SELECT count(*) n FROM authority_person_document_read_audit_v1').get()).toEqual({n:0});
  db.exec(`CREATE TRIGGER fail_document_audit BEFORE INSERT ON authority_person_document_read_audit_v1 BEGIN SELECT RAISE(ABORT,'audit unavailable'); END;`);expect(()=>app.read('member',doc.document_id)).toThrow('audit unavailable');
 });
 it('uses the monotonic authorization revision to reject an association change during release',()=>{
  const {app,repository,db}=setup();const bytes=Buffer.from('revision fence');const doc=app.upload('owner',input(bytes,{project_id:null}),bytes);
  expect(()=>repository.read(authorization(MEMBER),{operation:'original',document_id:doc.document_id},()=>{
   db.prepare(`INSERT INTO authority_person_document_associations_v1(document_id,project_id,organization_id,associated_at) VALUES (?,?,?,?)`).run(doc.document_id,PROJECT_ALPHA,OWNER.organization_id,PROJECT_CONTEXT_NOW);
   return authorization(MEMBER);
  })).toThrow(expect.objectContaining({code:'stale_access_state'}));
  expect(db.prepare('SELECT count(*) n FROM authority_person_document_associations_v1 WHERE document_id=?').get(doc.document_id)).toEqual({n:0});
  expect(db.prepare('SELECT count(*) n FROM authority_person_document_read_audit_v1').get()).toEqual({n:0});
 });
 it('keeps originals for explicit extraction failures and only permits the current lease to finish',()=>{
  const {app,repository,setTime}=setup();const bytes=Buffer.from('%PDF-not-valid');const doc=app.upload('owner',input(bytes,{filename:'scan.pdf'}),bytes);const old=repository.claimExtraction()!;expect(repository.claimExtraction()).toBeUndefined();
  setTime('2026-09-21T22:02:01.000Z');const fresh=repository.claimExtraction()!;expect(fresh.lease_token).not.toBe(old.lease_token);expect(repository.completeExtraction(old,{...result(old,'text')})).toBe(false);
  expect(repository.completeExtraction(fresh,{...result(fresh,'text'),status:'malformed',chunks:[],message:'Invalid PDF'})).toBe(true);expect(validatePersonDocumentMetadataV1(app.read('owner',doc.document_id)).extraction_state).toBe('malformed');expect(app.original('owner',doc.document_id).bytes).toEqual(bytes);expect(app.text('owner',doc.document_id).chunks).toEqual([]);
 });
 it('continues project-owned extraction after uploader removal and releases history to new exact-tenure members',()=>{
  const {app,repository,db}=setup();const bytes=Buffer.from('claim content');const doc=app.upload('member',input(bytes,{audience:{kind:'project',project_id:PROJECT_ALPHA}}),bytes);const claim=repository.claimExtraction()!;
  db.prepare(`UPDATE authority_project_memberships_v1 SET status='revoked',revoked_at=? WHERE membership_id=? AND project_id=?`).run(PROJECT_CONTEXT_NOW,MEMBER.membership_id,PROJECT_ALPHA);
  revokeMembership(db,MEMBER);addMembership(db,RETURNED_MEMBER,'Returned','member@example.test');
  expect(repository.completeExtraction(claim,result(claim,'historical-hardware'))).toBe(true);expect(app.read('owner',doc.document_id).extraction_state).toBe('ready');expect(app.original('owner',doc.document_id).bytes).toEqual(bytes);
  expect(()=>app.text('returned',doc.document_id)).toThrow(expect.objectContaining({code:'not_found'}));grant(db,PROJECT_ALPHA,RETURNED_MEMBER);
  expect(app.text('returned',doc.document_id,{project_id:PROJECT_ALPHA}).chunks[0]?.text).toBe('historical-hardware');expect(app.original('returned',doc.document_id,{project_id:PROJECT_ALPHA}).bytes).toEqual(bytes);expect(app.search('returned',search(PROJECT_ALPHA,'historical-hardware')).documents[0]?.document_id).toBe(doc.document_id);
  expect(()=>app.read('member',doc.document_id)).toThrow(expect.objectContaining({code:'unauthorized'}));
 });
 it('claims pending project content after uploader departure while keeping associated private content private',()=>{
  const {app,repository,db}=setup();const bytes=Buffer.from('pending project');const shared=app.upload('member',input(bytes,{audience:{kind:'project',project_id:PROJECT_ALPHA}}),bytes);
  revokeMembership(db,MEMBER);const claim=repository.claimExtraction();expect(claim?.document_id).toBe(shared.document_id);expect(repository.completeExtraction(claim!,result(claim!,'pending history'))).toBe(true);expect(app.text('owner',shared.document_id).chunks[0]?.text).toBe('pending history');
  const privateDoc=app.upload('owner',input(bytes,{audience:{kind:'only_me'}}),bytes);const privateClaim=repository.claimExtraction()!;expect(repository.completeExtraction(privateClaim,result(privateClaim,'private history'))).toBe(true);
  addMembership(db,RETURNED_MEMBER,'Returned','member@example.test');grant(db,PROJECT_ALPHA,RETURNED_MEMBER);expect(()=>app.original('returned',privateDoc.document_id)).toThrow(expect.objectContaining({code:'not_found'}));
 });
 it('recovers only an own minimal receipt and exact replay after losing project access',()=>{
  const {app,db}=setup();const bytes=Buffer.from('restricted body');const request=input(bytes,{audience:{kind:'project',project_id:PROJECT_ALPHA}});const saved=app.upload('member',request,bytes);
  db.prepare(`UPDATE authority_project_memberships_v1 SET status='revoked',revoked_at=? WHERE membership_id=? AND project_id=?`).run(PROJECT_CONTEXT_NOW,MEMBER.membership_id,PROJECT_ALPHA);
  const minimal={schema_version:1,kind:'echo-person-document-saved-v1',request_id:request.request_id,document_id:saved.document_id,received_at:saved.received_at,state:'saved'};
  expect(app.status('member',request.request_id)).toEqual(minimal);expect(()=>app.preflight('member',request)).not.toThrow();expect(app.upload('member',request,bytes)).toEqual(minimal);
  expect(()=>app.upload('member',{...request,title:'different'},bytes)).toThrow(expect.objectContaining({code:'conflict'}));expect(()=>app.read('member',saved.document_id)).toThrow(expect.objectContaining({code:'not_found'}));expect(()=>app.status('owner',request.request_id)).toThrow(expect.objectContaining({code:'not_found'}));
  revokeMembership(db,MEMBER);addMembership(db,RETURNED_MEMBER,'Returned','member@example.test');expect(()=>app.status('returned',request.request_id)).toThrow(expect.objectContaining({code:'not_found'}));
 });
 it('uses one request namespace across document and project operations in both directions and against retained legacy text',()=>{
  const {app,db}=setup();const projects=createProjectContextApplicationV1({authenticate:()=>authorization(OWNER),repository:new SqliteProjectContextRepositoryV1(db,()=>PROJECT_CONTEXT_NOW)});const bytes=Buffer.from('namespace');
  const create=(request_id:string)=>projects.createProject('owner',{schema_version:1,kind:'echo-project-create-v1',request_id,name:'Namespace project'});
  const text=(request_id:string)=>insertLegacyTextV1(db,OWNER,{request_id,title:'Text',text:'text',visibility:'team'});
  const priorProject=randomUUID();create(priorProject);expect(()=>app.upload('owner',input(bytes,{request_id:priorProject}),bytes)).toThrow(expect.objectContaining({code:'conflict'}));
  const priorDocument=randomUUID();app.upload('owner',input(bytes,{request_id:priorDocument}),bytes);expect(()=>create(priorDocument)).toThrow(expect.objectContaining({code:'conflict'}));
  const priorText=randomUUID();text(priorText);expect(()=>app.upload('owner',input(bytes,{request_id:priorText}),bytes)).toThrow(expect.objectContaining({code:'conflict'}));
 });
 it('continues keyset search without repeats after newer inserts and with deterministic equal-time ties',()=>{
  const {app,setTime}=setup();const bytes=Buffer.from('navigation');const first=app.upload('owner',input(bytes,{title:'A'}),bytes);setTime('2026-09-21T22:02:00.000Z');const second=app.upload('owner',input(bytes,{title:'B'}),bytes);
  const query={...search(),limit:1};const page=app.search('member',query);expect(page.documents[0]?.document_id).toBe(second.document_id);setTime('2026-09-21T22:03:00.000Z');app.upload('owner',input(bytes,{title:'C'}),bytes);
  const next=app.search('member',{...query,cursor:page.next_cursor});expect(next.documents.map(x=>x.document_id)).toEqual([first.document_id]);expect(next.next_cursor).toBeNull();
  const peer=app.upload('owner',input(bytes,{title:'D'}),bytes);const all:string[]=[];let cursor:string|null=null;do{const p=app.search('member',{...query,cursor});all.push(...p.documents.map(x=>x.document_id));cursor=p.next_cursor;}while(cursor);expect(new Set(all).size).toBe(4);expect(all).toContain(peer.document_id);
  expect(()=>app.search('member',{...query,query:'changed',cursor:page.next_cursor})).toThrow(expect.objectContaining({code:'invalid_request'}));
 });
 it('matches Unicode titles before extraction with canonical query normalization and current audience filtering',()=>{
  const {app,db}=setup();const bytes=Buffer.from('The body has no title words.');
  const title='ÉCOLE – ПЛАН – 硬件';const shared=app.upload('owner',input(bytes,{title}),bytes);
  app.upload('owner',input(bytes,{title,audience:{kind:'only_me'}}),bytes);
  for(const query of ['ÉCOLE','école','E\u0301COLE','ПЛАН','план','硬件','e\u0301cole – план']){
   const found=app.search('member',search(PROJECT_ALPHA,query));expect(found.documents.map(document=>document.document_id)).toEqual([shared.document_id]);expect(found.documents[0]?.extraction_state).toBe('extracting');
  }
  const cafe=app.upload('owner',input(bytes,{title:'CAFÉ'}),bytes);
  for(const query of ['CAFÉ','café','cafe\u0301'])expect(app.search('member',search(PROJECT_ALPHA,query)).documents.map(document=>document.document_id)).toEqual([cafe.document_id]);
  expect(db.prepare('SELECT count(*) n FROM authority_person_document_text_v1').get()).toEqual({n:0});
 });
 it('filters Unicode title matches before keyset paging while newer matches are inserted',()=>{
  const {app,setTime}=setup();const bytes=Buffer.from('No matching title in body');const first=app.upload('owner',input(bytes,{title:'ПЛАН hardware'}),bytes);
  setTime('2026-09-21T22:02:00.000Z');const second=app.upload('owner',input(bytes,{title:'ПЛАН software'}),bytes);
  setTime('2026-09-21T22:03:00.000Z');app.upload('owner',input(bytes,{title:'Unrelated document'}),bytes);
  const query={...search(PROJECT_ALPHA,'план'),limit:1};const page=app.search('member',query);expect(page.documents.map(document=>document.document_id)).toEqual([second.document_id]);
  setTime('2026-09-21T22:04:00.000Z');app.upload('owner',input(bytes,{title:'ПЛАН QA'}),bytes);
  const next=app.search('member',{...query,cursor:page.next_cursor});expect(next.documents.map(document=>document.document_id)).toEqual([first.document_id]);expect(next.next_cursor).toBeNull();
 });
 it('retries transient extraction with bounded backoff without publishing failed-attempt content',()=>{
  const {app,repository,setTime,db}=setup();const bytes=Buffer.from('retry original');const doc=app.upload('owner',input(bytes),bytes);const first=repository.claimExtraction()!;
  expect(repository.completeExtraction(first,{...result(first,''),status:'unavailable',chunks:[],message:'Temporary parser failure'})).toBe(true);expect(app.read('owner',doc.document_id).extraction_state).toBe('extracting');expect(repository.claimExtraction()).toBeUndefined();expect(db.prepare('SELECT count(*) n FROM authority_person_document_text_v1').get()).toEqual({n:0});
  setTime('2026-09-21T22:02:01.000Z');const second=repository.claimExtraction()!;expect(second.lease_token).not.toBe(first.lease_token);expect(repository.completeExtraction(first,result(first,'stale'))).toBe(false);expect(repository.completeExtraction(second,result(second,'recovered content'))).toBe(true);expect(app.text('owner',doc.document_id).chunks[0]?.text).toBe('recovered content');expect(app.original('owner',doc.document_id).bytes).toEqual(bytes);
 });
 it('keeps shared team processing independent of departed contributor but cancels private work',()=>{
  const {app,repository,db}=setup();const bytes=Buffer.from('scope');const team=app.upload('member',input(bytes,{audience:{kind:'team'}}),bytes);const privateDoc=app.upload('member',input(bytes,{audience:{kind:'only_me'}}),bytes);
  revokeMembership(db,MEMBER);
  let sharedClaim=repository.claimExtraction();if(!sharedClaim)sharedClaim=repository.claimExtraction();expect(sharedClaim?.document_id).toBe(team.document_id);expect(repository.completeExtraction(sharedClaim!,result(sharedClaim!,'retained team'))).toBe(true);
  repository.claimExtraction();expect(app.read('owner',team.document_id).extraction_state).toBe('ready');expect(db.prepare('SELECT extraction_state FROM authority_person_document_work_v1 WHERE document_id=?').get(privateDoc.document_id)).toEqual({extraction_state:'unavailable'});expect(()=>app.read('owner',privateDoc.document_id)).toThrow(expect.objectContaining({code:'not_found'}));
 });
 it('caps transient retries and never overwrites terminal extracted evidence',()=>{
  const {app,repository,setTime,db}=setup();const bytes=Buffer.from('bounded retries');const doc=app.upload('owner',input(bytes),bytes);let finalClaim;
  for(let attempt=0;attempt<3;attempt++){setTime(`2026-09-21T22:0${attempt+1}:00.000Z`);const claim=repository.claimExtraction()!;expect(claim).toBeDefined();expect(repository.completeExtraction(claim,{...result(claim,''),status:'timed_out',chunks:[],message:'Timeout'})).toBe(true);finalClaim=claim;}
  expect(app.read('owner',doc.document_id)).toMatchObject({extraction_state:'timed_out',extraction_detail:'Extraction timed out after 3 attempts'});expect(repository.claimExtraction()).toBeUndefined();expect(repository.completeExtraction(finalClaim!,result(finalClaim!,'late rewrite'))).toBe(false);expect(app.text('owner',doc.document_id).chunks).toEqual([]);expect(db.prepare('SELECT count(*) n FROM authority_source_representations_v1').get()).toEqual({n:1});
 });
 it('atomically retains source revision and representation and rebuilds provenance from verified custody',()=>{
  const {app,repository,db}=setup();const bytes=Buffer.from('atomic representation');const doc=app.upload('owner',input(bytes,{audience:{kind:'project',project_id:PROJECT_ALPHA}}),bytes);const claim=repository.claimExtraction()!;
  db.exec(`CREATE TRIGGER fail_representation BEFORE INSERT ON authority_source_representations_v1 BEGIN SELECT RAISE(ABORT,'representation unavailable'); END;`);
  expect(()=>repository.completeExtraction(claim,result(claim,'derived'))).toThrow('representation unavailable');expect(db.prepare('SELECT count(*) n FROM authority_person_document_text_v1').get()).toEqual({n:0});expect(db.prepare('SELECT count(*) n FROM authority_sources_v1').get()).toEqual({n:0});expect(app.read('owner',doc.document_id).extraction_state).toBe('extracting');
  db.exec('DROP TRIGGER fail_representation');expect(repository.completeExtraction({...claim,source_scope:{...claim.source_scope,custody_ref:'membership:forged'},contributor:{principal_id:'forged',membership_id:'forged'}},result(claim,'derived'))).toBe(true);
  expect(db.prepare('SELECT custody_ref FROM authority_sources_v1').get()).toEqual({custody_ref:`project:${PROJECT_ALPHA}`});const retained=db.prepare('SELECT manifest_json FROM authority_source_revisions_v1').get() as {manifest_json:string};expect(JSON.parse(retained.manifest_json).contributor).toEqual({principal_id:OWNER.principal_id,membership_id:OWNER.membership_id});expect(db.prepare('SELECT count(*) n FROM authority_source_representations_v1').get()).toEqual({n:1});
 });
 it('does not trust declared size/digest and enforces exact original byte limit',()=>{
  const {app}=setup();const bytes=Buffer.from('bytes');expect(()=>app.upload('owner',{...input(bytes),content_length:6},bytes)).toThrow(expect.objectContaining({code:'invalid_request'}));expect(()=>app.upload('owner',{...input(bytes),sha256:canonicalSha256('other')},bytes)).toThrow(expect.objectContaining({code:'invalid_request'}));
  const boundary=Buffer.alloc(25*1024*1024,0x61);const request=input(boundary);const doc=app.upload('owner',request,boundary);expect(app.original('owner',doc.document_id).metadata.content_length).toBe(boundary.length);
  const over=Buffer.alloc(boundary.length+1,0x61);expect(()=>app.upload('owner',{...request,request_id:randomUUID(),content_length:over.length},over)).toThrow(expect.objectContaining({code:'invalid_request'}));
 });
 it('atomically rolls back original, receipt, work and association when any admission write fails',()=>{
  const {app,db}=setup();db.exec(`CREATE TRIGGER fail_document_receipt BEFORE INSERT ON authority_person_document_receipts_v1 BEGIN SELECT RAISE(ABORT,'receipt unavailable'); END;`);const bytes=Buffer.from('atomic');expect(()=>app.upload('owner',input(bytes),bytes)).toThrow('receipt unavailable');
  for(const table of ['authority_person_documents_v1','authority_person_document_originals_v1','authority_person_document_work_v1','authority_person_document_associations_v1'])expect(db.prepare(`SELECT count(*) n FROM ${table}`).get()).toEqual({n:0});
 });
 it('enforces count quota while replay remains permitted',()=>{
  const {app}=setup();const bytes=Buffer.from('count');const request=input(bytes);const first=app.upload('owner',request,bytes);for(let n=1;n<100;n++)app.upload('owner',input(bytes),bytes);expect(()=>app.upload('owner',input(bytes),bytes)).toThrow(expect.objectContaining({code:'quota_exceeded'}));expect(app.upload('owner',request,bytes)).toEqual(first);
 });
 it('enforces document-only byte quota while retaining the shared note/document count cap',()=>{
  const {app,db}=setup();const bytes=Buffer.alloc(25*1024*1024,0x61);for(let n=0;n<10;n++)app.upload('owner',input(bytes),bytes);
  expect(()=>app.upload('owner',input(Buffer.from('x')),Buffer.from('x'))).toThrow(expect.objectContaining({code:'quota_exceeded'}));
  insertLegacyTextV1(db,OWNER,{request_id:randomUUID(),title:'Legacy',text:'x',visibility:'team'});
  const projects=createProjectContextApplicationV1({authenticate:()=>authorization(OWNER),repository:new SqliteProjectContextRepositoryV1(db,()=>PROJECT_CONTEXT_NOW)});expect(projects.submitUpload('owner',{schema_version:2,kind:'echo-person-update-submit-v2',request_id:randomUUID(),title:'Project note',text:'x',audience:{kind:'team'},project_id:null})).toMatchObject({state:'received'});
  expect(db.prepare('SELECT count(*) n FROM authority_person_documents_v1').get()).toEqual({n:10});
 });
 it('preserves ordinary words across defensive text chunk boundaries',()=>{
  const {app,repository}=setup();const bytes=Buffer.from('word boundary source');const doc=app.upload('owner',input(bytes),bytes);const claim=repository.claimExtraction()!;const first='a '.repeat(1532),second='a '.repeat(2)+'hardware',text=first+second;repository.completeExtraction(claim,{...result(claim,first),chunks:[{anchor_kind:'paragraph',anchor_start:1,text:first},{anchor_kind:'paragraph',anchor_start:2,text:second}]});
  const found=app.search('member',search(PROJECT_ALPHA,'hardware'));expect(found.documents[0]?.document_id).toBe(doc.document_id);expect(app.text('member',doc.document_id).chunks.map(c=>c.text).join('')).toBe(text);
 });
 it('indexes the tail of 5,000 packed hard-wrapped lines and keeps the phrase in one searchable chunk',async()=>{
  const {app,repository}=setup();const bytes=Buffer.from(Array.from({length:5000},(_,index)=>index===4999?'tail-marker':'hardware\nrequirements').join('\n'));const doc=app.upload('owner',input(bytes),bytes);const claim=repository.claimExtraction()!;
  const extracted=await extractDocument({bytes,filename:'wrapped.md',sourceSha256:claim.source_sha256});expect(extracted.status).toBe('ready');expect(repository.completeExtraction(claim,extracted)).toBe(true);
  expect(app.search('member',search(PROJECT_ALPHA,'hardware requirements')).documents.map(value=>value.document_id)).toContain(doc.document_id);
  expect(app.search('member',search(PROJECT_ALPHA,'tail-marker')).documents.map(value=>value.document_id)).toContain(doc.document_id);
 });
 it('forms search excerpts at Unicode scalar boundaries',()=>{
  const {app,repository}=setup();const bytes=Buffer.from('unicode source');const doc=app.upload('owner',input(bytes),bytes);const claim=repository.claimExtraction()!;const text='😀'+'x'.repeat(78)+' needle';repository.completeExtraction(claim,result(claim,text));
  const found=validatePersonDocumentSearchResultV1(app.search('member',search(PROJECT_ALPHA,'needle')));expect(found.documents[0]?.document_id).toBe(doc.document_id);expect(found.documents[0]?.excerpt).toBe(text);
 });
 it('paginates escaped/control text within serialized wire bounds without dropping content',()=>{
  const {app,repository}=setup();const bytes=Buffer.from('bounded text');const receipt=app.upload('owner',input(bytes),bytes);const claim=repository.claimExtraction()!;const text='\u0001'.repeat(8000)+'😀ending';repository.completeExtraction(claim,{...result(claim,text.slice(0,3072)),chunks:[{anchor_kind:'paragraph',anchor_start:1,text:text.slice(0,3072)},{anchor_kind:'paragraph',anchor_start:2,text:text.slice(3072,6144)},{anchor_kind:'paragraph',anchor_start:3,text:text.slice(6144)}]});
  let cursor:string|null=null;let all='';do{const page=validatePersonDocumentTextV1(app.text('owner',receipt.document_id,{cursor}));expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(24*1024);all+=page.chunks.map(c=>c.text).join('');cursor=page.next_cursor;}while(cursor);expect(all).toBe(text);
 });
});
