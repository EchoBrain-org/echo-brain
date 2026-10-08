import { validatePersonDiagnosticCaptureIdV1, type PersonDiagnosticCaptureIdV1 } from './person-diagnostics-v1.js';
import { validatePersonImpactCardV1, type PersonImpactCardV1 } from './person-impact-card-v1.js';
import { asEnumerableRecord, assertExactKeys, assertString, assertTimestamp, fail, utf8ByteLength } from './validation.js';

/**
 * Trigger runs (runs store and impact card v1, section 5; ADR-0032). A signed-in
 * person lists the runs made for their own approvals, starts the oldest
 * pending one, asks to try a failed one again, and views a finished one as an
 * impact card. One envelope: `{schema_version: 1, operation, ...}`.
 *
 * A run holds no word read from outside ECHO. `view` rebuilds the card from
 * fresh reads for the viewer on every call and the API never returns more than
 * the card, its check time and how many cited items the viewer could not open.
 */
export const PERSON_RUNS_PATH_V1 = '/v1/person/runs';

export type PersonRunStateV1 = 'pending' | 'running' | 'done' | 'failed';
export type PersonRunErrorCodeV1 = 'no_access' | 'unavailable' | 'timed_out' | 'research_failed';

export type PersonRunsRequestV1 =
  | { readonly schema_version: 1; readonly operation: 'list' }
  | { readonly schema_version: 1; readonly operation: 'start'; readonly run_id: string; readonly capture_id?: PersonDiagnosticCaptureIdV1 }
  | { readonly schema_version: 1; readonly operation: 'retry'; readonly run_id: string }
  | { readonly schema_version: 1; readonly operation: 'view'; readonly run_id: string };

export interface PersonRunV1 {
  readonly run_id: string; readonly trigger: 'approved_record'; readonly event_ref: string;
  readonly state: PersonRunStateV1; readonly error_code: PersonRunErrorCodeV1 | null;
  readonly created_at: string; readonly updated_at: string;
}

export interface PersonRunsResultsV1 {
  list: { readonly runs: readonly PersonRunV1[] };
  start: { readonly state: 'pending' | 'running' | 'busy' | 'done' | 'failed' };
  retry: { readonly state: 'pending' };
  view: { readonly card: PersonImpactCardV1; readonly checked_at: string; readonly hidden: number };
}

/** A card is at most a few dozen short lines and pointers; 1 MiB is far above it. */
export const PERSON_RUNS_MAX_RESPONSE_BYTES_V1 = 1024 * 1024;
/** The most runs one list returns. */
export const PERSON_RUNS_LIST_LIMIT_V1 = 100;

const RUN_ID = /^run_[A-Za-z0-9-]{4,60}$/;
const STATES: readonly string[] = ['pending', 'running', 'done', 'failed'];
const ERROR_CODES: readonly string[] = ['no_access', 'unavailable', 'timed_out', 'research_failed'];
const REQUEST_KEYS: Readonly<Record<PersonRunsRequestV1['operation'], readonly string[]>> = Object.freeze({ list: [], start: ['run_id'], retry: ['run_id'], view: ['run_id'] });
const RESULT_KEYS: Readonly<Record<keyof PersonRunsResultsV1, readonly string[]>> = Object.freeze({ list: ['runs'], start: ['state'], retry: ['state'], view: ['card', 'checked_at', 'hidden'] });
const START_STATES: readonly string[] = ['pending', 'running', 'busy', 'done', 'failed'];

function runId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !RUN_ID.test(value)) fail(`${label} is invalid`);
  return value;
}

export function validatePersonRunsRequestV1(value: unknown): PersonRunsRequestV1 {
  const request = asEnumerableRecord(value, 'Runs request');
  const operation = request.operation;
  if (typeof operation !== 'string' || !Object.hasOwn(REQUEST_KEYS, operation)) fail('Runs request operation is invalid');
  assertExactKeys(request, ['schema_version', 'operation', ...REQUEST_KEYS[operation as PersonRunsRequestV1['operation']], ...(operation === 'start' && Object.hasOwn(request, 'capture_id') ? ['capture_id'] : [])], 'Runs request');
  if (request.schema_version !== 1) fail('Runs request version is invalid');
  if (operation === 'list') return Object.freeze({ schema_version: 1 as const, operation });
  const run_id = runId(request.run_id, 'Runs request run id');
  if (operation === 'start') return Object.freeze({ schema_version: 1 as const, operation, run_id, ...(Object.hasOwn(request, 'capture_id') ? { capture_id: validatePersonDiagnosticCaptureIdV1(request.capture_id) } : {}) });
  return Object.freeze({ schema_version: 1 as const, operation: operation as 'retry' | 'view', run_id });
}

function run(value: unknown): PersonRunV1 {
  const entry = asEnumerableRecord(value, 'Run');
  assertExactKeys(entry, ['run_id', 'trigger', 'event_ref', 'state', 'error_code', 'created_at', 'updated_at'], 'Run');
  runId(entry.run_id, 'Run id');
  if (entry.trigger !== 'approved_record') fail('Run trigger is invalid');
  assertString(entry.event_ref, 'Run event ref', 128);
  if (typeof entry.state !== 'string' || !STATES.includes(entry.state)) fail('Run state is invalid');
  // A reason is given exactly when the run failed.
  if (entry.error_code !== null && (typeof entry.error_code !== 'string' || !ERROR_CODES.includes(entry.error_code))) fail('Run error code is invalid');
  if ((entry.state === 'failed') !== (entry.error_code !== null)) fail('Run error code does not match its state');
  assertTimestamp(entry.created_at, 'Run created_at');
  assertTimestamp(entry.updated_at, 'Run updated_at');
  return Object.freeze({
    run_id: entry.run_id as string, trigger: 'approved_record', event_ref: entry.event_ref as string, state: entry.state as PersonRunStateV1,
    error_code: entry.error_code as PersonRunErrorCodeV1 | null, created_at: entry.created_at as string, updated_at: entry.updated_at as string,
  });
}

/** Transport bounds apply before parsing; the Authority runs the same checks on what it sends. */
export function validatePersonRunsResultV1<K extends keyof PersonRunsResultsV1>(operation: K, value: unknown): PersonRunsResultsV1[K] {
  if (typeof operation !== 'string' || !Object.hasOwn(RESULT_KEYS, operation)) fail('Runs response operation is invalid');
  const result = asEnumerableRecord(value, 'Runs response');
  assertExactKeys(result, RESULT_KEYS[operation], 'Runs response');
  const checked = (response: PersonRunsResultsV1[keyof PersonRunsResultsV1]): PersonRunsResultsV1[K] => {
    if (utf8ByteLength(JSON.stringify(response)) > PERSON_RUNS_MAX_RESPONSE_BYTES_V1) fail('Runs response exceeds its bound');
    return Object.freeze(response) as PersonRunsResultsV1[K];
  };
  switch (operation) {
    case 'list':
      if (!Array.isArray(result.runs) || result.runs.length > PERSON_RUNS_LIST_LIMIT_V1) fail('Runs list is invalid');
      return checked({ runs: Object.freeze(result.runs.map(run)) });
    case 'start':
      if (typeof result.state !== 'string' || !START_STATES.includes(result.state)) fail('Runs start state is invalid');
      return checked({ state: result.state as PersonRunsResultsV1['start']['state'] });
    case 'retry':
      if (result.state !== 'pending') fail('Runs retry state is invalid');
      return checked({ state: 'pending' });
    default: {
      // view
      const card = validatePersonImpactCardV1(result.card);
      assertTimestamp(result.checked_at, 'Runs view checked_at');
      if (typeof result.hidden !== 'number' || !Number.isSafeInteger(result.hidden) || result.hidden < 0) fail('Runs view hidden count is invalid');
      return checked({ card, checked_at: result.checked_at, hidden: result.hidden });
    }
  }
}
