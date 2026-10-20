import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startModelFence } from '../model-fence.mjs';
import { stagingReader, STAGING_ORIGIN } from '../staging-reader.mjs';

function fakeClient() {
  const state = { revoked: false, owner: 'one', text: 'Approved checklist task.', ids: [] };
  const client = {
    sessionSummary: () => ({ authority_origin: STAGING_ORIGIN, authority_id: 'a', organization_id: 'o', principal_id: state.owner, membership_id: state.owner, display_name: 'Synthetic owner' }),
    changes: async () => { if (state.revoked) throw new Error('revoked'); return {}; },
    list: async ({ cursor }) => ({ items: [{ ref: cursor ? 'note:two' : 'note:one', kind: 'note', title: cursor ? 'Two' : 'One' }], next_cursor: cursor ? null : 'page2' }),
    open: async ({ ref, cursor }) => { state.ids.push(ref); return { ref, text: state.text, next_cursor: cursor ? null : 'open2' }; },
    projectsV2: async () => ({ items: [{ project_id: 'p1', name: 'Project', status: 'active' }], next_cursor: null }),
    projectMembers: async () => ({ items: [{ display_name: 'Lead', role: 'lead' }], next_cursor: null }),
  };
  return { state, client };
}
test('staging reader follows pages and refuses guessed record/project ids', async () => {
  const { client, state } = fakeClient(), reader = stagingReader(client);
  const rows = await reader.call('list_records', {}); assert.equal(rows.items.length, 2);
  await assert.rejects(reader.call('open_record', { id: 'S999' }), /unknown_record/);
  await assert.rejects(reader.call('project_members', { id: 'S1' }), /unknown_project/);
  const opened = await reader.call('open_record', { id: rows.items[0].id });
  assert.equal(opened.content.length, 2); assert.ok(state.ids.every(id => id === 'note:one'));
  const listedAgain = await reader.call('list_records', {}); assert.equal(listedAgain.items[0].kind, 'record_body');
  assert.throws(() => reader.validateAnswer({ status: 'answered', statements: [{ text: 'Invented', evidence: ['S999'] }], missing: [] }), /invalid_citation/);
});
test('staging reader stops permanently on access loss, changed evidence or account switch', async () => {
  for (const change of ['revoked', 'text', 'owner']) {
    const { client, state } = fakeClient(), reader = stagingReader(client);
    const rows = await reader.call('list_records', {}); await reader.call('open_record', { id: rows.items[0].id });
    state[change] = change === 'revoked' ? true : 'changed';
    await assert.rejects(reader.check(), /staging_access_stopped|staging_identity_changed/);
    assert.throws(() => reader.validateAnswer({ status: 'answered', statements: [{ text: 'Old', evidence: ['S1'] }], missing: [] }));
    state.revoked = false; state.owner = 'one'; state.text = 'Approved checklist task.';
    await assert.rejects(reader.check());
  }
});
test('staging reader refuses other origins and incomplete source reads', async () => {
  const { client } = fakeClient();
  assert.throws(() => stagingReader({ ...client, sessionSummary: () => ({ authority_origin: 'https://other.example' }) }), /staging_only/);
  const reader = stagingReader({ ...client, list: async () => ({ items: [], next_cursor: null, notice: 'unavailable' }) });
  await assert.rejects(reader.call('list_records', {}), /staging_read_incomplete/);
});
test('model fence checks every request, including retry and token counting, and latches denial', async () => {
  let calls = 0, sent = 0, reject = false;
  const fence = await startModelFence({ check: async () => { calls++; if (reject) throw new Error('revoked'); }, forward: async ({ res }) => { sent++; res.writeHead(200); res.end('{}'); } });
  try {
    const base = fence.environment().ANTHROPIC_BASE_URL;
    for (const path of ['/v1/messages?beta=true', '/v1/messages?beta=true', '/v1/messages/count_tokens']) assert.equal((await fetch(`${base}${path}`, { method: 'POST', body: '{}' })).status, 200);
    assert.equal(calls, 3); assert.equal(sent, 3);
    reject = true; assert.equal((await fetch(`${base}/v1/messages`, { method: 'POST', body: '{}' })).status, 403);
    reject = false; assert.equal((await fetch(`${base}/v1/messages`, { method: 'POST', body: '{}' })).status, 403);
    assert.equal(sent, 3); assert.equal(fence.stats().denied, 2);
  } finally { fence.close(); }
});
test('model fence refuses unrecognized routes without forwarding data', async () => {
  let sent = 0;
  const fence = await startModelFence({ check: async () => {}, forward: async () => { sent++; } });
  try {
    const base = fence.environment().ANTHROPIC_BASE_URL;
    for (const path of ['/v1/anything', '/../v1/messages']) assert.equal((await fetch(`${base}${path}`, { method: 'POST', body: '{}' })).status, 404);
    assert.equal(sent, 0);
  } finally { fence.close(); }
});
test('revocation during the request check sends no body upstream', async () => {
  const abort = new AbortController(); let sent = 0;
  const fence = await startModelFence({ signal: abort.signal, check: async () => { abort.abort(); }, forward: async () => { sent++; } });
  const base = fence.environment().ANTHROPIC_BASE_URL;
  try { await fetch(`${base}/v1/messages`, { method: 'POST', body: 'synthetic private source' }); } catch { /* Closed socket is the expected fail-closed result. */ }
  assert.equal(sent, 0); assert.equal(fence.stats().stopped, true); fence.close();
});
