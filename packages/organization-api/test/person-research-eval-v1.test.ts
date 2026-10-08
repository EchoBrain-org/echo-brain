import { canonicalSha256 } from '@echo-brain/federation-protocol';
import { describe, expect, it } from 'vitest';
import {
  PERSON_RESEARCH_EVAL_MAX_RESPONSE_BYTES_V1,
  PERSON_RESEARCH_EVAL_MAX_TRACE_BYTES_V1,
  PERSON_RESEARCH_EVAL_MAX_TRACE_EVENTS_V1,
  validatePersonResearchEvalReadRequestV1,
  validatePersonResearchEvalReadResponseV1,
  validatePersonResearchEvalStartReceiptV1,
  validatePersonResearchEvalStartRequestV1,
} from '../src/person-research-eval-v1.js';

const record = { kind: 'approved_record', atom_id: canonicalSha256('atom'), record_sha256: canonicalSha256('record'), policy_id: 'organization-member-readable-person-v2' };
const ticket = { kind: 'ticket', tool_id: 'jira', external_scope_id: 'cloud-1', ticket_id: '10046', permalink: 'https://therm.example.test/browse/THERM-46', text_sha256: canonicalSha256('ticket') };
const page = { kind: 'page', tool_id: 'confluence', external_scope_id: 'cloud-1', page_id: '1441793', section_id: 's1', version: '3', permalink: 'https://therm.example.test/wiki/pages/viewpage.action?pageId=1441793', text_sha256: canonicalSha256('page') };
const runId = 'rr_00000000-0000-4000-8000-000000000001';
const project = 'prj_00000000-0000-4000-8000-000000000002';

describe('research evaluation start request', () => {
  it('accepts any well-formed envelope: a trigger name, its input, and an optional budget and scope', () => {
    expect(validatePersonResearchEvalStartRequestV1({ schema_version: 1, trigger: 'check', budget: 'background', project_id: project, input: { record } }))
      .toEqual({ schema_version: 1, trigger: 'check', budget: 'background', project_id: project, input: { record } });
    const findings = [{ finding: 'Firmware shows two decimals', expected: 'SW-22b updated', citations: [ticket, page, record] }];
    expect(validatePersonResearchEvalStartRequestV1({ schema_version: 1, trigger: 'sweep', input: { findings } })).toEqual({ schema_version: 1, trigger: 'sweep', input: { findings } });
    // The Authority's trigger definitions judge the name and the input; the API checks only their form.
    expect(validatePersonResearchEvalStartRequestV1({ schema_version: 1, trigger: 'a_future_trigger', mine: true, input: { anything: [1, 'two', null, true, { nested: 3.5 }] } }))
      .toMatchObject({ trigger: 'a_future_trigger', mine: true });
  });

  it('still accepts Ask\'s legacy question field, with the product question limits, as the envelope', () => {
    expect(validatePersonResearchEvalStartRequestV1({ schema_version: 1, trigger: 'ask', budget: 'live', project_id: project, question: 'Why is the DVT gate on hold?' }))
      .toEqual({ schema_version: 1, trigger: 'ask', budget: 'live', project_id: project, input: { question: 'Why is the DVT gate on hold?' } });
    expect(() => validatePersonResearchEvalStartRequestV1({ schema_version: 1, trigger: 'ask', budget: 'live', question: 'x '.repeat(130).trim() })).toThrow(expect.objectContaining({ name: 'PersonQueryInputError', code: 'query_too_long' }));
  });

  it('requires an explicit true opt-in for diagnostic payload capture, including the legacy Ask form', () => {
    const request = { schema_version: 1, trigger: 'ask', input: { question: 'Why is DVT on hold?' } };
    expect(validatePersonResearchEvalStartRequestV1(request)).not.toHaveProperty('capture_trace');
    expect(validatePersonResearchEvalStartRequestV1({ ...request, capture_trace: true })).toEqual({ ...request, capture_trace: true });
    expect(validatePersonResearchEvalStartRequestV1({ schema_version: 1, trigger: 'ask', question: 'Why is DVT on hold?', capture_trace: true }))
      .toEqual({ ...request, capture_trace: true });
    for (const capture_trace of [false, undefined, null, 1, 'true']) {
      expect(() => validatePersonResearchEvalStartRequestV1({ ...request, capture_trace })).toThrow(/trace request/u);
    }
  });

  it('refuses a malformed envelope', () => {
    const deep = (depth: number): unknown => depth === 0 ? 'leaf' : { next: deep(depth - 1) };
    const bad: unknown[] = [
      { schema_version: 1, trigger: 'ask', budget: 'live', question: 'q', input: { question: 'q' } },
      { schema_version: 1, trigger: 'check', budget: 'soon', input: { record } },
      { schema_version: 1, trigger: 'check', input: { record }, record },
      { schema_version: 1, trigger: 'check' },
      { schema_version: 1, trigger: 'check', input: [record] },
      { schema_version: 1, trigger: 'check', input: null },
      { schema_version: 1, trigger: 'check', input: { record: Number.NaN } },
      { schema_version: 1, trigger: 'check', input: { record: undefined } },
      { schema_version: 1, trigger: 'check', input: deep(9) },
      { schema_version: 1, trigger: 'check', input: { text: 'x'.repeat(16 * 1024) } },
      { schema_version: 1, trigger: 'Check', input: {} },
      { schema_version: 1, trigger: 'drift-2', input: {} },
      { schema_version: 1, trigger: 'x'.repeat(65), input: {} },
      { schema_version: 1, trigger: 7, input: {} },
      { schema_version: 1, trigger: 'ask', mine: true, project_id: project, input: { question: 'q' } },
      { schema_version: 2, trigger: 'ask', input: { question: 'q' } },
    ];
    for (const value of bad) expect(() => validatePersonResearchEvalStartRequestV1(value), JSON.stringify(value)).toThrow();
    expect(validatePersonResearchEvalStartRequestV1({ schema_version: 1, trigger: 'check', input: deep(7) })).toMatchObject({ trigger: 'check' });
  });
});

describe('research evaluation diagnostic trace', () => {
  const research = { schema_version: 1, kind: 'echo-agentic-research-result-v1', trigger: 'ask', items: [], rounds: [], plan: [] };
  const completed = { schema_version: 1, kind: 'echo-person-research-eval-result-v1', run_id: runId, status: 'completed', research };
  const trace = { schema_version: 1, kind: 'echo-agentic-research-trace-v1', complete: true, events: [], dropped_events: 0 };
  const event = { kind: 'model_request', sequence: 1, call_id: 1 };
  const deep = (depth: number): unknown => depth === 0 ? 'leaf' : { next: deep(depth - 1) };

  it('preserves exact model prompts, structured decisions, and tool payloads without line normalization', () => {
    const prompt = ' Read these links.\n\nTHERM-50 → THERM-51\t"blocks"\r\n';
    const schema = { properties: { nested: deep(16) } };
    const shared = { tool: 'open', args: { id: 'E8' } };
    const events = [
      { ...event, input: { system_prompt: prompt, user_prompt: '{"last_results":[]}', schema } },
      { kind: 'model_response', sequence: 2, call_id: 1, value: { actions: [shared], plan: [{ need: 'PVT entry', state: 'open' }] } },
      { kind: 'tool_request', sequence: 3, tool_call_id: 1, ...shared },
      { kind: 'tool_response', sequence: 4, tool_call_id: 1, result: { opened: ['E8'], results: [{ id: 'E12', title: 'Fixture readiness' }] } },
      { kind: 'tool_error', sequence: 5, tool_call_id: 2, error_kind: 'unavailable' },
      { kind: 'model_error', sequence: 6, call_id: 2, error_kind: 'timed_out' },
    ];
    const captured = { ...trace, events };
    expect(validatePersonResearchEvalReadResponseV1({ ...completed, trace: captured }).trace).toEqual(captured);
    expect(validatePersonResearchEvalReadResponseV1(completed)).not.toHaveProperty('trace');
  });

  it('allows a captured prefix on completed or failed runs, and never on running runs', () => {
    const partial = { ...trace, complete: false, events: [event], dropped_events: 3 };
    expect(validatePersonResearchEvalReadResponseV1({ ...completed, trace: partial }).trace).toEqual(partial);
    const failed = { schema_version: 1, kind: 'echo-person-research-eval-result-v1', run_id: runId, status: 'failed', error: { code: 'unavailable', message: 'The model request failed' } };
    expect(validatePersonResearchEvalReadResponseV1({ ...failed, trace }).trace).toEqual(trace);
    expect(validatePersonResearchEvalReadResponseV1({ ...failed, trace: partial }).trace).toEqual(partial);
    expect(() => validatePersonResearchEvalReadResponseV1({ schema_version: 1, kind: 'echo-person-research-eval-result-v1', run_id: runId, status: 'running', trace })).toThrow(/status/u);
  });

  it('rejects malformed trace envelopes, inconsistent completeness, and invalid event sequences', () => {
    const bad = [
      undefined, null, [], { ...trace, schema_version: 2 }, { ...trace, kind: 'other' }, { ...trace, extra: true },
      { ...trace, complete: 'true' }, { ...trace, complete: false }, { ...trace, dropped_events: 1 },
      ...[-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, '0'].map(dropped_events => ({ ...trace, dropped_events })),
      { ...trace, events: {} }, { ...trace, events: [null] }, { ...trace, events: [{ ...event, kind: 'prompt' }] },
      ...[undefined, 0, -1, 0.5, 2, '1', Number.NaN, Number.POSITIVE_INFINITY].map(sequence => ({ ...trace, events: [{ ...event, sequence }] })),
      { ...trace, events: [event, { ...event, sequence: 1 }] },
      { ...trace, events: [event, { ...event, sequence: 3 }] },
    ];
    for (const invalid of bad) expect(() => validatePersonResearchEvalReadResponseV1({ ...completed, trace: invalid })).toThrow();
  });

  it('rejects non-JSON payloads, cycles, hidden properties, sparse arrays, and accessors without invoking them', () => {
    const cycle: Record<string, unknown> = {};
    cycle.next = cycle;
    const hidden = Object.defineProperty({}, 'hidden', { value: 'omitted', enumerable: false });
    const symbol = { [Symbol('omitted')]: 'omitted' };
    let getterCalls = 0;
    const accessor = { get payload() { getterCalls += 1; return 'must not read'; } };
    const arrayWithExtra = Object.assign(['visible'], { extra: 'omitted' });
    for (const payload of [undefined, Number.NaN, Number.POSITIVE_INFINITY, 1n, () => 'omitted', new Date(), cycle, hidden, symbol, accessor, Array(1), arrayWithExtra]) {
      expect(() => validatePersonResearchEvalReadResponseV1({ ...completed, trace: { ...trace, events: [{ ...event, payload }] } })).toThrow();
    }
    expect(getterCalls).toBe(0);
  });

  it('uses a separate depth allowance for nested model JSON schemas', () => {
    const captured = { ...trace, events: [{ ...event, payload: deep(45) }] };
    expect(validatePersonResearchEvalReadResponseV1({ ...completed, trace: captured }).trace).toEqual(captured);
    expect(() => validatePersonResearchEvalReadResponseV1({ ...completed, trace: { ...trace, events: [{ ...event, payload: deep(46) }] } })).toThrow(/trace/u);
  });

  it('bounds the complete JSON trace by event count and UTF-8 bytes, retaining the existing response ceiling', () => {
    const events = Array.from({ length: PERSON_RESEARCH_EVAL_MAX_TRACE_EVENTS_V1 }, (_, index) => ({ ...event, sequence: index + 1 }));
    expect(validatePersonResearchEvalReadResponseV1({ ...completed, trace: { ...trace, events } }).trace?.events).toHaveLength(512);
    expect(() => validatePersonResearchEvalReadResponseV1({ ...completed, trace: { ...trace, events: [...events, { ...event, sequence: 513 }] } })).toThrow(/trace/u);
    const emptyText = { ...trace, events: [{ ...event, payload: '' }] };
    const overhead = Buffer.byteLength(JSON.stringify(emptyText), 'utf8');
    const exact = { ...trace, events: [{ ...event, payload: 'x'.repeat(PERSON_RESEARCH_EVAL_MAX_TRACE_BYTES_V1 - overhead) }] };
    expect(validatePersonResearchEvalReadResponseV1({ ...completed, trace: exact }).trace?.events).toHaveLength(1);
    expect(() => validatePersonResearchEvalReadResponseV1({ ...completed, trace: { ...trace, events: [{ ...event, payload: `${exact.events[0]!.payload}é` }] } })).toThrow(/too large/u);
    expect(PERSON_RESEARCH_EVAL_MAX_RESPONSE_BYTES_V1).toBe(16 * 1024 * 1024);
  });
});

describe('research evaluation receipts and results', () => {
  it('validates run ids and read requests', () => {
    expect(validatePersonResearchEvalStartReceiptV1({ schema_version: 1, kind: 'echo-person-research-eval-run-v1', run_id: runId, status: 'running' }).run_id).toBe(runId);
    expect(validatePersonResearchEvalReadRequestV1({ schema_version: 1, run_id: runId })).toEqual({ schema_version: 1, run_id: runId });
    expect(() => validatePersonResearchEvalReadRequestV1({ schema_version: 1, run_id: 'rr_guess' })).toThrow();
  });

  it('keeps each status consistent with its payload', () => {
    const research = { schema_version: 1, kind: 'echo-agentic-research-result-v1', trigger: 'check', items: [], rounds: [], plan: [] };
    // Any well-formed trigger name: the Authority's definitions decide which exist.
    expect(validatePersonResearchEvalReadResponseV1({ schema_version: 1, kind: 'echo-person-research-eval-result-v1', run_id: runId, status: 'completed', research: { ...research, trigger: 'a_future_trigger' } }).status).toBe('completed');
    expect(validatePersonResearchEvalReadResponseV1({ schema_version: 1, kind: 'echo-person-research-eval-result-v1', run_id: runId, status: 'running' }).status).toBe('running');
    expect(validatePersonResearchEvalReadResponseV1({ schema_version: 1, kind: 'echo-person-research-eval-result-v1', run_id: runId, status: 'completed', research }).research).toEqual(research);
    expect(validatePersonResearchEvalReadResponseV1({ schema_version: 1, kind: 'echo-person-research-eval-result-v1', run_id: runId, status: 'failed', error: { code: 'not_found', message: 'Starting evidence is not available' } }).error?.code).toBe('not_found');
    for (const value of [
      { schema_version: 1, kind: 'echo-person-research-eval-result-v1', run_id: runId, status: 'running', research },
      { schema_version: 1, kind: 'echo-person-research-eval-result-v1', run_id: runId, status: 'completed' },
      { schema_version: 1, kind: 'echo-person-research-eval-result-v1', run_id: runId, status: 'failed', error: { code: 'teapot', message: 'x' } },
      { schema_version: 1, kind: 'echo-person-research-eval-result-v1', run_id: runId, status: 'completed', research, ask: { writer_evidence: ['E1'], response: {} } },
      { schema_version: 1, kind: 'echo-person-research-eval-result-v1', run_id: runId, status: 'completed', research: { ...research, kind: 'other' } },
      { schema_version: 1, kind: 'echo-person-research-eval-result-v1', run_id: runId, status: 'completed', research: { ...research, trigger: 'Not A Name' } },
    ]) expect(() => validatePersonResearchEvalReadResponseV1(value)).toThrow();
  });

  it('carries a rendered impact card beside the research of a task, and Ask output beside the research of a question', () => {
    const base = { schema_version: 1, kind: 'echo-person-research-eval-result-v1', run_id: runId };
    const task = { schema_version: 1, kind: 'echo-agentic-research-result-v1', trigger: 'approved_record', goal: { kind: 'task', task: 'A PM just approved record E1.' }, items: [], rounds: [], plan: [] };
    const question = { ...task, trigger: 'ask', goal: { kind: 'question', question: 'Why is DVT on hold?' } };
    const card = {
      decided: [{ text: 'The display shows two decimals.', citation_index: 0 }], affected: [], unconfirmed: ['owner of the PRD display section'], people: [], status: 'assessed',
      citations: [{ citation: record, kind: 'decision', label: 'Pilot review: display precision', visibility: 'team' }],
    };
    expect(validatePersonResearchEvalReadResponseV1({ ...base, status: 'completed', research: task, rendered: card })).toEqual({ ...base, status: 'completed', research: task, rendered: card });
    // The goal's form, not a trigger name, decides which output fits: a question has Ask's writer, a task its trigger's renderer.
    expect(() => validatePersonResearchEvalReadResponseV1({ ...base, status: 'completed', research: { ...task, trigger: 'ask' }, ask: { writer_evidence: [], response: {} } })).toThrow(/question result/u);
    for (const value of [
      { ...base, status: 'running', rendered: card },
      { ...base, status: 'completed', research: question, rendered: card },
      { ...base, status: 'completed', research: { ...task, goal: undefined }, rendered: card },
      { ...base, status: 'completed', research: task, rendered: { ...card, status: 'maybe' } },
      { ...base, status: 'completed', research: task, rendered: { ...card, affected: [{ citation_index: 0, says_now: 'Change THERM-46 in Jira.', relation: 'conflicts' }] } },
    ]) expect(() => validatePersonResearchEvalReadResponseV1(value), JSON.stringify(value).slice(0, 120)).toThrow();
  });
});
