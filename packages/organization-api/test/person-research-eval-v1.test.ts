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
  it('accepts one goal field per trigger, with a project or global scope', () => {
    expect(validatePersonResearchEvalStartRequestV1({ schema_version: 1, trigger: 'ask', budget: 'live', project_id: project, question: 'Why is the DVT gate on hold?' }))
      .toEqual({ schema_version: 1, trigger: 'ask', budget: 'live', project_id: project, question: 'Why is the DVT gate on hold?' });
    expect(validatePersonResearchEvalStartRequestV1({ schema_version: 1, trigger: 'check', budget: 'background', project_id: project, record })).toMatchObject({ trigger: 'check', record });
    expect(validatePersonResearchEvalStartRequestV1({ schema_version: 1, trigger: 'sweep', budget: 'background', findings: [
      { finding: 'Firmware shows two decimals', expected: 'SW-22b updated', citations: [ticket, page, record] },
    ] })).toMatchObject({ trigger: 'sweep', findings: [{ citations: [ticket, page, record] }] });
  });

  it('applies the product question limits to Ask, so the baseline sees what users see', () => {
    expect(() => validatePersonResearchEvalStartRequestV1({ schema_version: 1, trigger: 'ask', budget: 'live', question: 'x '.repeat(130).trim() })).toThrow();
  });

  it('refuses mismatched goal fields, other citation kinds for Check, and unbounded findings', () => {
    const bad: unknown[] = [
      { schema_version: 1, trigger: 'ask', budget: 'live', question: 'q', record },
      { schema_version: 1, trigger: 'check', budget: 'live', record: ticket },
      { schema_version: 1, trigger: 'check', budget: 'soon', record },
      { schema_version: 1, trigger: 'check', budget: 'live', mine: true, record },
      { schema_version: 1, trigger: 'sweep', budget: 'background', findings: [] },
      { schema_version: 1, trigger: 'sweep', budget: 'background', findings: [{ finding: 'f', expected: 'e', citations: [] }] },
      { schema_version: 1, trigger: 'sweep', budget: 'background', findings: Array.from({ length: 21 }, () => ({ finding: 'f', expected: 'e', citations: [ticket] })) },
      { schema_version: 1, trigger: 'sweep', budget: 'background', findings: [{ finding: 'f', expected: 'e', citations: [ticket], note: 'x' }] },
      { schema_version: 2, trigger: 'ask', budget: 'live', question: 'q' },
      { schema_version: 1, trigger: 'drift', budget: 'live', question: 'q' },
    ];
    for (const value of bad) expect(() => validatePersonResearchEvalStartRequestV1(value)).toThrow();
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
    expect(validatePersonResearchEvalReadResponseV1({ schema_version: 1, kind: 'echo-person-research-eval-result-v1', run_id: runId, status: 'running' }).status).toBe('running');
    expect(validatePersonResearchEvalReadResponseV1({ schema_version: 1, kind: 'echo-person-research-eval-result-v1', run_id: runId, status: 'completed', research }).research).toEqual(research);
    expect(validatePersonResearchEvalReadResponseV1({ schema_version: 1, kind: 'echo-person-research-eval-result-v1', run_id: runId, status: 'failed', error: { code: 'not_found', message: 'Starting evidence is not available' } }).error?.code).toBe('not_found');
    for (const value of [
      { schema_version: 1, kind: 'echo-person-research-eval-result-v1', run_id: runId, status: 'running', research },
      { schema_version: 1, kind: 'echo-person-research-eval-result-v1', run_id: runId, status: 'completed' },
      { schema_version: 1, kind: 'echo-person-research-eval-result-v1', run_id: runId, status: 'failed', error: { code: 'teapot', message: 'x' } },
      { schema_version: 1, kind: 'echo-person-research-eval-result-v1', run_id: runId, status: 'completed', research, ask: { writer_evidence: ['E1'], response: {} } },
      { schema_version: 1, kind: 'echo-person-research-eval-result-v1', run_id: runId, status: 'completed', research: { ...research, kind: 'other' } },
    ]) expect(() => validatePersonResearchEvalReadResponseV1(value)).toThrow();
  });
});
