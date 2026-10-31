import { describe, expect, it, vi } from 'vitest';
import { canonicalSha256 } from '@echo-brain/federation-protocol';
import { AgenticAskGenerationFailureV1, createAgenticAskV5, createAgenticResearchV1, type AgenticAskAuditEntryV1 } from '../../src/answer-composition/agentic-ask-v1.js';
import { parseAgenticDriverFinishV1, type AgenticResearchDriverSessionV1 } from '../../src/answer-composition/agentic-research-driver-v1.js';
import type { EvidenceDeskPortV2 } from '../../src/shared/evidence-desk-v2.js';
import { AGENTIC_RESEARCH_BACKGROUND_BUDGET_V1 } from '../../src/answer-composition/agentic-research-v1.js';
import { AuthorityOperationError } from '../../src/domain/errors.js';
import { observeCoreRuntimeV1 } from '../../src/shared/core-runtime-observation-v1.js';
import { checked, generation, record, result } from './fixtures/agentic-scenarios.js';

const evidence = record('driver', 'Approved: calibrate every unit.');
const packets = new WeakMap<AgenticResearchDriverSessionV1, unknown[]>();
const admit = (session: AgenticResearchDriverSessionV1, label = 'request') => session.model_request({ model: 'claude-fixture', body_sha256: canonicalSha256({ label }), payload_digests: (packets.get(session) ?? []).map(canonicalSha256), operation: 'messages', timeout: () => 10_000 }, async () => ({ value: undefined }));
const finish = (ids = ['E1'], completed = true, kind = 'content') => ({ completed, parts: [{ question: 'Calibration', notes: 'Use the approved rule.', needs: [{ need: 'rule', kind, status: completed ? 'found' : 'open', evidence: ids }] }] });
function harness(run: (session: AgenticResearchDriverSessionV1) => Promise<void>, overrides: Partial<EvidenceDeskPortV2> = {}) {
  const audit: AgenticAskAuditEntryV1[] = [];
  const revalidate = vi.fn(async () => checked);
  const desk: EvidenceDeskPortV2 = { scope: { kind: 'global' }, search: async () => result([evidence]), open: async () => result([evidence]), list: async () => result([evidence]), revalidate, ...overrides };
  const generate = vi.fn(async () => ({ sentences: [{ text: 'Calibrate every unit.', evidence: ['E1'] }], not_found: [], lists: [] }));
  const driver = { run: vi.fn(async (session: AgenticResearchDriverSessionV1) => {
    const released = [session.initial];
    const wrapped = { ...session, call: async (...args: Parameters<AgenticResearchDriverSessionV1['call']>) => { const value = await session.call(...args); released.push(value); return value; } };
    packets.set(wrapped, released); return run(wrapped);
  }) };
  const options = { desk, model: { generate }, generation, audit: { append: (entry: AgenticAskAuditEntryV1) => { audit.push(entry); } }, research_driver: driver, today: () => '2026-10-20' };
  return { options, desk, generate, revalidate, driver, audit, ask: () => createAgenticAskV5(options).answerWithResearch({ question: 'What was decided?' }) };
}

describe('native research harness shares the real ECHO tool state', () => {
  it.each([['provider retries', 'unusable_step', 1], ['request timeout', 'budget', 0]] as const)('keeps released evidence available to the writer after native %s', async (failure, stop, corrections) => {
    const h = harness(async session => {
      await admit(session);
      await session.call('search', { query: 'calibrate' });
      await admit(session, 'read');
      if (failure === 'provider retries') throw new AgenticAskGenerationFailureV1('research model was unavailable', 'fallback');
      const timer = new AbortController();
      const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timer.signal);
      try {
        await session.model_request({ model: 'claude-fixture', body_sha256: canonicalSha256('timeout'), operation: 'messages', timeout: () => 4_000 },
          signal => new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
            queueMicrotask(() => timer.abort(new DOMException('local timer', 'TimeoutError')));
          }));
      } finally { timeout.mockRestore(); }
    });
    let fallbackCorrections = 0;
    const output = await observeCoreRuntimeV1('research_run', h.ask, { observer: event => {
      if (event.event !== 'started') fallbackCorrections += event.model_corrections?.research_unusable_step_stop ?? 0;
    } });
    expect(output.research.stop.reason).toBe(stop);
    expect(output.research.items[0]).toMatchObject({ read_in_full: true });
    expect(output.response.citations).toHaveLength(1);
    expect(h.generate).toHaveBeenCalledTimes(1);
    expect(h.audit).toHaveLength(1);
    expect(fallbackCorrections).toBe(corrections);
  });

  it.each(['search', 'list'] as const)('does not let unseen %s results establish absence, including same-turn tool batches', async tool => {
    const h = harness(async session => {
      await admit(session);
      const absent = { completed: true, parts: [{ question: 'Absent record', notes: '', needs: [{ need: 'record', kind: 'content', status: 'not_found', evidence: [] }] }] };
      if (tool === 'search') {
        await session.call('search', { query: 'absent' });
        await session.call('search', { query: 'missing' });
      } else await session.call('list', { source: 'meetings' });
      expect(await session.call('finish', absent)).toHaveProperty('error');
      await session.model_request({ model: 'claude-fixture', body_sha256: canonicalSha256('count only'), payload_digests: (packets.get(session) ?? []).map(canonicalSha256), operation: 'count_tokens', timeout: () => 10_000 }, async () => ({ value: true }));
      expect(await session.call('finish', absent)).toHaveProperty('error');
      await session.model_request({ model: 'claude-fixture', body_sha256: canonicalSha256('omitted'), operation: 'messages', timeout: () => 10_000 }, async () => ({ value: true }));
      expect(await session.call('finish', absent)).toHaveProperty('error');
      await admit(session, 'observed reads');
      expect(await session.call('finish', absent)).toMatchObject({ accepted: true });
    }, { search: async () => result([]), list: async () => result([]) });
    expect((await h.ask()).response.outcome).toBe('not_found');
  });

  it('hands released evidence to the unchanged writer, progress and audited release', async () => {
    const h = harness(async session => {
      await admit(session, 'initial');
      const read = await session.call('search', { query: 'calibrate' });
      expect(JSON.stringify(read)).toContain('Approved: calibrate every unit.');
      expect(JSON.stringify(read)).not.toContain(evidence.id);
      await admit(session, 'after read');
      expect(await session.call('finish', finish())).toEqual({ accepted: true, completed: true });
    });
    const progress: unknown[] = [];
    const output = await createAgenticAskV5(h.options).answerWithReceipt({ question: 'What was decided?', on_progress: event => { progress.push(event); } });
    expect(output.response.outcome).toBe('answered');
    expect(h.generate).toHaveBeenCalledTimes(1); // SDK researched; ECHO writer only.
    expect(h.audit).toHaveLength(1);
    expect(h.audit[0]).toMatchObject({ model_calls: 3 });
    expect(JSON.stringify(progress)).toContain(evidence.label);
    expect(h.revalidate.mock.calls.length).toBeGreaterThanOrEqual(4);
  });

  it('records one round per model turn and keeps an accepted finish through a later SDK failure', async () => {
    const h = harness(async session => {
      await admit(session, 'turn 1');
      await session.call('search', { query: 'calibrate' });
      await session.call('list', { source: 'meetings' });
      await admit(session, 'turn 2');
      expect(await session.call('finish', finish(['E1'], false))).toMatchObject({ accepted: true, completed: false });
      await admit(session, 'structured output');
      throw new AgenticAskGenerationFailureV1('research model was unavailable', 'fallback');
    });
    const { research } = await h.ask();
    expect(research.rounds.map(round => round.actions.map(action => action.tool))).toEqual([['search', 'list'], ['finish']]);
    expect(research.stop).toMatchObject({ reason: 'finished', completed: false });
  });

  it('refuses reads before the audit row would overflow, and the model can still finish', async () => {
    const h = harness(async session => {
      await admit(session);
      expect(await session.call('search', { query: 'calibrate' })).not.toHaveProperty('error');
      expect(await session.call('search', { query: 'again' })).toMatchObject({ error: expect.stringContaining('read budget') });
      await admit(session, 'after');
      expect(await session.call('finish', finish())).toMatchObject({ accepted: true });
    });
    const { research } = await createAgenticAskV5(h.options).answerWithResearch({ question: 'What was decided?', budget: { ...AGENTIC_RESEARCH_BACKGROUND_BUDGET_V1, max_receipts: 21 } });
    expect(research.stop.reason).toBe('finished');
  });

  it('ends an SDK session still waiting when research time runs out, and the writer answers', async () => {
    const h = harness(async session => {
      await session.call('search', { query: 'calibrate' });
      await new Promise((_resolve, reject) => session.signal.addEventListener('abort', () => reject(session.signal.reason), { once: true }));
    });
    const { research } = await createAgenticAskV5(h.options).answerWithResearch({ question: 'What was decided?', budget: { ...AGENTIC_RESEARCH_BACKGROUND_BUDGET_V1, deadline_ms: 27_300 } });
    expect(research.stop.reason).toBe('budget');
    expect(h.generate).toHaveBeenCalledTimes(1);
  });

  it('does not mark a body read before an outbound inference has passed the access gate', async () => {
    const h = harness(async session => {
      await admit(session);
      await session.call('search', { query: 'calibrate' });
      expect(await session.call('finish', finish())).toMatchObject({ error: expect.stringContaining('full text') });
      // A compaction/auxiliary inference that omits the new tool packet is not evidence admission.
      await session.model_request({ model: 'claude-fixture', body_sha256: canonicalSha256('omitted'), operation: 'messages', timeout: () => 10_000 }, async () => ({ value: true }));
      expect(await session.call('finish', finish())).toMatchObject({ error: expect.stringContaining('full text') });
      await session.model_request({ model: 'claude-fixture', body_sha256: canonicalSha256('count only'), payload_digests: (packets.get(session) ?? []).map(canonicalSha256), operation: 'count_tokens', timeout: () => 10_000 }, async () => ({ value: true }));
      expect(await session.call('finish', finish())).toMatchObject({ error: expect.stringContaining('full text') });
      await admit(session, 'body');
      expect(await session.call('finish', finish())).toMatchObject({ accepted: true });
    });
    expect((await h.ask()).research.items[0]).toMatchObject({ read_in_full: true });
  });

  it('rejects guessed ids and recovers without sending a desk open', async () => {
    const open = vi.fn(async () => result([evidence]));
    const h = harness(async session => {
      await admit(session);
      expect(await session.call('open', { id: 'E999' })).toHaveProperty('error');
      await session.call('search', { query: 'calibrate' }); await admit(session, 'read');
      expect(await session.call('finish', finish(['E1', 'E999']))).toHaveProperty('error');
      await session.call('finish', finish());
    }, { open });
    expect((await h.ask()).response.outcome).toBe('answered');
    expect(open).not.toHaveBeenCalled();
  });

  it('keeps list paging, metadata/body distinction, and source filter refusal', async () => {
    const second = record('next', 'Approved: use the new checklist.');
    const list = vi.fn(async (input: Parameters<EvidenceDeskPortV2['list']>[0]) => result(input.cursor ? [second] : [evidence], input.cursor ? {} : { next_cursor: 'private-cursor' }));
    const h = harness(async session => {
      await admit(session);
      const bad = await session.call('list', { source: 'meetings', status: 'decided' });
      expect(JSON.stringify(bad)).toContain('refused');
      expect(list).not.toHaveBeenCalled();
      await session.call('list', { source: 'meetings', limit: '1' }); await admit(session, 'page1');
      expect(await session.call('finish', finish(['L1'], true, 'which_items'))).toHaveProperty('error');
      const next = await session.call('list', { source: 'meetings', limit: '1' }); await admit(session, 'page2');
      expect(JSON.stringify(next)).not.toContain('private-cursor');
      expect(await session.call('finish', finish(['L1'], true, 'which_items'))).toMatchObject({ accepted: true });
    }, { list });
    const output = await h.ask();
    expect(output.research.lists?.[0]).toMatchObject({ complete: true });
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('does not invoke the SDK when the trigger disables planning and preserves starting slots', async () => {
    const h = harness(async () => { throw new Error('must not run'); }, { openCitation: async () => result([evidence]) });
    const output = await createAgenticResearchV1(h.options).research({ trigger: 'sweep', brief: {
      goal: { kind: 'task', task: 'Recheck {{starting:1}}.' }, starting: [{ citation: evidence.citation, if_unreadable: 'report' }],
      options: { planner: false, list: false }, budget: AGENTIC_RESEARCH_BACKGROUND_BUDGET_V1,
    } });
    expect(h.driver.run).not.toHaveBeenCalled();
    expect(output.stop.completed).toBe(true);
    expect(output.items[0]).toMatchObject({ read_in_full: true, preloaded: true });
  });

  it('preserves search-only trigger restrictions and terminal desk failures', async () => {
    const h = harness(async session => {
      expect(session.list_available).toBe(false);
      expect(await session.call('list', { source: 'meetings' })).toHaveProperty('error');
      await expect(session.call('search', { query: 'private' })).rejects.toMatchObject({ code: 'unauthorized' });
      await expect(session.call('search', { query: 'again' })).rejects.toMatchObject({ code: 'unauthorized' });
    }, { search: async () => { throw new AuthorityOperationError('unauthorized', 'revoked'); } });
    await expect(createAgenticResearchV1(h.options).research({ trigger: 'approved_record', brief: {
      goal: { kind: 'task', task: 'Find related records.' }, starting: [], options: { list: false }, budget: AGENTIC_RESEARCH_BACKGROUND_BUDGET_V1,
    } })).rejects.toMatchObject({ code: 'unauthorized' });
    expect(h.generate).not.toHaveBeenCalled();
  });

  it('retains more than the old plan caps without losing notes or evidence ids', () => {
    const value = { completed: true, parts: Array.from({ length: 8 }, (_, i) => ({ question: `Question ${i}`, notes: 'Long note. '.repeat(200),
      needs: Array.from({ length: 9 }, (_, j) => ({ need: `Need ${j}`, kind: 'content', status: 'found', evidence: Array.from({ length: 40 }, (_, k) => `E${k + 1}`) })) })) };
    expect(parseAgenticDriverFinishV1(value, true)).toEqual(value);
  });

  it('keeps the global catalog and source restrictions bound by ECHO', async () => {
    const list = vi.fn(async () => result([]));
    const h = harness(async session => {
      const catalog = (session.initial.source_catalog as { source: string }[]).map(value => value.source);
      expect(catalog).toEqual(expect.arrayContaining(['tickets', 'pages']));
      await admit(session);
      await session.call('list', { source: 'tickets' });
      await session.call('finish', finish([], false));
    }, { scope: { kind: 'global' }, live_sources: [
      { source_id: 'jira', selector: 'tickets', kind: 'ticket', description: 'Authorized Jira source', tool_id: 'jira', metadata_only_list: true },
      { source_id: 'confluence', selector: 'pages', kind: 'page', description: 'Authorized Confluence source', tool_id: 'confluence', metadata_only_list: true },
    ], list });
    await h.ask();
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('reports not found only after completed reads and still performs final release checks', async () => {
    const h = harness(async session => {
      await admit(session);
      const absent = { completed: true, parts: [{ question: 'Absent meeting', notes: '', needs: [{ need: 'meeting', kind: 'content', status: 'not_found', evidence: [] }] }] };
      expect(await session.call('finish', absent)).toHaveProperty('error');
      await session.call('search', { query: 'absent meeting' });
      await session.call('search', { query: 'missing record' });
      await admit(session, 'negative reads');
      expect(await session.call('finish', absent)).toMatchObject({ accepted: true });
    }, { search: async () => result([]) });
    const output = await h.ask();
    expect(output.response.outcome).toBe('not_found');
    expect(output.research.stop.completed).toBe(true);
    expect(h.audit).toHaveLength(1);
  });
});
