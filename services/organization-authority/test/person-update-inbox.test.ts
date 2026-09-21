import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalSha256 } from '@echo-brain/federation-protocol';
import { database, databases, ADMITTED_AT } from '../../../packages/organization-processing/test/admitted-meeting-processing/fixtures/sqlite-meeting-state.js';
import { SqlitePersonUpdateInboxV1, PERSON_UPLOAD_MEMBERSHIP_CAPACITY, PERSON_UPLOAD_ORGANIZATION_CAPACITY } from '../src/adapters/persistence/sqlite/person-update-inbox-v1.js';
import type { PersonAccessAuthorization } from '@echo-brain/organization-authority-kernel/application/ports/person-access-authorization';
import { PersonUpdatesApplicationV1 } from '../src/application/person-updates.js';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';

const actor = { organization_id: 'org_test', principal_id: 'prn_test', membership_id: 'mem_test', membership_type: 'owner' as const };
const request = { schema_version: 1 as const, kind: 'echo-person-update-submit-v1' as const, request_id: '00000000-0000-4000-8000-000000000001', title: 'Update', text: 'We agreed to ship the release.\n' };
const authorization = (person: Parameters<SqlitePersonUpdateInboxV1['submit']>[0] = actor): PersonAccessAuthorization => ({ ...person, identity_binding_id: 'identity', session_family_id: 'session', access_credential_sha256: canonicalSha256('access'), person_state_sha256: canonicalSha256(person), session_state_sha256: canonicalSha256('session'), checked_at: ADMITTED_AT, access_expires_at: '2027-01-01T00:00:00.000Z', hard_reauthentication_at: '2027-01-01T00:00:00.000Z' });
const roots: string[] = [];
afterEach(() => { for (const db of databases.splice(0)) if (db.open) db.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function employee(db: Database.Database, n: number, email = `employee${n}@example.com`) {
  const membership_id = `mem_employee_${n}`;
  const principal_id = `prn_employee_${n}`;
  db.prepare(`INSERT INTO authority_principals VALUES (?, 'org_test', 'Employee', ?)`).run(principal_id, ADMITTED_AT);
  db.prepare(`INSERT INTO authority_memberships (membership_id, organization_id, principal_id, membership_type, status, provisioned_at, employee_email, employee_email_sha256) VALUES (?, 'org_test', ?, 'employee', 'active', ?, ?, ?)`)
    .run(membership_id, principal_id, ADMITTED_AT, email, canonicalSha256({ email }));
  return { organization_id: 'org_test', principal_id, membership_id, membership_type: 'employee' as const };
}

describe('durable Person intake', () => {
  it('commits one immutable receipt, rejects conflicting retries, and recovers exact status after restart', async () => {
    const root = mkdtempSync(join(tmpdir(), 'person-inbox-')); roots.push(root);
    const memory = database(); const path = join(root, 'authority.sqlite'); await memory.backup(path);
    const db = new Database(path); const other = new Database(path); databases.push(db, other);
    const store = new SqlitePersonUpdateInboxV1(db, () => ADMITTED_AT);
    const receipt = store.submit(actor, request); // The successful response is deliberately discarded by the caller.
    expect(new SqlitePersonUpdateInboxV1(other).submit(actor, request)).toEqual(receipt);
    expect(() => store.submit(actor, { ...request, text: 'different' })).toThrow(expect.objectContaining({ code: 'conflict' }));
    db.close(); other.close();
    const reopened = new Database(path); databases.push(reopened);
    const recovered = new SqlitePersonUpdateInboxV1(reopened);
    expect(recovered.status(actor, request.request_id)).toMatchObject({ status: 'stored', received_at: ADMITTED_AT });
    recovered.claim();
    expect(recovered.submit(actor, request)).toEqual(receipt);
    expect(reopened.prepare('SELECT count(*) AS n FROM authority_person_updates_v1').get()).toEqual({ n: 1 });
    expect(() => reopened.prepare('UPDATE authority_person_updates_v1 SET text = ?').run('rewrite')).toThrow('immutable');
  });

  it('authenticates every operation and scopes lookup/dedup to the exact tenure', () => {
    const db = database(); const other = employee(db, 1); const store = new SqlitePersonUpdateInboxV1(db, () => ADMITTED_AT);
    const app = new PersonUpdatesApplicationV1(token => { if (token !== 'active') throw new AuthorityOperationError('unauthorized', 'request failed'); return authorization(); }, store);
    expect(() => app.submit('expired', request)).toThrow(expect.objectContaining({ code: 'unauthorized' }));
    expect(() => app.submit('active', { ...request, principal_id: other.principal_id })).toThrow(expect.objectContaining({ code: 'invalid_request' }));
    app.submit('active', request);
    expect(() => store.status(other, request.request_id)).toThrow(expect.objectContaining({ code: 'not_found' }));
    expect(() => store.status(other, randomUUID())).toThrow(expect.objectContaining({ code: 'not_found' }));
    expect(store.submit(other, { ...request, text: 'another member' }).state).toBe('received');
    db.prepare(`UPDATE authority_memberships SET status = 'revoked', revoked_at = ?, revocation_reason = 'test' WHERE membership_id = ?`).run(ADMITTED_AT, other.membership_id);
    expect(() => store.status(other, request.request_id)).toThrow(expect.objectContaining({ code: 'unauthorized' }));
    expect(JSON.stringify(app.status('active', request.request_id))).not.toContain(request.text);
    expect(() => app.status('expired', request.request_id)).toThrow(expect.objectContaining({ code: 'unauthorized' }));
  });

  it('does not transfer pending custody or status to a new tenure reusing the same email', () => {
    const db = database(); const previous = employee(db, 1, 'returning@example.com');
    const store = new SqlitePersonUpdateInboxV1(db, () => ADMITTED_AT);
    const previousReceipt = store.submit(previous, request);
    db.prepare(`UPDATE authority_memberships SET status = 'revoked', revoked_at = ?, revocation_reason = 'test' WHERE membership_id = ?`).run(ADMITTED_AT, previous.membership_id);
    const replacement = employee(db, 2, 'returning@example.com');
    expect(store.isActive(previous)).toBe(false);
    expect(() => store.status(previous, request.request_id)).toThrow(expect.objectContaining({ code: 'unauthorized' }));
    expect(() => store.status(replacement, request.request_id)).toThrow(expect.objectContaining({ code: 'not_found' }));
    expect(() => store.content(replacement, previousReceipt.context_id)).toThrow(expect.objectContaining({ code: 'not_found' }));
    expect(store.search(replacement, { query: 'release' }).results).toEqual([]);
    store.submit(replacement, { ...request, text: 'New tenure, independent submission.' });
    expect(store.read(previous, request.request_id)).toMatchObject({ ...previous, text: request.text });
    expect(store.read(replacement, request.request_id)).toMatchObject({ ...replacement, text: 'New tenure, independent submission.' });
  });

  it('checks matching retries before both atomic retained-corpus limits, including enriched uploads', () => {
    const db = database(); const store = new SqlitePersonUpdateInboxV1(db, () => ADMITTED_AT);
    const people = [actor, ...Array.from({ length: 10 }, (_, n) => employee(db, n))];
    const receipt = store.submit(actor, request);
    store.enriched(store.read(actor, request.request_id)!, 'release', canonicalSha256('fixture'));
    for (let n = 1; n < PERSON_UPLOAD_MEMBERSHIP_CAPACITY; n++) store.submit(actor, { ...request, request_id: randomUUID() });
    expect(store.submit(actor, request)).toEqual(receipt);
    expect(() => store.submit(actor, { ...request, request_id: randomUUID() })).toThrow(expect.objectContaining({ code: 'rate_limited' }));
    for (const person of people.slice(1, 10)) for (let n = 0; n < 100; n++) store.submit(person, { ...request, request_id: randomUUID() });
    expect(db.prepare('SELECT count(*) AS n FROM authority_person_updates_v1').get()).toEqual({ n: PERSON_UPLOAD_ORGANIZATION_CAPACITY });
    expect(() => store.submit(people[10]!, { ...request, request_id: randomUUID() })).toThrow(expect.objectContaining({ code: 'rate_limited' }));
    expect(store.submit(actor, request)).toEqual(receipt);
  });

  it('rolls back on database failure rather than returning a receipt', () => {
    const db = database(); const store = new SqlitePersonUpdateInboxV1(db, () => ADMITTED_AT);
    db.exec(`CREATE TRIGGER fixture_disk_failure BEFORE INSERT ON authority_person_update_work_v1 BEGIN SELECT RAISE(ABORT, 'fixture failure'); END`);
    expect(() => store.submit(actor, request)).toThrow('fixture failure');
    expect(db.prepare('SELECT count(*) AS n FROM authority_person_updates_v1').get()).toEqual({ n: 0 });
  });
  it('enforces selected visibility on original content and search hints before release', () => {
    const db = database(); const other = employee(db, 1); const store = new SqlitePersonUpdateInboxV1(db, () => ADMITTED_AT);
    const mine = store.submit(actor, request);
    const employeePrivate = store.submit(other, { ...request, request_id: randomUUID(), title: 'Employee private', text: 'Personal note.' });
    expect(() => store.content(actor, employeePrivate.context_id)).toThrow(expect.objectContaining({ code: 'not_found' }));
    const shared = store.submit(actor, { ...request, request_id: randomUUID(), title: 'Shared memo', visibility: 'team' });
    store.enriched(store.read(actor, request.request_id)!, 'confidential-client-alias', canonicalSha256('fixture'));
    expect(store.content(actor, mine.context_id).text).toBe(request.text);
    expect(() => store.content(other, mine.context_id)).toThrow(expect.objectContaining({ code: 'not_found' }));
    expect(() => store.content(other, `ctx_${'f'.repeat(64)}`)).toThrow(expect.objectContaining({ code: 'not_found' }));
    expect(store.content(other, shared.context_id)).toMatchObject({ text: request.text, visibility: 'team' });
    expect(store.search(other, { query: 'release' }).results.map(row => row.context_id)).toEqual([shared.context_id]);
    expect(store.search(other, { query: 'confidential' }).results).toEqual([]);
    expect(store.search(actor, { query: 'confidential' }).results[0]?.context_id).toBe(mine.context_id);
    expect(() => store.submit(actor, { ...request, visibility: 'team' })).toThrow(expect.objectContaining({ code: 'conflict' }));
    expect(store.submit(actor, { ...request, visibility: 'only_me' })).toEqual(mine);
    db.prepare(`UPDATE authority_memberships SET status = 'revoked', revoked_at = ?, revocation_reason = 'test' WHERE membership_id = ?`).run(ADMITTED_AT, other.membership_id);
    expect(() => store.content(other, shared.context_id)).toThrow(expect.objectContaining({ code: 'unauthorized' }));
    expect(() => store.search(other, { query: 'release' })).toThrow(expect.objectContaining({ code: 'unauthorized' }));
  });

  it('audits exact read/search releases without logging the source, query, or bearer', () => {
    const db = database(); const store = new SqlitePersonUpdateInboxV1(db, () => ADMITTED_AT);
    const app = new PersonUpdatesApplicationV1(() => authorization(), store); const receipt = app.submit('synthetic-bearer', request);
    expect(app.content('synthetic-bearer', receipt.context_id).text).toBe(request.text);
    expect(app.search('synthetic-bearer', { query: 'release' }).results).toHaveLength(1);
    const audit = JSON.stringify(db.prepare('SELECT * FROM authority_person_upload_read_audit_v1').all());
    expect(audit).not.toContain(request.text); expect(audit).not.toContain('synthetic-bearer'); expect(audit).not.toContain('"query"');
    expect(db.prepare('SELECT count(*) AS n FROM authority_person_upload_read_audit_v1').get()).toEqual({ n: 2 });
    db.exec(`CREATE TRIGGER fixture_read_audit_failure BEFORE INSERT ON authority_person_upload_read_audit_v1 BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END`);
    expect(() => app.content('synthetic-bearer', receipt.context_id)).toThrow('audit unavailable');
    expect(() => app.search('synthetic-bearer', { query: 'release' })).toThrow('audit unavailable');
  });

  it('revalidates the exact session before releasing original context', () => {
    const db = database(); const store = new SqlitePersonUpdateInboxV1(db, () => ADMITTED_AT); const receipt = store.submit(actor, request);
    let checks = 0;
    const app = new PersonUpdatesApplicationV1(() => ({ ...authorization(), session_state_sha256: canonicalSha256(++checks) }), store);
    expect(() => app.content('active', receipt.context_id)).toThrow(expect.objectContaining({ code: 'unauthorized' }));
    expect(db.prepare('SELECT count(*) AS n FROM authority_person_upload_read_audit_v1').get()).toEqual({ n: 0 });
  });

});
