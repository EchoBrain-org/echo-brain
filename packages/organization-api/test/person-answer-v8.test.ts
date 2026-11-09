import { describe, expect, it } from 'vitest';
import {
  personWorkspaceRefV1,
  validatePersonAnswerResponseV8,
  validatePersonItemRefV1,
  validatePersonWorkspaceCitationV1,
  validatePersonWorkspaceRefV1,
} from '../src/index.js';

// Each citation kind's answer rules (versions, kinds, refs, keys, privacy) are one table: person-answer-citation-kinds.test.ts.
const projectId = 'prj_6b0f8a52-55a4-4f6e-9a39-6d3c8c3c2a10' as const;
const membershipId = 'mem_0f1e2d3c-4b5a-4968-8778-695a4b3c2d1e';
const project = { citation: { kind: 'project' as const, project_id: projectId }, kind: 'project' as const, label: 'Thermal recovery', visibility: 'project' as const, ref: `project:${projectId}` as const };
const person = { citation: { kind: 'person' as const, membership_id: membershipId } };
const tool = { citation: { kind: 'tool' as const, tool_id: 'jira' } };
const containerCitation = {
  kind: 'tool_container' as const, tool_id: 'jira', external_scope_id: 'cloud-1', container: 'jira_project' as const, container_id: '10001',
  permalink: 'https://example.atlassian.net/browse/THERM',
};
/** One answered part whose one sentence cites every citation. */
const response = (citations: readonly { readonly visibility: string }[] = [project]) => ({
  schema_version: 8 as const, kind: 'echo-clean-person-answer-v8' as const, scope: { kind: 'global' as const }, outcome: 'answered' as const, citations,
  parts: [{ question: 'What are my current projects?', status: 'answered' as const, statements: [{ text: 'Thermal recovery is active, led by Mara.', citation_indexes: citations.map((_, index) => index), private: false }],
    blocks: [{ kind: 'answer' as const, statements: [0] }] }],
});

describe('Workspace answer V8 (research tool contract v1)', () => {
  it('carries bounded typed explanations separately from technical diagnostic gaps', () => {
    const value = { ...response([]), outcome: 'partial', parts: [{ question: 'Find a rule and change it.', status: 'not_found', statements: [],
      gap: 'Some evidence could not fit in this response.', gap_details: { unsupported_action: true, interrupted: true, not_found: 'Not found: the owner.' } }] };
    expect(validatePersonAnswerResponseV8(value).parts[0]).toMatchObject({ gap_details: value.parts[0]!.gap_details });
    for (const gap_details of [{}, { unsupported_action: false }, { interrupted: 'yes' }, { technical: true }, { not_found: '' }, { not_found: 'x'.repeat(2049) }]) {
      expect(() => validatePersonAnswerResponseV8({ ...value, parts: [{ ...value.parts[0], gap_details }] })).toThrow();
    }
    expect(() => validatePersonAnswerResponseV8({ ...value, outcome: 'not_found' })).toThrow();
  });

  it('refuses every retired answer version', () => {
    for (const version of [4, 5, 6, 7]) {
      expect(() => validatePersonAnswerResponseV8({ ...response(), schema_version: version, kind: `echo-clean-person-answer-v${version}` })).toThrow('Ask response is invalid');
    }
  });
});

describe('Workspace refs V1', () => {
  it('open a project in ECHO and a tool on the tools page, and are not person-open refs', () => {
    expect(personWorkspaceRefV1(project.citation)).toBe(`project:${projectId}`);
    expect(personWorkspaceRefV1(tool.citation)).toBe('tool:jira');
    expect(validatePersonWorkspaceRefV1(`project:${projectId}`)).toBe(`project:${projectId}`);
    expect(validatePersonWorkspaceRefV1('tool:google-drive')).toBe('tool:google-drive');
    for (const value of ['project:', `project:${projectId.toUpperCase()}`, `projects:${projectId}`, 'tool:', 'tool:-jira', `tool:${'a'.repeat(65)}`, `person:${membershipId}`, projectId, 42, undefined]) {
      expect(() => validatePersonWorkspaceRefV1(value)).toThrow();
    }
    expect(() => validatePersonItemRefV1(`project:${projectId}`)).toThrow();
    expect(() => validatePersonItemRefV1('tool:jira')).toThrow();
  });
});

describe('Workspace citations V1', () => {
  it('name exactly one project, person, tool or container', () => {
    for (const citation of [project.citation, person.citation, tool.citation, containerCitation]) {
      expect(validatePersonWorkspaceCitationV1(citation)).toEqual(citation);
      expect(Object.isFrozen(validatePersonWorkspaceCitationV1(citation))).toBe(true);
    }
    for (const value of [
      { ...project.citation, name: 'Thermal recovery' },
      { ...project.citation, project_id: 'prj_1' },
      { ...person.citation, membership_id: projectId },
      { ...tool.citation, tool_id: 'Jira' },
      { ...containerCitation, key: 'THERM' },
      { ...containerCitation, container: 'jira_board' },
      { ...containerCitation, container_id: '' },
      { ...containerCitation, external_scope_id: 'two\nlines' },
      { ...containerCitation, permalink: 'http://example.atlassian.net/browse/THERM' },
      { ...containerCitation, permalink: 'https://user:pass@example.atlassian.net/browse/THERM' },
      { ...containerCitation, permalink: 'https://example.atlassian.net/browse/THERM?x=1' },
      { ...containerCitation, permalink: 'https://example.atlassian.net/browse/THERM#top' },
      // Only a link already in the form the desktop opens: no upper-case host, default port, dot segment or raw non-ASCII.
      { ...containerCitation, permalink: 'https://Example.atlassian.net/browse/THERM' },
      { ...containerCitation, permalink: 'https://example.atlassian.net:443/browse/THERM' },
      { ...containerCitation, permalink: 'https://example.atlassian.net/browse/../THERM' },
      { ...containerCitation, permalink: 'https://example.atlassian.net/browse/Tä' },
      { ...containerCitation, permalink: 'https://1.1/x' },
      { kind: 'workspace' },
      null,
    ]) expect(() => validatePersonWorkspaceCitationV1(value)).toThrow();
  });
});
