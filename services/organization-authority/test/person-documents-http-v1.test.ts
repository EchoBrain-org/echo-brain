import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, realpathSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest, type ClientRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalJson, sha256Digest } from '@echo-brain/federation-protocol';
import { validatePersonDocumentReceiptV1, MAX_ORGANIZATION_API_BODY_BYTES, type PersonDocumentUploadMetadataV1 } from '@echo-brain/organization-api';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import { runPersonClientCli } from '../../../src/product/person-client/composition.js';
import { PersonSessionStore } from '../../../src/product/person-client/session-store.js';
import { SqlitePersonDocumentRepositoryV1 } from '../src/adapters/persistence/sqlite/document-v1.js';
import { createPersonDocumentApplicationV1 } from '../src/application/document-v1.js';
import { createPersonDocumentUploadStagingV1 } from '../src/adapters/files/document-upload-staging-v1.js';
import type { PersonDocumentApplicationV1 } from '../src/application/ports/document-v1.js';
import type { PersonDocumentUploadStagingV1 } from '../src/application/ports/document-upload-staging-v1.js';
import { createOrganizationAuthorityHttpServer, type OrganizationAuthorityHttpServerOptions } from '../src/presentation/organization-authority-http-server.js';
import { addMembership, authorization, PROJECT_CONTEXT_NOW, PROJECT_ALPHA } from './fixtures/project-context-sqlite.js';
import { PersonDocumentProcessingV1 } from '../src/composition/person-document-processing-v1.js';
import { pdf, zip, entries } from './document-extraction-fixtures.js';
import { PEOPLE } from '../../../tests/fixtures/project-context-integration/scenario.js';
const token='A'.repeat(43);const memberToken='B'.repeat(43);
const closers:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const close of closers.splice(0).reverse())await close();});
const options=():OrganizationAuthorityHttpServerOptions=>({descriptor:{} as never,sessions:{} as never,oidc_provider:{} as never,expected_issuer:'https://issuer.example'});
function input(bytes:Uint8Array,overrides:Partial<PersonDocumentUploadMetadataV1>={}):PersonDocumentUploadMetadataV1{return {schema_version:1,kind:'echo-person-document-upload-v1',request_id:randomUUID(),filename:'机器人-PRD.md',title:'SCOUT requirements',content_length:bytes.byteLength,sha256:sha256Digest(bytes),audience:{kind:'team'},project_id:PROJECT_ALPHA,...overrides};}
function headers(value:PersonDocumentUploadMetadataV1,bearer=token){return {authorization:`Bearer ${bearer}`,'content-type':'application/octet-stream','content-length':String(value.content_length),'x-echo-document-metadata':Buffer.from(canonicalJson(value)).toString('base64url')};}
async function fixture(extra:{decorate?:(app:PersonDocumentApplicationV1)=>PersonDocumentApplicationV1;closing?:()=>boolean;staging?:PersonDocumentUploadStagingV1;server?:Partial<OrganizationAuthorityHttpServerOptions>}={}){
 const directory=realpathSync(mkdtempSync(join(tmpdir(),'echo-document-http-test-')));const db=new Database(':memory:');db.pragma('foreign_keys=ON');db.exec(readFileSync(new URL('../../../packages/organization-authority-kernel/baselines/authority-baseline-v8.sql',import.meta.url),'utf8'));
 db.prepare(`INSERT INTO authority_metadata(singleton,authority_id,organization_id,organization_display_name,descriptor_json,created_at,last_observed_at) VALUES (1,'oau_00000000-0000-4000-8000-000000000006',?,'Document HTTP fixture','{}',?,?)`).run(PEOPLE.alice.organization_id,PROJECT_CONTEXT_NOW,PROJECT_CONTEXT_NOW);
 db.prepare(`INSERT INTO authority_project_authorization_state_v1(organization_id,revision,updated_at) VALUES (?,0,?)`).run(PEOPLE.alice.organization_id,PROJECT_CONTEXT_NOW);
 for(const actor of [PEOPLE.alice,PEOPLE.bob])addMembership(db,actor,actor.principal_id,`${actor.principal_id}@example.test`);
 db.prepare(`INSERT INTO authority_projects_v1(project_id,organization_id,name,created_at,creator_principal_id,creator_membership_id,creator_membership_type) VALUES (?,?,?,?,?,?,?)`).run(PROJECT_ALPHA,PEOPLE.alice.organization_id,'SCOUT',PROJECT_CONTEXT_NOW,PEOPLE.alice.principal_id,PEOPLE.alice.membership_id,PEOPLE.alice.membership_type);
 for(const actor of [PEOPLE.alice,PEOPLE.bob])db.prepare(`INSERT INTO authority_project_memberships_v1(project_membership_id,project_id,organization_id,principal_id,membership_id,membership_type,role,status,granted_at) VALUES (?,?,?,?,?,?,?,'active',?)`).run(`pgm_${randomUUID()}`,PROJECT_ALPHA,actor.organization_id,actor.principal_id,actor.membership_id,actor.membership_type,actor===PEOPLE.alice?'lead':'member',PROJECT_CONTEXT_NOW);
 const repository=new SqlitePersonDocumentRepositoryV1(db,()=>PROJECT_CONTEXT_NOW);const app=createPersonDocumentApplicationV1({repository,authenticate:value=>{if(value!==token&&value!==memberToken)throw new AuthorityOperationError('unauthorized','fixture secret');return authorization(value===token?PEOPLE.alice:PEOPLE.bob);}});
 const staging=extra.staging??createPersonDocumentUploadStagingV1({temporaryDirectory:directory});
 const server=createOrganizationAuthorityHttpServer({...options(),person_documents:extra.decorate?.(app)??app,document_upload_staging:staging,...(extra.closing?{is_closing:extra.closing}:{}),...extra.server});server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();if(!address||typeof address==='string')throw new Error('address unavailable');
 closers.push(async()=>{const closed=once(server,'close');server.close();server.closeAllConnections();await closed;await new Promise(resolve=>setImmediate(resolve));db.close();rmSync(directory,{recursive:true,force:true});});
 return {directory,db,app,repository,server,origin:`http://127.0.0.1:${address.port}`};
}
async function failure(response:Response,status=400,code='invalid_request'){expect(response.status).toBe(status);expect(await response.json()).toEqual({error:{code,message:'request failed'}});}
function pending(origin:string,value:PersonDocumentUploadMetadataV1,override:Record<string,string|string[]>={}):{request:ClientRequest;response:Promise<{status:number;body:string}>}{
 let request!:ClientRequest;const response=new Promise<{status:number;body:string}>((resolve,reject)=>{request=httpRequest(`${origin}/v1/person/documents/${value.request_id}`,{method:'PUT',headers:{...headers(value),...override}},res=>{let body='';res.on('data',chunk=>{body+=String(chunk);});res.on('end',()=>resolve({status:res.statusCode!,body}));});request.on('error',reject);request.flushHeaders();});void response.catch(()=>undefined);return {request,response};
}
async function waitFor(check:()=>boolean){for(let n=0;n<100;n++){if(check())return;await new Promise(resolve=>setTimeout(resolve,5));}throw new Error('condition did not become true');}
async function upload(origin:string,bytes:Buffer,value=input(bytes)){const response=await fetch(`${origin}/v1/person/documents/${value.request_id}`,{method:'PUT',headers:headers(value),body:new Uint8Array(bytes)});expect(response.status).toBe(201);return validatePersonDocumentReceiptV1(await response.json());}

describe('document binary HTTP boundary and real service integration',()=>{
 it('uploads a Unicode-named >8KiB original and reads status, bounded text, indexed project search and exact bytes',async()=>{
  const h=await fixture();const bytes=Buffer.from('SCOUT requirement\n'.repeat(900)+'end-needle');const value=input(bytes);const receipt=await upload(h.origin,bytes,value);
  const status=await fetch(`${h.origin}/v1/person/documents/requests/${value.request_id}`,{headers:{authorization:`Bearer ${token}`}});expect(status.status).toBe(200);expect(await status.json()).toMatchObject({document_id:receipt.document_id,extraction_state:'extracting',filename:value.filename});
  const claim=h.repository.claimExtraction()!;h.repository.completeExtraction(claim,{status:'ready',sourceSha256:claim.source_sha256,extractorVersion:'http-fixture-1',message:null,chunks:Array.from({length:Math.ceil(bytes.length/3000)},(_,i)=>({anchor_kind:'paragraph' as const,anchor_start:i+1,text:bytes.toString().slice(i*3000,(i+1)*3000)}))});
  let cursor:string|null=null;let extracted='';do{const response=await fetch(`${h.origin}/v1/person/documents/${receipt.document_id}/text?project_id=${PROJECT_ALPHA}${cursor?`&cursor=${cursor}`:''}`,{headers:{authorization:`Bearer ${memberToken}`}});expect(response.status).toBe(200);const page=await response.json() as {chunks:{text:string}[];next_cursor:string|null};extracted+=page.chunks.map(x=>x.text).join('');cursor=page.next_cursor;}while(cursor);expect(extracted).toBe(bytes.toString());
  const search=await fetch(`${h.origin}/v1/person/documents/search`,{method:'POST',headers:{authorization:`Bearer ${memberToken}`,'content-type':'application/json'},body:JSON.stringify({schema_version:1,kind:'echo-person-document-search-v1',project_id:PROJECT_ALPHA,query:'end-needle',limit:20,cursor:null})});expect(search.status).toBe(200);expect(await search.json()).toMatchObject({documents:[{document_id:receipt.document_id}]});
  const original=await fetch(`${h.origin}/v1/person/documents/${receipt.document_id}/original?project_id=${PROJECT_ALPHA}`,{headers:{authorization:`Bearer ${memberToken}`}});expect(original.status).toBe(200);expect(original.headers.get('x-echo-document-sha256')).toBe(value.sha256);expect(original.headers.get('content-disposition')).toContain(encodeURIComponent(value.filename));expect(Buffer.from(await original.arrayBuffer())).toEqual(bytes);
  expect(readdirSync(h.directory)).toEqual([]);
 });
 it('returns only the saved request proof after project removal on status and exact HTTP replay',async()=>{
  const h=await fixture();const bytes=Buffer.from('project secret');const value=input(bytes,{audience:{kind:'project',project_id:PROJECT_ALPHA}});
  const first=await fetch(`${h.origin}/v1/person/documents/${value.request_id}`,{method:'PUT',headers:headers(value,memberToken),body:new Uint8Array(bytes)});expect(first.status).toBe(201);const receipt=validatePersonDocumentReceiptV1(await first.json());
  h.db.prepare(`UPDATE authority_project_memberships_v1 SET status='revoked',revoked_at=? WHERE membership_id=? AND project_id=?`).run(PROJECT_CONTEXT_NOW,PEOPLE.bob.membership_id,PROJECT_ALPHA);
  const minimal={schema_version:1,kind:'echo-person-document-saved-v1',request_id:value.request_id,document_id:receipt.document_id,received_at:receipt.received_at,state:'saved'};
  const status=await fetch(`${h.origin}/v1/person/documents/requests/${value.request_id}`,{headers:{authorization:`Bearer ${memberToken}`}});expect(status.status).toBe(200);expect(await status.json()).toEqual(minimal);
  const replay=await fetch(`${h.origin}/v1/person/documents/${value.request_id}`,{method:'PUT',headers:headers(value,memberToken),body:new Uint8Array(bytes)});expect(replay.status).toBe(201);expect(await replay.json()).toEqual(minimal);
  await failure(await fetch(`${h.origin}/v1/person/documents/${receipt.document_id}/original`,{headers:{authorization:`Bearer ${memberToken}`}}),404,'not_found');
  await failure(await fetch(`${h.origin}/v1/person/documents/requests/${value.request_id}`,{headers:{authorization:`Bearer ${token}`}}),404,'not_found');expect(readdirSync(h.directory)).toEqual([]);
 });
 it.each([
  ['SCOUT-MRD.pdf',()=>pdf('SCOUT-END-SENTINEL'),'page'],
  ['SCOUT-PRD.docx',()=>zip(entries(['SCOUT-END-SENTINEL'])),'paragraph'],
 ] as const)('retains and really extracts %s through HTTP, the isolated parser, indexed search and original download',async(filename,makeBytes,anchor)=>{
  const h=await fixture();const bytes=makeBytes();const receipt=await upload(h.origin,bytes,input(bytes,{filename}));
  await new PersonDocumentProcessingV1(h.repository).runOnce(new AbortController().signal);
  const auth={authorization:`Bearer ${memberToken}`};const status=await fetch(`${h.origin}/v1/person/documents/${receipt.document_id}?project_id=${PROJECT_ALPHA}`,{headers:auth});expect(status.status).toBe(200);expect(await status.json()).toMatchObject({extraction_state:'ready',document_id:receipt.document_id});
  const text=await fetch(`${h.origin}/v1/person/documents/${receipt.document_id}/text?project_id=${PROJECT_ALPHA}`,{headers:auth});expect(text.status).toBe(200);const page=await text.json() as {chunks:{text:string;anchor_kind:string}[]};expect(page.chunks.map(x=>x.text).join('')).toContain('SCOUT-END-SENTINEL');expect(page.chunks[0]?.anchor_kind).toBe(anchor);
  const search=await fetch(`${h.origin}/v1/person/documents/search`,{method:'POST',headers:{...auth,'content-type':'application/json'},body:JSON.stringify({schema_version:1,kind:'echo-person-document-search-v1',project_id:PROJECT_ALPHA,query:'SCOUT-END-SENTINEL',limit:20,cursor:null})});expect(search.status).toBe(200);expect(await search.json()).toMatchObject({documents:[{document_id:receipt.document_id,anchor:{kind:anchor,start:1}}]});
  const original=await fetch(`${h.origin}/v1/person/documents/${receipt.document_id}/original?project_id=${PROJECT_ALPHA}`,{headers:auth});expect(original.status).toBe(200);expect(Buffer.from(await original.arrayBuffer())).toEqual(bytes);
 });
 it('rejects arbitrary ZIPs and malformed Word directory coordinates before custody admission',async()=>{
  const h=await fixture();const good=zip(entries(['Word package']));
  const multipleDisks=Buffer.from(good);multipleDisks.writeUInt16LE(1,multipleDisks.length-18);
  const excessiveCount=Buffer.from(good);excessiveCount.writeUInt16LE(2001,excessiveCount.length-14);excessiveCount.writeUInt16LE(2001,excessiveCount.length-12);
  const badOffset=Buffer.from(good);badOffset.writeUInt32LE(good.length,badOffset.length-6);
  const mismatch=Buffer.from(good);mismatch[30]=0x58;
  for(const bytes of [zip([{name:'readme.txt',value:'Not a Word document'},{name:'notes.txt',value:'Other data'}]),multipleDisks,excessiveCount,badOffset,mismatch]){
   const value=input(bytes,{filename:'candidate.docx'});await failure(await fetch(`${h.origin}/v1/person/documents/${value.request_id}`,{method:'PUT',headers:headers(value),body:new Uint8Array(bytes)}));
  }
  expect(h.db.prepare('SELECT count(*) n FROM authority_person_documents_v1').get()).toEqual({n:0});
 });
 it('authenticates before consuming/staging an upload body',async()=>{
  let staged=0;const h=await fixture({staging:{async stage(){staged++;throw new Error('must not stage');}}});const value=input(Buffer.from('body not transmitted'));const request=pending(h.origin,value,{authorization:'Bearer expired'});const response=await request.response;expect(response.status).toBe(401);expect(staged).toBe(0);request.request.destroy();expect(h.db.prepare('SELECT count(*) n FROM authority_person_documents_v1').get()).toEqual({n:0});
 });
 it('rejects duplicate headers, noncanonical or duplicate-key metadata, mismatched identity and declared length before staging',async()=>{
  let staged=0;const h=await fixture({staging:{async stage(){staged++;throw new Error('must not stage');}}});const bytes=Buffer.from('header');const value=input(bytes);const encoded=headers(value)['x-echo-document-metadata'];
  for(const override of [ {'x-echo-document-metadata':[encoded,encoded]}, {authorization:[`Bearer ${token}`,`Bearer ${token}`]}, {'x-echo-document-metadata':Buffer.from(JSON.stringify(value)).toString('base64url')}, {'x-echo-document-metadata':Buffer.from(canonicalJson(value).replace('"schema_version":1','"schema_version":1,"schema_version":1')).toString('base64url')}, {'x-echo-document-metadata':Buffer.from(canonicalJson({...value,request_id:randomUUID()})).toString('base64url')}, {'content-length':String(bytes.length+1)}, {'content-encoding':'gzip'} ] as Record<string,string|string[]>[]){
   const request=pending(h.origin,value,override);request.request.end(bytes);expect((await request.response).status).toBe(400);
  }expect(staged).toBe(0);
 });
 it('rejects a completed digest mismatch without admission and removes staged files',async()=>{
  const h=await fixture();const bytes=Buffer.from('actual');const value=input(bytes,{sha256:sha256Digest(Buffer.from('wrong!'))});await failure(await fetch(`${h.origin}/v1/person/documents/${value.request_id}`,{method:'PUT',headers:headers(value),body:new Uint8Array(bytes)}));expect(h.db.prepare('SELECT count(*) n FROM authority_person_documents_v1').get()).toEqual({n:0});expect(readdirSync(h.directory)).toEqual([]);
 });
 it('bounds concurrent transfers and releases their slots and staged files after interruption',async()=>{
  let preflight=0;const h=await fixture({decorate:app=>({...app,preflight(...args){app.preflight(...args);preflight++;}})});const bytes=Buffer.alloc(20000,0x61);const first=pending(h.origin,input(bytes));const second=pending(h.origin,input(bytes));first.request.write(bytes.subarray(0,100));second.request.write(bytes.subarray(0,100));await waitFor(()=>preflight===2);
  const third=pending(h.origin,input(bytes));expect((await third.response).status).toBe(429);third.request.destroy();first.request.destroy();second.request.destroy();await waitFor(()=>readdirSync(h.directory).length===0);await new Promise(resolve=>setTimeout(resolve,10));expect(h.db.prepare('SELECT count(*) n FROM authority_person_documents_v1').get()).toEqual({n:0});await upload(h.origin,Buffer.from('after interruption'));
 });
 it('bounds originals held for slow readers before allocating another binary response',async()=>{
  let originalReads=0;const h=await fixture({decorate:app=>({...app,original(...args){originalReads++;return app.original(...args);}})});const bytes=Buffer.alloc(8*1024*1024,0x61);const receipt=await upload(h.origin,bytes);const url=`${h.origin}/v1/person/documents/${receipt.document_id}/original`;
  let firstClosed!:()=>void;const firstServerClosed=new Promise<void>(resolve=>{firstClosed=resolve;});
  h.server.prependListener('request',(request,response)=>{if(request.headers['x-test-download']==='first')response.once('close',firstClosed);});
  const paused=(label:string)=>new Promise<{request:ClientRequest;response:import('node:http').IncomingMessage}>((resolve,reject)=>{const request=httpRequest(url,{headers:{authorization:`Bearer ${token}`,'x-test-download':label}},response=>{response.pause();response.on('error',()=>undefined);resolve({request,response});});request.on('error',reject);request.end();});
  const first=await paused('first');const second=await paused('second');expect(first.response.statusCode).toBe(200);expect(second.response.statusCode).toBe(200);
  await failure(await fetch(url,{headers:{authorization:`Bearer ${token}`}}),429,'rate_limited');expect(originalReads).toBe(2);
  first.response.destroy();first.request.destroy();await firstServerClosed;
  const next=await fetch(url,{headers:{authorization:`Bearer ${token}`}});expect(next.status).toBe(200);expect(Buffer.from(await next.arrayBuffer())).toEqual(bytes);expect(originalReads).toBe(3);second.response.destroy();second.request.destroy();
 });
 it('rechecks shutdown after transfer completion and admits no late original',async()=>{
  let closing=false;let stagingEntered=false;let finish!:()=>void;const gate=new Promise<void>(resolve=>{finish=resolve;});const bytes=Buffer.from('closing body');const real=createPersonDocumentUploadStagingV1();
  const h=await fixture({closing:()=>closing,staging:{async stage(stream,metadata){const result=await real.stage(stream,metadata);stagingEntered=true;await gate;return result;}}});const value=input(bytes);const response=fetch(`${h.origin}/v1/person/documents/${value.request_id}`,{method:'PUT',headers:headers(value),body:new Uint8Array(bytes)});await waitFor(()=>stagingEntered);closing=true;finish();await failure(await response,503,'unavailable');expect(h.db.prepare('SELECT count(*) n FROM authority_person_documents_v1').get()).toEqual({n:0});
 });
 it('requires the current project association and grant on every scoped read and download',async()=>{
  const h=await fixture();const receipt=await upload(h.origin,Buffer.from('team-visible source'));const auth={authorization:`Bearer ${memberToken}`};
  h.db.prepare(`UPDATE authority_project_memberships_v1 SET status='revoked',revoked_at=? WHERE membership_id=?`).run(PROJECT_CONTEXT_NOW,PEOPLE.bob.membership_id);
  for(const suffix of ['','/text','/original'])await failure(await fetch(`${h.origin}/v1/person/documents/${receipt.document_id}${suffix}?project_id=${PROJECT_ALPHA}`,{headers:auth}),404,'not_found');
  expect((await fetch(`${h.origin}/v1/person/documents/${receipt.document_id}`,{headers:auth})).status).toBe(200);
  h.db.prepare('DELETE FROM authority_person_document_associations_v1 WHERE document_id=?').run(receipt.document_id);await failure(await fetch(`${h.origin}/v1/person/documents/${receipt.document_id}?project_id=${PROJECT_ALPHA}`,{headers:{authorization:`Bearer ${token}`}}),404,'not_found');
 });
 it('rejects duplicate/unknown text query fields and duplicate JSON search keys',async()=>{
  const h=await fixture();const receipt=await upload(h.origin,Buffer.from('query'));const auth={authorization:`Bearer ${token}`};for(const query of ['project_id=bad','project_id='+PROJECT_ALPHA+'&project_id='+PROJECT_ALPHA,'cursor=x&cursor=y','unknown=x'])await failure(await fetch(`${h.origin}/v1/person/documents/${receipt.document_id}/text?${query}`,{headers:auth}));
  await failure(await fetch(`${h.origin}/v1/person/documents/search`,{method:'POST',headers:{...auth,'content-type':'application/json'},body:'{"schema_version":1,"schema_version":1,"kind":"echo-person-document-search-v1","project_id":null,"query":"","limit":20,"cursor":null}'}));
 });
 it('rejects invalid application output before release',async()=>{
  const h=await fixture({decorate:app=>({...app,read(...args){return {...app.read(...args),private_extra:'must not release'} as never;}})});const receipt=await upload(h.origin,Buffer.from('output guard'));await failure(await fetch(`${h.origin}/v1/person/documents/${receipt.document_id}`,{headers:{authorization:`Bearer ${token}`}}),502,'invalid_output');
 });
 it('reserves the entire document family from provider ingress and requires paired staging composition',()=>{
  for(const key of ['private_approval_interaction_ingress','person_external_identity_link','person_tools'])for(const path of ['/v1/person/documents','/v1/person/documents/search','/v1/person/documents/arbitrary/original'])expect(()=>createOrganizationAuthorityHttpServer({...options(),[key]:{routes:[{route_id:'collision',method:'POST',path}],accept:async()=>({status:200,body:{}})}})).toThrow('collides with Authority route');
  expect(()=>createOrganizationAuthorityHttpServer({...options(),person_documents:{} as never})).toThrow('composed together');
 });
 it('preserves the legacy 16KiB JSON request cap while admitting larger binary documents',async()=>{
  let calls=0;const h=await fixture({server:{project_context:{createProject(){calls++;return {schema_version:1,kind:'echo-project-create-receipt-v1',request_id:'00000000-0000-4000-8000-000000000001',project_id:PROJECT_ALPHA,name:'SCOUT',created_at:PROJECT_CONTEXT_NOW,role:'lead'};}} as never}});
  const request=JSON.stringify({schema_version:1,kind:'echo-project-create-v1',request_id:'00000000-0000-4000-8000-000000000001',name:'SCOUT'});const body=request+' '.repeat(MAX_ORGANIZATION_API_BODY_BYTES-Buffer.byteLength(request));
  const accepted=await fetch(`${h.origin}/v1/person/projects`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body});expect(calls).toBe(1);expect(accepted.status).not.toBe(400);
  await failure(await fetch(`${h.origin}/v1/person/projects`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:body+' '}));expect(calls).toBe(1);await upload(h.origin,Buffer.alloc(20000,0x61));
 });
 it('runs the real Person CLI upload, status, scoped paged read, search and byte-exact download against HTTP/SQLite',async()=>{
  const h=await fixture();const home=join(h.directory,'person-home');mkdirSync(home,{mode:0o700});new PersonSessionStore(home).install('https://authority.example','oau_00000000-0000-4000-8000-000000000006',{...PEOPLE.alice,display_name:'PM',identity_binding_id:'oib_00000000-0000-4000-8000-000000000006',session_family_id:'psf_00000000-0000-4000-8000-000000000006',access_token:token,refresh_token:'Z'.repeat(43),access_expires_at:'2026-09-21T23:01:00.000Z',refresh_expires_at:'2026-09-28T22:01:00.000Z',hard_reauthentication_at:'2026-09-28T22:01:00.000Z'});
  const network:typeof fetch=(url,init)=>{const parsed=new URL(String(url));expect(parsed.origin).toBe('https://authority.example');return fetch(h.origin+parsed.pathname+parsed.search,init);};
  const cli=async(argv:string[])=>{let stdout='';let stderr='';const code=await runPersonClientCli(argv,{home_directory:home,now:()=>PROJECT_CONTEXT_NOW,fetch:network,stdout:{write:value=>{stdout+=value;}},stderr:{write:value=>{stderr+=value;}}});expect(stderr).toBe('');expect(code).toBe(0);expect(Buffer.byteLength(stdout)).toBeLessThanOrEqual(32768);return JSON.parse(stdout) as any;};
  const bytes=Buffer.from('SCOUT requirement\n'.repeat(700)+'last-proof');const path=join(h.directory,'SCOUT-PRD.md');writeFileSync(path,bytes);const requestId=randomUUID();const saved=await cli(['documents','upload','--file',path,'--audience','team','--project-id',PROJECT_ALPHA,'--title','SCOUT PRD','--request-id',requestId]);const receipt=saved.result??saved;
  const claim=h.repository.claimExtraction()!;h.repository.completeExtraction(claim,{status:'ready',sourceSha256:claim.source_sha256,extractorVersion:'cli-fixture-1',message:null,chunks:Array.from({length:Math.ceil(bytes.length/3000)},(_,i)=>({anchor_kind:'paragraph',anchor_start:i+1,text:bytes.toString().slice(i*3000,(i+1)*3000)}))});
  await cli(['documents','status','--request-id',requestId]);const first=await cli(['documents','read','--document-id',receipt.document_id,'--project-id',PROJECT_ALPHA]);const result=first.result??first;expect(result.metadata.document_id).toBe(receipt.document_id);expect(result.text.next_cursor).not.toBeNull();await cli(['documents','read','--document-id',receipt.document_id,'--project-id',PROJECT_ALPHA,'--cursor',result.text.next_cursor]);
  const found=await cli(['documents','search','--project-id',PROJECT_ALPHA,'--query','last-proof']);expect((found.result??found).documents).toHaveLength(1);const output=join(h.directory,'downloaded.md');await cli(['documents','download','--document-id',receipt.document_id,'--project-id',PROJECT_ALPHA,'--out',output]);expect(readFileSync(output)).toEqual(bytes);
 });
});
