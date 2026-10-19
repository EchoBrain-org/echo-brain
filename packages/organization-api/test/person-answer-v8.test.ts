import { canonicalSha256 } from '@echo-brain/federation-protocol';
import { describe, expect, it } from 'vitest';
import {
  PERSON_ANSWER_PATH_V6,
  PERSON_ANSWER_PATH_V7,
  personAnswerCitationKeyV8,
  personWorkspaceRefV1,
  validatePersonAnswerCitationV6,
  validatePersonAnswerCitationV7,
  validatePersonAnswerCitationV8,
  validatePersonAnswerResponseV7,
  validatePersonAnswerResponseV8,
  validatePersonEvidenceDeskResponseV1,
  validatePersonOpenRefV1,
  validatePersonWorkspaceCitationV1,
  validatePersonWorkspaceRefV1,
} from '../src/index.js';

const projectId = 'prj_6b0f8a52-55a4-4f6e-9a39-6d3c8c3c2a10';
const membershipId = 'mem_0f1e2d3c-4b5a-4968-8778-695a4b3c2d1e';
const project = { citation: { kind: 'project' as const, project_id: projectId }, kind: 'project' as const, label: 'Thermal recovery', visibility: 'project' as const, ref: `project:${projectId}` as const };
const person = { citation: { kind: 'person' as const, membership_id: membershipId }, kind: 'person' as const, label: 'Mara Lind', visibility: 'team' as const };
const tool = { citation: { kind: 'tool' as const, tool_id: 'jira' }, kind: 'tool' as const, label: 'Jira', visibility: 'only_me' as const, ref: 'tool:jira' as const };
const containerCitation = {
  kind: 'tool_container' as const, tool_id: 'jira', external_scope_id: 'cloud-1', container: 'jira_project' as const, container_id: '10001',
  permalink: 'https://example.atlassian.net/browse/THERM',
};
const container = { citation: containerCitation, kind: 'tool_container' as const, label: 'Thermal', visibility: 'only_me' as const, key: 'THERM' };
const itemId = 'itm_6b0f8a52-55a4-4f6e-9a39-6d3c8c3c2a10';
const followUp = { citation: { kind: 'follow_up' as const, item_id: itemId }, kind: 'follow_up' as const, label: 'THERM-48 Fan curve v2', visibility: 'team' as const, ref: `follow_up:${itemId}` as const };
const record = `sha256:${'a'.repeat(64)}` as const;
const meeting = { citation: { kind: 'approved_record' as const, atom_id: `sha256:${'b'.repeat(64)}` as const, record_sha256: record, policy_id: 'organization-member-readable-person-v2' as const }, kind: 'decision' as const, label: 'Ship fan curve v2', visibility: 'team' as const, ref: `meeting:${record}` as const };
const page = { citation: { kind: 'page' as const, tool_id: 'knowledge', external_scope_id: 'site-1', page_id: 'p1', section_id: 's1', version: '3', permalink: 'https://knowledge.example.test/wiki/p1', text_sha256: canonicalSha256('x') }, kind: 'page' as const, label: 'Plan', visibility: 'only_me' as const };
const isPrivate = (citation: { readonly visibility: string }) => citation.visibility === 'only_me' || citation.visibility === 'approver_only';
/** One answered part whose one sentence cites every citation, marked private exactly when one of them is. */
const response = (citations: readonly { readonly visibility: string }[] = [project]) => ({
  schema_version: 8 as const, kind: 'echo-clean-person-answer-v8' as const, scope: { kind: 'global' as const }, outcome: 'answered' as const, citations,
  parts: [{ question: 'What are my current projects?', status: 'answered' as const, statements: [{ text: 'Thermal recovery is active, led by Mara.', citation_indexes: citations.map((_, index) => index), private: citations.some(isPrivate) }] }],
});

describe('Workspace answer V8 (research tool contract v1)', () => {
  it('serves on its own route and cites projects, people, tools and tool containers', () => {
    expect(PERSON_ANSWER_PATH_V7).toBe('/v7/person/ask');
    expect(PERSON_ANSWER_PATH_V7).not.toBe(PERSON_ANSWER_PATH_V6);
    const all = [project, person, tool, container];
    const accepted = validatePersonAnswerResponseV8(response(all));
    expect(accepted.citations).toEqual(all);
    expect(Object.isFrozen(accepted.citations[3])).toBe(true);
    for (const citation of all) expect(validatePersonAnswerCitationV8(citation)).toEqual(citation);
  });

  it('keeps V7 and every earlier version closed to workspace citations', () => {
    for (const citation of [project, person, tool, container]) {
      expect(() => validatePersonAnswerCitationV7(citation)).toThrow();
      expect(() => validatePersonAnswerCitationV6(citation)).toThrow();
      expect(() => validatePersonAnswerResponseV7({ ...response([citation]), schema_version: 7, kind: 'echo-clean-person-answer-v7' })).toThrow();
    }
    // The model-free evidence doors stay V4.
    expect(() => validatePersonEvidenceDeskResponseV1({ schema_version: 1, kind: 'echo-person-evidence-desk-v1', scope: { kind: 'global' }, truncated: false,
      items: [{ id: 'desk_project', kind: 'project', citation: project.citation, label: 'Thermal recovery', visibility: 'project', receipt_sha256: record }] })).toThrow();
    // A V8 answer is never read as V7.
    expect(() => validatePersonAnswerResponseV7(response())).toThrow('Ask response is invalid');
  });

  it('accepts every V7 citation unchanged', () => {
    const accepted = validatePersonAnswerResponseV8(response([meeting, page, followUp, project]));
    expect(accepted.citations).toEqual([meeting, page, followUp, project]);
  });

  it('opens a project and a tool by their own ref, and nothing else by one', () => {
    const { ref: _projectRef, ...unopenedProject } = project;
    const { ref: _toolRef, ...unopenedTool } = tool;
    expect(() => validatePersonAnswerCitationV8(unopenedProject)).toThrow('Workspace citation ref is missing');
    expect(() => validatePersonAnswerCitationV8(unopenedTool)).toThrow('Workspace citation ref is missing');
    for (const value of [
      { ...project, ref: 'project:prj_00000000-0000-4000-8000-000000000000' },
      { ...project, ref: 'tool:jira' },
      { ...project, ref: `meeting:${record}` },
      { ...tool, ref: 'tool:confluence' },
      { ...tool, ref: `project:${projectId}` },
      { ...person, ref: `project:${projectId}` },
      { ...person, ref: `meeting:${record}` },
      { ...container, ref: 'tool:jira' },
      { ...meeting, ref: `project:${projectId}` },
      { ...followUp, ref: 'tool:jira' },
      { ...project, ref: `project:${projectId} ` },
      { ...project, ref: 'project:prj_1' },
      { ...tool, ref: 'tool:Jira' },
      { ...tool, ref: 'tool:' },
    ]) expect(() => validatePersonAnswerCitationV8(value)).toThrow();
  });

  it('keeps each kind its citation’s', () => {
    for (const value of [
      { ...project, kind: 'decision' },
      { ...meeting, kind: 'project' },
      { ...person, kind: 'project' },
      { ...tool, kind: 'tool_container' },
      { ...container, kind: 'page' },
      { ...page, kind: 'tool_container' },
      { ...person, kind: 'team' },
    ]) expect(() => validatePersonAnswerCitationV8(value)).toThrow();
  });

  it('shows a key only beside a tool container', () => {
    const { key: _key, ...unkeyed } = container;
    expect(validatePersonAnswerCitationV8(unkeyed)).toEqual(unkeyed);
    const channel = { ...unkeyed, citation: { ...containerCitation, tool_id: 'slack', container: 'slack_channel' as const, container_id: 'C0123456', permalink: 'https://acme.slack.com/archives/C0123456' }, label: '#therm-dvt' };
    expect(validatePersonAnswerCitationV8(channel)).toEqual(channel);
    for (const value of [{ ...project, key: 'THERM' }, { ...tool, key: 'JIRA' }, { ...person, key: 'ML' }, { ...followUp, key: 'THERM-48' }]) {
      expect(() => validatePersonAnswerCitationV8(value)).toThrow('applies only to a tool container');
    }
    for (const key of ['', ' THERM', 'THE\nRM', 'x'.repeat(257), 7]) expect(() => validatePersonAnswerCitationV8({ ...container, key })).toThrow();
    // V7 has no key at all.
    expect(() => validatePersonAnswerCitationV7({ ...meeting, key: 'THERM' })).toThrow('unexpected shape');
  });

  it('cites each project, person, tool and container once, by what it names and never by its label', () => {
    expect(() => validatePersonAnswerResponseV8(response([project, { ...project, label: 'Thermal' }]))).toThrow('duplicate citations');
    expect(() => validatePersonAnswerResponseV8(response([person, { ...person, label: 'Mara' }]))).toThrow('duplicate citations');
    expect(() => validatePersonAnswerResponseV8(response([tool, { ...tool, label: 'Atlassian Jira' }]))).toThrow('duplicate citations');
    expect(() => validatePersonAnswerResponseV8(response([container, { ...container, label: 'THERM', key: 'TH' }]))).toThrow('duplicate citations');
    // Two containers whose ids differ only in where a colon falls are two containers.
    const left = { ...container, citation: { ...containerCitation, external_scope_id: 'a:b', container_id: 'c' } };
    const right = { ...container, citation: { ...containerCitation, external_scope_id: 'a', container_id: 'b:c' } };
    expect(validatePersonAnswerResponseV8(response([left, right])).citations).toHaveLength(2);
    expect(personAnswerCitationKeyV8(left.citation)).not.toBe(personAnswerCitationKeyV8(right.citation));
    // A Jira project and a Jira issue never share a key.
    expect(personAnswerCitationKeyV8(project.citation)).toBe(`project:${projectId}`);
    expect(personAnswerCitationKeyV8(person.citation)).toBe(`person:${membershipId}`);
    expect(personAnswerCitationKeyV8(tool.citation)).toBe('tool:jira');
    expect(personAnswerCitationKeyV8(containerCitation)).toBe('tool_container:["jira","cloud-1","jira_project","10001"]');
  });

  it('marks a sentence private exactly when a cited workspace item is', () => {
    expect(() => validatePersonAnswerResponseV8({ ...response([container]), parts: [{ ...response([container]).parts[0]!, statements: [{ text: 'Thermal is the Jira project.', citation_indexes: [0], private: false }] }] }))
      .toThrow('private is inconsistent');
    expect(validatePersonAnswerResponseV8(response([container])).parts[0]!.statements[0]!.private).toBe(true);
    expect(validatePersonAnswerResponseV8(response([project, person])).parts[0]!.statements[0]!.private).toBe(false);
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
    expect(() => validatePersonOpenRefV1(`project:${projectId}`)).toThrow();
    expect(() => validatePersonOpenRefV1('tool:jira')).toThrow();
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
      { kind: 'workspace' },
      null,
    ]) expect(() => validatePersonWorkspaceCitationV1(value)).toThrow();
  });
});
