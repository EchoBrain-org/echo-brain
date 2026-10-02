import { describe, expect, it } from 'vitest';
import type { AnswerSource } from '../../src/shared/protocol.js';
import { documentName, passageBlocks, sourceGroups, statementGroups } from '../../src/renderer/answer.js';

const digest = (digit: string) => `sha256:${digit.repeat(64)}`;
const original = (source: string, anchor: string, label = 'SCOUT-Hardware-Review-v0.1.md'): AnswerSource => ({
  kind: 'original', label,
  ref: { source_id: `source:${source.repeat(64)}`, revision_id: 'rev-1', source_sha256: digest('2'), representation_sha256: digest('3'), anchor_sha256: digest(anchor) },
});
const record = (digit: string): AnswerSource => ({
  kind: 'record', label: 'Approved record 1', record: { record_sha256: digest(digit), policy_id: 'organization-member-readable-person-v2' },
});
const slack = (ts: string): AnswerSource => ({ kind: 'slack', label: '#launch · Maya', permalink: `https://acme.slack.com/archives/C01ABCDEF/p${ts}` });

describe('an answer cites sources, not passages', () => {
  it('groups repeated ticket citations by link while keeping Slack sources distinct', () => {
    const ticket: AnswerSource = { kind: 'ticket', label: 'ECHO-7', permalink: 'https://example.test/tickets/7' };
    expect(sourceGroups([ticket, slack('1758873600000100'), { ...ticket, label: 'ECHO-7 updated title' }])).toEqual([
      { kind: 'ticket', indexes: [0, 2] }, { kind: 'slack', indexes: [1] },
    ]);
  });
  it('groups the passages of one document, the items of one meeting record, and keeps each Slack message apart, in first-cited order', () => {
    const sources = [original('a', '4'), original('b', '5', 'SCOUT-Software-Review-v0.1.md'), original('a', '6'), record('7'), record('7'),
      slack('1758873600000100'), slack('1758873600000200'), original('b', '8', 'SCOUT-Software-Review-v0.1.md')];
    expect(sourceGroups(sources)).toEqual([
      { kind: 'original', indexes: [0, 2] },
      { kind: 'original', indexes: [1, 7] },
      { kind: 'record', indexes: [3, 4] },
      { kind: 'slack', indexes: [5] },
      { kind: 'slack', indexes: [6] },
    ]);
  });

  it('gives a sentence one marker per source it cites, in source order', () => {
    const groups = sourceGroups([original('a', '4'), original('b', '5'), original('a', '6')]);
    expect(statementGroups([2, 1, 0], groups)).toEqual([0, 1]);
    expect(statementGroups([1], groups)).toEqual([1]);
    // An index the answer does not have is not a source.
    expect(statementGroups([9], groups)).toEqual([]);
  });
});

describe('a file name reads as a name', () => {
  it('drops the extension, reads dashes as spaces in a name without spaces, and keeps a trailing version apart', () => {
    expect(documentName('SCOUT-Hardware-Review-v0.1.md')).toEqual({ name: 'SCOUT Hardware Review', version: 'v0.1' });
    expect(documentName('launch_plan_v2.docx')).toEqual({ name: 'launch plan', version: 'v2' });
    expect(documentName('Pre-launch checklist.pdf')).toEqual({ name: 'Pre-launch checklist' });
    expect(documentName('Apollo update')).toEqual({ name: 'Apollo update' });
    expect(documentName('Transcript: Tuesday sync')).toEqual({ name: 'Transcript: Tuesday sync' });
    // A title someone wrote keeps its version: only a file name's is set apart.
    expect(documentName('Pricing v2')).toEqual({ name: 'Pricing v2' });
    // A version needs a name before it; a name that is only an extension is left as it came.
    expect(documentName('v2.md')).toEqual({ name: 'v2' });
    expect(documentName('.md')).toEqual({ name: '.md' });
  });
});

describe('a passage reads as its document does', () => {
  it('turns headings, lists and bold into blocks, and keeps other lines as they are', () => {
    const text = [
      '### Concerns',
      '- "Unobstructed" in **PRD-07** excludes lab clutter.',
      '- Floor transitions are unspecified.',
      '',
      '## 3. Stopping, e-stop',
      '1. Stop first.',
      '2) Report after.',
      '---',
      'Jules: I will publish the dashboard',
      'Maya: `v2` ships Friday',
    ].join('\n');
    expect(passageBlocks(text, 'SCOUT-Hardware-Review-v0.1.md')).toEqual([
      { kind: 'heading', text: [{ text: 'Concerns' }] },
      { kind: 'list', ordered: false, items: [
        [{ text: '"Unobstructed" in ' }, { text: 'PRD-07', bold: true }, { text: ' excludes lab clutter.' }],
        [{ text: 'Floor transitions are unspecified.' }],
      ] },
      { kind: 'heading', text: [{ text: '3. Stopping, e-stop' }] },
      { kind: 'list', ordered: true, items: [[{ text: 'Stop first.' }], [{ text: 'Report after.' }]] },
      { kind: 'paragraph', text: [{ text: 'Jules: I will publish the dashboard\nMaya: ' }, { text: 'v2', code: true }, { text: ' ships Friday' }] },
    ]);
  });

  it('drops the file name the evidence starts with, since the pane already names it', () => {
    expect(passageBlocks('SCOUT-Hardware-Review-v0.1.md docking approach is an OPEN-01 input.', 'SCOUT-Hardware-Review-v0.1.md'))
      .toEqual([{ kind: 'paragraph', text: [{ text: 'docking approach is an OPEN-01 input.' }] }]);
    expect(passageBlocks('We agreed to ship.', 'Apollo update')).toEqual([{ kind: 'paragraph', text: [{ text: 'We agreed to ship.' }] }]);
  });

  it('leaves unmatched markers as text', () => {
    expect(passageBlocks('A **half bold and a `tick', 'x')).toEqual([{ kind: 'paragraph', text: [{ text: 'A **half bold and a `tick' }] }]);
  });
});
