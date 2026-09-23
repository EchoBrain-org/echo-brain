import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { applyAuthorityBaselineV7, applyAuthorityBaselineV8, authorityBaselineSha256V7 } from '@echo-brain/organization-authority-kernel/adapters/persistence/sqlite/baseline';

const databases: Database.Database[] = [];
const NOW = '2026-09-23T00:00:00.000Z';
const DOCUMENT = `doc_${'a'.repeat(64)}`;
const SHA = `sha256:${'a'.repeat(64)}`;
function database() { const db = new Database(':memory:'); databases.push(db); db.pragma('foreign_keys = ON'); return db; }
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function seeded() {
  const db = database(); applyAuthorityBaselineV8(db);
  db.prepare("INSERT INTO authority_metadata VALUES (1,'oau_fixture','org_fixture','Fixture','{}',?,?)").run(NOW,NOW);
  db.prepare("INSERT INTO authority_principals VALUES ('prn_fixture','org_fixture','PM',?)").run(NOW);
  db.prepare("INSERT INTO authority_memberships(membership_id,organization_id,principal_id,membership_type,status,provisioned_at) VALUES ('mem_fixture','org_fixture','prn_fixture','owner','active',?)").run(NOW);
  db.prepare(`INSERT INTO authority_person_documents_v1(document_id,organization_id,principal_id,membership_id,membership_type,request_id,filename,title,detected_media_type,original_size,original_sha256,payload_sha256,audience_kind,received_at) VALUES (?,'org_fixture','prn_fixture','mem_fixture','owner','fixture-request','fixture.txt','Fixture','text/plain',5,?,?,'only_me',?)`).run(DOCUMENT,SHA,SHA,NOW);
  db.prepare('INSERT INTO authority_person_document_originals_v1 VALUES (?,?)').run(DOCUMENT,Buffer.from('hello'));
  db.prepare('INSERT INTO authority_person_document_work_v1(document_id,retry_at) VALUES (?,?)').run(DOCUMENT,NOW);
  return db;
}

describe('Authority V8 document schema', () => {
  it('preserves pinned V7 declarations and isolates original BLOBs from metadata', () => {
    const v7 = readFileSync(new URL('../../../packages/organization-authority-kernel/baselines/authority-baseline-v7.sql', import.meta.url), 'utf8');
    const v8 = readFileSync(new URL('../../../packages/organization-authority-kernel/baselines/authority-baseline-v8.sql', import.meta.url), 'utf8');
    expect(v8.startsWith(v7)).toBe(true);
    expect(authorityBaselineSha256V7()).toBe('sha256:593fbdc54ab102b679f84735b724bff8233d0238eae89c11a0137194e9273da9');
    const db = database(); applyAuthorityBaselineV8(db);
    expect(db.pragma('user_version', { simple: true })).toBe(8);
    const columns = db.prepare("PRAGMA table_info('authority_person_documents_v1')").all() as { name: string; type: string }[];
    expect(columns.some(column => column.type === 'BLOB')).toBe(false);
    expect(db.prepare("SELECT name FROM sqlite_schema WHERE name LIKE 'authority_person_document_%_v1' ORDER BY name").pluck().all()).toContain('authority_person_document_originals_v1');
    const previous = database(); applyAuthorityBaselineV7(previous);
    expect(() => applyAuthorityBaselineV8(previous)).toThrow('completely empty');
    expect(previous.pragma('user_version', { simple: true })).toBe(7);
  });
  it('enforces immutable custody, original size, and membership binding', () => {
    const db = seeded();
    expect(() => db.prepare('UPDATE authority_person_documents_v1 SET title = ?').run('changed')).toThrow('immutable');
    expect(() => db.prepare('DELETE FROM authority_person_documents_v1').run()).toThrow('immutable');
    expect(() => db.prepare('UPDATE authority_person_document_originals_v1 SET original = ?').run(Buffer.from('other'))).toThrow('immutable');
    expect(() => db.prepare('DELETE FROM authority_person_document_originals_v1').run()).toThrow('immutable');
    expect(() => db.prepare(`INSERT INTO authority_person_documents_v1 SELECT ?,organization_id,'wrong-principal',membership_id,membership_type,'other-request',filename,title,detected_media_type,original_size,original_sha256,payload_sha256,audience_kind,audience_project_id,project_id,received_at FROM authority_person_documents_v1`).run(`doc_${'b'.repeat(64)}`)).toThrow('FOREIGN KEY');
    db.prepare(`INSERT INTO authority_person_documents_v1 SELECT ?,organization_id,principal_id,membership_id,membership_type,'other-request',filename,title,detected_media_type,original_size,original_sha256,payload_sha256,audience_kind,audience_project_id,project_id,received_at FROM authority_person_documents_v1`).run(`doc_${'b'.repeat(64)}`);
    expect(() => db.prepare('INSERT INTO authority_person_document_originals_v1 VALUES (?,?)').run(`doc_${'b'.repeat(64)}`,Buffer.from('sixsix'))).toThrow('size');
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });
  it('indexes anchored chunks and enforces the aggregate extracted-text budget', () => {
    const db = seeded();
    db.prepare("UPDATE authority_person_document_work_v1 SET state='processing',lease_token='fixture-lease',lease_expires_at=?").run('2026-09-23T00:01:00.000Z');
    const put = db.prepare("INSERT INTO authority_person_document_text_v1(document_id,ordinal,anchor_kind,anchor_start,text,extractor) VALUES (?,?,'paragraph',?,?, 'fixture-extractor-v1')");
    db.transaction(() => { for (let n = 0; n < 64; n++) put.run(DOCUMENT,n,n+1,'calibration '.padEnd(32768,'x')); })();
    expect(() => put.run(DOCUMENT,64,65,'x')).toThrow('byte budget');
    expect(db.prepare('SELECT extracted_text_bytes FROM authority_person_document_work_v1').pluck().get()).toBe(2 * 1024 * 1024);
    expect(() => db.prepare('UPDATE authority_person_document_work_v1 SET extracted_text_bytes = 0').run()).toThrow('cannot decrease');
    expect(db.prepare("SELECT count(*) FROM authority_person_document_text_fts_v1 WHERE authority_person_document_text_fts_v1 MATCH 'calibration'").pluck().get()).toBe(64);
    expect(() => db.prepare("UPDATE authority_person_document_text_v1 SET text='changed'").run()).toThrow('immutable');
    expect(() => db.prepare('DELETE FROM authority_person_document_text_v1').run()).toThrow('immutable');
  });
  it('requires leased processing and immutable terminal extraction outcomes', () => {
    const db = seeded();
    expect(() => db.prepare("UPDATE authority_person_document_work_v1 SET state='processing'").run()).toThrow('CHECK');
    db.prepare("UPDATE authority_person_document_work_v1 SET state='processing',attempts=1,lease_token='fixture-lease',lease_expires_at=?").run('2026-09-23T00:01:00.000Z');
    expect(() => db.prepare("UPDATE authority_person_document_work_v1 SET state='complete',extraction_state='ready'").run()).toThrow('CHECK');
    db.prepare("UPDATE authority_person_document_work_v1 SET state='complete',extraction_state='no_text',lease_token=NULL,lease_expires_at=NULL,extractor='fixture-extractor-v1'").run();
    expect(() => db.prepare("UPDATE authority_person_document_work_v1 SET extraction_state='ready'").run()).toThrow('immutable');
  });
});
