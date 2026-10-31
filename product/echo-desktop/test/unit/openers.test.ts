import { describe, expect, it } from 'vitest';
import type { AnswerSource } from '../../src/shared/protocol.js';
import { groupKey } from '../../src/renderer/answer.js';
import { sourceKey } from '../../src/renderer/openers.js';

const sha = (digit: string) => `sha256:${digit.repeat(64)}`;
const coordinates = (anchor: string) => ({ source_id: `source:${'3'.repeat(64)}`, revision_id: 'r1', source_sha256: sha('4'), representation_sha256: sha('5'), anchor_sha256: sha(anchor) });
const decision = (atom: string, label = 'Tuesday sync'): AnswerSource =>
  ({ kind: 'record', label, record: { record_sha256: sha('2'), policy_id: 'project-members-readable-person-v1' }, atom_id: sha(atom) });
const ticket = (key: string): AnswerSource => ({ kind: 'ticket', tool_id: 'jira', label: key, permalink: `https://example.atlassian.net/browse/${key}` });

describe('one key for each item Ask cites', () => {
  it('keys a follow-up by its item id (ADR-0040)', () => {
    const followUp: AnswerSource = { kind: 'follow_up', label: 'Ship the launch checklist', item_id: 'itm_launch-1' };
    // One follow-up is one item and one source, whatever its title says; two follow-ups are two.
    expect(sourceKey(followUp)).toBe(sourceKey({ ...followUp, label: 'Renamed' } as AnswerSource));
    expect(sourceKey(followUp)).not.toBe(sourceKey({ ...followUp, item_id: 'itm_launch-2' } as AnswerSource));
    expect(groupKey(followUp)).not.toBe(groupKey({ ...followUp, item_id: 'itm_launch-2' } as AnswerSource));
  });

  it('keys your project, a person, a tool and a Jira project or Confluence space by what it names (research tool contract v1)', () => {
    const PROJECT = 'prj_6b0f8a52-55a4-4f6e-9a39-6d3c8c3c2a10';
    const project: AnswerSource = { kind: 'project', label: 'Thermal recovery', project_id: PROJECT };
    const person: AnswerSource = { kind: 'person', label: 'Mara Lind', membership_id: 'mem_0f1e2d3c-4b5a-4968-8778-695a4b3c2d1e' };
    const tool: AnswerSource = { kind: 'tool', label: 'Jira', tool_id: 'jira' };
    const container: AnswerSource = { kind: 'container', tool_id: 'jira', label: 'Thermal', permalink: 'https://example.atlassian.net/browse/THERM', container: 'jira_project', key: 'THERM' };
    // Each is one item and one source by what it names, whatever its label or key says.
    for (const source of [project, person, tool, container]) {
      expect(sourceKey({ ...source, label: 'Renamed' } as AnswerSource)).toBe(sourceKey(source));
      expect(groupKey({ ...source, label: 'Renamed' } as AnswerSource)).toBe(groupKey(source));
    }
    expect(sourceKey({ ...container, key: 'TH' } as AnswerSource)).toBe(sourceKey(container));
    // A tool, its Jira project and one of its issues are three items; so are two projects.
    expect(new Set([tool, container, ticket('THERM-48')].map(sourceKey)).size).toBe(3);
    expect(new Set([tool, container, ticket('THERM-48')].map(groupKey)).size).toBe(3);
    expect(sourceKey(project)).not.toBe(sourceKey({ ...project, project_id: 'prj_00000000-0000-4000-8000-000000000000' } as AnswerSource));
    expect(groupKey(container)).not.toBe(groupKey({ ...container, permalink: 'https://example.atlassian.net/browse/OTHER' } as AnswerSource));
  });

  it('tells items apart by what they cite, not by their label', () => {
    expect(sourceKey(decision('1', 'One'))).toBe(sourceKey(decision('1', 'Another')));
    expect(sourceKey(decision('1'))).not.toBe(sourceKey(decision('2')));
    expect(sourceKey({ kind: 'original', label: 'a', ref: coordinates('6') })).not.toBe(sourceKey({ kind: 'original', label: 'a', ref: coordinates('7') }));
  });
});
