import { canonicalSha256 } from '@echo-brain/federation-protocol';
import { describe, expect, it } from 'vitest';
import {
  PERSON_ASK_PROGRESS_HEADER_VALUE_V1,
  PERSON_ASK_PROGRESS_HEADER_VALUE_V2,
  PERSON_ASK_PROGRESS_HEADER_VALUE_V3,
  PERSON_ASK_PROGRESS_SOURCES_MAX_V1,
  PERSON_ASK_PROGRESS_SOURCES_MAX_V3,
  createPersonAskProgressDecoderV2,
  createPersonAskProgressDecoderV3,
  formatPersonAskProgressEventV2,
  formatPersonAskProgressEventV3,
  validatePersonAskProgressEventV2,
  validatePersonAskProgressEventV3,
  validatePersonAskProgressLineV2,
  validatePersonAskProgressLineV3,
  validatePersonAskProgressResultLineV2,
  validatePersonAskProgressResultLineV3,
  validatePersonAskProgressStepEventV1,
  validatePersonAskProgressStepEventV2,
  validatePersonAskProgressStepEventV3,
  validatePersonAskReceiptV1,
  validatePersonAskReceiptV2,
  validatePersonAskReceiptV3,
  type PersonAskProgressEventV3,
} from '../src/index.js';

const record = canonicalSha256('record');
const projectId = 'prj_6b0f8a52-55a4-4f6e-9a39-6d3c8c3c2a10' as const;
const decision = { citation: { kind: 'approved_record' as const, atom_id: canonicalSha256('atom'), record_sha256: record, policy_id: 'organization-member-readable-person-v2' as const }, kind: 'decision' as const, label: 'THERM DVT recovery sync', visibility: 'team' as const, ref: `meeting:${record}` as const };
const followUp = { citation: { kind: 'follow_up' as const, item_id: 'itm_launch-1' }, kind: 'follow_up' as const, label: 'Ship the launch checklist', visibility: 'team' as const, ref: 'follow_up:itm_launch-1' as const };
const project = { citation: { kind: 'project' as const, project_id: projectId }, kind: 'project' as const, label: 'Thermal recovery', visibility: 'project' as const, ref: `project:${projectId}` as const };
const person = { citation: { kind: 'person' as const, membership_id: 'mem_0f1e2d3c-4b5a-4968-8778-695a4b3c2d1e' }, kind: 'person' as const, label: 'Mara Lind', visibility: 'team' as const };
const tool = { citation: { kind: 'tool' as const, tool_id: 'jira' }, kind: 'tool' as const, label: 'Jira', visibility: 'only_me' as const, ref: 'tool:jira' as const };
const container = {
  citation: { kind: 'tool_container' as const, tool_id: 'jira', external_scope_id: 'cloud-1', container: 'jira_project' as const, container_id: '10001', permalink: 'https://example.atlassian.net/browse/THERM' },
  kind: 'tool_container' as const, label: 'Thermal', visibility: 'only_me' as const, key: 'THERM',
};
const workspace = [project, person, tool, container];
const sources = [{ kind: 'projects' as const }, { kind: 'people' as const }, { kind: 'tools' as const }, { kind: 'containers' as const, tool_id: 'jira' }];
const v8 = () => ({ schema_version: 8 as const, kind: 'echo-clean-person-answer-v8' as const, scope: { kind: 'global' as const }, outcome: 'answered' as const, citations: [project, container],
  parts: [{ question: 'Where is the Jira project for Thermal recovery?', status: 'answered' as const, statements: [{ text: 'Thermal recovery uses the THERM Jira project.', citation_indexes: [0, 1], private: true }] }] });
const v7 = () => ({ schema_version: 7 as const, kind: 'echo-clean-person-answer-v7' as const, scope: { kind: 'global' as const }, outcome: 'answered' as const, citations: [followUp],
  parts: [{ question: 'What is still open?', status: 'answered' as const, statements: [{ text: 'The launch checklist is still open.', citation_indexes: [0], private: false }] }] });
const receipt = () => ({ looked_through: 4, elapsed_ms: 31_000, rows: [{ type: 'searched' as const, sources: [{ kind: 'meetings' as const }, ...sources], found: 9 },
  { type: 'read' as const, items: [...workspace] }] });
const v2Receipt = () => ({ looked_through: 1, elapsed_ms: 12_000, rows: [{ type: 'searched' as const, sources: [{ kind: 'follow_ups' as const }], found: 4 }, { type: 'read' as const, items: [followUp] }] });

describe('Ask progress V3 wire contract (/v7, research tool contract v1)', () => {
  it('opts in with its own header value, beside V1 and V2', () => {
    expect(PERSON_ASK_PROGRESS_HEADER_VALUE_V3).toBe('3');
    expect(new Set([PERSON_ASK_PROGRESS_HEADER_VALUE_V1, PERSON_ASK_PROGRESS_HEADER_VALUE_V2, PERSON_ASK_PROGRESS_HEADER_VALUE_V3]).size).toBe(3);
  });

  it('names the workspace as plain source kinds, and a tool’s containers by its id', () => {
    const searched = { type: 'searched', sources: [{ kind: 'follow_ups' }, ...sources, { kind: 'tickets', tool_id: 'jira' }], found: 9 };
    expect(validatePersonAskProgressStepEventV3(searched)).toEqual(searched);
    for (const bad of [{ kind: 'projects', tool_id: 'jira' }, { kind: 'containers' }, { kind: 'containers', tool_id: 'Jira' }, { kind: 'channels', tool_id: 'slack' }, { kind: 'workspace' }]) {
      expect(() => validatePersonAskProgressStepEventV3({ type: 'searched', sources: [bad], found: 1 })).toThrow();
    }
    expect(() => validatePersonAskProgressStepEventV3({ type: 'searched', sources: [{ kind: 'containers', tool_id: 'jira' }, { kind: 'containers', tool_id: 'jira' }], found: 1 })).toThrow('duplicates');
    // Older clients never meet one.
    expect(() => validatePersonAskProgressStepEventV2(searched)).toThrow('kind is invalid');
    expect(() => validatePersonAskProgressStepEventV1(searched)).toThrow('kind is invalid');
  });

  it('names up to sixteen sources in one row', () => {
    expect(PERSON_ASK_PROGRESS_SOURCES_MAX_V3).toBe(2 * PERSON_ASK_PROGRESS_SOURCES_MAX_V1);
    const many = ['jira', 'confluence', 'slack', 'linear', 'notion'].flatMap(tool_id => [{ kind: 'containers', tool_id }, { kind: 'tickets', tool_id }]);
    const sixteen = [{ kind: 'meetings' }, { kind: 'documents' }, { kind: 'slack' }, { kind: 'follow_ups' }, { kind: 'projects' }, { kind: 'people' }, ...many];
    expect(sixteen).toHaveLength(16);
    expect(validatePersonAskProgressStepEventV3({ type: 'searched', sources: sixteen, found: 3 }).type).toBe('searched');
    expect(() => validatePersonAskProgressStepEventV3({ type: 'searched', sources: [...sixteen, { kind: 'tools' }], found: 3 })).toThrow('sources is invalid');
  });

  it('names a workspace item read as its V8 citation: a project and a tool with their refs, a container with its key', () => {
    const event = validatePersonAskProgressStepEventV3({ type: 'read', items: workspace });
    expect(event).toEqual({ type: 'read', items: workspace });
    expect(Object.isFrozen(event)).toBe(true);
    const { ref: _ref, ...unopened } = project;
    expect(() => validatePersonAskProgressStepEventV3({ type: 'read', items: [unopened] })).toThrow('ref is missing');
    expect(() => validatePersonAskProgressStepEventV3({ type: 'read', items: [{ ...person, ref: `project:${projectId}` }] })).toThrow('ref is inconsistent');
    expect(() => validatePersonAskProgressStepEventV3({ type: 'read', items: [{ ...tool, key: 'JIRA' }] })).toThrow('only to a tool container');
    // An item is named once, whatever its label or key.
    expect(() => validatePersonAskProgressStepEventV3({ type: 'read', items: [container, { ...container, key: 'TH' }] })).toThrow('names an item twice');
    for (const item of workspace) {
      expect(() => validatePersonAskProgressStepEventV2({ type: 'read', items: [item] })).toThrow();
      expect(() => validatePersonAskProgressStepEventV3({ type: 'read', items: [{ ...item, text: 'Lead: Mara' }] })).toThrow('unexpected shape');
    }
  });

  it('accepts every V2 step and receipt as V3, so a /v6 or /v5 stream reads as V3', () => {
    for (const step of [{ type: 'stage', stage: 'reading', pending: 2 }, { type: 'searched', sources: [{ kind: 'follow_ups' }, { kind: 'pages', tool_id: 'confluence' }], found: 0 }, { type: 'read', items: [decision, followUp] }]) {
      expect(validatePersonAskProgressStepEventV3(step)).toEqual(validatePersonAskProgressStepEventV2(step));
    }
    expect(validatePersonAskReceiptV3(v2Receipt())).toEqual(validatePersonAskReceiptV2(v2Receipt()));
  });

  it('builds a receipt whose rows may name the workspace, with V1 merge and coverage rules', () => {
    expect(validatePersonAskReceiptV3(receipt())).toEqual(receipt());
    expect(() => validatePersonAskReceiptV2(receipt())).toThrow();
    expect(() => validatePersonAskReceiptV3({ ...receipt(), looked_through: 3 })).toThrow('less than the items');
    expect(() => validatePersonAskReceiptV3({ ...receipt(), rows: [{ type: 'read', items: [project] }, { type: 'read', items: [tool] }] })).toThrow('not merged');
    expect(() => validatePersonAskReceiptV3({ ...receipt(), rows: [{ type: 'read', items: [project] }, receipt().rows[0], { type: 'read', items: [project] }] })).toThrow('names an item twice');
  });

  it('carries the released V8 answer as the terminal event, and only V8', () => {
    expect(validatePersonAskProgressEventV3({ type: 'answer', response: v8(), receipt: receipt() })).toEqual({ type: 'answer', response: v8(), receipt: receipt() });
    expect(() => validatePersonAskProgressEventV3({ type: 'answer', response: v7(), receipt: v2Receipt() })).toThrow();
    expect(() => validatePersonAskProgressEventV2({ type: 'answer', response: v8(), receipt: v2Receipt() })).toThrow();
    expect(validatePersonAskProgressEventV3({ type: 'error', status: 503, error: { code: 'unavailable', message: 'request failed' } }).type).toBe('error');
  });
});

describe('Ask progress V3 stream framing', () => {
  // Framing, chunking and failing closed are the shared codec's, tested in person-ask-progress-v1.test.ts.
  it('formats and decodes a workspace stream that a V2 decoder refuses, and reads a V2 stream', () => {
    const events: readonly PersonAskProgressEventV3[] = [
      { type: 'searched', sources, found: 3 },
      { type: 'read', items: [project, container] },
      { type: 'answer', response: v8(), receipt: { looked_through: 2, elapsed_ms: 20_000, rows: [{ type: 'searched', sources, found: 3 }, { type: 'read', items: [project, container] }] } },
    ];
    const stream = events.map(formatPersonAskProgressEventV3).join('');
    const decoder = createPersonAskProgressDecoderV3();
    expect(decoder.push(stream)).toEqual(events);
    decoder.end();
    expect(() => createPersonAskProgressDecoderV2().push(stream)).toThrow();
    expect(createPersonAskProgressDecoderV3().push(formatPersonAskProgressEventV2({ type: 'read', items: [followUp] }))).toEqual([{ type: 'read', items: [followUp] }]);
    expect(() => formatPersonAskProgressEventV3({ type: 'read', items: [{ ...project, lead: 'Mara' }] } as unknown as PersonAskProgressEventV3)).toThrow();
  });
});

describe('person ask --progress lines from a /v7 client', () => {
  it('prints V3 steps, which include every V2 step', () => {
    expect(validatePersonAskProgressLineV3({ ok: true, progress: { type: 'read', items: [person] } })).toEqual({ ok: true, progress: { type: 'read', items: [person] } });
    expect(validatePersonAskProgressLineV3({ ok: true, progress: { type: 'read', items: [followUp] } }).progress.type).toBe('read');
    expect(() => validatePersonAskProgressLineV2({ ok: true, progress: { type: 'read', items: [person] } })).toThrow();
    expect(() => validatePersonAskProgressLineV3({ ok: true, progress: { type: 'answer', response: v8(), receipt: receipt() } })).toThrow();
  });

  it('pairs each streamed answer with its own receipt: V8 with V3, V7 with V2, V6 with V1, and none for V5', () => {
    expect(validatePersonAskProgressResultLineV3({ ok: true, result: v8(), receipt: receipt() })).toEqual({ ok: true, result: v8(), receipt: receipt() });
    expect(validatePersonAskProgressResultLineV3({ ok: true, result: v8() })).toEqual({ ok: true, result: v8() });
    expect(validatePersonAskProgressResultLineV3({ ok: true, result: v7(), receipt: v2Receipt() })).toEqual({ ok: true, result: v7(), receipt: v2Receipt() });
    // A V7 answer from /v6 never has a workspace item in its receipt.
    expect(() => validatePersonAskProgressResultLineV3({ ok: true, result: v7(), receipt: receipt() })).toThrow();
    const v6 = { ...v7(), schema_version: 6 as const, kind: 'echo-clean-person-answer-v6' as const, citations: [decision],
      parts: [{ question: 'What did we decide?', status: 'answered' as const, statements: [{ text: 'The team chose the recovery plan.', citation_indexes: [0], private: false }] }] };
    const v1Receipt = { looked_through: 1, elapsed_ms: 1_000, rows: [{ type: 'read' as const, items: [decision] }] };
    expect(validatePersonAskProgressResultLineV3({ ok: true, result: v6, receipt: v1Receipt })).toEqual({ ok: true, result: v6, receipt: validatePersonAskReceiptV1(v1Receipt) });
    const v5 = { ...v6, schema_version: 5 as const, kind: 'echo-clean-person-answer-v5' as const };
    expect(validatePersonAskProgressResultLineV3({ ok: true, result: v5 }).result.schema_version).toBe(5);
    expect(() => validatePersonAskProgressResultLineV3({ ok: true, result: v5, receipt: v1Receipt })).toThrow('needs a streamed answer');
    // V2's final line never carries a V8 answer.
    expect(() => validatePersonAskProgressResultLineV2({ ok: true, result: v8(), receipt: receipt() })).toThrow();
  });
});
