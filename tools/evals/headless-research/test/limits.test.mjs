import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unlimitedCore, stripSizeBounds } from '../unlimited-core.mjs';
import { createBridge } from '../bridge.mjs';
import { limitFixture, assessLimit } from '../limit-fixtures.mjs';
import { UNLIMITED_BUDGET } from '../limit-trial.mjs';

const brief = { goal: { kind: 'question', question: 'Synthetic size proof' }, starting: [], options: {}, budget: UNLIMITED_BUDGET };
test('unbounded tools return all rows and still reject unknown sources and invented evidence', async () => {
  const core = await unlimitedCore(), f = limitFixture('open_items', true);
  const b = createBridge(f, brief, { unbounded: true, parsePlan: core.parseStep });
  await b.initialize();
  const listed = await b.call('list', { source: 'tickets' });
  assert.equal(listed.items.length, 105); assert.equal(listed.more, false); assert.equal(listed.list.complete, true);
  await assert.rejects(b.call('open', { id: 'E999' }), /E id/);
  await assert.rejects(b.call('list', { source: 'secret' }), /not available/);
  f.revoke(); await assert.rejects(b.check(), /access_revoked/);
});
test('the unbounded plan retains more than 5 parts, 6 needs, 12 citations and 800 note characters', async () => {
  const { parseStep } = await unlimitedCore();
  const parts = Array.from({ length: 8 }, (_, p) => ({ question: `Part ${p}`, notes: 'n'.repeat(1600), needs: Array.from({ length: 9 }, (_, n) => ({ need: `Need ${n}`, kind: 'content', status: 'found', evidence: Array.from({ length: 20 }, (_, e) => `E${e + 1}`) })) }));
  const result = parseStep({ parts, actions: [] }, { lists: true });
  assert.equal(result.parts.length, 8); assert.equal(result.parts[0].needs.length, 9);
  assert.equal(result.parts[0].needs[0].evidence.length, 20); assert.equal(result.parts[0].notes.length, 1600);
});
test('citing a metadata-only member beside a complete list does not promote it to writer text', async () => {
  const core = await unlimitedCore(), f = limitFixture('open_items', true), b = createBridge(f, brief, { unbounded: true, parsePlan: core.parseStep });
  await b.initialize(); await b.call('list', { source: 'tickets' });
  const bundle = await b.bundle({ completed: true, parts: [{ question: 'All', notes: '', needs: [{ need: 'all tickets', kind: 'which_items', status: 'found', evidence: ['L1', 'E1'] }] }] });
  assert.equal(bundle.items[0].full, false); assert.equal(bundle.items[0].cited_by_plan, false);
  const coreRenderer = core.createAskRendererV1({ response_version: 8, answer_prompt: core.ANSWER_PROMPT, source_catalog: f.catalog.entries, scope: 'synthetic', context: f.context, desk_scope: f.desk.scope });
  await coreRenderer.render({ bundle, trigger_input: { question: 'List tickets.' }, signal: new AbortController().signal, remaining: () => Infinity, prompt_budget: () => Infinity,
    gate: { stats: () => ({ calls: 0, stopped: false }), withRepair: async (_r, _s, user, _sc, _t, parse) => {
      assert.equal(user.evidence.length, 0); return parse({ lists: [{ id: 'L1' }], sentences: [], not_found: [] });
    } } });
});
test('schema size caps are removed recursively without removing required fields or types', () => {
  assert.deepEqual(stripSizeBounds({ type: 'object', required: ['a'], properties: { a: { type: 'array', maxItems: 5, items: { type: 'string', maxLength: 10 } } } }),
    { type: 'object', required: ['a'], properties: { a: { type: 'array', items: { type: 'string' } } } });
});
test('uncapped real renderer sees all 105 rows and names/cites all 60 projects', async () => {
  const core = await unlimitedCore();
  for (const [name, source, total] of [['open_items', 'tickets', 105], ['roster', 'projects', 60]]) {
    const f = limitFixture(name, true), b = createBridge(f, brief, { unbounded: true, parsePlan: core.parseStep });
    await b.initialize(); await b.call('list', { source });
    const bundle = await b.bundle({ completed: true, parts: [{ question: 'All', notes: '', needs: [{ need: 'all', kind: 'which_items', status: 'found', evidence: ['L1'] }] }] });
    const renderer = core.createAskRendererV1({ response_version: 8, answer_prompt: core.ANSWER_PROMPT, source_catalog: f.catalog.entries, scope: 'synthetic', context: f.context, desk_scope: f.desk.scope });
    const result = await renderer.render({ bundle, trigger_input: { question: 'List every item.' }, signal: new AbortController().signal, remaining: () => Infinity, prompt_budget: () => Infinity,
      gate: { stats: () => ({ calls: 0, stopped: false }), withRepair: async (_r, _s, user, _sc, _t, parse) => {
        assert.equal(user.lists[0].members.length, total);
        return parse({ lists: [{ id: 'L1' }], sentences: [], not_found: [] });
      } } });
    assert.equal(result.result.response.citations.length, total);
    assert.equal(result.outcome, 'answered');
    assert.doesNotMatch(result.result.response.parts[0].statements[0].text, /and \d+ more/);
  }
});
test('the uncapped renderer accepts more than ten statements and a response exceeding 64 KiB', async () => {
  const core = await unlimitedCore(), f = limitFixture('roster', true), b = createBridge(f, brief, { unbounded: true, parsePlan: core.parseStep });
  await b.initialize(); const listed = await b.call('list', { source: 'projects' });
  const bundle = await b.bundle({ completed: true, parts: [{ question: 'Details', notes: '', needs: [{ need: 'details', kind: 'content', status: 'found', evidence: listed.items.map(i => i.id) }] }] });
  const renderer = core.createAskRendererV1({ response_version: 8, answer_prompt: core.ANSWER_PROMPT, source_catalog: f.catalog.entries, scope: 'synthetic', context: f.context, desk_scope: f.desk.scope });
  const result = await renderer.render({ bundle, trigger_input: { question: 'Give every detail.' }, signal: new AbortController().signal, remaining: () => Infinity, prompt_budget: () => Infinity,
    gate: { stats: () => ({ calls: 0, stopped: false }), withRepair: async (_r, _s, _u, _sc, _t, parse) => parse({ lists: [], not_found: [], sentences: listed.items.map((i, n) => ({ text: `${n}: ${'Synthetic output size validation. '.repeat(180)}`, evidence: [i.id] })) }) } });
  assert.equal(result.result.response.parts[0].statements.length, 60);
  assert.ok(Buffer.byteLength(JSON.stringify(result.result.response)) > 65536);
});
test('the uncapped writer receives more than five lists', async () => {
  const core = await unlimitedCore(), f = limitFixture('projects', true), b = createBridge(f, brief, { unbounded: true, parsePlan: core.parseStep });
  await b.initialize();
  for (let day = 2; day <= 8; day++) await b.call('list', { source: 'projects', since: '2026-10-01', until: `2026-10-${String(day).padStart(2, '0')}`, date_field: 'created' });
  const bundle = await b.bundle({ completed: true, parts: [{ question: 'Seven windows', notes: '', needs: [{ need: 'windows', kind: 'which_items', status: 'found', evidence: Array.from({ length: 7 }, (_, i) => `L${i + 1}`) }] }] });
  const renderer = core.createAskRendererV1({ response_version: 8, answer_prompt: core.ANSWER_PROMPT, source_catalog: f.catalog.entries, scope: 'synthetic', context: f.context, desk_scope: f.desk.scope });
  await renderer.render({ bundle, trigger_input: { question: 'List the seven windows.' }, signal: new AbortController().signal, remaining: () => Infinity, prompt_budget: () => Infinity,
    gate: { stats: () => ({ calls: 0, stopped: false }), withRepair: async (_r, _s, user, _sc, _t, parse) => {
      assert.equal(user.lists.length, 7); return parse({ lists: user.lists.map(l => ({ id: l.id })), sentences: [], not_found: [] });
    } } });
});
test('quality checks fail a plausible but incomplete roster even if renderer calls it answered', () => {
  const result = { case: 'roster', rendered: { parts: [{ statements: [{ text: 'Orbit Project 001 and 59 more' }] }], citations: [] }, research: { stop: { completed: true } }, renderer_outcome: 'answered', renderer_fallbacks: 0 };
  const check = assessLimit(result); assert.equal(check.passed, false); assert.equal(check.missing.length, 59);
});
test('eighteen separately numbered briefing entries can share nine renderer statements', () => {
  const lines = Array.from({ length: 18 }, (_, i) => `${i + 1}. Readiness briefing ${String(i + 1).padStart(2, '0')}: VEGA-${401 + i}, Lina Torres, 2026-11-${String(i + 1).padStart(2, '0')}.`);
  const statements = Array.from({ length: 9 }, (_, i) => ({ text: lines.slice(2 * i, 2 * i + 2).join(' ') }));
  const result = { case: 'briefing', rendered: { parts: [{ statements }], citations: [] }, research: { stop: { completed: true } }, renderer_outcome: 'answered', renderer_fallbacks: 0 };
  assert.equal(assessLimit(result).passed, true);
});
