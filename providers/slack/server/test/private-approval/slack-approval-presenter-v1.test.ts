import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { createSlackApprovalPresenterV1 } from '../../src/private-approval/slack-approval-presenter-v1.js';

const databases: Database.Database[] = [];
const signal = () => new AbortController().signal;
const target = { connection_id: 'con_1', external_identity_link_id: 'lnk_1', external_identity_link_contract_sha256: `sha256:${'a'.repeat(64)}`, slack_workspace_id: 'T1', slack_subject_id: 'U1', api_app_id: 'A1' };
afterEach(() => databases.splice(0).forEach(db => db.close()));
function fixture() {
  const db = new Database(':memory:'); databases.push(db);
  db.exec(`CREATE TABLE authority_live_approval_outbox_v2(approval_id TEXT PRIMARY KEY,state TEXT,updated_at TEXT);
    CREATE TABLE authority_approval_decisions_v1(approval_id TEXT PRIMARY KEY,action TEXT);
    CREATE TABLE authority_approval_presentations_v1(approval_id TEXT,surface TEXT,target_json TEXT,dm_channel_id TEXT,delivery TEXT,message_ts TEXT,card_sha256 TEXT,shows TEXT,attempts INTEGER,retry_at TEXT,created_at TEXT,updated_at TEXT,PRIMARY KEY(approval_id,surface));`);
  const calls: string[] = [];
  const presenter = createSlackApprovalPresenterV1({ database: db, core: { proposal: () => undefined, ownerProposals: () => [] }, target: () => target, targetCurrent: () => true,
    projects: () => [], now: () => new Date('2026-10-07T00:00:00.000Z'), poster: {
      async openDirectMessage() { calls.push('open'); return { kind: 'opened', channel_id: 'D1' } as const; },
      async postMarker() { calls.push('post'); return { kind: 'posted', provider_message_ts: '1.000001' } as const; },
      async reconcileMarker() { calls.push('reconcile'); return { kind: 'posted', provider_message_ts: '1.000001' } as const; },
      async publish() { calls.push('publish'); return { kind: 'done' } as const; },
    } });
  return { db, calls, presenter };
}
describe('Slack approval presenter V1', () => {
  it('does not retry a persisted posting row before retry_at', async () => {
    const f = fixture();
    f.db.prepare("INSERT INTO authority_live_approval_outbox_v2 VALUES ('apr_retry','staged','2026-10-07T00:00:00.000Z')").run();
    f.db.prepare(`INSERT INTO authority_approval_presentations_v1 VALUES ('apr_retry','slack',?,'D1','posting',NULL,NULL,'open',1,'2026-10-07T00:01:00.000Z','2026-10-07T00:00:00.000Z','2026-10-07T00:00:00.000Z')`).run(JSON.stringify(target));
    expect(await f.presenter.reconcile(signal())).toBe('idle');
    expect(f.calls).toEqual([]);
  });
  it('reconciles a crash-left posting marker without a blind second post', async () => {
    const f = fixture();
    f.db.prepare("INSERT INTO authority_live_approval_outbox_v2 VALUES ('apr_crash','staged','2026-10-06T23:59:00.000Z')").run();
    f.db.prepare(`INSERT INTO authority_approval_presentations_v1 VALUES ('apr_crash','slack',?,'D1','posting',NULL,NULL,'open',0,NULL,'2026-10-06T23:59:00.000Z','2026-10-06T23:59:00.000Z')`).run(JSON.stringify(target));
    expect(await f.presenter.reconcile(signal())).toBe('rendered');
    expect(f.calls).toEqual(['reconcile', 'publish']);
    expect(f.db.prepare(`SELECT delivery,shows,card_sha256 FROM authority_approval_presentations_v1 WHERE approval_id='apr_crash'`).get()).toMatchObject({ delivery: 'posted', shows: 'superseded' });
  });
});
