import type { PersonAnswerCitationV3 } from './person-answer-v3.js';
import { validatePersonAnswerResponseV6, validatePersonEvidenceOpenRequestV1 } from './person-answer-v4.js';
import type { PersonAnswerResponseV6 } from './person-answer-v6.js';
import { validatePersonPageCitationV1, type PersonPageCitationV1 } from './person-page-citation-v1.js';
import { validatePersonQueryText } from './person-query.js';
import { validatePersonTicketCitationV1, type PersonTicketCitationV1 } from './person-ticket-citation-v1.js';
import { validateProjectIdV1, type ProjectIdV1 } from './project-context-v1.js';
import { asEnumerableRecord, fail, utf8ByteLength } from './validation.js';

/**
 * Staging-only research evaluation (research loop evaluation v1). A signed-in
 * person starts one research run (Ask, Check or Sweep) and reads its research
 * result once it completes. Production never composes these routes.
 */
export const PERSON_RESEARCH_EVAL_START_PATH_V1 = '/v1/person/research-eval/start';
export const PERSON_RESEARCH_EVAL_READ_PATH_V1 = '/v1/person/research-eval/read';

export type PersonResearchEvalTriggerV1 = 'ask' | 'check' | 'sweep';
export type PersonResearchEvalBudgetV1 = 'live' | 'background';
export type PersonResearchEvalCitationV1 = PersonAnswerCitationV3 | PersonTicketCitationV1 | PersonPageCitationV1;

export interface PersonResearchEvalFindingV1 {
  readonly finding: string;
  readonly expected: string;
  readonly citations: readonly PersonResearchEvalCitationV1[];
}

interface PersonResearchEvalStartBaseV1 {
  readonly schema_version: 1;
  readonly budget: PersonResearchEvalBudgetV1;
  readonly project_id?: ProjectIdV1;
  readonly mine?: true;
}
export type PersonResearchEvalStartRequestV1 =
  | (PersonResearchEvalStartBaseV1 & { readonly trigger: 'ask'; readonly question: string })
  | (PersonResearchEvalStartBaseV1 & { readonly trigger: 'check'; readonly record: PersonAnswerCitationV3 })
  | (PersonResearchEvalStartBaseV1 & { readonly trigger: 'sweep'; readonly findings: readonly PersonResearchEvalFindingV1[] });

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
  /** The loop's research result (eval view); present once completed. */
  readonly research?: Readonly<Record<string, unknown>>;
  /** Ask only: the writer's input ids and the V6 answer. */
  readonly ask?: { readonly writer_evidence: readonly string[]; readonly response: PersonAnswerResponseV6 };
  readonly error?: { readonly code: string; readonly message: string };
}

export const PERSON_RESEARCH_EVAL_MAX_FINDINGS_V1 = 20;
export const PERSON_RESEARCH_EVAL_MAX_FINDING_CITATIONS_V1 = 12;
/** A research result carries released text; the eval reads it whole. */
export const PERSON_RESEARCH_EVAL_MAX_RESPONSE_BYTES_V1 = 16 * 1024 * 1024;
const RUN_ID = /^rr_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
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
function localCitation(value: unknown): PersonAnswerCitationV3 {
  return validatePersonEvidenceOpenRequestV1({ schema_version: 1, citation: value }).citation;
}
function evidenceCitation(value: unknown): PersonResearchEvalCitationV1 {
  const kind = asEnumerableRecord(value, 'Research evaluation citation').kind;
  if (kind === 'ticket') return validatePersonTicketCitationV1(value);
  if (kind === 'page') return validatePersonPageCitationV1(value);
  return localCitation(value);
}

export function validatePersonResearchEvalStartRequestV1(value: unknown): PersonResearchEvalStartRequestV1 {
  const input = asEnumerableRecord(value, 'Research evaluation start request');
  const trigger = input.trigger;
  const field = trigger === 'ask' ? 'question' : trigger === 'check' ? 'record' : trigger === 'sweep' ? 'findings' : fail('Research evaluation trigger is invalid');
  exactKeys(input, ['schema_version', 'trigger', 'budget', field], ['project_id', 'mine'], 'Research evaluation start request');
  if (input.schema_version !== 1) fail('Research evaluation start request version is invalid');
  const budget: PersonResearchEvalBudgetV1 = input.budget === 'live' || input.budget === 'background' ? input.budget : fail('Research evaluation budget is invalid');
  if (Object.hasOwn(input, 'mine') && (input.mine !== true || Object.hasOwn(input, 'project_id') || trigger !== 'ask')) fail('Research evaluation scope is invalid');
  const base = {
    schema_version: 1 as const, budget,
    ...(Object.hasOwn(input, 'project_id') ? { project_id: validateProjectIdV1(input.project_id, 'Research evaluation project_id') } : {}),
    ...(input.mine === true ? { mine: true as const } : {}),
  };
  if (trigger === 'ask') return Object.freeze({ ...base, trigger, question: validatePersonQueryText(input.question) });
  if (trigger === 'check') {
    const record = localCitation(input.record);
    if (record.kind !== 'approved_record') fail('A Check starts from an approved record citation');
    return Object.freeze({ ...base, trigger, record });
  }
  if (!Array.isArray(input.findings) || input.findings.length === 0 || input.findings.length > PERSON_RESEARCH_EVAL_MAX_FINDINGS_V1) fail('Research evaluation findings are invalid');
  const findings = input.findings.map((raw: unknown, index: number) => {
    const finding = asEnumerableRecord(raw, `Research evaluation finding ${index + 1}`);
    exactKeys(finding, ['finding', 'expected', 'citations'], [], `Research evaluation finding ${index + 1}`);
    if (!Array.isArray(finding.citations) || finding.citations.length === 0 || finding.citations.length > PERSON_RESEARCH_EVAL_MAX_FINDING_CITATIONS_V1) fail('Research evaluation finding citations are invalid');
    return Object.freeze({
      finding: line(finding.finding, 'Research evaluation finding'), expected: line(finding.expected, 'Research evaluation expectation'),
      citations: Object.freeze(finding.citations.map(evidenceCitation)),
    });
  });
  return Object.freeze({ ...base, trigger: 'sweep' as const, findings: Object.freeze(findings) });
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
  exactKeys(input, ['schema_version', 'kind', 'run_id', 'status'], ['research', 'ask', 'error'], 'Research evaluation result');
  if (input.schema_version !== 1 || input.kind !== 'echo-person-research-eval-result-v1') fail('Research evaluation result is invalid');
  const status = input.status;
  if (status !== 'running' && status !== 'completed' && status !== 'failed') fail('Research evaluation status is invalid');
  if ((status === 'completed') !== Object.hasOwn(input, 'research') || (status === 'failed') !== Object.hasOwn(input, 'error') ||
      (Object.hasOwn(input, 'ask') && status !== 'completed')) fail('Research evaluation result does not match its status');
  let research: Readonly<Record<string, unknown>> | undefined;
  if (input.research !== undefined) {
    research = asEnumerableRecord(input.research, 'Research result');
    if (research.schema_version !== 1 || research.kind !== 'echo-agentic-research-result-v1' || !['ask', 'check', 'sweep'].includes(research.trigger as string) ||
        !Array.isArray(research.items) || !Array.isArray(research.rounds) || !Array.isArray(research.plan)) fail('Research result is invalid');
  }
  let ask: PersonResearchEvalReadResponseV1['ask'];
  if (input.ask !== undefined) {
    const value = asEnumerableRecord(input.ask, 'Research evaluation Ask output');
    exactKeys(value, ['writer_evidence', 'response'], [], 'Research evaluation Ask output');
    if (!Array.isArray(value.writer_evidence) || !value.writer_evidence.every(id => typeof id === 'string' && /^E\d{1,4}$/.test(id))) fail('Research evaluation writer evidence is invalid');
    if (research?.trigger !== 'ask') fail('Research evaluation Ask output needs an Ask result');
    ask = Object.freeze({ writer_evidence: Object.freeze([...value.writer_evidence as string[]]), response: validatePersonAnswerResponseV6(value.response) });
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
    ...(research === undefined ? {} : { research }), ...(ask === undefined ? {} : { ask }), ...(error === undefined ? {} : { error }),
  });
}
