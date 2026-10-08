import { describe, expect, it, vi } from 'vitest';
import { AGENTIC_TRIGGER_DEFINITIONS_V1 } from '../../src/answer-composition/agentic-trigger-definitions-v1.js';
import { AGENTIC_RESEARCH_LIVE_BUDGET_V1 } from '../../src/answer-composition/agentic-research-v1.js';
import { AuthorityOperationError } from '../../src/domain/errors.js';
import { captureCoreRuntimeContentV1, observeCoreRuntimeV1, withCoreRuntimeDiagnosticsV1, type CoreRuntimeDiagnosticObservationV1, type CoreRuntimeObservationV1 } from '../../src/shared/core-runtime-observation-v1.js';
import { checked, listed, need, part, record, replay, researchHarness, result, SCENARIOS, step } from './fixtures/agentic-scenarios.js';

type Lifecycle = Extract<CoreRuntimeDiagnosticObservationV1, { readonly kind: 'lifecycle' }>;
const lifecycle = (events: readonly CoreRuntimeDiagnosticObservationV1[]) => events.filter((event): event is Lifecycle => event.kind === 'lifecycle');
const finish = (status = 'found', ids: readonly string[] = ['E1']) => step([part('Current state', [need('current state', status, ids)])], [{ tool: 'finish', args: {} }]);

describe('shared research diagnostics lifecycle', () => {
  it.each(['ask', 'approved_record', 'sweep'])('observes %s through the same correlated lifecycle and terminal release', async trigger => {
    const events: CoreRuntimeDiagnosticObservationV1[] = [];
    const metadata: CoreRuntimeObservationV1[] = [];
    const body = record('display', 'Approved: show two decimals.');
    const h = researchHarness([
      finish(),
      trigger === 'approved_record'
        ? { decided: [{ id: 'E1', text: 'Show two decimals.' }], affected: [] }
        : { sentences: [{ text: 'Show two decimals.', evidence: ['E1'] }], not_found: [] },
    ], {
      search: async () => result([listed('display')]), open: async () => result([body]), openCitation: async () => result([body]),
    }, { small_scope_shortcut: true });
    const definition = AGENTIC_TRIGGER_DEFINITIONS_V1.find(value => value.name === trigger)!;
    const input = definition.parseEvent(trigger === 'ask' ? { question: 'What is the display decision?' } : trigger === 'approved_record'
      ? { record: body.citation } : { findings: [{ finding: 'Display precision', expected: 'Show two decimals', citations: [body.citation] }] });
    const output = await withCoreRuntimeDiagnosticsV1(event => { events.push(event); }, () => observeCoreRuntimeV1('research_run', async () => {
      if (trigger === 'ask') return (await h.research.answerWithResearch({ question: 'What is the display decision?' })).response;
      if (definition.renderer !== undefined) return (await h.research.renderWithResearch({ trigger, brief: definition.brief(input), renderer: definition.renderer, trigger_input: input })).rendered;
      return h.research.research({ trigger, brief: definition.brief(input) });
    }, { observer: event => { metadata.push(event); } }));

    const stages = lifecycle(events);
    expect(stages[0]).toMatchObject({ stage: 'run', event: 'started', data: { trigger } });
    for (const stage of ['brief', 'research', 'audit', 'release', 'run']) {
      expect(stages.filter(event => event.stage === stage).map(event => event.event)).toEqual(['started', 'succeeded']);
    }
    expect(stages.filter(event => event.stage === 'revalidation' && event.event === 'started').map(event => event.data?.purpose))
      .toEqual(trigger === 'sweep' ? ['model', 'before_audit', 'after_audit'] : ['model', 'model', 'before_audit', 'after_audit']);
    expect(stages.at(-1)).toMatchObject({ stage: 'run', event: 'succeeded', data: { result: output } });
    expect(stages.find(event => event.stage === 'release' && event.event === 'succeeded')).toMatchObject({ data: { result: output } });
    expect(new Set(events.map(event => event.operation_id)).size).toBe(1);
    const modelRequests = events.filter(event => event.kind === 'model_request');
    const modelResponses = events.filter(event => event.kind === 'model_response');
    expect(new Set(modelRequests.map(event => event.span_id)).size).toBe(modelRequests.length);
    for (const request of modelRequests) {
      expect(modelResponses.find(event => event.call_id === request.call_id)?.span_id).toBe(request.span_id);
      expect(metadata).toContainEqual(expect.objectContaining({ span_id: request.span_id, phase: request.role === 'step' ? 'ask_planner' : trigger === 'ask' ? 'ask_answer' : 'research_render', event: 'succeeded' }));
    }
    expect(metadata.filter(event => event.phase === 'research_loop' && event.event === 'succeeded')).toEqual([
      expect.objectContaining({ research_stop_reason: 'finished' }),
    ]);
    expect(metadata.filter(event => event.phase === 'research_run' && event.event === 'succeeded')).toEqual([
      expect.objectContaining({ research_stop_reason: 'finished', result: 'answered', counts: expect.objectContaining({
        planned_query_count: 0, query_hit_count: 0, released_atom_count: 1, context_atom_count: trigger === 'sweep' ? 0 : 1, citation_count: 1,
      }) }),
    ]);
    if (trigger === 'ask') {
      expect(stages.filter(event => event.stage === 'preload' && event.event === 'started').map(event => event.data?.operation)).toEqual(['search', 'open']);
      expect(stages.find(event => event.stage === 'preload' && event.data?.released_items !== undefined && JSON.stringify(event.data).includes(body.text!)))
        .toMatchObject({ event: 'succeeded', data: { released_items: [expect.objectContaining({ text: body.text, citation: body.citation })] } });
    } else {
      expect(stages.find(event => event.stage === 'starting_read' && event.event === 'succeeded'))
        .toMatchObject({ data: { released_items: [expect.objectContaining({ text: body.text, citation: body.citation })] } });
    }
    expect(stages.filter(event => event.stage === 'renderer').map(event => event.event)).toEqual(trigger === 'sweep' ? ['skipped'] : ['started', 'succeeded']);
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(body.id);
    expect(serialized).not.toContain('receipt_sha256');
    expect(serialized).not.toContain('invocation_digests');
  });

  it('records writer repairs and the laid out fallback result', async () => {
    const events: CoreRuntimeDiagnosticObservationV1[] = [];
    const metadata: CoreRuntimeObservationV1[] = [];
    const output = await withCoreRuntimeDiagnosticsV1(event => { events.push(event); }, () => observeCoreRuntimeV1('research_run',
      () => replay('writer_fallback_to_records', SCENARIOS.writer_fallback_to_records!), { observer: event => { metadata.push(event); } }));
    expect(events.flatMap(event => event.kind === 'model_response' && event.role === 'answer' ? [event.value] : [])).toEqual([{ wrong: true }, { still: 'wrong' }]);
    expect(lifecycle(events)).toContainEqual(expect.objectContaining({ stage: 'renderer', event: 'succeeded', data: expect.objectContaining({ selected_evidence: ['E1'], fallback_count: 1, result: output.response }) }));
    expect(metadata).toContainEqual(expect.objectContaining({ phase: 'research_run', event: 'succeeded', counts: expect.objectContaining({ context_atom_count: 1 }) }));
    expect(lifecycle(events).at(-1)).toMatchObject({ stage: 'run', event: 'succeeded', data: { result: output.response } });
  });

  it('reports an unreadable sweep anchor without calling it resolved', async () => {
    const events: CoreRuntimeDiagnosticObservationV1[] = [];
    const body = record('hidden');
    const h = researchHarness([
      step([part('Current state', [need('current state', 'open')])], [{ tool: 'search', args: { query: 'display precision' } }, { tool: 'search', args: { query: 'two decimals' } }]),
      finish('not_found', []),
    ], { openCitation: async () => { throw new AuthorityOperationError('not_found', 'private source exception'); } });
    const definition = AGENTIC_TRIGGER_DEFINITIONS_V1.find(value => value.name === 'sweep')!;
    const input = definition.parseEvent({ findings: [{ finding: 'Display precision', expected: 'Show two decimals', citations: [body.citation] }] });
    const output = await withCoreRuntimeDiagnosticsV1(event => { events.push(event); }, () => h.research.research({ trigger: 'sweep', brief: definition.brief(input) }));
    expect(output.unreadable_starting).toEqual([body.citation]);
    expect(lifecycle(events)).toContainEqual(expect.objectContaining({ stage: 'starting_read', event: 'failed', error_kind: 'not_found' }));
    expect(lifecycle(events).at(-1)).toMatchObject({ stage: 'run', event: 'succeeded', data: { result: output } });
    expect(JSON.stringify(events)).not.toContain('private source exception');
  });

  it('keeps budget admission metadata after revalidation prevents the next planner call', async () => {
    const events: CoreRuntimeDiagnosticObservationV1[] = [];
    const metadata: CoreRuntimeObservationV1[] = [];
    let time = 0; let checks = 0;
    const body = record('budget');
    const h = researchHarness([step([part('Current state', [need('current state', 'open')])], [{ tool: 'search', args: { query: 'state' } }])], {
      openCitation: async () => result([body]), revalidate: async () => { if (++checks === 2) time = 86_001; return checked; },
    }, { now_ms: () => time });
    await withCoreRuntimeDiagnosticsV1(event => { events.push(event); }, () => observeCoreRuntimeV1('research_run', () => h.research.research({
      trigger: 'sweep', brief: { goal: { kind: 'task', task: 'Recheck current state.' }, starting: [{ citation: body.citation, if_unreadable: 'fail' }], budget: AGENTIC_RESEARCH_LIVE_BUDGET_V1, options: { small_scope_preload: false } },
    }), { observer: event => { metadata.push(event); } }));
    expect(events.filter(event => event.kind === 'model_request')).toHaveLength(1);
    expect(metadata).toContainEqual(expect.objectContaining({ phase: 'research_loop', event: 'succeeded', research_stop_reason: 'budget', research_admission: 'post_revalidation_no_time' }));
    expect(metadata).toContainEqual(expect.objectContaining({ phase: 'research_run', event: 'succeeded', result: 'partial', research_stop_reason: 'budget', research_admission: 'post_revalidation_no_time' }));
    expect(lifecycle(events)).toContainEqual(expect.objectContaining({ stage: 'research', event: 'succeeded', data: expect.objectContaining({ research: expect.objectContaining({ stop: { reason: 'budget', completed: false, admission: 'post_revalidation_no_time' } }) }) }));
  });

  it('keeps a successful audit distinct from failed release and suppresses legacy error content', async () => {
    const events: CoreRuntimeDiagnosticObservationV1[] = [];
    const metadata: CoreRuntimeObservationV1[] = [];
    const content = vi.fn();
    let checks = 0;
    const failure = new AuthorityOperationError('stale_access_state', 'private membership details');
    const h = researchHarness([finish('not_found', []), { sentences: [], not_found: ['current state'] }], {
      revalidate: async () => { if (++checks === 4) { captureCoreRuntimeContentV1('validation_error', failure); throw failure; } return checked; },
    });
    // The service owns the outer content-free root; attach legacy capture outside the shared kernel boundary.
    await expect(withCoreRuntimeDiagnosticsV1(event => { events.push(event); }, () => observeCoreRuntimeV1('research_run', async () => {
      await expect(h.research.answerWithResearch({ question: 'What is the current state?' })).rejects.toBe(failure);
    }, { observer: event => { metadata.push(event); }, content_observer: content }))).resolves.toBeUndefined();
    const stages = lifecycle(events);
    expect(stages).toContainEqual(expect.objectContaining({ stage: 'audit', event: 'succeeded' }));
    expect(stages.filter(event => event.stage === 'release').map(event => event.event)).toEqual(['started', 'failed']);
    expect(stages.at(-1)).toMatchObject({ stage: 'run', event: 'failed', error_kind: 'stale_access_state' });
    expect(h.audit).toHaveLength(1);
    expect(metadata).toContainEqual(expect.objectContaining({ phase: 'research_release', event: 'failed' }));
    expect(content).not.toHaveBeenCalled();
    expect(JSON.stringify(events)).not.toContain('private membership details');
  });

  it('marks audit failure terminal and never reports a successful release', async () => {
    const events: CoreRuntimeDiagnosticObservationV1[] = [];
    const failure = new AuthorityOperationError('unavailable', 'private audit store exception');
    await expect(withCoreRuntimeDiagnosticsV1(event => { events.push(event); }, () => replay('audit-failed', SCENARIOS.finish_after_search_and_open!, {
      on_append: () => { throw failure; },
    }))).rejects.toBe(failure);
    const stages = lifecycle(events);
    expect(stages.filter(event => event.stage === 'audit').map(event => event.event)).toEqual(['started', 'failed']);
    expect(stages.filter(event => event.stage === 'release').map(event => event.event)).toEqual(['started', 'failed']);
    expect(stages.at(-1)).toMatchObject({ stage: 'run', event: 'failed', error_kind: 'unavailable' });
    expect(JSON.stringify(events)).not.toContain('private audit store exception');
  });
});
