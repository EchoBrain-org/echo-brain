import { validatePersonAnswerResponseV6 } from './person-answer-v4.js';
import type { PersonAnswerResponseV6 } from './person-answer-v6.js';
import { validatePersonImpactCardV1, type PersonImpactCardV1 } from './person-impact-card-v1.js';
import { validatePersonQueryText } from './person-query.js';
import { validateProjectIdV1, type ProjectIdV1 } from './project-context-v1.js';
import { asEnumerableRecord, fail, MAX_ORGANIZATION_API_BODY_BYTES, utf8ByteLength } from './validation.js';

/**
 * Staging-only research evaluation (research loop evaluation v1). A signed-in
 * person starts one research run and reads its research result once it
 * completes. Production never composes these routes.
 *
 * The start request is an envelope: a trigger's name and its input. This
 * package cannot see the Authority's trigger definitions, so it checks only
 * the envelope's form; the named definition checks its own input.
 */
export const PERSON_RESEARCH_EVAL_START_PATH_V1 = '/v1/person/research-eval/start';
export const PERSON_RESEARCH_EVAL_READ_PATH_V1 = '/v1/person/research-eval/read';

export type PersonResearchEvalBudgetV1 = 'live' | 'background';

export interface PersonResearchEvalStartRequestV1 {
  readonly schema_version: 1;
  /** A trigger definition's name. */
  readonly trigger: string;
  /** The trigger's event; its definition on the Authority checks it. */
  readonly input: Readonly<Record<string, unknown>>;
  /** Overrides the trigger's own budget profile. */
  readonly budget?: PersonResearchEvalBudgetV1;
  readonly project_id?: ProjectIdV1;
  readonly mine?: true;
}

export interface PersonResearchEvalStartReceiptV1 {
  readonly schema_version: 1;
  readonly kind: 'echo-person-research-eval-run-v1';
  readonly run_id: string;
  readonly status: 'running';
}

export interface PersonResearchEvalReadRequestV1 {
  readonly schema_version: 1;
  readonly run_id: string;
}

export type PersonResearchEvalStatusV1 = 'running' | 'completed' | 'failed';
export interface PersonResearchEvalReadResponseV1 {
  readonly schema_version: 1;
  readonly kind: 'echo-person-research-eval-result-v1';
  readonly run_id: string;
  readonly status: PersonResearchEvalStatusV1;
  /** The loop's research result (eval view, the trimmed bundle); present once completed. */
  readonly research?: Readonly<Record<string, unknown>>;
  /** A question's output: the writer's input ids and the V6 answer. */
  readonly ask?: { readonly writer_evidence: readonly string[]; readonly response: PersonAnswerResponseV6 };
  /** A task's output when its trigger has a renderer: the impact card. A research-only trigger has none. */
  readonly rendered?: PersonImpactCardV1;
  readonly error?: { readonly code: string; readonly message: string };
}

/** A research result carries released text; the eval reads it whole. */
export const PERSON_RESEARCH_EVAL_MAX_RESPONSE_BYTES_V1 = 16 * 1024 * 1024;
const RUN_ID = /^rr_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TRIGGER = /^[a-z_]{1,64}$/;
/** Objects and arrays nested in a trigger's input, counting the input itself. */
const MAX_INPUT_DEPTH = 8;
const ERROR_CODES = new Set(['conflict', 'invalid_request', 'invalid_output', 'not_found', 'stale_access_state', 'unauthorized', 'rate_limited', 'quota_exceeded', 'unavailable', 'timed_out']);

function exactKeys(record: Record<string, unknown>, required: readonly string[], optional: readonly string[], label: string): void {
  for (const key of required) if (!Object.hasOwn(record, key)) fail(`${label} is missing ${key}`);
  for (const key of Object.keys(record)) if (!required.includes(key) && !optional.includes(key)) fail(`${label} has unexpected ${key}`);
}
function line(value: unknown, label: string, maximumBytes = 1_000): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value !== value.trim() || value !== value.normalize('NFC') ||
      utf8ByteLength(value) > maximumBytes || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(value)) fail(`${label} is invalid`);
  return value;
}
function runId(value: unknown): string {
  if (typeof value !== 'string' || !RUN_ID.test(value)) fail('Research evaluation run id is invalid');
  return value;
}
/** Plain JSON only: finite numbers, strings, booleans, null, arrays and plain objects, nested at most MAX_INPUT_DEPTH deep. */
function jsonValue(value: unknown, depth: number): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return;
  const prototype = typeof value === 'object' ? Object.getPrototypeOf(value) : undefined;
  if (depth >= MAX_INPUT_DEPTH || !(Array.isArray(value) || prototype === Object.prototype || prototype === null)) fail('Research evaluation input is invalid');
  for (const entry of Object.values(value as object)) jsonValue(entry, depth + 1);
}

export function validatePersonResearchEvalStartRequestV1(value: unknown): PersonResearchEvalStartRequestV1 {
  const request = asEnumerableRecord(value, 'Research evaluation start request');
  // Ask's legacy form, `question` beside the trigger: kept for one release so pre-envelope runners keep working.
  // Remove it once the staging evaluation runner sends the `input` envelope.
  const legacy = Object.hasOwn(request, 'question');
  exactKeys(request, ['schema_version', 'trigger', legacy ? 'question' : 'input'], ['budget', 'project_id', 'mine'], 'Research evaluation start request');
  if (request.schema_version !== 1) fail('Research evaluation start request version is invalid');
  const trigger = request.trigger;
  if (typeof trigger !== 'string' || !TRIGGER.test(trigger)) fail('Research evaluation trigger is invalid');
  const input = legacy ? { question: validatePersonQueryText(request.question) } : asEnumerableRecord(request.input, 'Research evaluation input');
  jsonValue(input, 0);
  if (utf8ByteLength(JSON.stringify(input)) > MAX_ORGANIZATION_API_BODY_BYTES) fail('Research evaluation input is too large');
  if (Object.hasOwn(request, 'budget') && request.budget !== 'live' && request.budget !== 'background') fail('Research evaluation budget is invalid');
  if (Object.hasOwn(request, 'mine') && (request.mine !== true || Object.hasOwn(request, 'project_id'))) fail('Research evaluation scope is invalid');
  return Object.freeze({
    schema_version: 1 as const, trigger, input,
    ...(Object.hasOwn(request, 'budget') ? { budget: request.budget as PersonResearchEvalBudgetV1 } : {}),
    ...(Object.hasOwn(request, 'project_id') ? { project_id: validateProjectIdV1(request.project_id, 'Research evaluation project_id') } : {}),
    ...(request.mine === true ? { mine: true as const } : {}),
  });
}

export function validatePersonResearchEvalStartReceiptV1(value: unknown): PersonResearchEvalStartReceiptV1 {
  const input = asEnumerableRecord(value, 'Research evaluation start receipt');
  exactKeys(input, ['schema_version', 'kind', 'run_id', 'status'], [], 'Research evaluation start receipt');
  if (input.schema_version !== 1 || input.kind !== 'echo-person-research-eval-run-v1' || input.status !== 'running') fail('Research evaluation start receipt is invalid');
  return Object.freeze({ schema_version: 1, kind: 'echo-person-research-eval-run-v1', run_id: runId(input.run_id), status: 'running' });
}

export function validatePersonResearchEvalReadRequestV1(value: unknown): PersonResearchEvalReadRequestV1 {
  const input = asEnumerableRecord(value, 'Research evaluation read request');
  exactKeys(input, ['schema_version', 'run_id'], [], 'Research evaluation read request');
  if (input.schema_version !== 1) fail('Research evaluation read request version is invalid');
  return Object.freeze({ schema_version: 1, run_id: runId(input.run_id) });
}

export function validatePersonResearchEvalReadResponseV1(value: unknown): PersonResearchEvalReadResponseV1 {
  const input = asEnumerableRecord(value, 'Research evaluation result');
  exactKeys(input, ['schema_version', 'kind', 'run_id', 'status'], ['research', 'ask', 'rendered', 'error'], 'Research evaluation result');
  if (input.schema_version !== 1 || input.kind !== 'echo-person-research-eval-result-v1') fail('Research evaluation result is invalid');
  const status = input.status;
  if (status !== 'running' && status !== 'completed' && status !== 'failed') fail('Research evaluation status is invalid');
  if ((status === 'completed') !== Object.hasOwn(input, 'research') || (status === 'failed') !== Object.hasOwn(input, 'error') ||
      ((Object.hasOwn(input, 'ask') || Object.hasOwn(input, 'rendered')) && status !== 'completed')) fail('Research evaluation result does not match its status');
  let research: Readonly<Record<string, unknown>> | undefined;
  if (input.research !== undefined) {
    research = asEnumerableRecord(input.research, 'Research result');
    if (research.schema_version !== 1 || research.kind !== 'echo-agentic-research-result-v1' || typeof research.trigger !== 'string' || !TRIGGER.test(research.trigger) ||
        !Array.isArray(research.items) || !Array.isArray(research.rounds) || !Array.isArray(research.plan)) fail('Research result is invalid');
  }
  // The goal's form decides which output fits: a question has Ask's writer, a task its trigger's renderer (or none).
  const goal = research?.goal;
  const goalKind = typeof goal === 'object' && goal !== null ? (goal as { readonly kind?: unknown }).kind : undefined;
  let ask: PersonResearchEvalReadResponseV1['ask'];
  if (input.ask !== undefined) {
    const value = asEnumerableRecord(input.ask, 'Research evaluation Ask output');
    exactKeys(value, ['writer_evidence', 'response'], [], 'Research evaluation Ask output');
    if (!Array.isArray(value.writer_evidence) || !value.writer_evidence.every(id => typeof id === 'string' && /^E\d{1,4}$/.test(id))) fail('Research evaluation writer evidence is invalid');
    if (goalKind !== 'question') fail('Research evaluation Ask output needs a question result');
    ask = Object.freeze({ writer_evidence: Object.freeze([...value.writer_evidence as string[]]), response: validatePersonAnswerResponseV6(value.response) });
  }
  let rendered: PersonImpactCardV1 | undefined;
  if (input.rendered !== undefined) {
    if (goalKind !== 'task') fail('Research evaluation rendered result needs a task result');
    rendered = validatePersonImpactCardV1(input.rendered);
  }
  let error: PersonResearchEvalReadResponseV1['error'];
  if (input.error !== undefined) {
    const value = asEnumerableRecord(input.error, 'Research evaluation error');
    exactKeys(value, ['code', 'message'], [], 'Research evaluation error');
    if (typeof value.code !== 'string' || !ERROR_CODES.has(value.code)) fail('Research evaluation error code is invalid');
    error = Object.freeze({ code: value.code, message: line(value.message, 'Research evaluation error message', 300) });
  }
  return Object.freeze({
    schema_version: 1, kind: 'echo-person-research-eval-result-v1', run_id: runId(input.run_id), status,
    ...(research === undefined ? {} : { research }), ...(ask === undefined ? {} : { ask }), ...(rendered === undefined ? {} : { rendered }), ...(error === undefined ? {} : { error }),
  });
}
