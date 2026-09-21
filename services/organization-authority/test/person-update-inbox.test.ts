import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalSha256 } from '@echo-brain/federation-protocol';
import { database, databases, ADMITTED_AT } from '../../../packages/organization-processing/test/admitted-meeting-processing/fixtures/sqlite-meeting-state.js';
import { SqlitePersonUpdateInboxV1, PERSON_UPDATE_MEMBERSHIP_PENDING_LIMIT, PERSON_UPDATE_ORGANIZATION_PENDING_LIMIT } from '../src/adapters/persistence/sqlite/person-update-inbox-v1.js';
import { PersonUpdatesApplicationV1 } from '../src/application/person-updates.js';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';

const actor = { organization_id: 'org_test', principal_id: 'prn_test', membership_id: 'mem_test', membership_type: 'owner' as const };
const request = { schema_version: 1 as const, kind: 'echo-person-update-submit-v1' as const, request_id: '00000000-0000-4000-8000-000000000001', title: 'Update', text: 'We agreed to ship the release.\n' };
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
    expect(recovered.status(actor, request.request_id)).toMatchObject({ status: 'received', received_at: ADMITTED_AT });
    recovered.claim();
    expect(recovered.submit(actor, request)).toEqual(receipt);
    expect(reopened.prepare('SELECT count(*) AS n FROM authority_person_updates_v1').get()).toEqual({ n: 1 });
    expect(() => reopened.prepare('UPDATE authority_person_updates_v1 SET text = ?').run('rewrite')).toThrow('immutable');
  });

  it('authenticates every operation and scopes lookup/dedup to the exact tenure', () => {
    const db = database(); const other = employee(db, 1); const store = new SqlitePersonUpdateInboxV1(db, () => ADMITTED_AT);
    const app = new PersonUpdatesApplicationV1(token => { if (token !== 'active') throw new AuthorityOperationError('unauthorized', 'request failed'); return actor; }, store);
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
    store.submit(previous, request);
    db.prepare(`UPDATE authority_memberships SET status = 'revoked', revoked_at = ?, revocation_reason = 'test' WHERE membership_id = ?`).run(ADMITTED_AT, previous.membership_id);
    const replacement = employee(db, 2, 'returning@example.com');
    expect(store.isActive(previous)).toBe(false);
    expect(() => store.status(previous, request.request_id)).toThrow(expect.objectContaining({ code: 'unauthorized' }));
    expect(() => store.status(replacement, request.request_id)).toThrow(expect.objectContaining({ code: 'not_found' }));
    store.submit(replacement, { ...request, text: 'New tenure, independent submission.' });
    expect(store.read(previous, request.request_id)).toMatchObject({ ...previous, text: request.text });
    expect(store.read(replacement, request.request_id)).toMatchObject({ ...replacement, text: 'New tenure, independent submission.' });
  });

  it('checks matching retries before both atomic pending limits, including blocked/review work', () => {
    const db = database(); const store = new SqlitePersonUpdateInboxV1(db, () => ADMITTED_AT);
    const people = [actor, ...Array.from({ length: 10 }, (_, n) => employee(db, n))];
    const receipt = store.submit(actor, request);
    store.update(store.read(actor, request.request_id)!, { status: 'blocked', reason: 'reviewer_unavailable' });
    for (let n = 1; n < PERSON_UPDATE_MEMBERSHIP_PENDING_LIMIT; n++) store.submit(actor, { ...request, request_id: randomUUID() });
    expect(store.submit(actor, request)).toEqual(receipt);
    expect(() => store.submit(actor, { ...request, request_id: randomUUID() })).toThrow(expect.objectContaining({ code: 'rate_limited' }));
    for (const person of people.slice(1, 10)) for (let n = 0; n < 100; n++) store.submit(person, { ...request, request_id: randomUUID() });
    expect(db.prepare('SELECT count(*) AS n FROM authority_person_updates_v1').get()).toEqual({ n: PERSON_UPDATE_ORGANIZATION_PENDING_LIMIT });
    expect(() => store.submit(people[10]!, { ...request, request_id: randomUUID() })).toThrow(expect.objectContaining({ code: 'rate_limited' }));
    store.update(store.read(actor, request.request_id)!, { status: 'no_signals' });
    expect(store.submit(people[10]!, { ...request, request_id: randomUUID() }).state).toBe('received');
  });

  it('rolls back on database failure rather than returning a receipt', () => {
    const db = database(); const store = new SqlitePersonUpdateInboxV1(db, () => ADMITTED_AT);
    db.exec(`CREATE TRIGGER fixture_disk_failure BEFORE INSERT ON authority_person_update_work_v1 BEGIN SELECT RAISE(ABORT, 'fixture failure'); END`);
    expect(() => store.submit(actor, request)).toThrow('fixture failure');
    expect(db.prepare('SELECT count(*) AS n FROM authority_person_updates_v1').get()).toEqual({ n: 0 });
  });
});
