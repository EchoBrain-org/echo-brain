import { canonicalSha256, sha256Digest } from '@echo-brain/federation-protocol';
import { describe, expect, it, vi } from 'vitest';
import { AuthorityOperationError } from '../../src/domain/errors.js';
import { captureCoreRuntimeContentV1, observeCoreRuntimeV1, withCoreRuntimeDiagnosticsV1, type CoreRuntimeDiagnosticObservationV1 } from '../../src/shared/core-runtime-observation-v1.js';
import type { EvidenceDeskItemV2 } from '../../src/shared/evidence-desk-v2.js';
import { need, part, record, researchHarness, result, step } from './fixtures/agentic-scenarios.js';

function ticket(id: string, text?: string): EvidenceDeskItemV2 {
  return {
    id: `private-desk-${id}`, source_id: 'jira', kind: 'ticket', label: `${id}: gate work`, visibility: 'only_me',
    citation: { kind: 'ticket', tool_id: 'jira', external_scope_id: 'fixture-cloud', ticket_id: id,
      permalink: `https://jira.example.test/browse/${id}`, text_sha256: sha256Digest(text ?? '') },
    attributes: { status: 'Open' }, receipt_sha256: canonicalSha256({ id, text: text ?? null }),
    ...(text === undefined ? {} : { text }),
  };
}

describe('request-owned research trace', () => {
  it('captures exact linked-open prompts, raw rejected decisions and repair calls without enabling runtime content capture', async () => {
    const events: CoreRuntimeDiagnosticObservationV1[] = [];
    const anchor = ticket('THERM-50');
    const linked = ticket('THERM-51');
    const anchorBody = ticket('THERM-50', 'DVT is on hold pending the fixture; inspect the linked PVT gate.');
    const linkedBody = ticket('THERM-51', 'PVT requires the approved package and fixture readiness.');
    const openPlan = [part('DVT and PVT', [need('DVT hold', 'open'), need('PVT entry', 'open')])];
    const foundPlan = [part('DVT and PVT', [need('DVT hold', 'found', ['E1']), need('PVT entry', 'found', ['E2'])])];
    const replies = [
      step(openPlan, [{ tool: 'list', args: { source: 'tickets' } }]),
      step(openPlan, [{ tool: 'open', args: { id: 'E1' } }]),
      step(foundPlan, [{ tool: 'finish', args: {} }]), // Rejected: linked item has metadata only.
      step(openPlan, [{ tool: 'open', args: { id: 'E2' } }]),
      step(foundPlan, [{ tool: 'finish', args: {} }]),
      { sentences: [{ text: 'DVT awaits the fixture; PVT needs the approved package and fixture readiness.', evidence: ['E1', 'E2'] }], not_found: [] },
    ];
    const usage = { input_tokens: 100, output_tokens: 20, total_tokens: 120, cached_input_tokens: null, reasoning_tokens: null };
    const h = researchHarness((input, index) => {
      captureCoreRuntimeContentV1('model_request', input.user_prompt);
      return replies[index];
    }, {
      ticket_available: true,
      live_sources: [{ source_id: 'jira', kind: 'ticket', selector: 'tickets', description: 'Live tickets', metadata_only_list: true, tool_id: 'jira' }],
      list: async () => result([anchor]),
      open: async input => input.item === anchor.id ? result([anchorBody, linked]) : result([linkedBody]),
    }, { usage: () => usage });
    const runtimeContent = vi.fn();
    const output = await withCoreRuntimeDiagnosticsV1(event => { events.push(event); }, () => observeCoreRuntimeV1('ask_request', () => h.research.answerWithResearch({ question: 'Why is DVT on hold and what is required for PVT?' }),
      { observer: () => undefined, content_observer: runtimeContent }));

    expect(output.response.outcome).toBe('answered');
    const requests = events.filter(event => event.kind === 'model_request');
    const responses = events.filter(event => event.kind === 'model_response');
    expect(requests.map(event => event.call_id)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(requests.map(event => event.recovery)).toEqual([false, false, false, true, false, false]);
    expect(responses.map(event => event.value)).toEqual(replies);
    for (const [index, event] of requests.entries()) {
      const { signal: _signal, ...modelInput } = h.inputs[index]!;
      expect(event.input).toEqual(modelInput);
      expect(event.input).not.toHaveProperty('signal');
    }
    expect(responses.every(event => event.finish_reason === 'stop' && event.usage?.total_tokens === 120)).toBe(true);
    const beforeLinkedRead = JSON.parse(requests[2]!.input.user_prompt);
    expect(beforeLinkedRead.opened).toEqual([expect.objectContaining({ id: 'E1', text: anchorBody.text })]);
    expect(beforeLinkedRead.seen).toEqual([expect.objectContaining({ id: 'E2', title: linked.label })]);
    expect(beforeLinkedRead.seen[0]).not.toHaveProperty('text');
    expect(JSON.parse(requests[3]!.input.user_prompt)).toMatchObject({
      validation_error: expect.stringContaining('found but cites no item whose full text you have read'),
      rejected_response: JSON.stringify(replies[2]),
    });
    const tools = events.filter(event => event.kind === 'tool_request');
    expect(tools.map(event => ({ id: event.tool_call_id, round: event.round, tool: event.tool, args: event.args }))).toEqual([
      { id: 1, round: 1, tool: 'list', args: { source: 'tickets' } },
      { id: 2, round: 2, tool: 'open', args: { id: 'E1' } },
      { id: 3, round: 3, tool: 'open', args: { id: 'E2' } },
      { id: 4, round: 4, tool: 'finish', args: {} },
    ]);
    expect(events).toContainEqual(expect.objectContaining({ kind: 'tool_response', tool_call_id: 4, round: 4, tool: 'finish', result: { tool: 'finish' } }));
    const expanded = events.find(event => event.kind === 'tool_response' && event.tool_call_id === 2);
    expect(expanded).toMatchObject({ result: beforeLinkedRead.last_results[0] });
    expect(JSON.stringify(events)).not.toContain('private-desk-');
    expect(JSON.stringify(events)).not.toContain('receipt_sha256');
    // Opt-in diagnostics never restore the separate global content observer.
    expect(runtimeContent).not.toHaveBeenCalled();
  });

  it('correlates batched reads that finish out of order while preserving the model-visible admission order', async () => {
    const events: CoreRuntimeDiagnosticObservationV1[] = [];
    const completed: string[] = [];
    let releaseSlow!: () => void;
    const slow = new Promise<void>(resolve => { releaseSlow = resolve; });
    const first = record('first-gate', 'The first gate is ready.');
    const second = record('second-gate', 'The second gate is ready.');
    const h = researchHarness([
      step([part('Gates', [need('gate readiness', 'open')])], [
        { tool: 'search', args: { query: 'slow' } }, { tool: 'search', args: { query: 'fast' } },
      ]),
      step([part('Gates', [need('gate readiness', 'found', ['E1', 'E2'])])], [{ tool: 'finish', args: {} }]),
      { sentences: [{ text: 'Both gates are ready.', evidence: ['E1', 'E2'] }], not_found: [] },
    ], { search: async input => {
      if (input.query === 'slow') { await slow; completed.push('slow'); return result([first]); }
      completed.push('fast'); releaseSlow(); return result([second]);
    } });

    const output = await withCoreRuntimeDiagnosticsV1(event => { events.push(event); }, () => h.research.answerWithResearch({ question: 'Are both gates ready?' }));

    expect(output.response.outcome).toBe('answered');
    expect(completed).toEqual(['fast', 'slow']);
    const requests = events.filter(event => event.kind === 'tool_request');
    const responses = events.filter(event => event.kind === 'tool_response');
    expect(requests.map(event => [event.tool_call_id, event.tool, event.args])).toEqual([
      [1, 'search', { query: 'slow' }], [2, 'search', { query: 'fast' }], [3, 'finish', {}],
    ]);
    expect(responses.map(event => event.tool_call_id)).toEqual([1, 2, 3]);
    expect(h.prompt(1).last_results).toEqual(responses.slice(0, 2).map(event => event.result));
    expect(h.prompt(1).last_results).toEqual([
      expect.objectContaining({ query: 'slow', results: [expect.objectContaining({ id: 'E1', title: first.label })] }),
      expect.objectContaining({ query: 'fast', results: [expect.objectContaining({ id: 'E2', title: second.label })] }),
    ]);
  });

  it('keeps observer mutation and exceptions out of the model input, parsing and answer', async () => {
    const body = record('gate', 'The fixture is ready.');
    const h = researchHarness([
      step([part('Fixture', [need('readiness', 'open')])], [{ tool: 'search', args: { query: 'fixture' } }]),
      step([part('Fixture', [need('readiness', 'found', ['E1'])])], [{ tool: 'finish', args: {} }]),
      { sentences: [{ text: 'The fixture is ready.', evidence: ['E1'] }], not_found: [] },
    ], { search: async () => result([body]) });
    const output = await withCoreRuntimeDiagnosticsV1(event => {
      if (event.kind === 'model_request') (event.input.schema as Record<string, unknown>).type = 'mutated';
      if (event.kind === 'model_response' && typeof event.value === 'object' && event.value !== null) Object.assign(event.value, { parts: [] });
      if (event.kind === 'tool_response') Object.assign(event.result, { error: 'invented' });
      throw new Error('observer unavailable');
    }, () => h.research.answerWithResearch({ question: 'Is the fixture ready?' }));
    expect(output.response.outcome).toBe('answered');
    expect(h.inputs.every(input => input.schema.type === 'object')).toBe(true);
    expect(h.prompt(1).last_results).toEqual([expect.not.objectContaining({ error: 'invented' })]);
  });

  it('captures finite model and tool failure labels without exception messages', async () => {
    const toolEvents: CoreRuntimeDiagnosticObservationV1[] = [];
    const toolFailure = new AuthorityOperationError('rate_limited', 'private upstream response');
    const h = researchHarness([
      step([part('Fixture', [need('readiness', 'open')])], [{ tool: 'search', args: { query: 'fixture' } }]),
    ], { search: async () => { throw toolFailure; } });
    await expect(withCoreRuntimeDiagnosticsV1(event => { toolEvents.push(event); }, () => h.research.answerWithResearch({ question: 'Is the fixture ready?' }))).rejects.toBe(toolFailure);
    expect(toolEvents).toContainEqual(expect.objectContaining({ kind: 'tool_error', tool_call_id: 1, round: 1, tool: 'search', error_kind: 'rate_limited' }));

    const modelEvents: CoreRuntimeDiagnosticObservationV1[] = [];
    const modelFailure = new Error('private model exception');
    const model = researchHarness(() => { throw modelFailure; });
    await expect(withCoreRuntimeDiagnosticsV1(event => { modelEvents.push(event); }, () => model.research.answerWithResearch({ question: 'Is the fixture ready?' }))).rejects.toBe(modelFailure);
    expect(modelEvents).toContainEqual(expect.objectContaining({ kind: 'model_error', call_id: 1, role: 'step', error_kind: 'other' }));
    expect(JSON.stringify([...toolEvents, ...modelEvents])).not.toContain('private upstream response');
    expect(JSON.stringify([...toolEvents, ...modelEvents])).not.toContain('private model exception');
  });

});
