import { describe, expect, it } from 'vitest';
import {
  abandonView, answerView, failureView, feedView, noteMatchesView, noteTitle, noteView, projectMatchesView, projectPageView, receiptView,
  recordView, statusView, toolsView, ViewError, writeStatusView,
} from '../../src/host/views.js';
import { askText, searchQuery } from '../../src/shared/query.js';

const sha = (digit: string) => `sha256:${digit.repeat(64)}`;

describe('view models copy only what the renderer may see', () => {
  it('status keeps the account and nothing else', () => {
    const view = statusView({
      schema_version: 1, kind: 'echo-person-client-status-v1', installed_version: '1', signed_in: true,
      client_build: { source_sha: 'a'.repeat(40), source_kind: 'materialized-commit' },
      display_name: 'Ari', membership_id: 'mem_1', membership_type: 'employee', connected_authority: 'https://a.example',
      access_token: 'SECRET',
    });
    expect(view).toEqual({
      signed_in: true, client_version: '1',
      account: { authority: 'https://a.example', membership_id: 'mem_1', display_name: 'Ari', role: 'employee' },
    });
    expect(JSON.stringify(view)).not.toContain('SECRET');
  });

  it('tools keep each name and state, never external ids, and only for the account asked about', () => {
    const reply = (membership: string) => ({ ok: true, result: {
      schema_version: 3, kind: 'echo-organization-person-tools', organization_id: 'org_1', membership_id: membership,
      tools: [{ tool_id: 'slack', display_name: 'Slack', availability: 'enabled', personal_status: 'linked',
        external_scope_id: 'T0SECRET', external_subject_id: 'U0SECRET' }],
    } });
    const view = toolsView(reply('mem_1'), 'mem_1');
    expect(view).toEqual({ tools: [{ name: 'Slack', enabled: true, linked: true }] });
    expect(JSON.stringify(view)).not.toContain('SECRET');
    expect(() => toolsView(reply('mem_2'), 'mem_1')).toThrow(ViewError);
  });

  it('rejects a reply of the wrong kind', () => {
    expect(() => projectPageView({ kind: 'something-else', items: [] })).toThrow(ViewError);
    expect(() => feedView({ kind: 'echo-project-context-feed-v1', items: [] })).toThrow(ViewError);
  });

  it('marks feed rows by who can read them', () => {
    const row = (kind: string) => ({ context_id: 'ctx', title: 't', excerpt: 'e', received_at: '2026-09-21T22:01:00.000Z', audience: { kind } });
    const page = feedView({ kind: 'echo-project-context-feed-v2', project_id: 'prj', items: [row('only_me'), row('team'), row('projects')], next_cursor: null });
    expect(page.items.map(item => item.audience)).toEqual(['only-me', 'team', 'project']);
  });

  it('keeps an approved record\'s digest and policy, and an original\'s coordinates, each source once', () => {
    const record = { kind: 'approved_record', record_sha256: sha('2'), policy_id: 'organization-member-readable-person-v2' };
    const original = { kind: 'source_revision', source_id: `source:${'3'.repeat(64)}`, revision_id: 'r1', source_sha256: sha('4'),
      representation_sha256: sha('5'), anchor_sha256: sha('6') };
    const answer = answerView({ ok: true, result: {
      schema_version: 3, kind: 'echo-clean-person-answer-v3', answer: 'Ship it.', scope: { kind: 'global' },
      citations: [
        { ...record, atom_id: sha('1') }, { ...record, atom_id: sha('7') },
        { ...original, label: ' Pricing call ' }, { ...original, representation_sha256: sha('8') },
        { ...original, anchor_sha256: sha('9') },
      ],
    } }, { kind: 'global' });
    expect(answer.sources).toEqual([
      { kind: 'record', label: 'Approved record 1', record: { record_sha256: sha('2'), policy_id: 'organization-member-readable-person-v2' } },
      { kind: 'original', label: 'Pricing call', ref: { source_id: `source:${'3'.repeat(64)}`, revision_id: 'r1', source_sha256: sha('4'),
        representation_sha256: sha('5'), anchor_sha256: sha('6') } },
      { kind: 'original', label: 'Original source 3', ref: expect.objectContaining({ anchor_sha256: sha('9') }) },
    ]);
    const unknownPolicy = { ...record, atom_id: sha('1'), policy_id: 'someone-else' };
    expect(() => answerView({ ok: true, result: { kind: 'echo-clean-person-answer-v3', answer: 'a', citations: [unknownPolicy] } }, { kind: 'global' }))
      .toThrow(ViewError);
  });

  it('accepts a receipt only for the request that was sent', () => {
    expect(() => receiptView({ request_id: 'other' }, 'mine', { kind: 'only-me' })).toThrow(ViewError);
    expect(receiptView({ request_id: 'mine' }, 'mine', { kind: 'team' })).toEqual({ request_id: 'mine', audience: { kind: 'team' } });
  });

  it('keeps a document receipt\'s extraction state, and only a known one', () => {
    const receipt = (state: unknown) => receiptView({ request_id: 'mine', extraction_state: state, filename: 'secret.pdf' }, 'mine', { kind: 'only-me' });
    expect(receipt('extracting')).toEqual({ request_id: 'mine', audience: { kind: 'only-me' }, extraction: 'extracting' });
    expect(receipt('Something <b>odd</b>')).toEqual({ request_id: 'mine', audience: { kind: 'only-me' } });
    expect(writeStatusView({ ok: true, result: { state: 'saved', extraction_state: 'no_text' } }, 'document'))
      .toEqual({ state: 'saved', extraction: 'no_text' });
  });

  it('accepts a kept copy removed only for the request asked about', () => {
    const reply = (requestId: string) => ({ ok: true, result: {
      schema_version: 1, kind: 'echo-person-document-abandoned-v1', request_id: requestId, local_snapshot_removed: true, authority_outcome: 'unchanged',
    } });
    expect(abandonView(reply('mine'), 'mine')).toBeNull();
    expect(() => abandonView(reply('other'), 'mine')).toThrow(ViewError);
  });

  it('reads a stored note or saved document as saved, anything else as unknown', () => {
    expect(writeStatusView({ kind: 'echo-person-update-status-v3', status: 'stored' }, 'note')).toEqual({ state: 'saved' });
    expect(writeStatusView({ ok: true, result: { state: 'saved' } }, 'document')).toEqual({ state: 'saved' });
    expect(writeStatusView({ kind: 'echo-person-update-status-v3', status: 'pending' }, 'note')).toEqual({ state: 'unknown' });
  });
});

describe('live matches', () => {
  const item = { context_id: 'ctx_1', received_at: '2026-09-21T22:01:00.000Z', title: 'Apollo update', excerpt: 'We agreed to ship.' };

  it('a project search counts only for the project searched, and says how to read each match', () => {
    const reply = { kind: 'echo-project-context-search-result-v2', project_id: 'prj_1', items: [{ ...item, audience: { kind: 'projects' } }] };
    expect(projectMatchesView(reply, 'prj_1')).toEqual({ items: [{ ...item, source: 'project' }] });
    expect(() => projectMatchesView(reply, 'prj_2')).toThrow(ViewError);
    expect(() => projectMatchesView({ ...reply, kind: 'echo-project-context-feed-v2' }, 'prj_1')).toThrow(ViewError);
  });

  it('saved notes keep their version, so each is read the way it was saved', () => {
    expect(noteMatchesView({ kind: 'echo-person-upload-search-v3', results: [item] }, 3)).toEqual([{ ...item, source: 'v3' }]);
    expect(noteMatchesView({ kind: 'echo-person-upload-search-v2', results: [item] }, 2)).toEqual([{ ...item, source: 'v2' }]);
    expect(() => noteMatchesView({ kind: 'echo-person-upload-search-v2', results: [item] }, 3)).toThrow(ViewError);
  });

  it('a note is read only as the one asked for', () => {
    const reply = { kind: 'echo-person-upload-content-v3', context_id: 'ctx_1', received_at: item.received_at, title: 'T', text: 'Body',
      audience: { kind: 'only_me' } };
    expect(noteView(reply, 3, 'ctx_1')).toEqual({ context_id: 'ctx_1', title: 'T', text: 'Body', received_at: item.received_at });
    expect(() => noteView(reply, 3, 'ctx_2')).toThrow(ViewError);
    expect(() => noteView(reply, 2, 'ctx_1')).toThrow(ViewError);
  });
});

describe('failures carry a code, never text', () => {
  it('drops the error message and keeps the outcome of a write', () => {
    const failure = failureView({ ok: false, error: 'Token AAAA expired at /Users/x', code: 'outcome_unknown', mutation_outcome: 'unknown' },
      'failed', true, 'req-1');
    expect(failure).toEqual({ code: 'outcome_unknown', retryable: true, mutation_outcome: 'unknown', request_id: 'req-1' });
    expect(JSON.stringify(failure)).not.toMatch(/Token|Users/);
  });

  it('treats an unavailable write as unknown and a refused one as not submitted', () => {
    expect(failureView({ code: 'unavailable' }, 'failed', true).mutation_outcome).toBe('unknown');
    expect(failureView({ code: 'transport_failed' }, 'failed', true)).toMatchObject({ mutation_outcome: 'unknown', retryable: true });
    expect(failureView({ code: 'transport_failed', mutation_outcome: 'not_submitted' }, 'failed', true).mutation_outcome).toBe('not_submitted');
    expect(failureView({ code: 'invalid_request' }, 'failed', true).mutation_outcome).toBe('not_submitted');
    expect(failureView({ code: 'unavailable' }, 'failed', false).mutation_outcome).toBeUndefined();
  });

  it('never lets an odd code through', () => {
    expect(failureView({ code: 'Bad Code <script>' }, 'failed', false).code).toBe('failed');
  });
});

describe('text the API accepts', () => {
  it('titles are the first non-empty line, tabs and controls made spaces, at most 200 bytes', () => {
    expect(noteTitle('\n\n  Northwind call  \nsecond')).toBe('Northwind call');
    expect(noteTitle('a\tb\u0007c\r\nnext')).toBe('a b c');
    expect(Buffer.byteLength(noteTitle('é'.repeat(200)))).toBe(200);
    expect(noteTitle('x' + '😀'.repeat(60))).toBe('x' + '😀'.repeat(49)); // never half a character
    expect(noteTitle('   \n  ')).toBe('');
  });

  it('questions are one NFC line of at most 240 code points', () => {
    expect(askText('  what\nchanged?\u2028 ')).toBe('what changed?');
    expect(askText('e\u0301')).toBe('é');
    expect([...askText('😀'.repeat(300))].length).toBe(240);
  });

  it('a search is a question of two or more characters with 1 to 32 distinct words of at most 64 bytes', () => {
    expect(searchQuery('  pri\ncing ')).toBe('pri cing');
    expect(searchQuery('p')).toBeNull();
    expect(searchQuery('!!')).toBeNull();
    expect(searchQuery(Array.from({ length: 33 }, (_, index) => `w${index}`).join(' '))).toBeNull();
    expect(searchQuery('x'.repeat(65))).toBeNull();
    expect(searchQuery('é'.repeat(32))).toBe('é'.repeat(32));
    expect(searchQuery('é'.repeat(33))).toBeNull();
  });
});

describe('an approved record shows only what the source pane needs', () => {
  const asked = { record_sha256: sha('5'), policy_id: 'organization-member-readable-person-v2' } as const;
  const item = (kind: string, id: string, text: string, extra: Record<string, unknown> = {}) => ({ id, kind, text, ...extra });
  const reply = (brief: Record<string, unknown>, change: (record: Record<string, unknown>) => void = () => undefined) => {
    const record: Record<string, unknown> = {
      position: 1, approval_id: 'apr_1', record_sha256: sha('5'),
      envelope: { record_sha256: sha('5'), body: { event: {
        kind: 'approved', policy_id: 'organization-member-readable-person-v2', approved_snapshot: { approved_payload: { brief: {
          meeting: { id: 'm1', title: 'Tuesday sync' }, decisions: [], actions: [], rationales: [], ...brief,
        } } },
      } } },
      source_metadata: { record_approved_by: { display_name: 'Maya Chen' } },
    };
    change(record);
    return { ok: true, result: { schema_version: 1, kind: 'echo-clean-person-record-list-v1', records: [record] } };
  };

  it('copies the meeting, who approved it, who was there, who can read it, and what was approved', () => {
    const view = recordView(reply({
      meeting: {
        id: 'm1', title: 'Tuesday\u0000sync', time: { scheduled_start_at: '2026-09-15T17:00:00Z', timezone: 'America/Los_Angeles' },
        participants: [
          { id: 'p1', display_name: 'Maya Chen' }, { id: 'p2', display_name: 'Ari' }, { id: 'p3', display_name: 'Maya Chen' },
          { id: 'p4', identities: [{ kind: 'email', value: 'private@example.test' }] },
        ],
      },
      decisions: [item('decision', 'd1', 'Ship annual plans first.', {
        status: 'proposed', evidence: [
          { quote: 'Annual first.', started_at: '2026-09-15T17:12:00Z', speaker_email: 'private@example.test' }, { quote: 'Annual first.' },
          { quote: 'Two' }, { quote: 'Three' }, { quote: 'Four' },
        ],
      })],
      actions: [item('action', 'a1', 'Update pricing.', { status: 'proposed' })],
      rationales: [item('rationale', 'r1', 'It funds the launch.')],
    }), asked);
    expect(view).toEqual({
      title: 'Tuesday sync', started_at: '2026-09-15T17:00:00Z', timezone: 'America/Los_Angeles', all_day: false, approved_by: 'Maya Chen',
      participants: ['Maya Chen', 'Ari'], participants_more: false, visibility: 'organization',
      decisions: { more: false, items: [{ text: 'Ship annual plans first.', status: 'proposed', excerpts: [
        { quote: 'Annual first.', at: '2026-09-15T17:12:00Z' }, { quote: 'Two' }, { quote: 'Three' },
      ] }] },
      actions: { more: false, items: [{ text: 'Update pricing.', excerpts: [] }] },
      rationales: { more: false, items: [{ text: 'It funds the launch.', excerpts: [] }] },
    });
    expect(JSON.stringify(view)).not.toContain('private@example.test');
  });

  it('shows at most 2,000 characters of any text, 32 items a section and 32 participants', () => {
    const decisions = Array.from({ length: 33 }, (_, index) => item('decision', `d${index}`, index === 0 ? 'x'.repeat(2_001) : `Decision ${index}`));
    const participants = Array.from({ length: 40 }, (_, index) => ({ id: `p${index}`, display_name: `Person ${index}` }));
    const view = recordView(reply({ meeting: { id: 'm1', participants }, decisions }), asked);
    expect(view.title).toBeUndefined();
    expect(view.decisions.items).toHaveLength(32);
    expect(view.decisions.more).toBe(true);
    expect(view.decisions.items[0]!.text).toBe(`${'x'.repeat(1_999)}… (truncated)`);
    expect(view.participants).toHaveLength(32);
    expect(view.participants_more).toBe(true);
  });

  it('refuses a record other than the one asked for, an unapproved one, or a malformed brief', () => {
    expect(() => recordView(reply({}), { ...asked, record_sha256: sha('6') })).toThrow(ViewError);
    expect(() => recordView(reply({}), { ...asked, policy_id: 'restricted-reviewer-person-v2' })).toThrow(ViewError);
    expect(() => recordView(reply({}, record => { (record.envelope as Record<string, unknown>).record_sha256 = sha('6'); }), asked))
      .toThrow(ViewError);
    expect(() => recordView(reply({ decisions: [item('action', 'd1', 'Wrong kind')] }), asked)).toThrow(ViewError);
    expect(() => recordView(reply({ decisions: [item('decision', 'd1', 'One'), item('decision', 'd1', 'Same id')] }), asked)).toThrow(ViewError);
    expect(() => recordView(reply({ actions: undefined }), asked)).toThrow(ViewError);
    const restricted = recordView(reply({}, record => {
      ((record.envelope as { body: { event: Record<string, unknown> } }).body.event).policy_id = 'restricted-reviewer-person-v2';
      delete record.source_metadata;
    }), { ...asked, policy_id: 'restricted-reviewer-person-v2' });
    expect(restricted.visibility).toBe('approver');
    expect(restricted.approved_by).toBeUndefined();
  });
});
