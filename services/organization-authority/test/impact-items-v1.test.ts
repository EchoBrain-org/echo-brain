import { canonicalSha256 } from '@echo-brain/federation-protocol';
import { describe, expect, it } from 'vitest';
import { SqliteImpactItemsV1, type ImpactItemDraftV1, type ImpactItemRowV1, type ImpactSendChoiceV1 } from '../src/adapters/persistence/sqlite/impact-items-v1.js';
import { addMembership, revokeMembership } from './fixtures/project-context-sqlite.js';
import { approvedRunFixture } from './fixtures/trigger-runs.js';

/** The approval fixture's person: the approver of every run here. */
const ARI = 'mem_00000000-0000-4000-8000-000000000004';
const MINA = { principal_id: 'prn_00000000-0000-4000-8000-00000000a1a1', membership_id: 'mem_00000000-0000-4000-8000-00000000a1a2' };
const RAFAEL = { principal_id: 'prn_00000000-0000-4000-8000-00000000b2b1', membership_id: 'mem_00000000-0000-4000-8000-00000000b2b2' };
const card = () => ({ json: '{"schema_version":1}', sha256: canonicalSha256({ schema_version: 1 }) });

/** A Jira ticket as an impact card stores its pointer: no title and no text. */
const draft = (key: string, changes: Partial<ImpactItemDraftV1> = {}): ImpactItemDraftV1 => ({
  item_key: canonicalSha256({ kind: 'ticket', primary_id: `ECHO-${key}` }),
  pointer: { kind: 'ticket', tool_id: 'jira', external_scope_id: 'cloud', ticket_id: key, permalink: `https://example.test/browse/ECHO-${key}`, text_sha256: canonicalSha256(`ECHO-${key}`) },
  relation: 'needs_updating', expected: 'launch next week', owner_membership_id: ARI, owner_match: 'approver', ...changes,
});
const ids = (rows: readonly ImpactItemRowV1[]) => rows.map(row => row.item_id);

/** One approved-record run per entry of `keys`, finished in turn a minute apart; `keys[n]` become run n's items in its finishing transaction. */
async function finishedRunsFixture(keys: readonly (readonly string[])[]) {
  const f = await approvedRunFixture({ runs: keys.length });
  if (f.owner.membership_id !== ARI) throw new Error('the approval fixture person changed');
  for (const [person, name] of [[MINA, 'Mina Patel'], [RAFAEL, 'Rafael Moreno']] as const) {
    addMembership(f.db, { organization_id: f.owner.organization_id, ...person, membership_type: 'employee' }, name, `${name.split(' ')[0]!.toLowerCase()}@example.test`);
  }
  const items = new SqliteImpactItemsV1(f.db, f.clock);
  const runs = [...f.runs.list(f.owner, keys.length)].reverse();
  for (const [index, run] of runs.entries()) {
    const lease = f.runs.claim(f.owner, run.run_id, 600_000);
    if (lease.kind !== 'claimed') throw new Error('expected lease');
    f.advance(60_000);
    const drafts = keys[index]!.map(key => draft(key));
    if (!f.runs.finish(run.run_id, lease.lease_token, card(), drafts.length === 0 ? undefined : transaction => items.insertForRun(transaction, run, drafts))) throw new Error('expected finish');
  }
  return {
    ...f, items, mina: MINA.membership_id, rafael: RAFAEL.membership_id,
    finished: runs.map(run => f.runs.read(f.owner, run.run_id)!),
    revoke: (person: typeof MINA) => revokeMembership(f.db, { organization_id: f.owner.organization_id, ...person, membership_type: 'employee' }),
  };
}
/** One approved-record run finished with a stored card and `keys` as its items. */
async function doneRunFixture(keys: readonly string[] = []) {
  const f = await finishedRunsFixture([keys]);
  return { ...f, run: f.finished[0]! };
}
const doneRunWithItems = (keys: readonly string[]) => doneRunFixture(keys);
/** One item sent to Mina, and a pending sweep of the approver's. */
async function sentItemFixture() {
  const f = await doneRunWithItems(['46']);
  const [item] = f.items.forRun(f.run.run_id);
  const sent = f.items.send({ run_id: f.run.run_id, by: f.owner.membership_id, command_id: 'cmd-send', choices: [{ item_id: item!.item_id, include: true, owner_membership_id: f.mina }] });
  if (sent.kind !== 'sent') throw new Error('expected a send');
  return { ...f, itemId: item!.item_id, sweepRunId: f.runs.enqueueSweep(f.owner, { kind: 'mine' }).run_id };
}

describe('SQLite open items v1', () => {
  it('inserts unsent items only for a done approved-record run of the same record and approver', async () => {
    const f = await doneRunFixture();
    f.db.transaction(() => f.items.insertForRun(f.db, f.run, [draft('46'), draft('47')]))();
    expect(f.items.forRun(f.run.run_id).map(row => row.state)).toEqual(['unsent', 'unsent']);
    const pending = await approvedRunFixture();
    expect(() => pending.db.transaction(() => f.items.insertForRun(pending.db, pending.runs.list(pending.owner, 1)[0]!, [draft('46')]))()).toThrow('starts unsent');
    expect(() => f.db.transaction(() => f.items.insertForRun(f.db, { ...f.run, actor: f.stranger }, [draft('48')]))()).toThrow('starts unsent');
    expect(() => f.db.transaction(() => f.items.insertForRun(f.db, f.run, [draft('48', { owner_match: 'picked' as never })]))()).toThrow('starts unsent');
    expect(() => f.items.insertForRun(f.db, f.run, [draft('48')])).toThrow('transaction');
  });

  it('stores the pointer, relation, phrase and owner, and an expected phrase only with a relation', async () => {
    const f = await doneRunFixture();
    f.db.transaction(() => f.items.insertForRun(f.db, f.run, [draft('46', { owner_membership_id: f.mina, owner_match: 'jira_account' }), draft('47', { relation: 'conflicts', expected: null }), draft('48', { relation: null, expected: null })]))();
    const rows = f.items.forRun(f.run.run_id);
    expect(rows).toHaveLength(3);
    expect(rows.find(row => row.pointer.ticket_id === '46')).toMatchObject({
      run_id: f.run.run_id, item_key: draft('46').item_key, pointer: draft('46').pointer, record_sha256: f.recordSha256, organization_id: f.owner.organization_id,
      approver: { principal_id: f.owner.principal_id, membership_id: ARI }, relation: 'needs_updating', expected: 'launch next week',
      owner_membership_id: f.mina, owner_match: 'jira_account', state: 'unsent', state_set_by: null, state_set_at: null, sent_at: null, send_command_id: null, check: null,
      created_at: f.clock().toISOString(), updated_at: f.clock().toISOString(),
    });
    expect(rows.find(row => row.pointer.ticket_id === '47')).toMatchObject({ relation: 'conflicts', expected: null });
    expect(f.items.read(rows[0]!.item_id)).toEqual(rows[0]);
    expect(f.items.read('itm_missing')).toBeUndefined();
    expect(() => f.db.transaction(() => f.items.insertForRun(f.db, f.run, [draft('49', { relation: null, expected: 'launch next week' })]))()).toThrow();
    expect(() => f.db.transaction(() => f.items.insertForRun(f.db, f.run, [draft('46')]))()).toThrow('UNIQUE');
  });

  it('sends once per command, refuses a stale list, and marks unticked items not relevant', async () => {
    const f = await doneRunWithItems(['46', '47']);
    const [a, b] = f.items.forRun(f.run.run_id);
    expect(f.items.send({ run_id: f.run.run_id, by: f.owner.membership_id, command_id: 'cmd-1', choices: [{ item_id: a!.item_id, include: true }] })).toEqual({ kind: 'stale' });
    const choices = [{ item_id: a!.item_id, include: true, owner_membership_id: f.mina }, { item_id: b!.item_id, include: false }];
    expect(f.items.send({ run_id: f.run.run_id, by: f.owner.membership_id, command_id: 'cmd-1', choices })).toEqual({ kind: 'sent', sent: 1, not_relevant: 1 });
    expect(f.items.send({ run_id: f.run.run_id, by: f.owner.membership_id, command_id: 'cmd-1', choices })).toEqual({ kind: 'replayed', sent: 1, not_relevant: 1 });
    expect(f.items.send({ run_id: f.run.run_id, by: f.owner.membership_id, command_id: 'cmd-2', choices })).toEqual({ kind: 'stale' });
    expect(f.items.read(a!.item_id)).toMatchObject({ state: 'open', owner_membership_id: f.mina, owner_match: 'picked' });
    expect(f.items.read(b!.item_id)).toMatchObject({ state: 'not_relevant' });
  });

  it('refuses a send that names an item twice or one of another run, and writes nothing', async () => {
    const f = await doneRunWithItems(['46', '47']);
    const [a, b] = f.items.forRun(f.run.run_id);
    const send = (choices: readonly ImpactSendChoiceV1[]) => f.items.send({ run_id: f.run.run_id, by: f.owner.membership_id, command_id: 'cmd-1', choices });
    expect(send([{ item_id: a!.item_id, include: true }, { item_id: a!.item_id, include: false }])).toEqual({ kind: 'stale' });
    expect(send([{ item_id: a!.item_id, include: true }, { item_id: b!.item_id, include: true }, { item_id: 'itm_elsewhere', include: true }])).toEqual({ kind: 'stale' });
    expect(f.items.send({ run_id: 'run_missing', by: f.owner.membership_id, command_id: 'cmd-1', choices: [] })).toEqual({ kind: 'stale' });
    expect(f.items.forRun(f.run.run_id).map(row => row.state)).toEqual(['unsent', 'unsent']);
    f.advance(1_000);
    expect(send([{ item_id: a!.item_id, include: true, owner_membership_id: ARI }, { item_id: b!.item_id, include: true }])).toEqual({ kind: 'sent', sent: 2, not_relevant: 0 });
    expect(f.items.read(a!.item_id)).toMatchObject({ state: 'open', owner_membership_id: ARI, owner_match: 'approver', sent_at: f.clock().toISOString(), send_command_id: 'cmd-1', state_set_by: ARI, state_set_at: f.clock().toISOString() });
  });

  it('changes the state or owner only of a sent item', async () => {
    const f = await doneRunWithItems(['46', '47']);
    const [a, b] = f.items.forRun(f.run.run_id);
    expect(f.items.setState(a!.item_id, 'done', ARI)).toBeUndefined();
    expect(f.items.read(a!.item_id)).toMatchObject({ state: 'unsent', state_set_by: null });
    f.items.send({ run_id: f.run.run_id, by: ARI, command_id: 'cmd-1', choices: [{ item_id: a!.item_id, include: true, owner_membership_id: f.mina }, { item_id: b!.item_id, include: true }] });
    f.advance(60_000);
    expect(f.items.setState(a!.item_id, 'done', f.mina)).toMatchObject({ state: 'done', state_set_by: f.mina, state_set_at: f.clock().toISOString(), owner_match: 'picked' });
    expect(f.items.setState(a!.item_id, 'open', ARI)).toMatchObject({ state: 'open', state_set_by: ARI });
    expect(f.items.setState('itm_missing', 'done', ARI)).toBeUndefined();
    expect(f.items.assign(b!.item_id, f.rafael, ARI)).toMatchObject({ owner_membership_id: f.rafael, owner_match: 'reassigned', state: 'open' });
    expect(f.db.prepare('SELECT owner_set_by, owner_set_at FROM authority_impact_items_v1 WHERE item_id=?').get(b!.item_id)).toEqual({ owner_set_by: ARI, owner_set_at: f.clock().toISOString() });
    expect(f.items.assign('itm_missing', f.rafael, ARI)).toBeUndefined();
  });

  it('never moves an item back to unsent, keeps identity frozen, and keeps only a newer check', async () => {
    const f = await sentItemFixture();
    expect(() => f.db.prepare("UPDATE authority_impact_items_v1 SET state='unsent', sent_at=NULL, send_command_id=NULL WHERE item_id=?").run(f.itemId)).toThrow();
    expect(() => f.db.prepare("UPDATE authority_impact_items_v1 SET expected='something else' WHERE item_id=?").run(f.itemId)).toThrow('immutable');
    expect(() => f.db.prepare('DELETE FROM authority_impact_items_v1 WHERE item_id=?').run(f.itemId)).toThrow('denied');
    expect(f.db.transaction(() => f.items.recordCheck(f.db, { item_id: f.itemId, verdict: 'landed', by: f.owner.membership_id, at: '2026-10-08T10:00:00.000Z', run_id: f.sweepRunId }))()).toBe(true);
    expect(f.db.transaction(() => f.items.recordCheck(f.db, { item_id: f.itemId, verdict: 'changed', by: f.owner.membership_id, at: '2026-10-08T09:00:00.000Z', run_id: f.sweepRunId }))()).toBe(false);
    expect(f.db.transaction(() => f.items.recordCheck(f.db, { item_id: f.itemId, verdict: 'changed', by: f.mina, at: '2026-10-08T10:00:00.000Z', run_id: f.sweepRunId }))()).toBe(false);
    expect(f.items.read(f.itemId)!.check).toMatchObject({ verdict: 'landed' });
    expect(f.items.read(f.itemId)).toMatchObject({ state: 'open', check: { verdict: 'landed', by: f.owner.membership_id, at: '2026-10-08T10:00:00.000Z', run_id: f.sweepRunId } });
    expect(f.db.transaction(() => f.items.recordCheck(f.db, { item_id: f.itemId, verdict: 'changed', by: f.mina, at: '2026-10-08T11:00:00.000Z', run_id: f.sweepRunId }))()).toBe(true);
    expect(f.items.read(f.itemId)!.check).toEqual({ verdict: 'changed', by: f.mina, at: '2026-10-08T11:00:00.000Z', run_id: f.sweepRunId });
    expect(() => f.db.prepare('UPDATE authority_impact_items_v1 SET checked_at=? WHERE item_id=?').run('2026-10-08T10:30:00.000Z', f.itemId)).toThrow('newer');
    expect(() => f.items.recordCheck(f.db, { item_id: f.itemId, verdict: 'landed', by: f.mina, at: '2026-10-08T12:00:00.000Z', run_id: f.sweepRunId })).toThrow('transaction');
    expect(() => f.db.transaction(() => f.items.recordCheck(f.db, { item_id: f.itemId, verdict: 'landed', by: f.mina, at: '2026-10-08T12:00Z', run_id: f.sweepRunId }))()).toThrow();
  });

  it('finds items by person and by record', async () => {
    const f = await sentItemFixture();
    const org = f.owner.organization_id;
    expect(ids(f.items.involving(org, f.mina, { states: ['open'], limit: 10 }))).toEqual([f.itemId]);
    expect(ids(f.items.involving(org, ARI, { states: ['open'], limit: 10 }))).toEqual([f.itemId]);
    expect(f.items.involving(org, f.rafael, { states: ['unsent', 'open', 'done', 'not_relevant'], limit: 10 })).toEqual([]);
    expect(f.items.involving(org, f.mina, { states: ['done', 'not_relevant'], limit: 10 })).toEqual([]);
    expect(f.items.involving('org_other', f.mina, { states: ['open'], limit: 10 })).toEqual([]);
    expect(ids(f.items.forRecords([f.recordSha256], { states: ['open'], limit: 10 }))).toEqual([f.itemId]);
    expect(f.items.forRecords([], { states: ['open'], limit: 10 })).toEqual([]);
  });

  it('lists an unsent or open item as orphaned only once its approver and its owner are both inactive', async () => {
    const f = await doneRunWithItems(['46', '47']);
    const org = f.owner.organization_id;
    const [mine, rafaels] = f.items.forRun(f.run.run_id);
    f.items.send({ run_id: f.run.run_id, by: ARI, command_id: 'cmd-1', choices: [{ item_id: mine!.item_id, include: true, owner_membership_id: f.mina }, { item_id: rafaels!.item_id, include: true, owner_membership_id: f.rafael }] });
    expect(f.items.orphaned(org, { limit: 10 })).toEqual([]);
    f.revoke(MINA);
    expect(f.items.orphaned(org, { limit: 10 })).toEqual([]);
    f.revokeReviewer();
    expect(ids(f.items.orphaned(org, { limit: 10 }))).toEqual([mine!.item_id]);
    expect(f.items.orphaned('org_other', { limit: 10 })).toEqual([]);
    expect(f.items.setState(mine!.item_id, 'done', ARI)).toMatchObject({ state: 'done' });
    expect(f.items.orphaned(org, { limit: 10 })).toEqual([]);
  });

  it('pages the items of several decisions oldest first', async () => {
    const f = await finishedRunsFixture([['46', '47'], ['48', '49']]);
    const records = f.finished.map(run => run.record_sha256!);
    const all = f.items.forRecords(records, { states: ['unsent'], limit: 10 });
    expect(all.map(row => row.pointer.ticket_id).slice(0, 2).sort()).toEqual(['46', '47']);
    expect(all.map(row => [row.created_at, row.item_id])).toEqual(all.map(row => [row.created_at, row.item_id]).sort());
    const first = f.items.forRecords(records, { states: ['unsent'], limit: 3 });
    const last = first[first.length - 1]!;
    const second = f.items.forRecords(records, { states: ['unsent'], limit: 3, after: { created_at: last.created_at, item_id: last.item_id } });
    expect(ids([...first, ...second])).toEqual(ids(all));
    expect(second).toHaveLength(1);
    expect(f.items.forRecords([records[1]!], { states: ['unsent'], limit: 10 }).map(row => row.pointer.ticket_id).sort()).toEqual(['48', '49']);
    expect(f.items.forRecords(records, { states: ['open'], limit: 10 })).toEqual([]);
    expect(f.items.forRecords(records, { states: ['unsent'], limit: 0 })).toEqual([]);
  });
});
