import { describe, expect, it } from 'vitest';
import {
  abandonView, answerView, changeView, createdView, directoryView, employeesView, failureView, impactCardView, invitationView, listView, membersView, noteMatchesView,
  noteTitle, openView, revokedView, NotReadable, projectMatchesView, projectPageView, projectSettingsView, projectView, receiptView, recordView,
  savedOriginalView, statusView, toolAttemptStatusView, toolAttemptView, toolsView, ViewError, writeStatusView,
} from '../../src/host/views.js';
import type { ApprovedRecord } from '../../src/shared/protocol.js';
import { askText, searchQuery } from '../../src/shared/query.js';

// The store reads the preload's bridge when it loads; its record join needs none.
(globalThis as { window?: unknown }).window = { echo: {} };
const { joinRecord } = await import('../../src/renderer/store.js');

const sha = (digit: string) => `sha256:${digit.repeat(64)}`;

describe('view models copy only what the renderer may see', () => {
  it.each(['confluence', 'notion', 'knowledge-base'])('preserves %s page identity without provider coordinates', tool_id => {
    const permalink = 'https://wiki.example.test/pages/view?pageId=12345';
    const source = (tool: unknown) => ({ schema_version: 6, kind: 'echo-clean-person-answer-v6', outcome: 'answered',
      citations: [{ kind: 'page', label: 'Launch plan', visibility: 'only_me', citation: { kind: 'page', tool_id: tool,
        external_scope_id: 'private-tenant', page_id: '12345', section_id: 'one', version: '7', permalink, text_sha256: sha('a') } }],
      parts: [{ question: 'When?', status: 'answered', statements: [{ text: 'Tuesday.', citation_indexes: [0], private: true }] }],
    });
    const answer = answerView({ ok: true, result: source(tool_id) }, { kind: 'global' });
    expect(answer.sources).toEqual([{ kind: 'page', tool_id, label: 'Launch plan', permalink }]);
    expect(JSON.stringify(answer)).not.toContain('private-tenant');
    expect(() => answerView({ ok: true, result: source('invalid tool id') }, { kind: 'global' })).toThrow(ViewError);
  });
  it('displays ticket citations only in V5 and retains only the direct ticket link', () => {
    const permalink = 'https://example.atlassian.net/browse/ECHO-7';
    const reply = (link: unknown, version = 5) => ({ ok: true, result: { schema_version: version, kind: `echo-clean-person-answer-v${version}`,
      scope: { kind: 'global' }, outcome: 'answered',
      citations: [{ kind: 'ticket', label: 'ECHO-7 · Jira launch', visibility: 'only_me', citation: {
        kind: 'ticket', tool_id: 'jira', external_scope_id: 'private-tenant', ticket_id: '10007', permalink: link, text_sha256: sha('a'),
      } }], parts: [{ question: 'Which ticket?', status: 'answered', statements: [{ text: 'ECHO-7 covers launch.', citation_indexes: [0], private: true }] }],
    } });
    const answer = answerView(reply(permalink), { kind: 'global' });
    expect(answer.sources).toEqual([{ kind: 'ticket', tool_id: 'jira', label: 'ECHO-7 · Jira launch', permalink }]);
    expect(JSON.stringify(answer)).not.toContain('private-tenant');
    expect(() => answerView(reply(permalink, 4), { kind: 'global' })).toThrow(ViewError);
    for (const link of ['javascript:alert(1)', 'https://user:password@example.test/ticket/7', 'https://example.test/ticket/7?token=secret',
      'https://example.test/ticket/7#token', 'https://example.test\\@evil.test/ticket/7', null]) {
      expect(() => answerView(reply(link), { kind: 'global' })).toThrow(ViewError);
    }
  });
  it('an impact card keeps its rows and turns each citation into a source the card can name or open', () => {
    const permalink = 'https://example.atlassian.net/browse/ECHO-12';
    const record = { kind: 'approved_record', atom_id: sha('1'), record_sha256: sha('2'), policy_id: 'restricted-reviewer-person-v2' } as const;
    const ticket = { kind: 'ticket', tool_id: 'jira', external_scope_id: 'private-tenant', ticket_id: '10012', permalink, text_sha256: sha('3') } as const;
    const card = {
      status: 'assessed', decided: [{ text: 'Launch next week.', citation_index: 0 }],
      affected: [{ citation_index: 1, says_now: 'Planned for the end of the month.', relation: 'conflicts', owner: 'Mina Patel' }],
      unconfirmed: ['No contract was found.'], people: [{ name: 'Mina Patel', items: [1] }],
      citations: [{ kind: 'decision', label: '', visibility: 'only_me', citation: record }, { kind: 'ticket', label: 'ECHO-12 · Pilot launch', visibility: 'only_me', citation: ticket }],
    } as const;
    const view = impactCardView({ card, checked_at: '2026-10-07T10:05:00.000Z', hidden: 2 } as unknown as Parameters<typeof impactCardView>[0]);
    expect(view).toEqual({
      status: 'assessed', decided: card.decided, affected: card.affected, unconfirmed: card.unconfirmed, people: card.people,
      sources: [{ kind: 'record', label: 'Item 1', record: { record_sha256: sha('2'), policy_id: 'restricted-reviewer-person-v2' } },
        { kind: 'ticket', tool_id: 'jira', label: 'ECHO-12 · Pilot launch', permalink }],
      checked_at: '2026-10-07T10:05:00.000Z', hidden: 2,
    });
    expect(JSON.stringify(view)).not.toContain('private-tenant');
  });

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

  it('tools keep each id, name and your connection, never external ids, and only for the account asked about', () => {
    const tool = (tool_id: string, availability: string, personal_status: string) => ({ tool_id, display_name: tool_id.toUpperCase(), availability,
      personal_status, external_scope_id: availability === 'enabled' ? 'T0SECRET' : null,
      external_subject_id: personal_status === 'linked' ? 'U0SECRET' : null, organization_setup: 'connected' });
    const reply = (membership: string, tools = [tool('slack', 'enabled', 'linked'), tool('jira', 'enabled', 'revoked'), tool('granola', 'unavailable', 'unavailable')]) =>
      ({ ok: true, result: { schema_version: 4, kind: 'echo-organization-person-tools', organization_id: 'org_1', membership_id: membership, tools } });
    const view = toolsView(reply('mem_1'), 'mem_1');
    expect(view).toEqual({ tools: [
      { tool_id: 'slack', name: 'SLACK', status: 'linked' },
      { tool_id: 'jira', name: 'JIRA', status: 'revoked' },
      { tool_id: 'granola', name: 'GRANOLA', status: 'unavailable' },
    ] });
    expect(JSON.stringify(view)).not.toContain('SECRET');
    expect(() => toolsView(reply('mem_2'), 'mem_1')).toThrow(ViewError);
    // A tool id the client could not take after --tool is refused, not passed on.
    expect(() => toolsView(reply('mem_1', [tool('--tool', 'enabled', 'unlinked')]), 'mem_1')).toThrow(ViewError);
  });

  it('a started connection keeps only its attempt and expiry, whichever key the tool prints', () => {
    const expires = '2026-10-02T12:30:00.000Z';
    expect(toolAttemptView({ ok: true, phase: 'waiting', attempt_id: 'sbl_abc', expires_at: expires })).toEqual({ attempt_id: 'sbl_abc', expires_at: expires });
    expect(toolAttemptView({ ok: true, phase: 'waiting', attempt: '6f1c2a4e-0b7d-4c55-9a1e-2f3b4c5d6e7f', expires_at: expires }))
      .toEqual({ attempt_id: '6f1c2a4e-0b7d-4c55-9a1e-2f3b4c5d6e7f', expires_at: expires });
    expect(() => toolAttemptView({ ok: true, phase: 'connected', attempt_id: 'sbl_abc', expires_at: expires })).toThrow(ViewError);
    expect(() => toolAttemptView({ ok: true, phase: 'waiting', attempt_id: 'a b', expires_at: expires })).toThrow(ViewError);

    expect(toolAttemptStatusView({ ok: true, result: { attempt: 'x', status: 'failed', failure_reason: 'account_mismatch', expires_at: expires } }))
      .toEqual({ status: 'failed', failure_reason: 'account_mismatch' });
    expect(toolAttemptStatusView({ ok: true, result: { attempt_id: 'sbl_abc', status: 'pending', failure_reason: null } }))
      .toEqual({ status: 'pending', failure_reason: null });
    expect(() => toolAttemptStatusView({ ok: true, result: { status: 'done', failure_reason: null } })).toThrow(ViewError);
  });

  it('a tool step that did not finish reports its reason as the failure code', () => {
    expect(failureView({ ok: false, error: 'Jira connection page could not be opened.', reason: 'browser_unavailable' }, 'failed', false).code)
      .toBe('browser_unavailable');
  });

  it('rejects a reply of the wrong kind', () => {
    expect(() => projectPageView({ kind: 'something-else', items: [] })).toThrow(ViewError);
    expect(() => listView({ ok: true, result: { schema_version: 1, kind: 'echo-project-context-feed-v2', scope: { kind: 'mine' }, items: [], next_cursor: null } },
      { kind: 'mine' })).toThrow(ViewError);
  });

  it('keeps each cited approved record by digest and policy, and each original by its coordinates, in citation order', () => {
    const record = { kind: 'approved_record', atom_id: sha('1'), record_sha256: sha('2'), policy_id: 'organization-member-readable-person-v2' };
    const original = { kind: 'source_revision', source_id: `source:${'3'.repeat(64)}`, revision_id: 'r1', source_sha256: sha('4'),
      representation_sha256: sha('5'), anchor_sha256: sha('6') };
    const v4 = (citations: unknown[]) => ({ schema_version: 4, kind: 'echo-clean-person-answer-v4', scope: { kind: 'global' }, outcome: 'answered',
      citations, parts: [{ question: 'What did we ship?', status: 'answered', statements: [{ text: 'Ship it.', citation_indexes: [0], private: false }] }] });
    const answer = answerView({ ok: true, result: v4([
      { citation: record, kind: 'decision', label: 'Tuesday sync', visibility: 'team' },
      { citation: { ...original, label: 'Pricing call' }, kind: 'document_passage', label: 'Pricing call', visibility: 'team' },
      { citation: original, kind: 'note', label: '', visibility: 'only_me' },
    ]) }, { kind: 'global' });
    expect(answer.sources).toEqual([
      { kind: 'record', label: 'Tuesday sync', record: { record_sha256: sha('2'), policy_id: 'organization-member-readable-person-v2' } },
      { kind: 'original', label: 'Pricing call', ref: { source_id: `source:${'3'.repeat(64)}`, revision_id: 'r1', source_sha256: sha('4'),
        representation_sha256: sha('5'), anchor_sha256: sha('6') } },
      { kind: 'original', label: 'Evidence 3', ref: expect.objectContaining({ anchor_sha256: sha('6') }) },
    ]);
    // One part answers the question itself: its plain text does not repeat it.
    expect(answer.text).toBe('Ship it.');
    const unknownPolicy = { citation: { ...record, policy_id: 'someone-else' }, kind: 'decision', label: 'x', visibility: 'team' };
    expect(() => answerView({ ok: true, result: v4([unknownPolicy]) }, { kind: 'global' })).toThrow(ViewError);
  });

  it('refuses the retired answer shapes and an answer with no part', () => {
    const v3 = { schema_version: 3, kind: 'echo-clean-person-answer-v3', answer: 'Ship it.', scope: { kind: 'global' }, citations: [] };
    expect(() => answerView({ ok: true, result: v3 }, { kind: 'global' })).toThrow(ViewError);
    const empty = { schema_version: 4, kind: 'echo-clean-person-answer-v4', scope: { kind: 'global' }, outcome: 'not_found', citations: [], parts: [] };
    expect(() => answerView({ ok: true, result: empty }, { kind: 'global' })).toThrow(ViewError);
  });

  it('keeps a Slack citation label and permalink without exposing its other coordinates', () => {
    const permalink = 'https://acme.slack.com/archives/C01ABCDEF/p1758873600000100?thread_ts=1758873600.000100';
    const reply = (url: unknown) => ({ schema_version: 4, kind: 'echo-clean-person-answer-v4', outcome: 'answered',
      citations: [{ kind: 'slack_message', label: '#launch · Maya', visibility: 'only_me', citation: {
        kind: 'slack_message', team_id: 'T01ABCDEF', channel_id: 'C01ABCDEF', message_ts: '1758873600.000100',
        permalink: url, text_sha256: sha('7'),
      } }],
      parts: [{ question: 'What changed?', status: 'answered', statements: [{ text: 'The launch is ready.', citation_indexes: [0], private: true }] }],
    });
    const answer = answerView({ ok: true, result: reply(permalink) }, { kind: 'global' });
    expect(answer.sources).toEqual([{ kind: 'slack', tool_id: 'slack', label: '#launch · Maya', permalink }]);
    expect(answer.parts[0]?.statements[0]).toEqual({ text: 'The launch is ready.', citation_indexes: [0], private: true });
    for (const url of ['javascript:alert(1)', 'https://acme.slack.com.evil.test/archives/C01ABCDEF/p1758873600000100',
      'https://user:password@acme.slack.com/archives/C01ABCDEF/p1758873600000100', null]) {
      expect(() => answerView(reply(url), { kind: 'global' })).toThrow(ViewError);
    }
  });

  it('maps Agentic Ask statements to their exact sources, including project records and fallback whitespace', () => {
    const citation = { kind: 'approved_record', atom_id: sha('1'), record_sha256: sha('2'), policy_id: 'project-members-readable-person-v1' };
    const answer = answerView({ ok: true, result: {
      schema_version: 4, kind: 'echo-clean-person-answer-v4', scope: { kind: 'global' }, outcome: 'partial',
      citations: [{ citation, kind: 'decision', label: 'Project review', visibility: 'project' }],
      direct: { text: 'A private summary.', citation_indexes: [0], private: true },
      parts: [{ question: 'What changed?', status: 'records_only', statements: [], gap: 'No prose was available.',
        records: [{ text: 'Exact\n  fallback', citation_indexes: [0], private: false }] }],
      assumption: 'Ecko means Echo', notice: 'Meeting records were unavailable.',
    } }, { kind: 'global' });
    expect(answer).toMatchObject({ outcome: 'partial', assumption: 'Ecko means Echo', notice: 'Meeting records were unavailable.',
      direct: { private: true, citation_indexes: [0] }, parts: [{ status: 'records_only', records: [{ text: 'Exact\n  fallback' }] }],
      sources: [{ kind: 'record', label: 'Project review', record: { policy_id: 'project-members-readable-person-v1' } }],
    });
  });

  it('keeps not-found and off-scope outcomes, and reads a not-found answer as its gap', () => {
    const project = { kind: 'project', project_id: 'prj_11111111-1111-4111-8111-111111111111' } as const;
    const empty = (outcome: string) => ({ schema_version: 4, kind: 'echo-clean-person-answer-v4', scope: project, outcome, citations: [],
      parts: [{ question: 'Who owns pricing?', status: 'not_found', statements: [], gap: 'Not found.' }] });
    expect(answerView({ ok: true, result: empty('not_found') }, project)).toEqual({
      text: 'Not found.', scope: project, sources: [], outcome: 'not_found',
      parts: [{ question: 'Who owns pricing?', status: 'not_found', statements: [], gap: 'Not found.' }],
    });
    expect(answerView({ ok: true, result: empty('off_scope') }, project)).toMatchObject({ outcome: 'off_scope' });
    expect(() => answerView({ ok: true, result: empty('authorship_unsupported') }, project)).toThrow(ViewError);
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
    // After leaving a project the note names, the Authority returns only the saved proof (ADR-0023).
    expect(writeStatusView({ kind: 'echo-person-update-saved-v3', status: 'stored' }, 'note')).toEqual({ state: 'saved' });
    expect(writeStatusView({ ok: true, result: { state: 'saved' } }, 'document')).toEqual({ state: 'saved' });
    expect(writeStatusView({ kind: 'echo-person-update-status-v3', status: 'pending' }, 'note')).toEqual({ state: 'unknown' });
  });
});

describe('live matches', () => {
  const item = { context_id: 'ctx_1', received_at: '2026-09-21T22:01:00.000Z', title: 'Apollo update', excerpt: 'We agreed to ship.' };

  it('a project search counts only for the project searched', () => {
    const reply = { kind: 'echo-project-context-search-result-v2', project_id: 'prj_1', items: [{ ...item, audience: { kind: 'projects' } }] };
    expect(projectMatchesView(reply, 'prj_1')).toEqual({ items: [item] });
    expect(() => projectMatchesView(reply, 'prj_2')).toThrow(ViewError);
    expect(() => projectMatchesView({ ...reply, kind: 'echo-project-context-feed-v2' }, 'prj_1')).toThrow(ViewError);
  });

  it('saved notes of either version are the same matches, each opened by its ref', () => {
    expect(noteMatchesView({ kind: 'echo-person-upload-search-v3', results: [item] }, 3)).toEqual([item]);
    expect(noteMatchesView({ kind: 'echo-person-upload-search-v2', results: [item] }, 2)).toEqual([item]);
    expect(() => noteMatchesView({ kind: 'echo-person-upload-search-v2', results: [item] }, 3)).toThrow(ViewError);
  });
});

const NOTE = `ctx_${'a'.repeat(64)}`;
const DOC = `doc_${'e'.repeat(64)}`;
const RECORD = sha('7');
const APOLLO = 'prj_11111111-1111-4111-8111-111111111111';
const HIDDEN = 'prj_99999999-9999-4999-8999-999999999999';
const row = (ref: string, extra: Record<string, unknown> = {}) => ({
  ref, kind: ref.slice(0, ref.indexOf(':')), title: 'Pricing review', added_at: '2026-09-21T20:30:00.000Z', visibility: 'only_me',
  projects: [{ project_id: APOLLO, name: 'Apollo' }], ...extra,
});
const documentRow = (extra: Record<string, unknown> = {}) => row(`document:${DOC}`, {
  media_type: 'application/pdf', extraction_state: 'ready', size_bytes: 1_245_184, ...extra,
});

describe('a list shows rows, and nothing else crosses', () => {
  const page = (fields: Record<string, unknown>) => ({ ok: true, result: {
    schema_version: 1, kind: 'echo-person-list-v1', scope: { kind: 'mine' }, items: [], next_cursor: null, ...fields,
  } });

  it('copies each row, names your projects without their ids, and marks who can read it', () => {
    const view = listView(page({ items: [
      row(`meeting:${RECORD}`, { meeting_date: '2026-09-21' }), documentRow({ visibility: 'project', added_at: '2026-09-21T18:00:00.000Z' }),
      row(`note:${NOTE}`, { visibility: 'team', added_at: '2026-09-20T12:00:00.000Z', projects: [] }),
    ], next_cursor: 'AnR3' }), { kind: 'mine' });
    expect(view).toEqual({ next_cursor: 'AnR3', meetings_held: false, items: [
      { ref: { kind: 'meeting', id: RECORD }, title: 'Pricing review', added_at: '2026-09-21T20:30:00.000Z', visibility: 'only-me', projects: ['Apollo'],
        meeting_date: '2026-09-21' },
      { ref: { kind: 'document', id: DOC }, title: 'Pricing review', added_at: '2026-09-21T18:00:00.000Z', visibility: 'project', projects: ['Apollo'],
        document: { type: 'pdf', size: 1_245_184, extraction: 'ready' } },
      { ref: { kind: 'note', id: NOTE }, title: 'Pricing review', added_at: '2026-09-20T12:00:00.000Z', visibility: 'team', projects: [] },
    ] });
    // No project id, and nothing of a header, reaches the renderer.
    const header = listView({ ok: true, result: {
      schema_version: 1, kind: 'echo-person-list-v1', scope: { kind: 'project', project_id: APOLLO },
      project: { project_id: APOLLO, name: 'Apollo', role: 'lead', status: 'active' }, items: [row(`note:${NOTE}`)], next_cursor: null,
    } }, { kind: 'project', project_id: APOLLO });
    expect(JSON.stringify([view, header])).not.toContain('prj_');
    expect(header).toEqual({ items: [expect.objectContaining({ projects: ['Apollo'] })], next_cursor: null, meetings_held: false });
  });

  it('is only for the scope asked for, a project header only for that project, and at most a page of rows', () => {
    expect(() => listView(page({ scope: { kind: 'project', project_id: APOLLO } }), { kind: 'mine' })).toThrow(ViewError);
    expect(() => listView(page({ scope: { kind: 'global' } }), { kind: 'mine' })).toThrow(ViewError);
    expect(() => listView(page({ scope: { kind: 'project', project_id: HIDDEN } }), { kind: 'project', project_id: APOLLO })).toThrow(ViewError);
    expect(() => listView(page({ scope: { kind: 'project', project_id: APOLLO }, project: { project_id: HIDDEN, name: 'x', role: 'lead', status: 'active' } }),
      { kind: 'project', project_id: APOLLO })).toThrow(ViewError);
    const many = Array.from({ length: 26 }, (_, index) => row(`note:ctx_${index.toString(16).padStart(64, '0')}`));
    expect(() => listView(page({ items: many }), { kind: 'mine' })).toThrow(ViewError);
    expect(() => listView(page({ items: [row(`note:${NOTE}`, { kind: 'document' })] }), { kind: 'mine' })).toThrow(ViewError);
    expect(() => listView(page({ items: [row(`note:ctx_short`)] }), { kind: 'mine' })).toThrow(ViewError);
    expect(() => listView(page({ items: [row(`note:${NOTE}`, { visibility: 'projects' })] }), { kind: 'mine' })).toThrow(ViewError);
    expect(() => listView(page({}).result, { kind: 'mine' })).toThrow(ViewError);
  });

  it('holds meetings only on the closed notice, never on prose', () => {
    expect(listView(page({ notice: 'meetings_unavailable' }), { kind: 'mine' }).meetings_held).toBe(true);
    expect(listView(page({ notice: 'Meetings are still being indexed.' }), { kind: 'mine' }).meetings_held).toBe(false);
  });
});

describe('an item opened by its ref', () => {
  const opened = (ref: string, fields: Record<string, unknown>) => ({ ok: true, result: {
    schema_version: 1, kind: 'echo-person-open-v1', ref, next_cursor: null, ...fields,
  } });

  it('a note is the one asked for, with where it is filed, as a row marks it', () => {
    const reply = opened(`note:${NOTE}`, { item: row(`note:${NOTE}`), text: 'Body' });
    expect(openView(reply, { kind: 'note', id: NOTE }, true)).toEqual({ kind: 'note', content: {
      context_id: NOTE, title: 'Pricing review', text: 'Body', received_at: '2026-09-21T20:30:00.000Z', audience: 'only-me', project_ids: [APOLLO],
    } });
    expect(() => openView(reply, { kind: 'note', id: `ctx_${'b'.repeat(64)}` }, true)).toThrow(ViewError);
    expect(() => openView(reply.result, { kind: 'note', id: NOTE }, true)).toThrow(ViewError);
    expect(() => openView(opened(`note:${NOTE}`, { item: row(`note:${NOTE}`), text: 'Body', next_cursor: 'AQ' }), { kind: 'note', id: NOTE }, true))
      .toThrow(ViewError);
    expect(() => openView(opened(`note:${NOTE}`, { item: row(`note:ctx_${'b'.repeat(64)}`), text: 'Body' }), { kind: 'note', id: NOTE }, true))
      .toThrow(ViewError);
  });

  it('a document is a page of its text, and its file', () => {
    const reply = opened(`document:${DOC}`, { item: documentRow(), filename: 'Pricing memo.pdf', next_cursor: 'AQ',
      chunks: [{ anchor: { kind: 'page', start: 3 }, text: 'Hello' }] });
    expect(openView(reply, { kind: 'document', id: DOC }, true)).toEqual({ kind: 'document', document: {
      document: { document_id: DOC, title: 'Pricing review', filename: 'Pricing memo.pdf', received_at: '2026-09-21T20:30:00.000Z', type: 'pdf',
        size: 1_245_184, audience: 'only-me', extraction: 'ready', project_ids: [APOLLO] },
      chunks: [{ anchor: 'page', start: 3, text: 'Hello' }], next_cursor: 'AQ',
    } });
    expect(() => openView(opened(`document:${DOC}`, { item: documentRow(), filename: 'x', chunks: [{ anchor: { kind: 'line', start: 1 }, text: 'x' }] }),
      { kind: 'document', id: DOC }, true)).toThrow(ViewError);
  });

  const meeting = { started_at: '2026-09-21T19:00:00.000Z', timezone: 'America/Los_Angeles', all_day: false, participants: ['Ari', 'Maya Chen'],
    participants_more: false, approved_by: 'Ari' };
  const meetingPage = (atoms: unknown[], fields: Record<string, unknown> = {}) => opened(`meeting:${RECORD}`, {
    item: row(`meeting:${RECORD}`), meeting, atoms, transcript_ref: `transcript:${RECORD}`, ...fields,
  });
  const ref = { kind: 'meeting', id: RECORD } as const;

  it('a meeting\'s first page describes it; its transcript\'s ref and every id stay behind', () => {
    const view = openView(meetingPage([
      { kind: 'decision', text: 'Annual plans first.', status: 'decided' }, { kind: 'decision', text: 'Keep the pilot.', status: 'proposed' },
      { kind: 'action', text: 'Send the sheet.', owner: 'Maya Chen', due_at: 'Friday' }, { kind: 'rationale', text: 'It funds the launch.' },
    ]), ref, true);
    expect(view).toEqual({ kind: 'meeting', next_cursor: null, record: {
      title: 'Pricing review', added_at: '2026-09-21T20:30:00.000Z', started_at: '2026-09-21T19:00:00.000Z', timezone: 'America/Los_Angeles', all_day: false, approved_by: 'Ari',
      participants: ['Ari', 'Maya Chen'], participants_more: false, visibility: 'approver',
      decisions: { more: false, items: [{ text: 'Annual plans first.', excerpts: [] }, { text: 'Keep the pilot.', status: 'proposed', excerpts: [] }] },
      actions: { more: false, items: [{ text: 'Send the sheet.', owner: 'Maya Chen', excerpts: [] }] },
      rationales: { more: false, items: [{ text: 'It funds the launch.', excerpts: [] }] },
    } });
    expect(JSON.stringify(view)).not.toMatch(/transcript|sha256|prj_/);
    const team = openView(meetingPage([], { item: row(`meeting:${RECORD}`, { visibility: 'team' }) }), ref, true);
    expect(team.kind === 'meeting' && team.record.visibility).toBe('organization');
    const project = openView(meetingPage([], { item: row(`meeting:${RECORD}`, { visibility: 'project' }) }), ref, true);
    expect(project.kind === 'meeting' && project.record.visibility).toBe('project');
  });

  it('only the first page describes the meeting, and a page holds at most 25 parts', () => {
    const atom = { kind: 'decision', text: 'One.' };
    expect(() => openView(meetingPage([atom]), ref, false)).toThrow(ViewError);
    expect(() => openView(meetingPage([atom], { meeting: undefined }), ref, true)).toThrow(ViewError);
    expect(openView(meetingPage([atom], { meeting: undefined, transcript_ref: undefined }), ref, false).kind).toBe('meeting');
    expect(() => openView(meetingPage(Array.from({ length: 26 }, () => atom)), ref, true)).toThrow(ViewError);
    expect(() => openView(meetingPage([{ kind: 'excerpt', text: 'A quote.' }]), ref, true)).toThrow(ViewError);
    expect(() => openView(meetingPage([atom], { meeting: { ...meeting, participants: ['Ari', 'Ari'] } }), ref, true)).toThrow(ViewError);
    expect(() => openView(meetingPage([atom], { meeting: { ...meeting, participants: [{ display_name: 'Ari' }] } }), ref, true)).toThrow(ViewError);
  });

  it('three parts of one action, across two pages, join into one action item', () => {
    const [one, two, three] = ['First part, ', 'second part, ', 'and the third.'];
    const first = openView(meetingPage([
      { kind: 'decision', text: 'Annual plans first.' },
      { kind: 'action', text: one, owner: 'Maya Chen', part: { index: 1, count: 3 } },
      { kind: 'action', text: two, part: { index: 2, count: 3 } },
    ], { next_cursor: 'AQ' }), ref, true);
    const next = openView(meetingPage([
      { kind: 'action', text: three, part: { index: 3, count: 3 } }, { kind: 'rationale', text: 'It funds the launch.' },
    ], { meeting: undefined, transcript_ref: undefined }), ref, false);
    if (first.kind !== 'meeting' || next.kind !== 'meeting') throw new Error('not a meeting');
    expect(first.record.actions.items).toEqual([{ text: `${one}${two}`, owner: 'Maya Chen', excerpts: [], parts: { from: 1, to: 2, count: 3 } }]);
    expect(first.next_cursor).toBe('AQ');
    const joined = joinRecord(first.record, next.record) as ApprovedRecord;
    expect(joined.actions.items).toEqual([{ text: 'First part, second part, and the third.', owner: 'Maya Chen', excerpts: [] }]);
    expect(joined.decisions.items).toHaveLength(1);
    expect(joined.rationales.items).toEqual([{ text: 'It funds the launch.', excerpts: [] }]);
    expect(joined.approved_by).toBe('Ari');
    // Parts that do not follow on are never joined.
    const skipped = openView(meetingPage([{ kind: 'action', text: 'late', part: { index: 3, count: 4 } }], { meeting: undefined, transcript_ref: undefined }),
      ref, false);
    if (skipped.kind !== 'meeting') throw new Error('not a meeting');
    expect(joinRecord(first.record, skipped.record)).toBeNull();
    expect(joinRecord(first.record, first.record)).toBeNull();
  });

  it('a part goes on the part before it: never first on a first page, never after another item', () => {
    const later = { kind: 'action', text: 'rest', part: { index: 2, count: 2 } };
    expect(() => openView(meetingPage([later]), ref, true)).toThrow(ViewError);
    expect(() => openView(meetingPage([{ kind: 'decision', text: 'One.' }, later], { meeting: undefined, transcript_ref: undefined }), ref, false))
      .toThrow(ViewError);
    expect(() => openView(meetingPage([
      { kind: 'action', text: 'start', part: { index: 1, count: 2 } }, { kind: 'decision', text: 'Between.' },
    ]), ref, true)).toThrow(ViewError);
    expect(() => openView(meetingPage([{ kind: 'action', text: 'start', part: { index: 3, count: 2 } }]), ref, true)).toThrow(ViewError);
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

  it('shows an action owner only as the approver confirmed it in the signed approval', () => {
    const view = recordView(reply({
      actions: [item('action', 'a1', 'Send the quote.', { owner: 'Unconfirmed proposal' }), item('action', 'a2', 'Book the venue.')],
    }, record => {
      const body = (record.envelope as { body: Record<string, unknown> }).body;
      body.human_act_resolution_ref = { action_owners: [{ signal_id: 'a2', owner: 'Priya Shah' }, { signal_id: 'd9', owner: 'Nobody' }] };
    }), asked);
    expect(view.actions.items).toEqual([
      { text: 'Send the quote.', excerpts: [] },
      { text: 'Book the venue.', owner: 'Priya Shah', excerpts: [] },
    ]);
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
    const project = recordView(reply({}, record => {
      ((record.envelope as { body: { event: Record<string, unknown> } }).body.event).policy_id = 'project-members-readable-person-v1';
    }), { ...asked, policy_id: 'project-members-readable-person-v1' });
    expect(project.visibility).toBe('project');
  });

  it('takes an empty list as a record the person can no longer read, not as a bad reply', () => {
    const none = { ok: true, result: { schema_version: 1, kind: 'echo-clean-person-record-list-v1', records: [] } };
    expect(() => recordView(none, asked)).toThrow(NotReadable);
    expect(() => recordView(none, asked)).not.toThrow(ViewError);
  });
});

describe('documents, members and project changes', () => {
  const PROJECT = 'prj_11111111-1111-4111-8111-111111111111';
  const DOCUMENT = `doc_${'e'.repeat(64)}`;

  it('a saved original leaves its path behind', () => {
    expect(savedOriginalView({ ok: true, result: { document_id: DOCUMENT, output_path: '/Users/someone/Plan.pdf', content_length: 1, sha256: sha('1') } },
      DOCUMENT)).toBeNull();
    expect(() => savedOriginalView({ ok: true, result: { document_id: `doc_${'f'.repeat(64)}`, output_path: '/x' } }, DOCUMENT)).toThrow(ViewError);
  });

  it('members and the directory are only for the project asked for, and a project read only that project', () => {
    const members = { schema_version: 1, kind: 'echo-project-members-v1', project_id: PROJECT, next_cursor: null,
      items: [{ membership_id: 'mem_1', display_name: 'Ari', role: 'lead' }] };
    expect(membersView(members, PROJECT).items).toEqual([{ membership_id: 'mem_1', display_name: 'Ari', role: 'lead' }]);
    expect(() => membersView(members, 'prj_other')).toThrow(ViewError);
    expect(() => membersView(members, PROJECT, true)).toThrow(ViewError);
    const directory = { schema_version: 1, kind: 'echo-project-directory-v1', project_id: PROJECT, next_cursor: null,
      items: [{ membership_id: 'mem_2', display_name: 'Raj' }] };
    expect(membersView(directory, PROJECT, true).items).toEqual([{ membership_id: 'mem_2', display_name: 'Raj' }]);
    const summary = { schema_version: 2, kind: 'echo-project-summary-v2', project_id: PROJECT, name: 'Apollo', created_at: 'x', role: 'member', status: 'active' };
    expect(projectView(summary, PROJECT).role).toBe('member');
    expect(() => projectView(summary, 'prj_other')).toThrow(ViewError);
    expect(() => projectView({ ...summary, status: 'gone' }, PROJECT)).toThrow(ViewError);
  });

  it('the organization directory names no project, and only a name and a membership id cross', () => {
    const people = { schema_version: 1, kind: 'echo-organization-directory-v1', next_cursor: 'AQ',
      items: [{ membership_id: 'mem_2', display_name: 'Raj', email: 'raj@example.test', role: 'lead' }] };
    expect(directoryView(people)).toEqual({ items: [{ membership_id: 'mem_2', display_name: 'Raj' }], next_cursor: 'AQ' });
    expect(directoryView({ ...people, items: [], next_cursor: null })).toEqual({ items: [], next_cursor: null });
    const project = { schema_version: 1, kind: 'echo-project-directory-v1', project_id: PROJECT, next_cursor: null, items: [] };
    expect(() => directoryView(project)).toThrow(ViewError);
    expect(() => membersView(people, PROJECT, true)).toThrow(ViewError);
    expect(() => directoryView({ ...people, schema_version: 2 })).toThrow(ViewError);
    expect(() => directoryView({ ...people, items: [{ membership_id: 'mem_2' }] })).toThrow(ViewError);
  });

  it('a change is made only by the receipt for exactly that request and change', () => {
    const receipt = { schema_version: 1, kind: 'echo-project-mutation-receipt-v1', request_id: 'r1', project_id: PROJECT, operation: 'member_set',
      membership_id: 'mem_2', received_at: 'x', state: 'applied' };
    const add = { kind: 'member-add' as const, project_id: PROJECT, membership_id: 'mem_2' };
    expect(changeView(receipt, 'r1', add)).toBeNull();
    expect(() => changeView(receipt, 'r2', add)).toThrow(ViewError);
    expect(() => changeView(receipt, 'r1', { ...add, membership_id: 'mem_3' })).toThrow(ViewError);
    expect(() => changeView(receipt, 'r1', { ...add, kind: 'member-remove' })).toThrow(ViewError);
    const link = { ok: true, result: { schema_version: 1, kind: 'echo-person-document-association-receipt-v1', request_id: 'r1', project_id: PROJECT,
      document_id: DOCUMENT, operation: 'dissociate', received_at: 'x', state: 'applied' } };
    expect(changeView(link, 'r1', { kind: 'document-dissociate', project_id: PROJECT, document_id: DOCUMENT })).toBeNull();
    expect(() => changeView(link, 'r1', { kind: 'document-associate', project_id: PROJECT, document_id: DOCUMENT })).toThrow(ViewError);
  });

  it('a create is made only by the receipt for exactly that request', () => {
    const receipt = { schema_version: 1, kind: 'echo-project-create-receipt-v1', request_id: 'r1', project_id: PROJECT, created_at: 'x', state: 'created' };
    expect(createdView(receipt, 'r1')).toEqual({ project_id: PROJECT });
    expect(() => createdView(receipt, 'r2')).toThrow(ViewError);
    expect(() => createdView({ ...receipt, state: 'pending' }, 'r1')).toThrow(ViewError);
  });

  it('a project setting is made only by its matching V1 receipt', () => {
    const receipt = { schema_version: 1, kind: 'echo-project-settings-receipt-v1', request_id: 'r1', project_id: PROJECT,
      operation: 'archive', received_at: 'x', state: 'applied' };
    expect(projectSettingsView(receipt, 'r1', PROJECT, 'archive')).toEqual({ request_id: 'r1', project_id: PROJECT, operation: 'archive' });
    expect(() => projectSettingsView(receipt, 'r2', PROJECT, 'archive')).toThrow(ViewError);
    expect(() => projectSettingsView({ ...receipt, operation: 'leave' }, 'r1', PROJECT, 'archive')).toThrow(ViewError);
    expect(() => projectSettingsView({ ...receipt, state: 'pending' }, 'r1', PROJECT, 'archive')).toThrow(ViewError);
  });

  it('employees keep their name, email and standing; an invitation says only when it expires, and only for the file asked for', () => {
    const roster = { ok: true, result: { schema_version: 1, kind: 'echo-clean-person-employee-roster-v1', employees: [
      { email: 'ana@example.com', display_name: 'Ana', membership_status: 'active', invitation_state: 'redeemed' },
    ] } };
    expect(employeesView(roster)).toEqual({ items: [{ email: 'ana@example.com', display_name: 'Ana', membership: 'active', invitation: 'redeemed' }] });
    const odd = structuredClone(roster);
    odd.result.employees[0]!.invitation_state = 'sent';
    expect(() => employeesView(odd)).toThrow(ViewError);
    const saved = { ok: true, output_path: '/private/x/person-invitation.json', expires_at: '2026-09-28T22:01:00.000Z' };
    expect(invitationView(saved, '/private/x/person-invitation.json')).toEqual({ expires_at: '2026-09-28T22:01:00.000Z' });
    expect(JSON.stringify(invitationView(saved, '/private/x/person-invitation.json'))).not.toContain('/private');
    expect(() => invitationView(saved, '/private/y/person-invitation.json')).toThrow(ViewError);
    expect(revokedView({ ok: true, revoked: true })).toBeNull();
    expect(() => revokedView({ ok: true })).toThrow(ViewError);
  });

  it('an employee change the Authority refused was not made, and one it made is not unknown', () => {
    expect(failureView({ code: 'employee_already_exists', mutation_outcome: 'rejected' }, 'failed', true).mutation_outcome).toBe('not_submitted');
    const committed = failureView({ code: 'invitation_save_failed', mutation_outcome: 'committed' }, 'failed', true);
    expect(committed).toEqual({ code: 'invitation_save_failed', retryable: false });
    expect(failureView({ code: 'outcome_unknown', mutation_outcome: 'unknown' }, 'failed', true).mutation_outcome).toBe('unknown');
  });
});
