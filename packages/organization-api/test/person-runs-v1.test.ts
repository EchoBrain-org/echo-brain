import { canonicalSha256 } from '@echo-brain/federation-protocol';
import { describe, expect, it } from 'vitest';
import {
  PERSON_RUNS_MAX_RESPONSE_BYTES_V1,
  PERSON_RUNS_PATH_V1,
  validatePersonRunsRequestV1,
  validatePersonRunsResultV1,
  type PersonRunsResultsV1,
} from '../src/person-runs-v1.js';

const refused = (call: () => unknown, label: string) => {
  expect(call, label).toThrow(expect.objectContaining({ name: 'OrganizationApiValidationError' }));
};

const NOW = '2026-10-07T10:00:00.000Z';
const LATER = '2026-10-07T10:05:00.000Z';
const run = (overrides: Record<string, unknown> = {}) => ({
  run_id: 'run_0f6c1a2e-3b4d-4c5e-8f90-123456789abc', trigger: 'approved_record', event_ref: 'apr_9b1d', state: 'pending', error_code: null, created_at: NOW, updated_at: NOW, ...overrides,
});

const record = {
  citation: { kind: 'approved_record', atom_id: canonicalSha256('atom'), record_sha256: canonicalSha256('record'), policy_id: 'organization-member-readable-person-v2' },
  kind: 'decision', label: 'Gate review: display precision', visibility: 'team',
};
const ticket = {
  citation: { kind: 'ticket', tool_id: 'jira', external_scope_id: 'cloud-1', ticket_id: '10046', permalink: 'https://therm.example.test/browse/THERM-46', text_sha256: canonicalSha256('ticket') },
  kind: 'ticket', label: 'THERM-46: Display precision', visibility: 'only_me',
};
const card = {
  decided: [{ text: 'Show two decimals on the display.', citation_index: 0 }],
  affected: [{ citation_index: 1, says_now: 'THERM-46 formats one decimal.', relation: 'conflicts', owner: 'Mara Quinn', date_at_risk: { date: '2026-10-15', milestone: 'DVT gate' } }],
  unconfirmed: ['1 item could not be read.'],
  people: [{ name: 'Mara Quinn', items: [1] }],
  status: 'assessed',
  citations: [record, ticket],
};

describe('runs API path', () => {
  it('is the one runs route', () => {
    expect(PERSON_RUNS_PATH_V1).toBe('/v1/person/runs');
  });
});

describe('runs API request', () => {
  const id = 'run_0f6c1a2e-3b4d-4c5e-8f90-123456789abc';

  it('accepts each operation with exactly its keys', () => {
    for (const request of [
      { schema_version: 1, operation: 'list' },
      { schema_version: 1, operation: 'start', run_id: id },
      { schema_version: 1, operation: 'retry', run_id: id },
      { schema_version: 1, operation: 'view', run_id: id },
    ]) {
      expect(validatePersonRunsRequestV1(request)).toEqual(request);
      expect(Object.isFrozen(validatePersonRunsRequestV1(request))).toBe(true);
    }
  });

  it.each([
    ['wrong schema version', { schema_version: 2, operation: 'list' }],
    ['no schema version', { operation: 'list' }],
    ['string schema version', { schema_version: '1', operation: 'list' }],
    ['unknown operation', { schema_version: 1, operation: 'cancel', run_id: id }],
    ['no operation', { schema_version: 1 }],
    ['a prototype operation name', { schema_version: 1, operation: 'toString' }],
    ['list with a run id', { schema_version: 1, operation: 'list', run_id: id }],
    ['list with an extra key', { schema_version: 1, operation: 'list', limit: 5 }],
    ['start without a run id', { schema_version: 1, operation: 'start' }],
    ['start with an extra key', { schema_version: 1, operation: 'start', run_id: id, force: true }],
    ['retry with an extra key', { schema_version: 1, operation: 'retry', run_id: id, attempts: 0 }],
    ['view with an extra key', { schema_version: 1, operation: 'view', run_id: id, project_id: 'prj_x' }],
    ['a run id without the prefix', { schema_version: 1, operation: 'start', run_id: 'rr_0f6c1a2e-3b4d' }],
    ['a run id that is too short', { schema_version: 1, operation: 'start', run_id: 'run_abc' }],
    ['a run id that is too long', { schema_version: 1, operation: 'start', run_id: `run_${'a'.repeat(61)}` }],
    ['a run id with a forbidden character', { schema_version: 1, operation: 'start', run_id: 'run_abcd_efgh' }],
    ['a run id with whitespace', { schema_version: 1, operation: 'start', run_id: 'run_abcd efgh' }],
    ['a run id with a newline', { schema_version: 1, operation: 'start', run_id: 'run_abcdefgh\n' }],
    ['a numeric run id', { schema_version: 1, operation: 'start', run_id: 12345678 }],
    ['not an object', 'list'],
    ['null', null],
    ['an array', [{ schema_version: 1, operation: 'list' }]],
  ])('refuses %s', (_label, request) => {
    refused(() => validatePersonRunsRequestV1(request), _label);
  });

  it('accepts a run id at both length limits', () => {
    expect(() => validatePersonRunsRequestV1({ schema_version: 1, operation: 'view', run_id: `run_${'a'.repeat(4)}` })).not.toThrow();
    expect(() => validatePersonRunsRequestV1({ schema_version: 1, operation: 'view', run_id: `run_${'Z-9'.repeat(20)}` })).not.toThrow();
  });
});

describe('runs API list result', () => {
  const list = (value: unknown) => validatePersonRunsResultV1('list', value);

  it('accepts runs in every state with the matching error code', () => {
    const runs = [
      run(),
      run({ run_id: 'run_aaaa', state: 'running', updated_at: LATER }),
      run({ run_id: 'run_bbbb', state: 'done', updated_at: LATER }),
      ...(['no_access', 'unavailable', 'timed_out', 'research_failed'] as const).map((error_code, at) => run({ run_id: `run_f${at}f${at}`, state: 'failed', error_code, updated_at: LATER })),
    ];
    expect(list({ runs })).toEqual({ runs });
    expect(list({ runs: [] })).toEqual({ runs: [] });
    expect(Object.isFrozen(list({ runs }))).toBe(true);
  });

  it('accepts at most 100 runs', () => {
    const many = (count: number) => ({ runs: Array.from({ length: count }, (_, at) => run({ run_id: `run_${String(at).padStart(6, '0')}` })) });
    expect(list(many(100)).runs).toHaveLength(100);
    refused(() => list(many(101)), 'one run too many');
  });

  it.each([
    ['an extra key on the result', { runs: [], cursor: 'next' }],
    ['no runs key', {}],
    ['runs that are not an array', { runs: run() }],
    ['an extra key on a run', { runs: [run({ result_json: '{}' })] }],
    ['a run missing a key', { runs: [{ ...run(), error_code: undefined }] }],
    ['a trigger other than approved_record', { runs: [run({ trigger: 'sweep' })] }],
    ['a bad run id', { runs: [run({ run_id: 'rr_1234' })] }],
    ['an empty event ref', { runs: [run({ event_ref: '' })] }],
    ['an event ref over 128 characters', { runs: [run({ event_ref: 'a'.repeat(129) })] }],
    ['an event ref with a control character', { runs: [run({ event_ref: 'apr_\u0000' })] }],
    ['an unknown state', { runs: [run({ state: 'completed' })] }],
    ['an unknown error code', { runs: [run({ state: 'failed', error_code: 'boom' })] }],
    ['failed without an error code', { runs: [run({ state: 'failed', error_code: null })] }],
    ['done with an error code', { runs: [run({ state: 'done', error_code: 'unavailable' })] }],
    ['pending with an error code', { runs: [run({ state: 'pending', error_code: 'timed_out' })] }],
    ['running with an error code', { runs: [run({ state: 'running', error_code: 'no_access' })] }],
    ['an error code that is not a string or null', { runs: [run({ state: 'failed', error_code: 0 })] }],
    ['a timestamp without milliseconds', { runs: [run({ created_at: '2026-10-07T10:00:00Z' })] }],
    ['a timestamp that is not a real instant', { runs: [run({ updated_at: '2026-13-07T10:00:00.000Z' })] }],
    ['a non-string timestamp', { runs: [run({ created_at: 1790000000000 })] }],
  ])('refuses %s', (_label, value) => {
    refused(() => list(value), _label);
  });
});

describe('runs API start and retry results', () => {
  it('accepts a start state from the closed set', () => {
    for (const state of ['pending', 'running', 'busy', 'done', 'failed'] as const) expect(validatePersonRunsResultV1('start', { state })).toEqual({ state });
    for (const [label, value] of [
      ['an unknown state', { state: 'queued' }], ['an extra key', { state: 'running', run_id: 'run_abcd' }], ['no state', {}], ['a non-string state', { state: 1 }],
    ] as const) refused(() => validatePersonRunsResultV1('start', value), label);
  });

  it('accepts only pending as a retry result', () => {
    expect(validatePersonRunsResultV1('retry', { state: 'pending' })).toEqual({ state: 'pending' });
    for (const [label, value] of [
      ['running', { state: 'running' }], ['busy', { state: 'busy' }], ['failed', { state: 'failed' }], ['an extra key', { state: 'pending', attempts: 0 }], ['no state', {}],
    ] as const) refused(() => validatePersonRunsResultV1('retry', value), label);
  });
});

describe('runs API view result', () => {
  const view = (value: unknown) => validatePersonRunsResultV1('view', value);
  const valid = { card, checked_at: LATER, hidden: 2 };

  it('accepts a valid card with its check time and hidden count', () => {
    const result = view(valid);
    expect(result).toEqual(valid);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.card)).toBe(true);
    expect(view({ ...valid, hidden: 0 }).hidden).toBe(0);
  });

  it.each([
    ['an extra key', { ...valid, run_id: 'run_abcd' }],
    ['no card', { checked_at: LATER, hidden: 0 }],
    ['no check time', { card, hidden: 0 }],
    ['no hidden count', { card, checked_at: LATER }],
    ['a card with an extra key', { ...valid, card: { ...card, suggested_edits: [] } }],
    ['a card that is not valid', { ...valid, card: { ...card, citations: [record] } }],
    ['a card whose people do not match its owners', { ...valid, card: { ...card, people: [] } }],
    ['a card that is not an object', { ...valid, card: 'card' }],
    ['a bad check time', { ...valid, checked_at: '2026-10-07 10:05' }],
    ['a negative hidden count', { ...valid, hidden: -1 }],
    ['a fractional hidden count', { ...valid, hidden: 1.5 }],
    ['an unsafe hidden count', { ...valid, hidden: Number.MAX_SAFE_INTEGER + 1 }],
    ['a string hidden count', { ...valid, hidden: '1' }],
  ])('refuses %s', (_label, value) => {
    refused(() => view(value), _label);
  });
});

describe('runs API results in general', () => {
  it('refuses an operation it does not know, and a value that is not an object', () => {
    refused(() => validatePersonRunsResultV1('cancel' as keyof PersonRunsResultsV1, {}), 'unknown operation');
    refused(() => validatePersonRunsResultV1('toString' as keyof PersonRunsResultsV1, {}), 'prototype operation');
    for (const value of [null, 'done', ['done']]) refused(() => validatePersonRunsResultV1('start', value), String(value));
  });

  it('caps a response at 1 MiB', () => {
    expect(PERSON_RUNS_MAX_RESPONSE_BYTES_V1).toBe(1024 * 1024);
    // A full list of ordinary runs is far below the cap.
    const runs = Array.from({ length: 100 }, (_, at) => run({ run_id: `run_${String(at).padStart(6, '0')}`, event_ref: 'e'.repeat(120) }));
    expect(() => validatePersonRunsResultV1('list', { runs })).not.toThrow();
  });
});
