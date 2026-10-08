import { PERSON_RESEARCH_EVAL_MAX_TRACE_BYTES_V1, PERSON_RESEARCH_EVAL_MAX_TRACE_EVENTS_V1, validatePersonResearchEvalReadResponseV1 } from '@echo-brain/organization-api';
import { describe, expect, it } from 'vitest';
import { createPersonResearchEvalTraceV1 } from '../src/composition/person-research-eval-trace-v1.js';

const read = (trace: ReturnType<ReturnType<typeof createPersonResearchEvalTraceV1>['snapshot']>) => validatePersonResearchEvalReadResponseV1({
  schema_version: 1, kind: 'echo-person-research-eval-result-v1', run_id: 'rr_00000000-0000-4000-8000-000000000001',
  status: 'failed', error: { code: 'timed_out', message: 'The research run reached its deadline' }, trace,
});

describe('private research evaluation trace collector', () => {
  it('snapshots nested payloads and returns independent copies with capture order and time', () => {
    const capture = createPersonResearchEvalTraceV1(() => Date.parse('2026-10-08T20:00:00.000Z'));
    const event = { kind: 'tool_response', tool_call_id: 1, result: { results: [{ id: 'E2', title: 'Fixture blocks PVT' }] } };
    capture.record(event);
    event.result.results[0]!.title = 'changed after capture';
    const first = read(capture.snapshot()).trace!;
    expect(first).toMatchObject({ complete: true, dropped_events: 0, events: [{ sequence: 1, observed_at: '2026-10-08T20:00:00.000Z', result: { results: [{ title: 'Fixture blocks PVT' }] } }] });
    (first.events[0]!.result as typeof event.result).results[0]!.title = 'changed by a reader';
    expect(capture.snapshot().events[0]).toMatchObject({ result: { results: [{ title: 'Fixture blocks PVT' }] } });
  });

  it('retains at most 512 events and reports every omitted event', () => {
    const capture = createPersonResearchEvalTraceV1(() => 0);
    for (let index = 0; index < PERSON_RESEARCH_EVAL_MAX_TRACE_EVENTS_V1 + 3; index += 1) capture.record({ kind: 'model_error', call_id: index + 1, error_kind: 'deadline' });
    const trace = read(capture.snapshot()).trace!;
    expect(trace).toMatchObject({ complete: false, dropped_events: 3 });
    expect(trace.events).toHaveLength(PERSON_RESEARCH_EVAL_MAX_TRACE_EVENTS_V1);
    expect(trace.events.at(-1)!.sequence).toBe(PERSON_RESEARCH_EVAL_MAX_TRACE_EVENTS_V1);
  });

  it('bounds the entire JSON envelope by UTF-8 bytes and stops at the first overflow', () => {
    const capture = createPersonResearchEvalTraceV1(() => 0);
    capture.record({ kind: 'model_response', value: '界'.repeat(Math.floor(PERSON_RESEARCH_EVAL_MAX_TRACE_BYTES_V1 / 3) - 300) });
    capture.record({ kind: 'model_response', value: 'overflow'.repeat(200) });
    capture.record({ kind: 'model_response', value: 'small but after the missing event' });
    const trace = read(capture.snapshot()).trace!;
    expect(trace).toMatchObject({ complete: false, dropped_events: 2 });
    expect(trace.events).toHaveLength(1);
    expect(Buffer.byteLength(JSON.stringify(trace))).toBeLessThanOrEqual(PERSON_RESEARCH_EVAL_MAX_TRACE_BYTES_V1);
  });

  it.each(['circular', 'too_deep', 'capture_error'])('reports %s snapshots as incomplete without exposing an invalid event', kind => {
    const capture = createPersonResearchEvalTraceV1(() => 0);
    const event: Record<string, unknown> = { kind: 'model_response' };
    if (kind === 'circular') event.value = event;
    else if (kind === 'too_deep') { let value: unknown = {}; for (let index = 0; index < 48; index += 1) value = { child: value }; event.value = value; }
    else { event.kind = 'capture_error'; event.error_kind = 'snapshot_failed'; }
    capture.record(event);
    expect(read(capture.snapshot()).trace).toMatchObject({ complete: false, dropped_events: 1, events: [] });
  });

  it('seals a settled run and clears it immediately on close, ignoring late callbacks', () => {
    const capture = createPersonResearchEvalTraceV1(() => 0);
    capture.record({ kind: 'model_response', value: 'private source text' });
    capture.seal();
    capture.record({ kind: 'model_response', value: 'late response' });
    expect(capture.snapshot().events).toHaveLength(1);
    capture.close();
    capture.record({ kind: 'model_response', value: 'after close' });
    expect(capture.snapshot().events).toEqual([]);
  });
});
