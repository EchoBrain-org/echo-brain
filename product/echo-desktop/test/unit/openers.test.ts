import { describe, expect, it } from 'vitest';
import type { AnswerSource } from '../../src/shared/protocol.js';
import { groupKey } from '../../src/renderer/answer.js';
import { openerOf, sourceKey } from '../../src/renderer/openers.js';

const sha = (digit: string) => `sha256:${digit.repeat(64)}`;
const coordinates = (anchor: string) => ({ source_id: `source:${'3'.repeat(64)}`, revision_id: 'r1', source_sha256: sha('4'), representation_sha256: sha('5'), anchor_sha256: sha(anchor) });
const decision = (atom: string, label = 'Tuesday sync'): AnswerSource =>
  ({ kind: 'record', label, record: { record_sha256: sha('2'), policy_id: 'organization-member-readable-person-v2' }, atom_id: sha(atom) });
const ticket = (key: string): AnswerSource => ({ kind: 'ticket', tool_id: 'jira', label: key, permalink: `https://example.atlassian.net/browse/${key}` });

describe('one opener for each kind of item', () => {
  it('opens a record item, a passage, a transcript and live evidence each in its place', () => {
    expect(openerOf(decision('1'))).toEqual({ pane: 'record', page: { kind: 'reader', ref: { kind: 'meeting', id: sha('2') } } });
    expect(openerOf({ kind: 'original', label: 'Notes', ref: coordinates('6'), item: { kind: 'note', id: `ctx_${'8'.repeat(64)}` } }))
      .toEqual({ pane: 'passages', page: { kind: 'reader', ref: { kind: 'note', id: `ctx_${'8'.repeat(64)}` } } });
    // An older answer's passage without a ref still shows its passages, with no page to open.
    expect(openerOf({ kind: 'original', label: 'Notes', ref: coordinates('6') })).toEqual({ pane: 'passages', page: null });
    expect(openerOf({ kind: 'transcript', label: 'Transcript', ref: coordinates('6'), meeting: sha('2') }))
      .toEqual({ pane: 'meeting', meeting: sha('2'), page: { kind: 'reader', ref: { kind: 'meeting', id: sha('2') } } });
    for (const source of [ticket('ECHO-7'), { ...ticket('ECHO-7'), kind: 'page' } as AnswerSource,
      { kind: 'slack', tool_id: 'slack', label: '#launch', permalink: 'https://acme.slack.com/archives/C01ABCDEF/p1758873600000100' } as AnswerSource]) {
      expect(openerOf(source)).toEqual({ pane: 'external', page: null });
    }
  });

  it('opens a follow-up beside Ask with its title, owner, status and check, and its full page by its item id (ADR-0040)', () => {
    const followUp: AnswerSource = { kind: 'follow_up', label: 'Ship the launch checklist', item_id: 'itm_launch-1' };
    expect(openerOf(followUp)).toEqual({ pane: 'follow_up', page: { kind: 'follow_up', item_id: 'itm_launch-1' } });
    // One follow-up is one item and one source, whatever its title says; two follow-ups are two.
    expect(sourceKey(followUp)).toBe(sourceKey({ ...followUp, label: 'Renamed' } as AnswerSource));
    expect(sourceKey(followUp)).not.toBe(sourceKey({ ...followUp, item_id: 'itm_launch-2' } as AnswerSource));
    expect(groupKey(followUp)).not.toBe(groupKey({ ...followUp, item_id: 'itm_launch-2' } as AnswerSource));
  });

  it('tells items apart by what they cite, not by their label', () => {
    expect(sourceKey(decision('1', 'One'))).toBe(sourceKey(decision('1', 'Another')));
    expect(sourceKey(decision('1'))).not.toBe(sourceKey(decision('2')));
    expect(sourceKey({ kind: 'original', label: 'a', ref: coordinates('6') })).not.toBe(sourceKey({ kind: 'transcript', label: 'a', ref: coordinates('6'), meeting: sha('2') }));
  });
});
