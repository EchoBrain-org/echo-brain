import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { canonicalSha256, sha256Digest } from '@echo-brain/federation-protocol';
import { validatePersonDocumentMetadataV2, validatePersonDocumentSearchResultV2, type PersonDocumentUploadMetadataV2 } from '@echo-brain/organization-api';
import { SqlitePersonDocumentRepositoryV1 } from '../src/adapters/persistence/sqlite/document-v1.js';
import { SqlitePersonOriginalItemsV1 } from '../src/adapters/persistence/sqlite/person-original-items-v1.js';
import { createPersonDocumentApplicationV1 } from '../src/application/document-v1.js';
import { extractDocument } from '../src/adapters/documents/document-extraction.js';
import { SqliteProjectContextRepositoryV1 } from '../src/adapters/persistence/sqlite/project-context-v1.js';
import { createProjectContextApplicationV1 } from '../src/application/project-context-application-v1.js';
import { OWNER, MEMBER, RETURNED_MEMBER, PROJECT_ALPHA, PROJECT_BETA, PROJECT_CONTEXT_NOW, addMembership, authorization, insertStoredDocumentV1, projectContextDatabase, revokeMembership, seedProject, seedProjectMember } from './fixtures/project-context-sqlite.js';
import type { AuthorityPersonMembershipBinding } from '@echo-brain/organization-authority-kernel/application/ports/authority-repository';
const databases: Database.Database[]=[];
afterEach(()=>databases.splice(0).forEach(d=>d.close()));
function setup(){
 const db=projectContextDatabase();databases.push(db);
 for(const project of [PROJECT_ALPHA,PROJECT_BETA]){seedProject(db,project,OWNER);grant(db,project,OWNER);}
 grant(db,PROJECT_ALPHA,MEMBER);
 let time=PROJECT_CONTEXT_NOW;
 const repository=new SqlitePersonDocumentRepositoryV1(db,()=>time);
 const app=createPersonDocumentApplicationV1({repository,authenticate:token=>authorization(token==='member'?MEMBER:token==='returned'?RETURNED_MEMBER:OWNER)});
 return {db,repository,app,setTime:(value:string)=>{time=value;}};
}
function grant(db:Database.Database,project:string,actor:AuthorityPersonMembershipBinding){seedProjectMember(db,project,actor,actor===OWNER?'lead':'member');}
function input(bytes:Uint8Array,changes:Partial<PersonDocumentUploadMetadataV2>={}):PersonDocumentUploadMetadataV2{return {schema_version:2,kind:'echo-person-document-upload-v2',request_id:randomUUID(),filename:'SCOUT-PRD.md',title:'SCOUT product requirements',content_length:bytes.byteLength,sha256:sha256Digest(bytes),audience:{kind:'team'},association_project_ids:[PROJECT_ALPHA],...changes};}
/** A document the retired V1 upload stored (ADR-0048): by default a team document whose single project link is Alpha. */
function storedV1(db:Database.Database,actor:AuthorityPersonMembershipBinding,bytes:Uint8Array,changes:Partial<Parameters<typeof insertStoredDocumentV1>[2]>={}){return insertStoredDocumentV1(db,actor,{filename:'SCOUT-PRD.md',title:'SCOUT product requirements',audience:{kind:'team'},project_id:PROJECT_ALPHA,...changes},bytes);}
function search(project_id:typeof PROJECT_ALPHA|null=null,query=''){return {schema_version:2,kind:'echo-person-document-search-v2',project_id,query,limit:20,cursor:null};}
function result(claim:{source_sha256:string},text:string){return {status:'ready' as const,sourceSha256:claim.source_sha256,extractorVersion:'fixture-1',chunks:[{anchor_kind:'paragraph' as const,anchor_start:1,text}],message:null};}
/** A document's extracted text as `person open --ref document:<id>` reads it (ADR-0024): every page's chunk texts, in order. */
function opened(db:Database.Database,token:string,documentId:string):string[][]{
 const items=new SqlitePersonOriginalItemsV1(db,{authenticateAccess:({access_token})=>authorization(access_token==='member'?MEMBER:access_token==='returned'?RETURNED_MEMBER:OWNER)},OWNER.organization_id);
 const pages:string[][]=[];
 for(let from:number|undefined;;){const page=items.open({access_token:token,ref:{kind:'document',id:documentId as `doc_${string}`},...(from===undefined?{}:{from_ordinal:from})});if(page.kind!=='document')throw new Error('expected a document');pages.push(page.chunks.map(chunk=>chunk.text));if(page.next_ordinal===null)return pages;from=page.next_ordinal;}
}
describe('Document custody and retrieval V1',()=>{
 it('retains an ordinary >8KiB PRD, exact download, immutable receipt replay and paged end-of-document search',()=>{
  const {app,repository,db}=setup();const bytes=Buffer.from('SCOUT requirement '.repeat(1600)+'terminal-needle');const request=input(bytes);const receipt=app.uploadV2('owner',request,bytes);
  expect(app.uploadV2('owner',request,bytes)).toEqual(receipt);expect(Buffer.from(app.originalV2('member',receipt.document_id).bytes).equals(bytes)).toBe(true);
  const claim=repository.claimExtraction()!;expect(Buffer.from(claim.bytes).equals(bytes)).toBe(true);const text=bytes.toString(),chunks=Array.from({length:Math.ceil(text.length/3072)},(_,index)=>({anchor_kind:'paragraph' as const,anchor_start:index+1,text:text.slice(index*3072,(index+1)*3072)}));expect(repository.completeExtraction(claim,{...result(claim,'x'),chunks})).toBe(true);
  const pages=opened(db,'member',receipt.document_id);expect(pages.length).toBeGreaterThan(1);expect(pages.flat().join('')).toBe(text);
  const found=validatePersonDocumentSearchResultV2(app.searchV2('member',search(PROJECT_ALPHA,'terminal-needle')));expect(found.documents[0]?.document_id).toBe(receipt.document_id);expect(found.documents[0]?.anchor).toEqual({kind:'paragraph',start:chunks.length});expect(app.uploadV2('owner',request,bytes)).toEqual(receipt);
  expect(()=>app.uploadV2('owner',{...request,title:'changed'},bytes)).toThrow(expect.objectContaining({code:'conflict'}));
  const audit=db.prepare(`SELECT body_json FROM authority_person_document_read_audit_v1 UNION ALL SELECT body_json FROM authority_person_upload_read_audit_v1`).all() as {body_json:string}[];expect(audit.length).toBeGreaterThan(3);expect(audit.every(x=>!x.body_json.includes('terminal-needle')&&!x.body_json.includes('SCOUT requirement'))).toBe(true);
 });
 it('filters private/project audiences before search and treats association independently',()=>{
  const {app}=setup();const bytes=Buffer.from('private needle');
  const privateDoc=app.uploadV2('owner',input(bytes,{audience:{kind:'only_me'}}),bytes);
  const hidden=app.uploadV2('owner',input(bytes,{audience:{kind:'project',project_id:PROJECT_BETA},association_project_ids:[PROJECT_ALPHA]}),bytes);
  const team=app.uploadV2('owner',input(bytes,{association_project_ids:[PROJECT_BETA]}),bytes);
  expect(()=>app.readV2('member',privateDoc.document_id)).toThrow(expect.objectContaining({code:'not_found'}));expect(()=>app.originalV2('member',hidden.document_id)).toThrow(expect.objectContaining({code:'not_found'}));
  expect(app.searchV2('member',search(PROJECT_ALPHA)).documents).toEqual([]);expect(app.searchV2('member',search()).documents.map(x=>x.document_id)).toEqual([team.document_id]);expect(app.readV2('member',team.document_id).association_project_ids).toEqual([]);
  expect(()=>app.searchV2('member',{...search(),project_id:PROJECT_BETA})).toThrow(expect.objectContaining({code:'not_found'}));
 });
 it('requires exact active tenure and current project grants, including before upload commit',()=>{
  const {app,repository,db}=setup();const bytes=Buffer.from('tenure');const doc=app.uploadV2('member',input(bytes,{audience:{kind:'only_me'}}),bytes);
  revokeMembership(db,MEMBER);addMembership(db,RETURNED_MEMBER,'Returned','member@example.test');expect(()=>app.readV2('member',doc.document_id)).toThrow(expect.objectContaining({code:'unauthorized'}));expect(()=>app.readV2('returned',doc.document_id)).toThrow(expect.objectContaining({code:'not_found'}));
  const before=(db.prepare('SELECT count(*) n FROM authority_person_documents_v1').get() as {n:number}).n;
  expect(()=>repository.uploadV2(authorization(OWNER),input(bytes),bytes,()=>authorization(OWNER,{session_state_sha256:canonicalSha256('revoked')}))).toThrow(expect.objectContaining({code:'stale_access_state'}));expect((db.prepare('SELECT count(*) n FROM authority_person_documents_v1').get() as {n:number}).n).toBe(before);
 });
 it('cancels release and its audit atomically if session or membership changes after selection',()=>{
  const {app,repository,db}=setup();const bytes=Buffer.from('audit release');const doc=app.uploadV2('owner',input(bytes),bytes);
  expect(()=>repository.readV2(authorization(MEMBER),{operation:'original',document_id:doc.document_id},()=>authorization(MEMBER,{person_state_sha256:canonicalSha256('changed')}))).toThrow(expect.objectContaining({code:'stale_access_state'}));
  expect(db.prepare('SELECT count(*) n FROM authority_person_document_read_audit_v1').get()).toEqual({n:0});
  db.exec(`CREATE TRIGGER fail_document_audit BEFORE INSERT ON authority_person_document_read_audit_v1 BEGIN SELECT RAISE(ABORT,'audit unavailable'); END;`);expect(()=>app.readV2('member',doc.document_id)).toThrow('audit unavailable');
 });
 it('uses the monotonic authorization revision to reject an association change during release',()=>{
  const {app,repository,db}=setup();const bytes=Buffer.from('revision fence');const doc=app.uploadV2('owner',input(bytes,{association_project_ids:[]}),bytes);
  expect(()=>repository.readV2(authorization(MEMBER),{operation:'original',document_id:doc.document_id},()=>{
   db.prepare(`INSERT INTO authority_person_document_associations_v1(document_id,project_id,organization_id,associated_at) VALUES (?,?,?,?)`).run(doc.document_id,PROJECT_ALPHA,OWNER.organization_id,PROJECT_CONTEXT_NOW);
   return authorization(MEMBER);
  })).toThrow(expect.objectContaining({code:'stale_access_state'}));
  expect(db.prepare('SELECT count(*) n FROM authority_person_document_associations_v1 WHERE document_id=?').get(doc.document_id)).toEqual({n:0});
  expect(db.prepare('SELECT count(*) n FROM authority_person_document_read_audit_v1').get()).toEqual({n:0});
 });
 it('keeps originals for explicit extraction failures and only permits the current lease to finish',()=>{
  const {app,repository,setTime,db}=setup();const bytes=Buffer.from('%PDF-not-valid');const doc=app.uploadV2('owner',input(bytes,{filename:'scan.pdf'}),bytes);const old=repository.claimExtraction()!;expect(repository.claimExtraction()).toBeUndefined();
  setTime('2026-09-21T22:02:01.000Z');const fresh=repository.claimExtraction()!;expect(fresh.lease_token).not.toBe(old.lease_token);expect(repository.completeExtraction(old,{...result(old,'text')})).toBe(false);
  expect(repository.completeExtraction(fresh,{...result(fresh,'text'),status:'malformed',chunks:[],message:'Invalid PDF'})).toBe(true);expect(validatePersonDocumentMetadataV2(app.readV2('owner',doc.document_id)).extraction_state).toBe('malformed');expect(app.originalV2('owner',doc.document_id).bytes).toEqual(bytes);expect(opened(db,'owner',doc.document_id)).toEqual([[]]);
 });
 it('continues project-owned extraction after uploader removal and releases history to new exact-tenure members',()=>{
  const {app,repository,db}=setup();const bytes=Buffer.from('claim content');const doc=app.uploadV2('member',input(bytes,{audience:{kind:'project',project_id:PROJECT_ALPHA}}),bytes);const claim=repository.claimExtraction()!;
  db.prepare(`UPDATE authority_project_memberships_v1 SET status='revoked',revoked_at=? WHERE membership_id=? AND project_id=?`).run(PROJECT_CONTEXT_NOW,MEMBER.membership_id,PROJECT_ALPHA);
  revokeMembership(db,MEMBER);addMembership(db,RETURNED_MEMBER,'Returned','member@example.test');
  expect(repository.completeExtraction(claim,result(claim,'historical-hardware'))).toBe(true);expect(app.readV2('owner',doc.document_id).extraction_state).toBe('ready');expect(app.originalV2('owner',doc.document_id).bytes).toEqual(bytes);
  expect(()=>opened(db,'returned',doc.document_id)).toThrow(expect.objectContaining({code:'not_found'}));grant(db,PROJECT_ALPHA,RETURNED_MEMBER);
  expect(opened(db,'returned',doc.document_id)).toEqual([['historical-hardware']]);expect(app.originalV2('returned',doc.document_id,{project_id:PROJECT_ALPHA}).bytes).toEqual(bytes);expect(app.searchV2('returned',search(PROJECT_ALPHA,'historical-hardware')).documents[0]?.document_id).toBe(doc.document_id);
  expect(()=>app.readV2('member',doc.document_id)).toThrow(expect.objectContaining({code:'unauthorized'}));
 });
 it('claims pending project content after uploader departure while keeping associated private content private',()=>{
  const {app,repository,db}=setup();const bytes=Buffer.from('pending project');const shared=app.uploadV2('member',input(bytes,{audience:{kind:'project',project_id:PROJECT_ALPHA}}),bytes);
  revokeMembership(db,MEMBER);const claim=repository.claimExtraction();expect(claim?.document_id).toBe(shared.document_id);expect(repository.completeExtraction(claim!,result(claim!,'pending history'))).toBe(true);expect(opened(db,'owner',shared.document_id)).toEqual([['pending history']]);
  const privateDoc=app.uploadV2('owner',input(bytes,{audience:{kind:'only_me'}}),bytes);const privateClaim=repository.claimExtraction()!;expect(repository.completeExtraction(privateClaim,result(privateClaim,'private history'))).toBe(true);
  addMembership(db,RETURNED_MEMBER,'Returned','member@example.test');grant(db,PROJECT_ALPHA,RETURNED_MEMBER);expect(()=>app.originalV2('returned',privateDoc.document_id)).toThrow(expect.objectContaining({code:'not_found'}));
 });
 it('recovers only an own minimal receipt and exact replay after losing project access',()=>{
  const {app,db}=setup();const bytes=Buffer.from('restricted body');const request=input(bytes,{audience:{kind:'project',project_id:PROJECT_ALPHA}});const saved=app.uploadV2('member',request,bytes);
  // A document the retired V1 upload stored (ADR-0048) recovers its status through the same V2 read.
  const legacy=storedV1(db,MEMBER,bytes,{audience:{kind:'project',project_id:PROJECT_ALPHA}});expect(app.statusV2('member',legacy.request_id)).toMatchObject({kind:'echo-person-document-metadata-v2',request_id:legacy.request_id,audience:{kind:'project',project_id:PROJECT_ALPHA},association_project_ids:[PROJECT_ALPHA]});
  db.prepare(`UPDATE authority_project_memberships_v1 SET status='revoked',revoked_at=? WHERE membership_id=? AND project_id=?`).run(PROJECT_CONTEXT_NOW,MEMBER.membership_id,PROJECT_ALPHA);
  const minimal=(value:{request_id:string;document_id:string;received_at:string})=>({schema_version:2,kind:'echo-person-document-saved-v2',request_id:value.request_id,document_id:value.document_id,received_at:value.received_at,state:'saved'});
  expect(app.statusV2('member',request.request_id)).toEqual(minimal(saved));expect(app.statusV2('member',legacy.request_id)).toEqual(minimal(legacy));expect(()=>app.preflightV2('member',request)).not.toThrow();expect(app.uploadV2('member',request,bytes)).toEqual(minimal(saved));
  expect(()=>app.uploadV2('member',{...request,title:'different'},bytes)).toThrow(expect.objectContaining({code:'conflict'}));expect(()=>app.readV2('member',saved.document_id)).toThrow(expect.objectContaining({code:'not_found'}));expect(()=>app.statusV2('owner',request.request_id)).toThrow(expect.objectContaining({code:'not_found'}));
  revokeMembership(db,MEMBER);addMembership(db,RETURNED_MEMBER,'Returned','member@example.test');expect(()=>app.statusV2('returned',request.request_id)).toThrow(expect.objectContaining({code:'not_found'}));
 });
 it('uses one request namespace across document and project operations in both directions',()=>{
  const {app,db}=setup();const projects=createProjectContextApplicationV1({authenticate:()=>authorization(OWNER),repository:new SqliteProjectContextRepositoryV1(db,()=>PROJECT_CONTEXT_NOW)});const bytes=Buffer.from('namespace');
  const create=(request_id:string)=>projects.createProject('owner',{schema_version:1,kind:'echo-project-create-v1',request_id,name:'Namespace project'});
  const priorProject=randomUUID();create(priorProject);expect(()=>app.uploadV2('owner',input(bytes,{request_id:priorProject}),bytes)).toThrow(expect.objectContaining({code:'conflict'}));
  const priorDocument=randomUUID();app.uploadV2('owner',input(bytes,{request_id:priorDocument}),bytes);expect(()=>create(priorDocument)).toThrow(expect.objectContaining({code:'conflict'}));
  // A request the retired V1 upload stored (ADR-0048) stays taken for project commands and V2 uploads alike.
  const legacy=storedV1(db,OWNER,bytes);expect(()=>create(legacy.request_id)).toThrow(expect.objectContaining({code:'conflict'}));expect(()=>app.uploadV2('owner',input(bytes,{request_id:legacy.request_id}),bytes)).toThrow(expect.objectContaining({code:'conflict'}));
 });
 it('continues keyset search without repeats after newer inserts and with deterministic equal-time ties',()=>{
  const {app,setTime}=setup();const bytes=Buffer.from('navigation');const first=app.uploadV2('owner',input(bytes,{title:'A'}),bytes);setTime('2026-09-21T22:02:00.000Z');const second=app.uploadV2('owner',input(bytes,{title:'B'}),bytes);
  const query={...search(),limit:1};const page=app.searchV2('member',query);expect(page.documents[0]?.document_id).toBe(second.document_id);setTime('2026-09-21T22:03:00.000Z');app.uploadV2('owner',input(bytes,{title:'C'}),bytes);
  const next=app.searchV2('member',{...query,cursor:page.next_cursor});expect(next.documents.map(x=>x.document_id)).toEqual([first.document_id]);expect(next.next_cursor).toBeNull();
  const peer=app.uploadV2('owner',input(bytes,{title:'D'}),bytes);const all:string[]=[];let cursor:string|null=null;do{const p=app.searchV2('member',{...query,cursor});all.push(...p.documents.map(x=>x.document_id));cursor=p.next_cursor;}while(cursor);expect(new Set(all).size).toBe(4);expect(all).toContain(peer.document_id);
  expect(()=>app.searchV2('member',{...query,query:'changed',cursor:page.next_cursor})).toThrow(expect.objectContaining({code:'invalid_request'}));
 });
 it('matches Unicode titles before extraction with canonical query normalization and current audience filtering',()=>{
  const {app,db}=setup();const bytes=Buffer.from('The body has no title words.');
  const title='ÉCOLE – ПЛАН – 硬件';const shared=app.uploadV2('owner',input(bytes,{title}),bytes);
  app.uploadV2('owner',input(bytes,{title,audience:{kind:'only_me'}}),bytes);
  for(const query of ['ÉCOLE','école','E\u0301COLE','ПЛАН','план','硬件','e\u0301cole – план']){
   const found=app.searchV2('member',search(PROJECT_ALPHA,query));expect(found.documents.map(document=>document.document_id)).toEqual([shared.document_id]);expect(found.documents[0]?.extraction_state).toBe('extracting');
  }
  const cafe=app.uploadV2('owner',input(bytes,{title:'CAFÉ'}),bytes);
  for(const query of ['CAFÉ','café','cafe\u0301'])expect(app.searchV2('member',search(PROJECT_ALPHA,query)).documents.map(document=>document.document_id)).toEqual([cafe.document_id]);
  expect(db.prepare('SELECT count(*) n FROM authority_person_document_text_v1').get()).toEqual({n:0});
 });
 it('filters Unicode title matches before keyset paging while newer matches are inserted',()=>{
  const {app,setTime}=setup();const bytes=Buffer.from('No matching title in body');const first=app.uploadV2('owner',input(bytes,{title:'ПЛАН hardware'}),bytes);
  setTime('2026-09-21T22:02:00.000Z');const second=app.uploadV2('owner',input(bytes,{title:'ПЛАН software'}),bytes);
  setTime('2026-09-21T22:03:00.000Z');app.uploadV2('owner',input(bytes,{title:'Unrelated document'}),bytes);
  const query={...search(PROJECT_ALPHA,'план'),limit:1};const page=app.searchV2('member',query);expect(page.documents.map(document=>document.document_id)).toEqual([second.document_id]);
  setTime('2026-09-21T22:04:00.000Z');app.uploadV2('owner',input(bytes,{title:'ПЛАН QA'}),bytes);
  const next=app.searchV2('member',{...query,cursor:page.next_cursor});expect(next.documents.map(document=>document.document_id)).toEqual([first.document_id]);expect(next.next_cursor).toBeNull();
 });
 it('retries transient extraction with bounded backoff without publishing failed-attempt content',()=>{
  const {app,repository,setTime,db}=setup();const bytes=Buffer.from('retry original');const doc=app.uploadV2('owner',input(bytes),bytes);const first=repository.claimExtraction()!;
  expect(repository.completeExtraction(first,{...result(first,''),status:'unavailable',chunks:[],message:'Temporary parser failure'})).toBe(true);expect(app.readV2('owner',doc.document_id).extraction_state).toBe('extracting');expect(repository.claimExtraction()).toBeUndefined();expect(db.prepare('SELECT count(*) n FROM authority_person_document_text_v1').get()).toEqual({n:0});
  setTime('2026-09-21T22:02:01.000Z');const second=repository.claimExtraction()!;expect(second.lease_token).not.toBe(first.lease_token);expect(repository.completeExtraction(first,result(first,'stale'))).toBe(false);expect(repository.completeExtraction(second,result(second,'recovered content'))).toBe(true);expect(opened(db,'owner',doc.document_id)).toEqual([['recovered content']]);expect(app.originalV2('owner',doc.document_id).bytes).toEqual(bytes);
 });
 it('keeps shared team processing independent of departed contributor but cancels private work',()=>{
  const {app,repository,db}=setup();const bytes=Buffer.from('scope');const team=app.uploadV2('member',input(bytes,{audience:{kind:'team'}}),bytes);const privateDoc=app.uploadV2('member',input(bytes,{audience:{kind:'only_me'}}),bytes);
  revokeMembership(db,MEMBER);
  let sharedClaim=repository.claimExtraction();if(!sharedClaim)sharedClaim=repository.claimExtraction();expect(sharedClaim?.document_id).toBe(team.document_id);expect(repository.completeExtraction(sharedClaim!,result(sharedClaim!,'retained team'))).toBe(true);
  repository.claimExtraction();expect(app.readV2('owner',team.document_id).extraction_state).toBe('ready');expect(db.prepare('SELECT extraction_state FROM authority_person_document_work_v1 WHERE document_id=?').get(privateDoc.document_id)).toEqual({extraction_state:'unavailable'});expect(()=>app.readV2('owner',privateDoc.document_id)).toThrow(expect.objectContaining({code:'not_found'}));
 });
 it('caps transient retries and never overwrites terminal extracted evidence',()=>{
  const {app,repository,setTime,db}=setup();const bytes=Buffer.from('bounded retries');const doc=app.uploadV2('owner',input(bytes),bytes);let finalClaim;
  for(let attempt=0;attempt<3;attempt++){setTime(`2026-09-21T22:0${attempt+1}:00.000Z`);const claim=repository.claimExtraction()!;expect(claim).toBeDefined();expect(repository.completeExtraction(claim,{...result(claim,''),status:'timed_out',chunks:[],message:'Timeout'})).toBe(true);finalClaim=claim;}
  expect(app.readV2('owner',doc.document_id)).toMatchObject({extraction_state:'timed_out',extraction_detail:'Extraction timed out after 3 attempts'});expect(repository.claimExtraction()).toBeUndefined();expect(repository.completeExtraction(finalClaim!,result(finalClaim!,'late rewrite'))).toBe(false);expect(opened(db,'owner',doc.document_id)).toEqual([[]]);expect(db.prepare('SELECT count(*) n FROM authority_source_representations_v1').get()).toEqual({n:1});
 });
 it('atomically retains source revision and representation and rebuilds provenance from verified custody',()=>{
  const {app,repository,db}=setup();const bytes=Buffer.from('atomic representation');const doc=app.uploadV2('owner',input(bytes,{audience:{kind:'project',project_id:PROJECT_ALPHA}}),bytes);const claim=repository.claimExtraction()!;
  db.exec(`CREATE TRIGGER fail_representation BEFORE INSERT ON authority_source_representations_v1 BEGIN SELECT RAISE(ABORT,'representation unavailable'); END;`);
  expect(()=>repository.completeExtraction(claim,result(claim,'derived'))).toThrow('representation unavailable');expect(db.prepare('SELECT count(*) n FROM authority_person_document_text_v1').get()).toEqual({n:0});expect(db.prepare('SELECT count(*) n FROM authority_sources_v1').get()).toEqual({n:0});expect(app.readV2('owner',doc.document_id).extraction_state).toBe('extracting');
  db.exec('DROP TRIGGER fail_representation');expect(repository.completeExtraction({...claim,source_scope:{...claim.source_scope,custody_ref:'membership:forged'},contributor:{principal_id:'forged',membership_id:'forged'}},result(claim,'derived'))).toBe(true);
  expect(db.prepare('SELECT custody_ref FROM authority_sources_v1').get()).toEqual({custody_ref:`project:${PROJECT_ALPHA}`});const retained=db.prepare('SELECT manifest_json FROM authority_source_revisions_v1').get() as {manifest_json:string};expect(JSON.parse(retained.manifest_json).contributor).toEqual({principal_id:OWNER.principal_id,membership_id:OWNER.membership_id});expect(db.prepare('SELECT count(*) n FROM authority_source_representations_v1').get()).toEqual({n:1});
 });
 it('does not trust declared size/digest and enforces exact original byte limit',()=>{
  const {app}=setup();const bytes=Buffer.from('bytes');expect(()=>app.uploadV2('owner',{...input(bytes),content_length:6},bytes)).toThrow(expect.objectContaining({code:'invalid_request'}));expect(()=>app.uploadV2('owner',{...input(bytes),sha256:canonicalSha256('other')},bytes)).toThrow(expect.objectContaining({code:'invalid_request'}));
  const boundary=Buffer.alloc(25*1024*1024,0x61);const request=input(boundary);const doc=app.uploadV2('owner',request,boundary);expect(app.originalV2('owner',doc.document_id).metadata.content_length).toBe(boundary.length);
  const over=Buffer.alloc(boundary.length+1,0x61);expect(()=>app.uploadV2('owner',{...request,request_id:randomUUID(),content_length:over.length},over)).toThrow(expect.objectContaining({code:'invalid_request'}));
 });
 it('atomically rolls back original, receipt, work and association when any admission write fails',()=>{
  const {app,db}=setup();db.exec(`CREATE TRIGGER fail_document_receipt BEFORE INSERT ON authority_person_document_receipts_v1 BEGIN SELECT RAISE(ABORT,'receipt unavailable'); END;`);const bytes=Buffer.from('atomic');expect(()=>app.uploadV2('owner',input(bytes),bytes)).toThrow('receipt unavailable');
  for(const table of ['authority_person_documents_v1','authority_person_document_originals_v1','authority_person_document_work_v1','authority_person_document_associations_v1'])expect(db.prepare(`SELECT count(*) n FROM ${table}`).get()).toEqual({n:0});
 });
 it('enforces count quota over V2 uploads and stored V1 documents while replay remains permitted',()=>{
  const {app,db}=setup();const bytes=Buffer.from('count');const request=input(bytes);const first=app.uploadV2('owner',request,bytes);for(let n=1;n<100;n++){if(n%2===0)storedV1(db,OWNER,bytes);else app.uploadV2('owner',input(bytes),bytes);}expect(()=>app.uploadV2('owner',input(bytes),bytes)).toThrow(expect.objectContaining({code:'quota_exceeded'}));expect(app.uploadV2('owner',request,bytes)).toEqual(first);
 });
 it('enforces document-only byte quota over V2 uploads and stored V1 documents while retaining the shared note/document count cap',()=>{
  const {app,db}=setup();const bytes=Buffer.alloc(25*1024*1024,0x61);for(let n=0;n<10;n++){if(n%2===0)storedV1(db,OWNER,bytes);else app.uploadV2('owner',input(bytes),bytes);}
  expect(()=>app.uploadV2('owner',input(Buffer.from('x')),Buffer.from('x'))).toThrow(expect.objectContaining({code:'quota_exceeded'}));
  const projects=createProjectContextApplicationV1({authenticate:()=>authorization(OWNER),repository:new SqliteProjectContextRepositoryV1(db,()=>PROJECT_CONTEXT_NOW)});expect(projects.submitUploadV3('owner',{schema_version:3,kind:'echo-person-update-submit-v3',request_id:randomUUID(),title:'Project note',text:'x',audience:{kind:'team'},association_project_ids:[]})).toMatchObject({state:'received'});
  expect(db.prepare('SELECT count(*) n FROM authority_person_documents_v1').get()).toEqual({n:10});
 });
 it('preserves ordinary words across defensive text chunk boundaries',()=>{
  const {app,repository,db}=setup();const bytes=Buffer.from('word boundary source');const doc=app.uploadV2('owner',input(bytes),bytes);const claim=repository.claimExtraction()!;const first='a '.repeat(1532),second='a '.repeat(2)+'hardware',text=first+second;repository.completeExtraction(claim,{...result(claim,first),chunks:[{anchor_kind:'paragraph',anchor_start:1,text:first},{anchor_kind:'paragraph',anchor_start:2,text:second}]});
  const found=app.searchV2('member',search(PROJECT_ALPHA,'hardware'));expect(found.documents[0]?.document_id).toBe(doc.document_id);expect(opened(db,'member',doc.document_id).flat().join('')).toBe(text);
 });
 it('indexes the tail of 5,000 packed hard-wrapped lines and keeps the phrase in one searchable chunk',async()=>{
  const {app,repository}=setup();const bytes=Buffer.from(Array.from({length:5000},(_,index)=>index===4999?'tail-marker':'hardware\nrequirements').join('\n'));const doc=app.uploadV2('owner',input(bytes),bytes);const claim=repository.claimExtraction()!;
  const extracted=await extractDocument({bytes,filename:'wrapped.md',sourceSha256:claim.source_sha256});expect(extracted.status).toBe('ready');expect(repository.completeExtraction(claim,extracted)).toBe(true);
  expect(app.searchV2('member',search(PROJECT_ALPHA,'hardware requirements')).documents.map(value=>value.document_id)).toContain(doc.document_id);
  expect(app.searchV2('member',search(PROJECT_ALPHA,'tail-marker')).documents.map(value=>value.document_id)).toContain(doc.document_id);
 });
 it('forms search excerpts at Unicode scalar boundaries',()=>{
  const {app,repository}=setup();const bytes=Buffer.from('unicode source');const doc=app.uploadV2('owner',input(bytes),bytes);const claim=repository.claimExtraction()!;const text='😀'+'x'.repeat(78)+' needle';repository.completeExtraction(claim,result(claim,text));
  const found=validatePersonDocumentSearchResultV2(app.searchV2('member',search(PROJECT_ALPHA,'needle')));expect(found.documents[0]?.document_id).toBe(doc.document_id);expect(found.documents[0]?.excerpt).toBe(text);
 });
 it('paginates escaped/control text within serialized wire bounds without dropping content',()=>{
  const {app,repository,db}=setup();const bytes=Buffer.from('bounded text');const receipt=app.uploadV2('owner',input(bytes),bytes);const claim=repository.claimExtraction()!;const text='\u0001'.repeat(8000)+'😀ending';repository.completeExtraction(claim,{...result(claim,text.slice(0,3072)),chunks:[{anchor_kind:'paragraph',anchor_start:1,text:text.slice(0,3072)},{anchor_kind:'paragraph',anchor_start:2,text:text.slice(3072,6144)},{anchor_kind:'paragraph',anchor_start:3,text:text.slice(6144)}]});
  // Each escaped chunk alone is near the open page's canonical bound, so every chunk is its own page.
  const pages=opened(db,'owner',receipt.document_id);expect(pages.map(page=>page.length)).toEqual([1,1,1]);expect(pages.flat().join('')).toBe(text);
 });
});
