import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { canonicalSha256, sha256Digest } from '@echo-brain/federation-protocol';
import { validatePersonDocumentMetadataV1, validatePersonDocumentTextV1, validatePersonDocumentSearchResultV1, type PersonDocumentUploadMetadataV1 } from '@echo-brain/organization-api';
import { SqlitePersonUpdateInboxV1 } from '../src/adapters/persistence/sqlite/person-update-inbox-v1.js';
import { SqlitePersonDocumentRepositoryV1 } from '../src/adapters/persistence/sqlite/document-v1.js';
import { createPersonDocumentApplicationV1 } from '../src/application/document-v1.js';
import { OWNER, MEMBER, RETURNED_MEMBER, PROJECT_ALPHA, PROJECT_BETA, PROJECT_CONTEXT_NOW, addMembership, authorization, revokeMembership } from './fixtures/project-context-sqlite.js';
import type { AuthorityPersonMembershipBinding } from '@echo-brain/organization-authority-kernel/application/ports/authority-repository';
const databases: Database.Database[]=[];
afterEach(()=>databases.splice(0).forEach(d=>d.close()));
function setup(){
 const db=new Database(':memory:');databases.push(db);db.pragma('foreign_keys=ON');db.exec(readFileSync(new URL('../../../packages/organization-authority-kernel/baselines/authority-baseline-v8.sql',import.meta.url),'utf8'));
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
  const {app,repository,db}=setup();const bytes=Buffer.from('SCOUT requirement '.repeat(800)+'terminal-needle');const request=input(bytes);const receipt=app.upload('owner',request,bytes);
  expect(app.upload('owner',request,bytes)).toEqual(receipt);expect(app.original('member',receipt.document_id).bytes).toEqual(bytes);
  const claim=repository.claimExtraction()!;expect(claim.bytes).toEqual(bytes);expect(repository.completeExtraction(claim,{...result(claim,'x'),chunks:[{anchor_kind:'paragraph',anchor_start:1,text:bytes.toString().slice(0,7000)},{anchor_kind:'paragraph',anchor_start:2,text:bytes.toString().slice(7000)}]})).toBe(true);
  const page=validatePersonDocumentTextV1(app.text('member',receipt.document_id));expect(page.next_cursor).not.toBeNull();const second=app.text('member',receipt.document_id,{cursor:page.next_cursor});expect(second.chunks.map(c=>c.text).join('')).toContain('terminal-needle');
  const found=validatePersonDocumentSearchResultV1(app.search('member',search(PROJECT_ALPHA,'terminal-needle')));expect(found.documents[0]?.document_id).toBe(receipt.document_id);expect(found.documents[0]?.anchor).toEqual({kind:'paragraph',start:2});expect(app.upload('owner',request,bytes)).toEqual(receipt);
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
 it('keeps originals for explicit extraction failures and only permits the current lease to finish',()=>{
  const {app,repository,setTime}=setup();const bytes=Buffer.from('%PDF-not-valid');const doc=app.upload('owner',input(bytes,{filename:'scan.pdf'}),bytes);const old=repository.claimExtraction()!;expect(repository.claimExtraction()).toBeUndefined();
  setTime('2026-09-21T22:02:01.000Z');const fresh=repository.claimExtraction()!;expect(fresh.lease_token).not.toBe(old.lease_token);expect(repository.completeExtraction(old,{...result(old,'text')})).toBe(false);
  expect(repository.completeExtraction(fresh,{...result(fresh,'text'),status:'malformed',chunks:[],message:'Invalid PDF'})).toBe(true);expect(validatePersonDocumentMetadataV1(app.read('owner',doc.document_id)).extraction_state).toBe('malformed');expect(app.original('owner',doc.document_id).bytes).toEqual(bytes);expect(app.text('owner',doc.document_id).chunks).toEqual([]);
 });
 it('cancels extraction if uploader tenure or audience grant changes while parsing',()=>{
  const {app,repository,db}=setup();const bytes=Buffer.from('claim content');const doc=app.upload('member',input(bytes,{audience:{kind:'project',project_id:PROJECT_ALPHA}}),bytes);const claim=repository.claimExtraction()!;
  db.prepare(`UPDATE authority_project_memberships_v1 SET status='revoked',revoked_at=? WHERE membership_id=? AND project_id=?`).run(PROJECT_CONTEXT_NOW,MEMBER.membership_id,PROJECT_ALPHA);
  expect(repository.completeExtraction(claim,result(claim,'text'))).toBe(false);expect(app.read('owner',doc.document_id).extraction_state).toBe('unavailable');expect(app.original('owner',doc.document_id).bytes).toEqual(bytes);
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
  const {app}=setup();const bytes=Buffer.from('count');const request=input(bytes);const first=app.upload('owner',request,bytes);for(let n=1;n<100;n++)app.upload('owner',input(bytes),bytes);expect(()=>app.upload('owner',input(bytes),bytes)).toThrow(expect.objectContaining({code:'rate_limited'}));expect(app.upload('owner',request,bytes)).toEqual(first);
 });
 it('enforces shared byte quota at exactly 250MiB and prevents legacy admission bypass',()=>{
  const {app,db}=setup();const bytes=Buffer.alloc(25*1024*1024,0x61);for(let n=0;n<10;n++)app.upload('owner',input(bytes),bytes);
  expect(()=>app.upload('owner',input(Buffer.from('x')),Buffer.from('x'))).toThrow(expect.objectContaining({code:'rate_limited'}));
  const legacy=new SqlitePersonUpdateInboxV1(db,()=>PROJECT_CONTEXT_NOW);expect(()=>legacy.submit(OWNER,{schema_version:1,kind:'echo-person-update-submit-v1',request_id:randomUUID(),title:'Legacy',text:'x',visibility:'team'})).toThrow(expect.objectContaining({code:'rate_limited'}));
  expect(db.prepare('SELECT count(*) n FROM authority_person_documents_v1').get()).toEqual({n:10});
 });
 it('preserves ordinary words across defensive text chunk boundaries',()=>{
  const {app,repository}=setup();const bytes=Buffer.from('word boundary source');const doc=app.upload('owner',input(bytes),bytes);const claim=repository.claimExtraction()!;const text='a '.repeat(1534)+'hardware';repository.completeExtraction(claim,result(claim,text));
  const found=app.search('member',search(PROJECT_ALPHA,'hardware'));expect(found.documents[0]?.document_id).toBe(doc.document_id);expect(app.text('member',doc.document_id).chunks.map(c=>c.text).join('')).toBe(text);
 });
 it('forms search excerpts at Unicode scalar boundaries',()=>{
  const {app,repository}=setup();const bytes=Buffer.from('unicode source');const doc=app.upload('owner',input(bytes),bytes);const claim=repository.claimExtraction()!;const text='😀'+'x'.repeat(78)+' needle';repository.completeExtraction(claim,result(claim,text));
  const found=validatePersonDocumentSearchResultV1(app.search('member',search(PROJECT_ALPHA,'needle')));expect(found.documents[0]?.document_id).toBe(doc.document_id);expect(found.documents[0]?.excerpt).toBe(text);
 });
 it('paginates escaped/control text within serialized wire bounds without dropping content',()=>{
  const {app,repository}=setup();const bytes=Buffer.from('bounded text');const receipt=app.upload('owner',input(bytes),bytes);const claim=repository.claimExtraction()!;const text='\u0001'.repeat(8000)+'😀ending';repository.completeExtraction(claim,result(claim,text));
  let cursor:string|null=null;let all='';do{const page=validatePersonDocumentTextV1(app.text('owner',receipt.document_id,{cursor}));expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(24*1024);all+=page.chunks.map(c=>c.text).join('');cursor=page.next_cursor;}while(cursor);expect(all).toBe(text);
 });
});
