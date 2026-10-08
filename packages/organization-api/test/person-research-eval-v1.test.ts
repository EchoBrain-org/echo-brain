import { canonicalSha256 } from '@echo-brain/federation-protocol';
import { describe, expect, it } from 'vitest';
import {
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
