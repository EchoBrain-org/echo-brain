import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { ConfluenceConnectionStoreV1 } from '../src/confluence-connection-store-v1.js';

const cloud = '00000000-0000-4000-8000-000000000007';
const one = { organization_id: 'org', principal_id: 'person-one', membership_id: 'member-one' };
const two = { organization_id: 'org', principal_id: 'person-two', membership_id: 'member-two' };

it('isolates per-person selected Confluence references and invalidates a binding at local revocation', () => {
  const db = new Database(':memory:');
  try {
    const store = new ConfluenceConnectionStoreV1(db, () => Date.UTC(2026, 9, 5));
    const first = store.begin(one);
    const bound = store.complete(one, first.attempt, 'nango-confluence-one', cloud, 'atlassian-account-one', 'https://fixture.atlassian.net');
    expect(store.current(two)).toBeUndefined();
    expect(() => store.requireCurrent({ ...bound.binding, principal_id: two.principal_id, membership_id: two.membership_id })).toThrow(expect.objectContaining({ code: 'stale_access_state' }));
    const second = store.begin(two);
    expect(() => store.complete(two, second.attempt, 'nango-confluence-one', cloud, 'atlassian-account-two', 'https://fixture.atlassian.net')).toThrow(expect.objectContaining({ code: 'unauthorized' }));
    store.revoke(one);
    expect(() => store.requireCurrent(bound.binding)).toThrow(expect.objectContaining({ code: 'stale_access_state' }));
    expect(JSON.stringify(db.prepare('SELECT * FROM confluence_person_binding_v1').all())).not.toContain('access_token');
  } finally { db.close(); }
});
