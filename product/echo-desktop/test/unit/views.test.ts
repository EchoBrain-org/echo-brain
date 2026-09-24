import { describe, expect, it } from 'vitest';
import {
  answerView, askText, failureView, feedView, noteTitle, projectPageView, receiptView, statusView, ViewError, writeStatusView,
} from '../../src/host/views.js';

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

  it('rejects a reply of the wrong kind', () => {
    expect(() => projectPageView({ kind: 'something-else', items: [] })).toThrow(ViewError);
    expect(() => feedView({ kind: 'echo-project-context-feed-v1', items: [] })).toThrow(ViewError);
  });

  it('marks feed rows by who can read them', () => {
    const row = (kind: string) => ({ context_id: 'ctx', title: 't', excerpt: 'e', received_at: '2026-09-21T22:01:00.000Z', audience: { kind } });
    const page = feedView({ kind: 'echo-project-context-feed-v2', project_id: 'prj', items: [row('only_me'), row('team'), row('projects')], next_cursor: null });
    expect(page.items.map(item => item.audience)).toEqual(['only-me', 'team', 'project']);
  });

  it('keeps openable coordinates for sources and a plain label for approved decisions', () => {
    const answer = answerView({ ok: true, result: {
      schema_version: 3, kind: 'echo-clean-person-answer-v3', answer: 'Ship it.', scope: { kind: 'global' },
      citations: [
        { kind: 'approved_record', atom_id: sha('1'), record_sha256: sha('2'), policy_id: 'organization-member-readable-person-v2' },
        { kind: 'source_revision', source_id: `source:${'3'.repeat(64)}`, revision_id: 'r1', source_sha256: sha('4'),
          representation_sha256: sha('5'), anchor_sha256: sha('6'), label: 'Pricing call' },
      ],
    } }, { kind: 'global' });
    expect(answer.sources.map(source => source.label)).toEqual(['Approved decision', 'Pricing call']);
    expect(answer.sources[0]!.ref).toBeNull();
    expect(answer.sources[1]!.ref?.source_id).toBe(`source:${'3'.repeat(64)}`);
  });

  it('accepts a receipt only for the request that was sent', () => {
    expect(() => receiptView({ request_id: 'other' }, 'mine', { kind: 'only-me' })).toThrow(ViewError);
    expect(receiptView({ request_id: 'mine' }, 'mine', { kind: 'team' })).toEqual({ request_id: 'mine', audience: { kind: 'team' } });
  });

  it('reads a stored note or saved document as saved, anything else as unknown', () => {
    expect(writeStatusView({ kind: 'echo-person-update-status-v3', status: 'stored' }, 'note')).toEqual({ state: 'saved' });
    expect(writeStatusView({ ok: true, result: { state: 'saved' } }, 'document')).toEqual({ state: 'saved' });
    expect(writeStatusView({ kind: 'echo-person-update-status-v3', status: 'pending' }, 'note')).toEqual({ state: 'unknown' });
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
});
