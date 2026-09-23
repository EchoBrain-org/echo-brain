import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { canonicalJson, canonicalSha256, sha256Digest } from '@echo-brain/federation-protocol';
import { assertPersonDocumentOriginalV1, PERSON_DOCUMENT_EXTRACTED_TEXT_MAX_BYTES, validatePersonDocumentUploadMetadataV1, type PersonDocumentUploadMetadataV1, type PersonDocumentReceiptV1, type PersonDocumentMetadataV1, type PersonDocumentMediaTypeV1, type PersonDocumentExtractionStateV1, type PersonDocumentTextChunkV1, type PersonDocumentSearchV1, type PersonDocumentSearchResultV1, type ProjectIdV1 } from '@echo-brain/organization-api';
import type { PersonAccessAuthorization } from '@echo-brain/organization-authority-kernel/application/ports/person-access-authorization';
import type { AuthorityPersonMembershipBinding } from '@echo-brain/organization-authority-kernel/application/ports/authority-repository';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import type { PersonDocumentRepositoryV1, DocumentReadRequestV1, DocumentReadResultV1, DocumentExtractionClaimV1, DocumentExtractionResultV1 } from '../../../application/ports/document-v1.js';

import { assertPersonDocumentCapacityV1 } from './document-quota-v1.js';
export { PERSON_DOCUMENT_MEMBER_QUOTA_BYTES, PERSON_DOCUMENT_ORGANIZATION_QUOTA_BYTES } from './document-quota-v1.js';
const SELECT = `SELECT d.*, w.extraction_state,w.extraction_detail,w.extractor,w.extracted_text_bytes,a.project_id AS current_project_id FROM authority_person_documents_v1 d JOIN authority_person_document_work_v1 w USING(document_id) LEFT JOIN authority_person_document_associations_v1 a USING(document_id)`;
type Row = AuthorityPersonMembershipBinding & { document_id: `doc_${string}`; request_id: string; filename: string; title: string; detected_media_type: PersonDocumentMediaTypeV1; original_size: number; original_sha256: `sha256:${string}`; payload_sha256: string; audience_kind: 'only_me'|'team'|'project'; audience_project_id: ProjectIdV1|null; project_id: ProjectIdV1|null; current_project_id: ProjectIdV1|null; received_at: string; extraction_state: PersonDocumentExtractionStateV1; extraction_detail: string|null; extractor: string|null; extracted_text_bytes: number };
type Grant = { project_id: string; project_membership_id: string; role: string };
type Permissions = { actor: AuthorityPersonMembershipBinding; grants: readonly Grant[]; digest: string };
function fail(code: 'not_found'|'unauthorized'|'conflict'|'stale_access_state'|'rate_limited'|'invalid_request'|'invalid_output' = 'not_found'): never { throw new AuthorityOperationError(code, 'Document request failed'); }
function actorIdentity(actor: PersonAccessAuthorization): string { const { checked_at: _checked, ...rest } = actor; return canonicalJson(rest); }
function immutable<T>(value: T): T { const copy = JSON.parse(canonicalJson(value)) as T; const freeze = (v: unknown): void => { if (v && typeof v === 'object') { Object.values(v).forEach(freeze); Object.freeze(v); } }; freeze(copy); return copy; }
function audience(row: Row): PersonDocumentUploadMetadataV1['audience'] { return row.audience_kind === 'project' ? { kind: 'project', project_id: row.audience_project_id! } : { kind: row.audience_kind }; }
function cursorEncode(value: unknown): string { return Buffer.from(canonicalJson(value)).toString('base64url'); }
function cursorDecode(cursor: string|null, scope: string): number { if (cursor === null) return 0; try { const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {scope:unknown;offset:unknown}; if (Object.keys(value).sort().join() !== 'offset,scope' || value.scope !== scope || !Number.isSafeInteger(value.offset) || (value.offset as number) < 0 || (value.offset as number) > 65536) fail('invalid_request'); if (cursorEncode(value) !== cursor) fail('invalid_request'); return value.offset as number; } catch { return fail('invalid_request'); } }
function metadata(row: Row, permission: Permissions): PersonDocumentMetadataV1 {
  return { schema_version: 1, kind: 'echo-person-document-metadata-v1', request_id: row.request_id, filename: row.filename, title: row.title, content_length: row.original_size, sha256: row.original_sha256, audience: audience(row), project_id: permission.grants.some(g => g.project_id === row.current_project_id) ? row.current_project_id : null, document_id: row.document_id, detected_media_type: row.detected_media_type, received_at: row.received_at, state: 'saved', extraction_state: row.extraction_state, extraction_detail: row.extraction_detail, extractor: row.extractor, extracted_text_bytes: row.extracted_text_bytes };
}

/** Dedicated document transactions never load originals while listing or matching text. */
export class SqlitePersonDocumentRepositoryV1 implements PersonDocumentRepositoryV1 {
  constructor(private readonly database: Database.Database, private readonly now: () => string = () => new Date().toISOString()) {
    if (database.pragma('user_version', { simple: true }) !== 8 || database.pragma('foreign_keys', { simple: true }) !== 1) throw new Error('Documents require Authority V8 and foreign keys');
  }
  private transaction<T>(operation: () => T): T {
    if (this.database.inTransaction) throw new Error('Document transaction is not reentrant');
    this.database.exec('BEGIN IMMEDIATE');
    try { const result = operation(); if (result && typeof (result as {then?:unknown}).then === 'function') throw new Error('Document transactions must be synchronous'); this.database.exec('COMMIT'); return result; }
    catch (error) { try { this.database.exec('ROLLBACK'); } catch {} throw error; }
  }
  private permissions(actor: AuthorityPersonMembershipBinding): Permissions {
    const active = this.database.prepare(`SELECT membership_id FROM authority_memberships WHERE organization_id=? AND principal_id=? AND membership_id=? AND membership_type=? AND status='active'`).get(actor.organization_id, actor.principal_id, actor.membership_id, actor.membership_type);
    if (!active) fail('unauthorized');
    const grants = this.database.prepare(`SELECT project_id,project_membership_id,role FROM authority_project_memberships_v1 WHERE organization_id=? AND principal_id=? AND membership_id=? AND membership_type=? AND status='active' ORDER BY project_id,project_membership_id`).all(actor.organization_id, actor.principal_id, actor.membership_id, actor.membership_type) as Grant[];
    const binding = { organization_id: actor.organization_id, principal_id: actor.principal_id, membership_id: actor.membership_id, membership_type: actor.membership_type };
    return { actor: binding, grants, digest: canonicalSha256({ actor: binding, grants }) };
  }
  private requireProject(permission: Permissions, project: string|null): void { if (project !== null && !permission.grants.some(g => g.project_id === project)) fail(); }
  private coordinates(permission: Permissions, value: PersonDocumentUploadMetadataV1): void { this.requireProject(permission, value.project_id); if (value.audience.kind === 'project') this.requireProject(permission, value.audience.project_id); }
  preflight(actor: PersonAccessAuthorization, value?: PersonDocumentUploadMetadataV1): void { const permission = this.permissions(actor); if (value) this.coordinates(permission, validatePersonDocumentUploadMetadataV1(value)); }
  private current(actor: PersonAccessAuthorization, permission: Permissions, reauthenticate: () => PersonAccessAuthorization): void {
    const current = reauthenticate(); if (actorIdentity(current) !== actorIdentity(actor) || this.permissions(current).digest !== permission.digest) fail('stale_access_state');
  }
  upload(actor: PersonAccessAuthorization, input: PersonDocumentUploadMetadataV1, bytes: Uint8Array, reauthenticate: () => PersonAccessAuthorization): PersonDocumentReceiptV1 {
    let value: PersonDocumentUploadMetadataV1; let media: PersonDocumentMediaTypeV1;
    try { value = validatePersonDocumentUploadMetadataV1(input); media = assertPersonDocumentOriginalV1(value, bytes); } catch { return fail('invalid_request'); }
    return this.transaction(() => {
      const permission = this.permissions(actor); this.coordinates(permission, value);
      const payload = canonicalSha256(value);
      const prior = this.database.prepare(`SELECT payload_sha256,receipt_json,receipt_sha256 FROM authority_person_document_receipts_v1 WHERE organization_id=? AND membership_id=? AND request_id=?`).get(actor.organization_id,actor.membership_id,value.request_id) as { payload_sha256:string; receipt_json:string; receipt_sha256:string }|undefined;
      if (prior) { if (prior.payload_sha256 !== payload || canonicalSha256(JSON.parse(prior.receipt_json)) !== prior.receipt_sha256) fail('conflict'); this.current(actor,permission,reauthenticate); return immutable(JSON.parse(prior.receipt_json) as PersonDocumentReceiptV1); }
      assertPersonDocumentCapacityV1(this.database,actor,bytes.byteLength);
      const document_id = `doc_${canonicalSha256({kind:'echo-person-document-id-v1',organization_id:actor.organization_id,membership_id:actor.membership_id,request_id:value.request_id}).slice(7)}` as const;
      const received_at = this.now();
      const receipt: PersonDocumentReceiptV1 = { ...value, kind:'echo-person-document-receipt-v1', document_id, detected_media_type:media, received_at, state:'saved', extraction_state:'extracting' };
      this.database.prepare(`INSERT INTO authority_person_documents_v1(document_id,organization_id,principal_id,membership_id,membership_type,request_id,filename,title,detected_media_type,original_size,original_sha256,payload_sha256,audience_kind,audience_project_id,project_id,received_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(document_id,actor.organization_id,actor.principal_id,actor.membership_id,actor.membership_type,value.request_id,value.filename,value.title,media,value.content_length,value.sha256,payload,value.audience.kind,value.audience.kind==='project'?value.audience.project_id:null,value.project_id,received_at);
      this.database.prepare(`INSERT INTO authority_person_document_originals_v1(document_id,original) VALUES (?,?)`).run(document_id,bytes);
      this.database.prepare(`INSERT INTO authority_person_document_work_v1(document_id,retry_at) VALUES (?,?)`).run(document_id,received_at);
      if (value.project_id !== null) this.database.prepare(`INSERT INTO authority_person_document_associations_v1(document_id,project_id,organization_id,associated_at) VALUES (?,?,?,?)`).run(document_id,value.project_id,actor.organization_id,received_at);
      this.database.prepare(`INSERT INTO authority_person_document_receipts_v1(organization_id,membership_id,request_id,payload_sha256,receipt_json,receipt_sha256,committed_at) VALUES (?,?,?,?,?,?,?)`).run(actor.organization_id,actor.membership_id,value.request_id,payload,canonicalJson(receipt),canonicalSha256(receipt),received_at);
      this.current(actor,permission,reauthenticate); return immutable(receipt);
    });
  }
  private acl(permission: Permissions): {sql:string;args:string[]} {
    const projects = permission.grants.map(g => g.project_id);
    return { sql:`d.organization_id=? AND (d.audience_kind='team' OR (d.audience_kind='only_me' AND d.membership_id=?) OR (d.audience_kind='project' AND d.audience_project_id IN (${projects.map(()=>'?').join(',') || 'NULL'})))`, args:[permission.actor.organization_id,permission.actor.membership_id,...projects] };
  }
  private row(permission: Permissions, id: string): Row { const acl = this.acl(permission); const row = this.database.prepare(`${SELECT} WHERE ${acl.sql} AND d.document_id=?`).get(...acl.args,id) as Row|undefined; if (!row) fail(); return row; }
  read(actor: PersonAccessAuthorization, request: DocumentReadRequestV1, reauthenticate: () => PersonAccessAuthorization): DocumentReadResultV1 {
    return this.transaction(() => {
      const permission = this.permissions(actor);
      const authorizationState = this.readAuthorizationState(permission);
      let response: DocumentReadResultV1;
      if (request.operation === 'search') response = this.search(permission,request.request);
      else {
        let row: Row;
        if (request.operation === 'status') {
          const owned = this.database.prepare(`${SELECT} WHERE d.organization_id=? AND d.membership_id=? AND d.request_id=?`).get(actor.organization_id,actor.membership_id,request.request_id) as Row|undefined;
          if (!owned) fail(); row = this.row(permission,owned.document_id);
        } else row = this.row(permission,request.document_id);
        if(request.operation!=='status'){const selected=request.project_id??null;this.requireProject(permission,selected);if(selected!==null&&row.current_project_id!==selected)fail();}
        if (request.operation === 'original') {
          const original = this.database.prepare(`SELECT original FROM authority_person_document_originals_v1 WHERE document_id=?`).get(row.document_id) as {original:Buffer}|undefined;
          if (!original || original.original.byteLength !== row.original_size || sha256Digest(original.original) !== row.original_sha256) fail('invalid_output');
          response = { metadata: metadata(row,permission),bytes:original.original };
        } else if (request.operation === 'text') {
          const scope = canonicalSha256({kind:'text',project_id:request.project_id??null,id:row.document_id,sha:row.original_sha256,extractor:row.extractor,membership_id:actor.membership_id,organization_id:actor.organization_id});
          const offset = cursorDecode(request.cursor,scope);
          const candidates = this.database.prepare(`SELECT ordinal,anchor_kind,anchor_start,text FROM authority_person_document_text_v1 WHERE document_id=? AND ordinal>=? ORDER BY ordinal LIMIT 9`).all(row.document_id,offset) as PersonDocumentTextChunkV1[];
          const chunks: PersonDocumentTextChunkV1[] = []; let total=0;
          for (const chunk of candidates) { const size=Buffer.byteLength(chunk.text); if (size > 8192) fail('invalid_output'); if(chunks.length>=8 || total+size>8192 || Buffer.byteLength(canonicalJson([...chunks,chunk]))>20*1024) break; chunks.push(chunk);total+=size; }
          const next = candidates.length > chunks.length ? (chunks.at(-1)!.ordinal + 1) : null;
          response = {schema_version:1,kind:'echo-person-document-text-v1',document_id:row.document_id,original_sha256:row.original_sha256,extractor:row.extractor,extraction_state:row.extraction_state,chunks,next_cursor:next===null?null:cursorEncode({scope,offset:next})};
        } else response=metadata(row,permission);
      }
      const auditResponse = 'bytes' in response ? {metadata:response.metadata,original_sha256:response.metadata.sha256,original_bytes:response.bytes.byteLength} : response;
      if (Buffer.byteLength(canonicalJson(auditResponse)) > (request.operation==='text'?24*1024:32*1024)) fail('invalid_output');
      // Reauthenticate after selection, within this same synchronous SQLite snapshot.
      this.current(actor,permission,reauthenticate);
      if(this.readAuthorizationState(permission)!==authorizationState)fail('stale_access_state');
      const audit = {schema_version:1,kind:'echo-document-read-audit-v1',audit_id:randomUUID(),organization_id:actor.organization_id,principal_id:actor.principal_id,membership_id:actor.membership_id,session_family_id:actor.session_family_id,operation:request.operation,authorization_sha256:canonicalSha256({person:JSON.parse(actorIdentity(actor)),permission:permission.digest}),response_sha256:canonicalSha256(auditResponse),released_count:'documents' in response?response.documents.length:1,checked_at:actor.checked_at};
      this.database.prepare(`INSERT INTO authority_person_document_read_audit_v1(row_sha256,body_json,recorded_at) VALUES (?,?,?)`).run(canonicalSha256(audit),canonicalJson(audit),actor.checked_at);
      return 'bytes' in response ? Object.freeze({metadata:immutable(response.metadata),bytes:response.bytes}) : immutable(response);
    });
  }
  private readAuthorizationState(permission:Permissions):string {
    const acl=this.acl(permission);
    const visible=this.database.prepare(`SELECT d.document_id,a.project_id FROM authority_person_documents_v1 d LEFT JOIN authority_person_document_associations_v1 a USING(document_id) WHERE ${acl.sql} ORDER BY d.document_id`).all(...acl.args);
    return canonicalSha256({permission:permission.digest,visible});
  }
  private search(permission: Permissions, request: PersonDocumentSearchV1): PersonDocumentSearchResultV1 {
    this.requireProject(permission,request.project_id);
    const scope = canonicalSha256({kind:'document-search',membership_id:permission.actor.membership_id,organization_id:permission.actor.organization_id,project_id:request.project_id,query:request.query,limit:request.limit});
    const offset = cursorDecode(request.cursor,scope);
    const acl = this.acl(permission);
    const query=request.query.toLowerCase(); const fts='\"'+query.replace(/\"/g,'\"\"')+'\"'; const escaped=`%${query.replace(/[\\%_]/g,'\\$&')}%`;
    const sql = `${SELECT} WHERE ${acl.sql} ${request.project_id===null?'':'AND a.project_id=?'} ${query===''?'':`AND (lower(d.title) LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM authority_person_document_text_v1 t JOIN authority_person_document_text_fts_v1 f ON f.rowid=t.chunk_id WHERE t.document_id=d.document_id AND authority_person_document_text_fts_v1 MATCH ?))`} ORDER BY d.received_at DESC,d.document_id LIMIT ? OFFSET ?`;
    const args:(string|number)[]=[...acl.args]; if(request.project_id!==null)args.push(request.project_id); if(query!=='')args.push(escaped,fts);args.push(request.limit+1,offset);
    const rows=this.database.prepare(sql).all(...args) as Row[];
    const documents: PersonDocumentSearchResultV1['documents'][number][]=[];
    for(const row of rows.slice(0,request.limit)) {
      const chunk=this.database.prepare(`SELECT anchor_kind,anchor_start,text FROM authority_person_document_text_v1 WHERE document_id=? ${query===''?'':`AND chunk_id IN (SELECT rowid FROM authority_person_document_text_fts_v1 WHERE authority_person_document_text_fts_v1 MATCH ?)`} ORDER BY ordinal LIMIT 1`).get(...(query===''?[row.document_id]:[row.document_id,fts])) as {anchor_kind:'page'|'paragraph';anchor_start:number;text:string}|undefined;
      let excerpt:string|null=null;
      if(chunk) { const match=query===''?0:Math.max(0,chunk.text.toLowerCase().indexOf(query)); const before=Array.from(chunk.text.slice(0,match)).length; excerpt=Array.from(chunk.text).slice(Math.max(0,before-80),Math.max(0,before-80)+240).join(''); }
      const item={...metadata(row,permission),excerpt,anchor:chunk?{kind:chunk.anchor_kind,start:chunk.anchor_start}:null};
      if(Buffer.byteLength(canonicalJson({documents:[...documents,item]}))>28000)break;
      documents.push(item);
    }
    return {schema_version:1,kind:'echo-person-document-search-result-v1',documents,next_cursor:rows.length>documents.length?cursorEncode({scope,offset:offset+documents.length}):null};
  }
  private workAuthorization(row: Row): string|undefined { try { const permission=this.permissions(row); if(row.audience_kind==='project')this.requireProject(permission,row.audience_project_id); return canonicalSha256({actor:permission.actor,audience:row.audience_kind==='project'?permission.grants.filter(g=>g.project_id===row.audience_project_id):[]}); } catch { return undefined; } }
  claimExtraction(): DocumentExtractionClaimV1|undefined {
    return this.transaction(()=>{
      const now=this.now();
      if(this.database.prepare(`SELECT 1 FROM authority_person_document_work_v1 WHERE state='processing' AND lease_expires_at>? LIMIT 1`).get(now))return undefined;
      const candidate=this.database.prepare(`${SELECT} WHERE (w.state='pending' AND w.retry_at<=?) OR (w.state='processing' AND w.lease_expires_at<=?) ORDER BY d.received_at,d.document_id LIMIT 1`).get(now,now) as Row|undefined;
      if(!candidate)return undefined;
      const state=this.database.prepare(`SELECT attempts FROM authority_person_document_work_v1 WHERE document_id=?`).get(candidate.document_id) as {attempts:number};
      const authorization_sha256=this.workAuthorization(candidate);
      if(!authorization_sha256||state.attempts>=3){this.finishUnavailable(candidate.document_id,!authorization_sha256?'Uploader access changed before extraction':'Extraction retry budget exhausted');return undefined;}
      const original=this.database.prepare(`SELECT original FROM authority_person_document_originals_v1 WHERE document_id=?`).get(candidate.document_id) as {original:Buffer};
      if(sha256Digest(original.original)!==candidate.original_sha256)fail('invalid_output');
      const lease_token=randomUUID(); const expires=new Date(Date.parse(now)+60000).toISOString();
      this.database.prepare(`UPDATE authority_person_document_work_v1 SET state='processing',attempts=attempts+1,lease_token=?,lease_expires_at=? WHERE document_id=?`).run(lease_token,expires,candidate.document_id);
      return {document_id:candidate.document_id,lease_token,bytes:original.original,filename:candidate.filename,source_sha256:candidate.original_sha256,authorization_sha256};
    });
  }
  private finishUnavailable(id:string,detail:string):void {this.database.prepare(`UPDATE authority_person_document_work_v1 SET state='complete',extraction_state='unavailable',extraction_detail=?,lease_token=NULL,lease_expires_at=NULL WHERE document_id=?`).run(detail,id);}
  completeExtraction(claim:DocumentExtractionClaimV1,result:DocumentExtractionResultV1):boolean {
    return this.transaction(()=>{
      const work=this.database.prepare(`SELECT state,lease_token,lease_expires_at FROM authority_person_document_work_v1 WHERE document_id=?`).get(claim.document_id) as {state:string;lease_token:string|null;lease_expires_at:string|null}|undefined;
      if(!work||work.state!=='processing'||work.lease_token!==claim.lease_token||work.lease_expires_at!<=this.now())return false;
      const row=this.database.prepare(`${SELECT} WHERE d.document_id=?`).get(claim.document_id) as Row;
      if(this.workAuthorization(row)!==claim.authorization_sha256){this.finishUnavailable(row.document_id,'Uploader access changed during extraction');return false;}
      const states=['ready','partial','no_text','encrypted','malformed','limit_exceeded','timed_out','unsupported','unavailable'];
      if(result.sourceSha256!==row.original_sha256||!states.includes(result.status)||typeof result.extractorVersion!=='string'||Buffer.byteLength(result.extractorVersion)<1||Buffer.byteLength(result.extractorVersion)>512||!Array.isArray(result.chunks)||result.chunks.length>4096||(result.message!==null&&(typeof result.message!=='string'||Buffer.byteLength(result.message)>512||/[\u0000-\u001f\u007f-\u009f]/u.test(result.message))))fail('invalid_output');
      if(result.status!=='ready'&&result.status!=='partial'&&result.chunks.length!==0)fail('invalid_output');
      let total=0;
      for(const chunk of result.chunks){if(!['page','paragraph'].includes(chunk.anchor_kind)||!Number.isSafeInteger(chunk.anchor_start)||chunk.anchor_start<1||typeof chunk.text!=='string'||Buffer.from(chunk.text).toString('utf8')!==chunk.text||Buffer.byteLength(chunk.text)<1||Buffer.byteLength(chunk.text)>8192)fail('invalid_output');total+=Buffer.byteLength(chunk.text);}
      if(total>PERSON_DOCUMENT_EXTRACTED_TEXT_MAX_BYTES||(result.status==='ready'&&total===0))fail('invalid_output');
      const storedChunks: {anchor_kind:'page'|'paragraph';anchor_start:number;text:string}[]=[];
      for(const chunk of result.chunks){let part='';let bytes=0;for(const point of chunk.text){const size=Buffer.byteLength(point);if(bytes+size>3072){let cut=0;for(const delimiter of part.matchAll(/\s/gu))cut=delimiter.index!+delimiter[0].length;if(cut===0)cut=part.length;storedChunks.push({...chunk,text:part.slice(0,cut)});part=part.slice(cut);bytes=Buffer.byteLength(part);if(bytes+size>3072){storedChunks.push({...chunk,text:part});part='';bytes=0;}}part+=point;bytes+=size;}if(part)storedChunks.push({...chunk,text:part});}
      if(storedChunks.length>4096)fail('invalid_output');
      const insert=this.database.prepare(`INSERT INTO authority_person_document_text_v1(document_id,ordinal,anchor_kind,anchor_start,text,extractor) VALUES (?,?,?,?,?,?)`);
      storedChunks.forEach((chunk,ordinal)=>insert.run(row.document_id,ordinal,chunk.anchor_kind,chunk.anchor_start,chunk.text,result.extractorVersion));
      this.database.prepare(`UPDATE authority_person_document_work_v1 SET state='complete',extraction_state=?,extraction_detail=?,extractor=?,extracted_text_bytes=?,lease_token=NULL,lease_expires_at=NULL WHERE document_id=?`).run(result.status,result.message,result.extractorVersion,total,row.document_id);
      return true;
    });
  }
}
