import { describe, expect, it } from 'vitest';
import {
  PERSON_DIAGNOSTICS_PATH_V1,
  validatePersonDiagnosticCaptureIdV1,
  validatePersonDiagnosticTraceV1,
  validatePersonDiagnosticsRequestV1,
  validatePersonDiagnosticsResponseV1,
  validatePersonDiagnosticsResultV1,
} from '../src/person-diagnostics-v1.js';
import { validatePersonAnswerRequestV3 } from '../src/person-answer-v4.js';
import { validatePersonRunsRequestV1 } from '../src/person-runs-v1.js';

const capture_id = 'cap_00000000-0000-4000-8000-000000000001';
const run_id = 'run_00000000-0000-4000-8000-000000000002';
const expires_at = '2026-10-08T20:15:00.000Z';
const trace = { schema_version: 1, kind: 'echo-agentic-research-trace-v1', complete: true, events: [], dropped_events: 0 };
const prepared = { schema_version: 1, kind: 'echo-person-diagnostic-capture-v1', capture_id, status: 'prepared', expires_at };
const read = { ...prepared, kind: 'echo-person-diagnostic-result-v1' };

describe('ordinary request diagnostic captures', () => {
  it('prepares only a target and reads only a capture id, without accepting source payload or actor selectors', () => {
    expect(PERSON_DIAGNOSTICS_PATH_V1).toBe('/v1/person/diagnostics');
    for (const request of [
      { schema_version: 1, operation: 'prepare', target: { kind: 'ask' } },
      { schema_version: 1, operation: 'prepare', target: { kind: 'trigger_run', run_id } },
      { schema_version: 1, operation: 'read', capture_id },
    ]) expect(validatePersonDiagnosticsRequestV1(request)).toEqual(request);
    for (const request of [
      { schema_version: 1, operation: 'prepare', target: { kind: 'ask', question: 'What changed?' } },
      { schema_version: 1, operation: 'prepare', target: { kind: 'meeting', run_id } },
      { schema_version: 1, operation: 'prepare', target: { kind: 'trigger_run', run_id: 'rr_1234' } },
      { schema_version: 1, operation: 'prepare', target: { kind: 'trigger_run' } },
      { schema_version: 1, operation: 'prepare', target: { kind: 'ask' }, capture_id },
      { schema_version: 1, operation: 'read', capture_id, principal_id: 'someone_else' },
      { schema_version: 1, operation: 'read', capture_id, trace },
      { schema_version: 1, operation: 'delete', capture_id },
      { schema_version: 2, operation: 'read', capture_id },
      { schema_version: 1, operation: 'read' },
    ]) expect(() => validatePersonDiagnosticsRequestV1(request)).toThrow();
  });

  it('accepts only canonical server-generated UUIDv4 capture ids', () => {
    expect(validatePersonDiagnosticCaptureIdV1(capture_id)).toBe(capture_id);
    for (const value of [undefined, null, 1, 'cap_guess', capture_id.toUpperCase(), capture_id.replace('4000', '5000'), capture_id.replace('8000', '7000'), `${capture_id}\n`]) {
      expect(() => validatePersonDiagnosticCaptureIdV1(value)).toThrow();
    }
  });

  it('carries a capture on an ordinary Ask and only on the start operation of an approved run', () => {
    const ask = { schema_version: 3, question: 'Why is Thermo DVT on hold?', capture_id };
    expect(validatePersonAnswerRequestV3(ask)).toEqual(ask);
    expect(validatePersonAnswerRequestV3({ ...ask, mine: true })).toEqual({ ...ask, mine: true });
    expect(validatePersonRunsRequestV1({ schema_version: 1, operation: 'start', run_id, capture_id })).toEqual({ schema_version: 1, operation: 'start', run_id, capture_id });
    for (const operation of ['retry', 'view', 'list']) expect(() => validatePersonRunsRequestV1({ schema_version: 1, operation, ...(operation === 'list' ? {} : { run_id }), capture_id })).toThrow();
    for (const invalid of [null, undefined, 'cap_guess']) {
      expect(() => validatePersonAnswerRequestV3({ ...ask, capture_id: invalid })).toThrow();
      expect(() => validatePersonRunsRequestV1({ schema_version: 1, operation: 'start', run_id, capture_id: invalid })).toThrow();
    }
  });

  it('keeps prepare and read responses distinct and requires a valid expiry', () => {
    expect(validatePersonDiagnosticsResultV1('prepare', prepared)).toEqual(prepared);
    expect(validatePersonDiagnosticsResultV1('read', read)).toEqual(read);
    expect(() => validatePersonDiagnosticsResultV1('read', prepared)).toThrow(/operation/u);
    expect(() => validatePersonDiagnosticsResultV1('prepare', read)).toThrow(/operation/u);
    for (const value of [
      { ...prepared, status: 'running' }, { ...prepared, trace }, { ...prepared, extra: true },
      { ...read, status: 'unknown' }, { ...read, kind: 'unknown' }, { ...read, schema_version: 2 },
      { ...read, expires_at: 'tomorrow' }, { ...read, expires_at: '2026-10-08T20:15:00Z' },
      { ...read, expires_at: '2026-13-08T20:15:00.000Z' },
    ]) expect(() => validatePersonDiagnosticsResponseV1(value)).toThrow();
  });

  it('never releases payload on prepared/running captures and allows captured prefixes on terminal failures', () => {
    for (const status of ['prepared', 'running']) {
      expect(validatePersonDiagnosticsResponseV1({ ...read, status })).toEqual({ ...read, status });
      expect(() => validatePersonDiagnosticsResponseV1({ ...read, status, trace })).toThrow(/status/u);
    }
    const partial = { ...trace, complete: false, events: [{ kind: 'tool_request', sequence: 1, tool: 'open', args: { id: 'E8' } }], dropped_events: 2 };
    const error = { code: 'unavailable', message: 'Research could not complete' };
    for (const terminal of [{ ...read, status: 'completed' }, { ...read, status: 'failed', error }]) {
      expect(validatePersonDiagnosticsResponseV1({ ...terminal, trace: partial })).toEqual({ ...terminal, trace: partial });
    }
    for (const value of [
      { ...read, status: 'failed' }, { ...read, status: 'completed', error }, { ...read, status: 'running', error },
      { ...read, status: 'failed', error: { ...error, code: 'unexpected' } },
      { ...read, status: 'failed', error: { ...error, message: 'raw\nerror' } },
    ]) expect(() => validatePersonDiagnosticsResponseV1(value)).toThrow();
  });
});

describe('shared lifecycle diagnostic events', () => {
  it('preserves lifecycle payloads exactly in ordinary captures', () => {
    const prompt = '  Read E8.\nE8 → E12\tblocks\r\n';
    const captured = { ...trace, events: [
      { kind: 'lifecycle', sequence: 1, stage: 'brief', event: 'succeeded', data: { goal: { question: prompt } } },
      { kind: 'model_request', sequence: 2, input: { system_prompt: prompt, user_prompt: '{"seen":[]}' } },
      { kind: 'model_response', sequence: 3, value: { plan: [{ need: 'PVT entry', state: 'open' }], actions: [{ tool: 'open', args: { id: 'E12' } }] } },
      { kind: 'lifecycle', sequence: 4, stage: 'revalidation', event: 'failed', error_kind: 'stale_access_state' },
    ] };
    expect(validatePersonDiagnosticTraceV1(captured)).toEqual(captured);
    expect(validatePersonDiagnosticsResponseV1({ ...read, status: 'completed', trace: captured })).toMatchObject({ trace: captured });
  });

  it('accepts service lifecycle stages surrounding the shared research loop', () => {
    const events = ['trigger', 'application', 'persistence', 'output_view'].map((stage, index) => ({ kind: 'lifecycle', sequence: index + 1, stage, event: 'succeeded' }));
    expect(validatePersonDiagnosticTraceV1({ ...trace, events }).events).toEqual(events);
  });

  it('rejects unknown lifecycle stages, phases, error kinds, and non-record data', () => {
    const event = { kind: 'lifecycle', sequence: 1, stage: 'research', event: 'started' };
    for (const changes of [{ stage: 'database' }, { event: 'pending' }, { error_kind: 'secret error text' }, { data: [] }, { data: null }, { kind: 'capture_error' }]) {
      expect(() => validatePersonDiagnosticTraceV1({ ...trace, events: [{ ...event, ...changes }] })).toThrow();
    }
  });
});
