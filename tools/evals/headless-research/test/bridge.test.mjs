import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, FIXTURE_ITEMS } from '../fixtures.mjs';
import { createBridge } from '../bridge.mjs';
import { sdkResearch } from '../research.mjs';
import { AGENTIC_RESEARCH_LIVE_BUDGET_V1 as budget } from '../core.mjs';

const brief = (extra = {}) => ({ goal: { kind: 'question', question: 'Synthetic check' }, starting: [], budget, options: {}, ...extra });
const output = (evidence, kind = 'content') => ({ completed: true, parts: [{ question: 'Synthetic check', notes: '', needs: [{ need: 'evidence', status: 'found', kind, evidence }] }] });
async function setup(options, goal) { const f = fixture(options), bridge = createBridge(f, brief(goal)); const initial = await bridge.initialize(); return { f, bridge, initial }; }

test('catalog and client time are inherited; Mine and disconnected tools remain restricted', async () => {
  for (const options of [{}, { scope: 'mine' }, { connected: false }]) {
    const { f, initial } = await setup(options);
    assert.deepEqual(initial.source_catalog, f.catalog.entries);
    assert.equal(initial.context.time_zone, 'America/Los_Angeles');
    if (options.scope === 'mine' || options.connected === false) assert.equal(initial.source_catalog.some(s => s.source === 'tickets'), false);
  }
});
test('project scope cannot see the other project; unsupported sources fail closed', async () => {
  const { bridge } = await setup({ scope: 'project' });
  const rows = await bridge.call('list', { source: 'projects' });
  assert.deepEqual(rows.items.map(i => i.title), ['Atlas']);
  const mine = (await setup({ scope: 'mine' })).bridge;
  await assert.rejects(mine.call('list', { source: 'tickets' }), /not available/);
});
test('metadata exposes request ids, never server ids, receipts or source credentials', async () => {
  const { bridge } = await setup();
  const rows = await bridge.call('list', { source: 'tickets' });
  assert.equal(rows.items[0].id, 'E1'); assert.equal(rows.items[0].text, undefined);
  const encoded = JSON.stringify(rows);
  for (const forbidden of ['private_desk_', 'receipt_sha256', 'ticket_id', 'next_cursor']) assert.equal(encoded.includes(forbidden), false);
  await assert.rejects(bridge.call('open', { id: 'private_desk_ticket-1' }), /E id/);
  const opened = await bridge.call('open', { id: 'E1' });
  assert.match(opened.items[0].text, /DEMO-1/);
});
test('five pages preserve all 105 unique tickets and only then prove list completeness', async () => {
  const { bridge } = await setup(); let page;
  for (let n = 0; n < 5; n++) {
    page = await bridge.call('list', { source: 'tickets' });
    assert.equal(page.list.id, 'L1'); assert.equal(page.list.complete, n === 4);
  }
  assert.equal(page.list.members.length, 105); assert.equal(new Set(page.list.members).size, 105);
  const bundle = await bridge.bundle(output(['L1'], 'which_items'));
  assert.equal(bundle.lists[0].complete, true); assert.equal(bundle.items.length, 105);
});
test('unknown evidence, incomplete enumeration and metadata-only content cannot be marked found', async () => {
  const { bridge } = await setup(); await bridge.call('list', { source: 'tickets' });
  await assert.rejects(bridge.bundle(output(['E999'])), /Unknown evidence/);
  await assert.rejects(bridge.bundle(output(['L1'], 'which_items')), /complete list/);
  await assert.rejects(bridge.bundle(output(['E1'])), /released text/);
});
test('unsupported status filters return an actionable tool error without reading tickets', async () => {
  const { f, bridge } = await setup();
  await assert.rejects(bridge.call('list', { source: 'tickets', status: 'open' }), /Unsupported status/);
  assert.equal(f.reads(), 0);
});
test('yesterday uses client-local dates across the UTC midnight boundary', async () => {
  const { bridge } = await setup();
  const rows = await bridge.call('list', { source: 'meetings', since: '2026-10-19', until: '2026-10-19', date_field: 'occurred' });
  assert.equal(rows.items.length, 2);
  assert.ok(rows.items.every(i => i.dates.occurred.startsWith('2026-10-19')));
});
test('revocation during a read releases no result and stops the request', async () => {
  const { bridge } = await setup({ revokeAfter: 1 });
  await assert.rejects(bridge.call('list', { source: 'projects' }), /access_revoked/);
  await assert.rejects(bridge.bundle(output(['E1'])), /access_revoked/);
});
test('revocation before finalization prevents the bundle from reaching the renderer', async () => {
  const { f, bridge } = await setup(); await bridge.call('list', { source: 'projects' }); f.revoke();
  await assert.rejects(bridge.bundle(output(['E1'])), /access_revoked/);
});
test('cancellation stops further tools', async () => {
  const controller = new AbortController(), bridge = createBridge(fixture(), brief(), { signal: controller.signal });
  await bridge.initialize(); controller.abort(new Error('cancelled'));
  await assert.rejects(bridge.call('list', { source: 'projects' }), /cancelled/);
});
test('starting evidence, slot filling and planner=false preserve the sweep path without an SDK call', async () => {
  const start = FIXTURE_ITEMS.find(i => i.kind === 'ticket');
  const task = brief({ goal: { kind: 'task', task: 'Recheck {{starting:1}}' }, starting: [{ citation: start.citation, if_unreadable: 'report' }], options: { planner: false, list: false } });
  const { bundle, metrics } = await sdkResearch(fixture(), task);
  assert.equal(bundle.goal.task, 'Recheck E1'); assert.equal(bundle.items[0].preloaded, true);
  assert.equal(metrics.model_calls, 0); assert.equal(bundle.stop.completed, true);
  assert.equal(bundle.lists, undefined);
});
test('a trigger that disables list cannot accidentally acquire it', async () => {
  const { bridge } = await setup({}, { goal: { kind: 'task', task: 'Research a decision' }, options: { list: false } });
  await assert.rejects(bridge.call('list', { source: 'projects' }), /list_disabled/);
});
test('a production desk cannot be passed accidentally to this synthetic prototype', () => {
  assert.throws(() => createBridge({ desk: {} }, brief()), /Only synthetic/);
});
