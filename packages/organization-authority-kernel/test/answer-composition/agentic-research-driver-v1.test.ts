import { describe, expect, it, vi } from 'vitest';
import { canonicalSha256 } from '@echo-brain/federation-protocol';
import { AgenticAskGenerationFailureV1, createAgenticAskV5, createAgenticResearchV1, type AgenticAskAuditEntryV1 } from '../../src/answer-composition/agentic-ask-v1.js';
import { parseAgenticDriverFinishV1, type AgenticResearchDriverSessionV1 } from '../../src/answer-composition/agentic-research-driver-v1.js';
import type { EvidenceDeskPortV2 } from '../../src/shared/evidence-desk-v2.js';
import { AGENTIC_RESEARCH_BACKGROUND_BUDGET_V1, AGENTIC_RESEARCH_LIVE_BUDGET_V1 } from '../../src/answer-composition/agentic-research-v1.js';
import { AuthorityOperationError } from '../../src/domain/errors.js';
import { observeCoreRuntimeV1 } from '../../src/shared/core-runtime-observation-v1.js';
import { checked, generation, listed, record, result } from './fixtures/agentic-scenarios.js';

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
  const options = { include_gap_details: true as const, desk, model: { generate }, generation, audit: { append: (entry: AgenticAskAuditEntryV1) => { audit.push(entry); } }, research_driver: driver, today: () => '2026-10-20' };
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

  it('treats validated absence as completed even when the driver reports completed false', async () => {
    const h = harness(async session => {
      await admit(session);
      await session.call('search', { query: 'LANTERN reminder' });
      await session.call('search', { query: 'LANTERN-2046' });
      await admit(session, 'observed empty searches');
      expect(await session.call('finish', { completed: false, parts: [{ question: 'Reminder', notes: 'No matches; internal note must stay private.',
        needs: [{ need: 'reminder content', kind: 'content', status: 'not_found', evidence: [] }] }] })).toMatchObject({ accepted: true, completed: true });
    }, { search: async () => result([]) });
    const output = await h.ask();
    expect(output.research.stop).toMatchObject({ reason: 'finished', completed: true });
    expect(output.response.outcome).toBe('not_found');
    expect(output.response.parts[0]?.gap).toBe("I couldn't find this in the sources you can access.");
    expect(output.response.parts[0]?.gap_details).toEqual({ not_found: "I couldn't find this in the sources you can access." });
    expect(JSON.stringify(output.response)).not.toContain('internal note');
    expect(h.generate).not.toHaveBeenCalled();
  });

  it('explains an unsupported Ask write without searching or publishing researcher notes', async () => {
    const search = vi.fn(async () => result([]));
    const h = harness(async session => {
      await admit(session);
      expect(await session.call('finish', { completed: true, unsupported_action: true, parts: [] })).toMatchObject({ accepted: true, completed: true });
    }, { search });
    const output = await createAgenticAskV5(h.options).answerWithResearch({ question: 'Mark action A1 Done.' });
    expect(output.research.stop).toMatchObject({ reason: 'finished', completed: true, unsupported_action: true });
    expect(output.response.outcome).toBe('partial');
    expect(output.response.parts[0]?.gap).toBe("Ask can read your sources, but it can't make changes or send messages. Nothing was changed or sent.");
    expect(output.response.parts[0]?.gap_details).toEqual({ unsupported_action: true });
    expect(output.response.citations).toEqual([]);
    expect(search).not.toHaveBeenCalled();
    expect(h.generate).not.toHaveBeenCalled();
    expect(h.audit).toHaveLength(1);
    expect(h.revalidate).toHaveBeenCalled();
  });

  // Contract proof only: model intent classification is evaluated independently, not by this scripted driver.
  it.each(['Which calibration change was approved?', 'What did the record tell us to send?'])('does not infer an unsupported action from factual question wording: %s', async question => {
    const h = harness(async session => {
      await admit(session);
      await session.call('search', { query: 'calibration rule' });
      await admit(session, 'observed rule');
      await session.call('finish', finish());
    });
    const output = await createAgenticAskV5(h.options).answerWithResearch({ question });
    expect(output.response.outcome).toBe('answered');
    expect(output.research.stop).not.toHaveProperty('unsupported_action');
    expect(output.response.parts[0]).not.toHaveProperty('gap_details');
  });

  it('validates factual needs in a mixed read and unsupported write request', async () => {
    const h = harness(async session => {
      await admit(session);
      const mixed = { ...finish(), unsupported_action: true };
      expect(await session.call('finish', mixed)).toHaveProperty('error');
      await session.call('search', { query: 'calibration rule' });
      await admit(session, 'observed rule');
      expect(await session.call('finish', mixed)).toMatchObject({ accepted: true, completed: true });
    });
    const output = await createAgenticAskV5(h.options).answerWithResearch({ question: 'What was decided, and mark the calibration task Done.' });
    expect(output.response.outcome).toBe('partial');
    expect(output.response.parts[0]?.statements[0]?.text).toBe('Calibrate every unit.');
    expect(output.response.parts[0]?.gap).toContain("Ask can read your sources, but it can't make changes");
    expect(output.response.citations).toHaveLength(1);
  });

  it('keeps the no-match explanation for the factual portion of an unsupported write request', async () => {
    const h = harness(async session => {
      await admit(session);
      await session.call('search', { query: 'A1 rule' });
      await session.call('search', { query: 'A1 decision' });
      await admit(session, 'observed absence');
      await session.call('finish', { completed: true, unsupported_action: true, parts: [{ question: 'Find and update A1', notes: '',
        needs: [{ need: 'A1 rule', kind: 'content', status: 'not_found', evidence: [] }] }] });
    }, { search: async () => result([]) });
    const output = await h.ask();
    expect(output.response.parts[0]?.gap).toContain("Nothing was changed or sent.");
    expect(output.response.parts[0]?.gap).toContain("I couldn't find this in the sources you can access.");
    expect(output.response.outcome).toBe('partial');
  });

  it.each(['unseen', 'truncated', 'unavailable'] as const)('does not normalize an unproven absence after %s reads', async failure => {
    const h = harness(async session => {
      await admit(session);
      await session.call('search', { query: 'absent' });
      await session.call('search', { query: 'missing' });
      if (failure !== 'unseen') await admit(session, 'incomplete reads');
      const absent = { completed: false, parts: [{ question: 'Absent', notes: '', needs: [{ need: 'missing fact', kind: 'content', status: 'not_found', evidence: [] }] }] };
      expect(await session.call('finish', absent)).toHaveProperty('error');
      expect(await session.call('finish', finish([], false))).toMatchObject({ accepted: true, completed: false });
    }, { search: async () => result([], failure === 'truncated' ? { truncated: true } : failure === 'unavailable' ? { notice: 'Source temporarily unavailable.' } : {}) });
    const output = await h.ask();
    expect(output.research.stop.completed).toBe(false);
    expect(output.response.outcome).toBe('partial');
    expect(output.response.parts[0]?.gap).toContain("I couldn't complete the search");
  });

  const harborMissing = { completed: false, parts: [{ question: 'Who owns Harbor?', notes: '', needs: [{ need: 'Harbor owner', kind: 'content', status: 'not_found', evidence: [] }] }] };
  const OUTAGE = { notice: 'Live pages could not be searched just now, so these results leave them out.', notice_kind: 'availability' as const };
  /** A documents search answers with `value`; every other search, the two meeting searches, comes back clean and empty. */
  const documents = (value: ReturnType<typeof result>) => async (input: { readonly source?: string; readonly query?: string }) =>
    input.source === 'document' ? value : result([], { receipt_digests: [canonicalSha256({ query: input.query ?? null })] });

  // Two clean meeting searches pass the not_found check, but a source could not be read during the request: absence there is
  // unproven, so the not_found need stays unconfirmed whatever completed says, and the reader is asked to try again.
  it.each([
    ['an availability notice', true], ['an availability notice', false], ['the read budget', true], ['the read budget', false],
  ] as const)('keeps a not_found need unconfirmed after %s (completed=%s)', async (failure, completed) => {
    const h = harness(async session => {
      await admit(session);
      if (failure === 'an availability notice') await session.call('search', { query: 'Harbor owner', source: 'documents' });
      await session.call('search', { query: 'Harbor owner', source: 'meetings' });
      await session.call('search', { query: 'Harbor lead', source: 'meetings' });
      // Each meeting search adds its own receipt, so a third read no longer fits the 22-receipt budget.
      if (failure === 'the read budget') expect(await session.call('search', { query: 'Harbor owner', source: 'documents' })).toMatchObject({ error: expect.stringContaining('read budget') });
      await admit(session, 'observed reads');
      expect(await session.call('finish', { ...harborMissing, completed })).toMatchObject({ accepted: true, completed: false });
    }, { search: documents(result([], OUTAGE)) });
    const output = await createAgenticAskV5(h.options).answerWithResearch({ question: 'Who owns Harbor?',
      ...(failure === 'the read budget' ? { budget: { ...AGENTIC_RESEARCH_LIVE_BUDGET_V1, max_receipts: 22 } } : {}) });
    expect(output.research.stop).toMatchObject({ reason: 'finished', completed: false });
    expect(output.response.outcome).toBe('partial');
    expect(output.response.parts[0]).toMatchObject({ gap: "I couldn't complete the search. Please try again.", gap_details: { interrupted: true } });
    expect(output.response.parts[0]?.gap_details).not.toHaveProperty('not_found');
  });

  it('leaves a found need answered after an availability notice', async () => {
    const h = harness(async session => {
      await admit(session);
      await session.call('search', { query: 'calibration', source: 'documents' });
      await session.call('search', { query: 'calibration', source: 'meetings' });
      await admit(session, 'observed reads');
      expect(await session.call('finish', finish())).toMatchObject({ accepted: true, completed: true });
    }, { search: async input => input.source === 'document' ? result([], OUTAGE) : result([evidence]) });
    const output = await h.ask();
    expect(output.research.stop).toMatchObject({ reason: 'finished', completed: true });
    expect(output.response.outcome).toBe('answered');
    expect(output.response.parts[0]).not.toHaveProperty('gap_details');
  });

  // Reads that ran and came back cut, or read with a note, or that the model got wrong and corrected, are no availability
  // failure: after two clean empty searches, a completed=false finish with every need closed is the validated no-match.
  const hits = Array.from({ length: 8 }, (_, index) => record(`harbor-${index + 1}`, `Harbor review note ${index + 1}.`));
  const bodies = Array.from({ length: 22 }, (_, index) => record(index === 0 ? 'harbor-plan' : `harbor-note-${index}`, `Harbor note ${index}.`));
  const WRITER_MISSING = 'Not found: the Harbor owner.';
  const NOT_FOUND = "I couldn't find this in the sources you can access.";
  type Read = readonly ['search' | 'open' | 'list', Record<string, string>];
  const REPRESENTED = 'Some Confluence page content could not be fully represented as text.';
  it.each<readonly [string, Partial<EvidenceDeskPortV2>, readonly Read[], string]>([
    ['a search cut at 8 hits', { search: documents(result(hits, { truncated: true })) }, [['search', { query: 'Harbor review', source: 'documents' }]], WRITER_MISSING],
    ['an informational notice', { search: documents(result(hits.slice(0, 1), { notice: REPRESENTED, notice_kind: 'informational' })) }, [['search', { query: 'Harbor review', source: 'documents' }]], WRITER_MISSING],
    ['a reader notice without a kind', { search: documents(result(hits.slice(0, 1), { notice: REPRESENTED })) }, [['search', { query: 'Harbor review', source: 'documents' }]], WRITER_MISSING],
    ['bodies cut to fit', { search: documents(result([listed('harbor-plan')])), open: async () => result(bodies) },
      [['search', { query: 'Harbor plan', source: 'documents' }], ['open', { id: 'E1' }]], WRITER_MISSING],
    ['a deleted item', { search: documents(result(hits.slice(0, 1))), open: async () => { throw new AuthorityOperationError('not_found', 'The item is no longer available'); } },
      [['search', { query: 'Harbor review', source: 'documents' }], ['open', { id: 'E1' }]], WRITER_MISSING],
    ['a bad source name', {}, [['search', { query: 'Harbor owner', source: 'wiki' }]], NOT_FOUND],
    ['an unknown id', {}, [['open', { id: 'E99' }]], NOT_FOUND],
    ['a rejected filter', { list: async () => { throw new AuthorityOperationError('invalid_request', 'This source cannot be filtered by owner, status or role'); } },
      [['list', { source: 'documents' }]], NOT_FOUND],
  ])('types the absence after %s', async (_read, desk, reads, missing) => {
    const h = harness(async session => {
      await admit(session);
      for (const [tool, args] of reads) await session.call(tool, args);
      await session.call('search', { query: 'Harbor owner', source: 'meetings' });
      await session.call('search', { query: 'Harbor lead', source: 'meetings' });
      await admit(session, 'observed reads');
      expect(await session.call('finish', harborMissing)).toMatchObject({ accepted: true, completed: true });
    }, { search: documents(result([])), ...desk });
    // The writer, when anything it can read came back, finds no owner in it.
    h.generate.mockResolvedValue({ sentences: [], not_found: ['the Harbor owner'], lists: [] } as never);
    const output = await createAgenticAskV5(h.options).answerWithResearch({ question: 'Who owns Harbor?' });
    expect(output.research.stop).toMatchObject({ reason: 'finished', completed: true });
    expect(output.response.outcome).toBe('not_found');
    expect(output.response.parts[0]?.gap_details).toEqual({ not_found: missing });
  });

  it('types the absence after a list read to its end over two pages, although its first page was cut', async () => {
    const rows = ['harbor-1', 'harbor-2', 'harbor-3'].map(id => listed(id, { label: `Harbor note ${id.slice(-1)}` }));
    const h = harness(async session => {
      await admit(session);
      await session.call('list', { source: 'documents' });
      await session.call('list', { source: 'documents' });
      await session.call('open', { id: 'E1' });
      await admit(session, 'observed list');
      expect(await session.call('finish', { completed: false, parts: [{ question: 'Which documents name the Harbor owner?', notes: '',
        needs: [{ need: 'documents that name the Harbor owner', kind: 'which_items', status: 'not_found', evidence: ['L1'] }] }] })).toMatchObject({ accepted: true, completed: true });
    }, {
      // Every live page with a next cursor says it was truncated; the last page, read to its end, does not.
      list: async input => input.cursor === undefined ? result(rows.slice(0, 2), { truncated: true, next_cursor: 'page-2' }) : result(rows.slice(2)),
      open: async () => result([record('harbor-1', 'Harbor note 1: the review is pending.')]),
    });
    h.generate.mockResolvedValue({ sentences: [], not_found: ['documents that name the Harbor owner'], lists: [] } as never);
    const output = await createAgenticAskV5(h.options).answerWithResearch({ question: 'Which documents name the Harbor owner?' });
    expect(output.research.lists?.[0]).toMatchObject({ id: 'L1', complete: true });
    expect(output.response.outcome).toBe('not_found');
    expect(output.response.parts[0]?.gap_details).toEqual({ not_found: 'Not found: documents that name the Harbor owner.' });
  });

  it('does not let a task goal use the Ask-only unsupported-action outcome', () => {
    expect(() => parseAgenticDriverFinishV1({ completed: true, unsupported_action: true, parts: [] }, false)).toThrow();
    expect(() => parseAgenticDriverFinishV1({ completed: true, parts: [] }, true)).toThrow();
  });

  it('keeps a background task driver’s completion semantics unchanged', async () => {
    const h = harness(async session => {
      await admit(session);
      await session.call('search', { query: 'calibration' });
      await admit(session, 'read');
      expect(await session.call('finish', { ...finish(), completed: false })).toMatchObject({ accepted: true, completed: false });
    });
    const output = await createAgenticResearchV1(h.options).research({ trigger: 'approved_record', brief: {
      goal: { kind: 'task', task: 'Find related records.' }, starting: [], options: { list: false }, budget: AGENTIC_RESEARCH_BACKGROUND_BUDGET_V1,
    } });
    expect(output.stop).toEqual({ reason: 'finished', completed: false });
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
