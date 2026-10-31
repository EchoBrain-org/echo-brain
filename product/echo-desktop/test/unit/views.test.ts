import { describe, expect, it } from 'vitest';
import {
  abandonView, answerView, askCheckView, askStepView, changeView, createdView, directoryView, employeesView, failureView, homeView, invitationView, isRecordRef, listView, membersView, noteMatchesView,
  noteTitle, openItemsView, openItemView, openView, revokedView, NotReadable, projectActivityView, projectMatchesView, projectSettingsView, projectView, receiptView, recordView,
  savedOriginalView, statusView, toolAttemptStatusView, toolAttemptView, toolsView, ViewError, writeStatusView,
} from '../../src/host/views.js';
import { createHash } from 'node:crypto';
import type { ApprovedRecord } from '../../src/shared/protocol.js';
import { checkOf } from '../../src/shared/protocol.js';
import { askText, searchQuery } from '../../src/shared/query.js';
import { layoutAnswer } from '../fixtures/authority.js';

/**
 * An approved item's id as the Authority derives it (organization-record's
 * atom identity): the digest of its record and signal, spelled out here so
 * the desktop job needs no Authority package. The root's Ask progress
 * round trip checks it against the Authority's own function.
 */
const atomOf = (record: string, signal: string) =>
  `sha256:${createHash('sha256').update(JSON.stringify({ kind: 'echo-organization-record-atom', record_hash: record, signal_id: signal })).digest('hex')}`;

// The store reads the preload's bridge when it loads; its record join needs none.
(globalThis as { window?: unknown }).window = { echo: {} };
const { joinRecord } = await import('../../src/renderer/store.js');

const sha = (digit: string) => `sha256:${digit.repeat(64)}`;
/** Ids and times in the API's own grammar. */
const MEMBERSHIP = (digit: string) => `mem_${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;
const REQUEST = (digit: string) => `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;
const AT = '2026-09-21T22:01:00.000Z';

/**
 * An answer's sources as the page reads them: without the citation each keeps
 * as the response carried it (`cited`), the opaque value a follow-up sends back
 * and whose evidence citation a check asks about (ADR-0047).
 */
const visible = (sources: readonly Record<string, unknown>[]) => sources.map(({ cited: _cited, ...rest }) => rest);

describe('view models copy only what the renderer may see', () => {
  it.each(['confluence', 'notion', 'knowledge-base'])('preserves %s page identity without provider coordinates', tool_id => {
    const permalink = 'https://wiki.example.test/pages/view?pageId=12345';
    const source = (tool: unknown) => ({ schema_version: 8, kind: 'echo-clean-person-answer-v8', scope: { kind: 'global' }, outcome: 'answered',
      citations: [{ kind: 'page', label: 'Launch plan', visibility: 'only_me', citation: { kind: 'page', tool_id: tool,
        external_scope_id: 'private-tenant', page_id: '12345', section_id: 'one', version: '7', permalink, text_sha256: sha('a') } }],
      parts: [{ question: 'When?', status: 'answered', statements: [{ text: 'Tuesday.', citation_indexes: [0], private: true }] }],
    });
    const answer = answerView({ ok: true, result: source(tool_id) }, { kind: 'global' });
    // Only you can read it: an answer's source says so (ADR-0045).
    expect(visible(answer.sources)).toEqual([{ kind: 'page', tool_id, label: 'Launch plan', permalink, private: true }]);
    // Its coordinates cross only inside what a check and a follow-up send back as they came.
    expect(JSON.stringify({ ...answer, sources: visible(answer.sources) })).not.toContain('private-tenant');
  });
  it('keeps a ticket citation by its tool and direct link alone', () => {
    const permalink = 'https://example.atlassian.net/browse/ECHO-7';
    const answer = answerView({ ok: true, result: { schema_version: 8, kind: 'echo-clean-person-answer-v8', scope: { kind: 'global' }, outcome: 'answered',
      citations: [{ kind: 'ticket', label: 'ECHO-7 · Jira launch', visibility: 'only_me', citation: {
        kind: 'ticket', tool_id: 'jira', external_scope_id: 'private-tenant', ticket_id: '10007', permalink, text_sha256: sha('a'),
      } }], parts: [{ question: 'Which ticket?', status: 'answered', statements: [{ text: 'ECHO-7 covers launch.', citation_indexes: [0], private: true }] }],
    } }, { kind: 'global' });
    expect(visible(answer.sources)).toEqual([{ kind: 'ticket', tool_id: 'jira', label: 'ECHO-7 · Jira launch', permalink, private: true }]);
    expect(JSON.stringify({ ...answer, sources: visible(answer.sources) })).not.toContain('private-tenant');
  });
  it('an open item turns its live citation into a source it can open, an item you cannot open stays without one, and who and when cross', () => {
    const permalink = 'https://example.atlassian.net/browse/ECHO-12';
    const citation = { kind: 'ticket', label: 'ECHO-12 · Pilot launch', visibility: 'only_me', citation: {
      kind: 'ticket', tool_id: 'jira', external_scope_id: 'private-tenant', ticket_id: '10012', permalink, text_sha256: sha('3') } } as const;
    const person = { membership_id: 'mem_00000000-0000-4000-8000-000000000001', name: 'Mina Patel', active: true };
    const decision = { approval_id: 'apr_1', record_sha256: sha('2'), title: 'Pilot planning', first_line: null, approved_at: '2026-10-07T10:00:00.000Z', project_ids: [] };
    const base = {
      item_id: 'itm_00000001', run_id: 'run_00000001', kind: 'ticket', relation: 'conflicts', expected: 'launch next week', approver: person,
      owner: { ...person, match: 'jira_account' }, waits_on: 'owner', state: 'open', created_at: '2026-10-07T10:05:00.000Z', sent_at: '2026-10-07T11:00:00.000Z',
      state_set_at: '2026-10-07T11:00:00.000Z', state_set_by: person, owner_set_at: '2026-10-07T12:00:00.000Z', owner_set_by: person, send_included: true,
      check: null, can: { set_state: true, assign: true }, reach: 'no_access',
    } as const;
    // A meeting's action is never read live: it crosses as ECHO's own words.
    const action = { ...base, item_id: 'itm_00000002', kind: 'action', relation: 'needs_updating', expected: 'Send the revised quote', decision, reach: 'not_read' } as const;
    expect(openItemView(action as unknown as Parameters<typeof openItemView>[0])).toStrictEqual(action);
    const opened = { ...base, decision, reach: 'opened', current: { citation, says_now: 'Planned for the end of the month.', due_at: '2026-10-30' } };
    const home = homeView({ send: [], items: [opened, base], landed: 0, waiting: 1, last_checked_at: null, sweep_due: true } as unknown as Parameters<typeof homeView>[0]);
    expect(home.items[0]).toEqual({ ...base, decision, reach: 'opened', current: { source: { kind: 'ticket', tool_id: 'jira', label: 'ECHO-12 · Pilot launch', permalink },
      says_now: 'Planned for the end of the month.', due_at: '2026-10-30' } });
    expect(home.items[1]).toStrictEqual(base);
    expect(home).toMatchObject({ send: [], landed: 0, waiting: 1, last_checked_at: null, sweep_due: true });
    expect(JSON.stringify(home)).not.toContain('private-tenant');
    const stage = { record_sha256: sha('2'), run_id: 'run_00000001', state: 'done', error_code: null, mine: true } as const;
    const page = openItemsView({ items: [opened], next_cursor: null, stages: [stage], summary: { unsent: 0, open: 1, done: 0, not_relevant: 0, landed: 0, changed: 0,
      unreadable: 0, decisions: 1, last_checked_at: null, by_decision: [{ record_sha256: sha('2'), unsent: 0, open: 1, landed: 0, unreadable: 0 }] } } as unknown as Parameters<typeof openItemsView>[0]);
    // Whether a decision's check is your own crosses with its stage.
    expect(page.stages).toEqual([stage]);
    expect(page.items[0]?.current?.source).toEqual({ kind: 'ticket', tool_id: 'jira', label: 'ECHO-12 · Pilot launch', permalink });
    expect(page.summary.by_decision).toEqual([{ record_sha256: sha('2'), unsent: 0, open: 1, landed: 0, unreadable: 0 }]);
    expect(openItemView(opened as unknown as Parameters<typeof openItemView>[0]).current?.source).toMatchObject({ kind: 'ticket' });
  });

  it('status keeps the account and nothing else', () => {
    const view = statusView({
      schema_version: 1, kind: 'echo-person-client-status-v1', installed_version: '1', signed_in: true,
      client_build: { source_sha: 'a'.repeat(40), source_kind: 'materialized-commit' },
      display_name: 'Ari', membership_id: 'mem_1', membership_type: 'employee', connected_authority: 'https://a.example',
      access_token: 'SECRET',
    }, 0);
    expect(view).toEqual({
      signed_in: true, client_version: '1',
      account: { authority: 'https://a.example', membership_id: 'mem_1', display_name: 'Ari', role: 'employee' },
    });
    expect(JSON.stringify(view)).not.toContain('SECRET');
  });

  it('status says when the weekly sign-in is due, and how long that is by the host\'s clock', () => {
    const status = (due: unknown) => statusView({
      schema_version: 1, kind: 'echo-person-client-status-v1', installed_version: '1', signed_in: true,
      display_name: 'Ari', membership_id: 'mem_1', membership_type: 'employee', connected_authority: 'https://a.example',
      hard_reauthentication_at: due,
    }, Date.parse('2026-09-21T22:00:00.000Z'));
    expect(status('2026-09-22T10:00:00.000Z').account?.sign_in_due).toEqual({ at: '2026-09-22T10:00:00.000Z', in_ms: 12 * 60 * 60_000 });
    // Already past: what is left is negative, never clamped.
    expect(status('2026-09-21T21:00:00.000Z').account?.sign_in_due?.in_ms).toBe(-60 * 60_000);
    // Missing or unreadable: no notice is better than a wrong one.
    expect(status(undefined).account).not.toHaveProperty('sign_in_due');
    expect(status('soon').account).not.toHaveProperty('sign_in_due');
  });

  it('signed out, status says why a refresh ended the session, and where to sign in again; anything else says nothing', () => {
    const status = (ended: unknown) => statusView({
      schema_version: 1, kind: 'echo-person-client-status-v1', installed_version: '1', signed_in: false,
      display_name: null, membership_type: null, connected_authority: null, session_ended: ended,
    }, 0);
    expect(status({ reason: 'reauthentication_required', connected_authority: 'https://a.example' }))
      .toEqual({ signed_in: false, account: null, client_version: '1', session_ended: { reason: 'reauthentication_required', authority: 'https://a.example' } });
    expect(status({ reason: 'sign_in_required', connected_authority: 'https://a.example' }).session_ended?.reason).toBe('sign_in_required');
    for (const ended of [null, undefined, [], { reason: 'account_changed', connected_authority: 'https://a.example' }, { reason: 'sign_in_required' }]) {
      expect(status(ended)).toEqual({ signed_in: false, account: null, client_version: '1' });
    }
  });

  it('tools keep each id, name and your connection, never external ids, and only for the account asked about', () => {
    const tool = (tool_id: string, availability: string, personal_status: string) => ({ tool_id, display_name: tool_id.toUpperCase(), availability,
      personal_status, external_scope_id: availability === 'enabled' ? 'T0SECRET' : null,
      external_subject_id: personal_status === 'linked' ? 'U0SECRET' : null, organization_setup: 'connected' });
    const tools = [tool('slack', 'enabled', 'linked'), tool('jira', 'enabled', 'revoked'), tool('granola', 'unavailable', 'unavailable')];
    const reply = (membership: string) => ({ ok: true, result: {
      schema_version: 4, kind: 'echo-organization-person-tools', organization_id: `org_${REQUEST('1')}`, membership_id: membership, tools,
    } });
    const view = toolsView(reply(MEMBERSHIP('1')), MEMBERSHIP('1'));
    expect(view).toEqual({ tools: [
      { tool_id: 'slack', name: 'SLACK', status: 'linked' },
      { tool_id: 'jira', name: 'JIRA', status: 'revoked' },
      { tool_id: 'granola', name: 'GRANOLA', status: 'unavailable' },
    ] });
    expect(JSON.stringify(view)).not.toContain('SECRET');
    expect(() => toolsView(reply(MEMBERSHIP('2')), MEMBERSHIP('1'))).toThrow(ViewError);
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

  it('keeps each cited approved record by digest and policy, and each original by its coordinates, in citation order', () => {
    const record = { kind: 'approved_record', atom_id: sha('1'), record_sha256: sha('2'), policy_id: 'project-members-readable-person-v1' };
    const original = { kind: 'source_revision', source_id: `source:${'3'.repeat(64)}`, revision_id: 'r1', source_sha256: sha('4'),
      representation_sha256: sha('5'), anchor_sha256: sha('6') };
    const answered = (citations: unknown[]) => ({ schema_version: 8, kind: 'echo-clean-person-answer-v8', scope: { kind: 'global' }, outcome: 'answered',
      citations, parts: [{ question: 'What did we ship?', status: 'answered', statements: [{ text: 'Ship it.', citation_indexes: [0], private: false }] }] });
    const answer = answerView({ ok: true, result: answered([
      { citation: record, kind: 'decision', label: 'Tuesday sync', visibility: 'team' },
      { citation: { ...original, label: 'Pricing call' }, kind: 'document_passage', label: 'Pricing call', visibility: 'team' },
    ]) }, { kind: 'global' });
    expect(visible(answer.sources)).toEqual([
      { kind: 'record', label: 'Tuesday sync', record: { record_sha256: sha('2'), policy_id: 'project-members-readable-person-v1' }, atom_id: sha('1') },
      { kind: 'original', label: 'Pricing call', ref: { source_id: `source:${'3'.repeat(64)}`, revision_id: 'r1', source_sha256: sha('4'),
        representation_sha256: sha('5'), anchor_sha256: sha('6') } },
    ]);
    // One part answers the question itself: its plain text does not repeat it.
    expect(answer.text).toBe('Ship it.');
  });

  it('maps Agentic Ask statements to their exact sources, including project records and fallback whitespace; the notice stays behind', () => {
    const citation = { kind: 'approved_record', atom_id: sha('1'), record_sha256: sha('2'), policy_id: 'project-members-readable-person-v1' };
    const answer = answerView({ ok: true, result: {
      schema_version: 8, kind: 'echo-clean-person-answer-v8', scope: { kind: 'global' }, outcome: 'partial',
      citations: [{ citation, kind: 'decision', label: 'Project review', visibility: 'project' }],
      direct: { text: 'A summary.', citation_indexes: [0], private: false },
      parts: [{ question: 'What changed?', status: 'records_only', statements: [], gap: 'No prose was available.',
        records: [{ text: 'Exact\n  fallback', citation_indexes: [0], private: false }] }],
      notice: 'Meeting records were unavailable.',
    } }, { kind: 'global' });
    expect(answer).toMatchObject({ outcome: 'partial',
      direct: { private: false, citation_indexes: [0] }, parts: [{ status: 'records_only', records: [{ text: 'Exact\n  fallback' }] }],
      sources: [{ kind: 'record', label: 'Project review', record: { policy_id: 'project-members-readable-person-v1' } }],
    });
    // The page no longer shows what research did not cover (ADR-0047): neither the notice nor a gap reaches it, nor its plain reading.
    expect(answer).not.toHaveProperty('notice');
    expect(answer.text).toBe('A summary.\nExact\n  fallback');
  });

  it('keeps a not-found outcome, whose plain reading leaves its gap out', () => {
    const project = { kind: 'project', project_id: 'prj_11111111-1111-4111-8111-111111111111' } as const;
    const empty = (outcome: string) => ({ schema_version: 8, kind: 'echo-clean-person-answer-v8', scope: project, outcome, citations: [],
      parts: [{ question: 'Who owns pricing?', status: 'not_found', statements: [], gap: 'Not found.' }] });
    expect(answerView({ ok: true, result: empty('not_found') }, project)).toEqual({
      text: '', scope: project, sources: [], outcome: 'not_found',
      parts: [{ question: 'Who owns pricing?', status: 'not_found', statements: [], gap: 'Not found.' }],
    });
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
  const item = { context_id: `ctx_${'1'.repeat(64)}`, received_at: AT, title: 'Apollo update', excerpt: 'We agreed to ship.' };

  it('a project search counts only for the project searched, and who can read a match stays behind', () => {
    const reply = { schema_version: 2, kind: 'echo-project-context-search-result-v2', project_id: APOLLO, next_cursor: null,
      items: [{ ...item, audience: { kind: 'projects', project_ids: [APOLLO] } }] };
    expect(projectMatchesView(reply, APOLLO)).toEqual({ items: [item] });
    expect(() => projectMatchesView(reply, 'prj_22222222-2222-4222-8222-222222222222')).toThrow(ViewError);
  });

  it('saved notes of either version are the same matches, each opened by its ref', () => {
    const results = [{ ...item, audience: { kind: 'team' } }];
    expect(noteMatchesView({ schema_version: 3, kind: 'echo-person-upload-search-v3', results }, 3)).toEqual([item]);
    expect(noteMatchesView({ schema_version: 2, kind: 'echo-person-upload-search-v2', results }, 2)).toEqual([item]);
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
  const page = (fields: Record<string, unknown> = {}) => ({ ok: true, result: {
    schema_version: 1, kind: 'echo-person-list-v1', scope: { kind: 'only_me' }, items: [], next_cursor: null, ...fields,
  } });

  it('copies each row, names your projects without their ids, and marks who can read it', () => {
    const view = listView(page({ items: [
      row(`meeting:${RECORD}`, { meeting_date: '2026-09-21' }), documentRow({ visibility: 'project', added_at: '2026-09-21T18:00:00.000Z' }),
      row(`note:${NOTE}`, { visibility: 'team', added_at: '2026-09-20T12:00:00.000Z', projects: [] }),
    ], next_cursor: 'AnR3' }), { kind: 'only-me' });
    expect(view).toEqual({ next_cursor: 'AnR3', meetings_held: false, items: [
      { ref: { kind: 'meeting', id: RECORD }, title: 'Pricing review', added_at: '2026-09-21T20:30:00.000Z', visibility: 'only-me', projects: ['Apollo'] },
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

  it('is only for the scope asked for', () => {
    expect(() => listView(page({ scope: { kind: 'project', project_id: APOLLO } }), { kind: 'only-me' })).toThrow(ViewError);
    expect(() => listView(page({ scope: { kind: 'global' } }), { kind: 'only-me' })).toThrow(ViewError);
    // What you added is not what only you can read.
    expect(() => listView(page({ scope: { kind: 'mine' } }), { kind: 'only-me' })).toThrow(ViewError);
    expect(() => listView(page({ scope: { kind: 'project', project_id: HIDDEN } }), { kind: 'project', project_id: APOLLO })).toThrow(ViewError);
    expect(() => listView(page().result, { kind: 'only-me' })).toThrow(ViewError);
  });

  it('holds meetings only on the closed notice', () => {
    expect(listView(page({ notice: 'meetings_unavailable' }), { kind: 'only-me' }).meetings_held).toBe(true);
    expect(listView(page(), { kind: 'only-me' }).meetings_held).toBe(false);
  });
});

describe('an item opened by its ref', () => {
  // As the client prints it: a field left undefined is not there.
  const opened = (ref: string, fields: Record<string, unknown>) => JSON.parse(JSON.stringify({ ok: true, result: {
    schema_version: 1, kind: 'echo-person-open-v1', ref, next_cursor: null, ...fields,
  } }));

  it('a note is the one asked for, with where it is filed, as a row marks it', () => {
    const reply = opened(`note:${NOTE}`, { item: row(`note:${NOTE}`), text: 'Body' });
    expect(openView(reply, { kind: 'note', id: NOTE }, true)).toEqual({ kind: 'note', content: {
      context_id: NOTE, title: 'Pricing review', text: 'Body', received_at: '2026-09-21T20:30:00.000Z', audience: 'only-me', project_ids: [APOLLO],
    } });
    expect(() => openView(reply, { kind: 'note', id: `ctx_${'b'.repeat(64)}` }, true)).toThrow(ViewError);
    expect(() => openView(reply.result, { kind: 'note', id: NOTE }, true)).toThrow(ViewError);
  });

  it('a document is a page of its text, and its file', () => {
    const reply = opened(`document:${DOC}`, { item: documentRow(), filename: 'Pricing memo.pdf', next_cursor: 'AQ',
      chunks: [{ anchor: { kind: 'page', start: 3 }, text: 'Hello' }] });
    expect(openView(reply, { kind: 'document', id: DOC }, true)).toEqual({ kind: 'document', document: {
      document: { document_id: DOC, title: 'Pricing review', filename: 'Pricing memo.pdf', received_at: '2026-09-21T20:30:00.000Z', type: 'pdf',
        size: 1_245_184, audience: 'only-me', extraction: 'ready', project_ids: [APOLLO] },
      chunks: [{ anchor: 'page', start: 3, text: 'Hello' }], next_cursor: 'AQ',
    } });
  });

  const meeting = { started_at: '2026-09-21T19:00:00.000Z', timezone: 'America/Los_Angeles', all_day: false, participants: ['Ari', 'Maya Chen'],
    participants_more: false, approved_by: 'Ari' };
  const meetingPage = (atoms: unknown[], fields: Record<string, unknown> = {}) => opened(`meeting:${RECORD}`, {
    item: row(`meeting:${RECORD}`), meeting, atoms, ...fields,
  });
  const ref = { kind: 'meeting', id: RECORD } as const;

  it('a meeting\'s first page describes it; every id stays behind', () => {
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
    expect(JSON.stringify(view)).not.toMatch(/sha256|prj_/);
    const team = openView(meetingPage([], { item: row(`meeting:${RECORD}`, { visibility: 'team' }) }), ref, true);
    expect(team.kind === 'meeting' && team.record.visibility).toBe('organization');
    const project = openView(meetingPage([], { item: row(`meeting:${RECORD}`, { visibility: 'project' }) }), ref, true);
    expect(project.kind === 'meeting' && project.record.visibility).toBe('project');
  });

  it('only the first page describes the meeting', () => {
    const atom = { kind: 'decision', text: 'One.' };
    const later = { meeting: undefined };
    expect(() => openView(meetingPage([atom]), ref, false)).toThrow(ViewError);
    expect(() => openView(meetingPage([atom], later), ref, true)).toThrow(ViewError);
    expect(openView(meetingPage([atom], later), ref, false).kind).toBe('meeting');
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
    ], { meeting: undefined }), ref, false);
    if (first.kind !== 'meeting' || next.kind !== 'meeting') throw new Error('not a meeting');
    expect(first.record.actions.items).toEqual([{ text: `${one}${two}`, owner: 'Maya Chen', excerpts: [], parts: { from: 1, to: 2, count: 3 } }]);
    expect(first.next_cursor).toBe('AQ');
    const joined = joinRecord(first.record, next.record) as ApprovedRecord;
    expect(joined.actions.items).toEqual([{ text: 'First part, second part, and the third.', owner: 'Maya Chen', excerpts: [] }]);
    expect(joined.decisions.items).toHaveLength(1);
    expect(joined.rationales.items).toEqual([{ text: 'It funds the launch.', excerpts: [] }]);
    expect(joined.approved_by).toBe('Ari');
    // Parts that do not follow on are never joined.
    const skipped = openView(meetingPage([{ kind: 'action', text: 'late', part: { index: 3, count: 4 } }], { meeting: undefined }),
      ref, false);
    if (skipped.kind !== 'meeting') throw new Error('not a meeting');
    expect(joinRecord(first.record, skipped.record)).toBeNull();
    expect(joinRecord(first.record, first.record)).toBeNull();
  });

  it('a part goes on the part before it: never first on a first page, never after another item', () => {
    const later = { kind: 'action', text: 'rest', part: { index: 2, count: 2 } };
    expect(() => openView(meetingPage([later]), ref, true)).toThrow(ViewError);
    expect(() => openView(meetingPage([{ kind: 'decision', text: 'One.' }, later], { meeting: undefined }), ref, false))
      .toThrow(ViewError);
    expect(() => openView(meetingPage([
      { kind: 'action', text: 'start', part: { index: 1, count: 2 } }, { kind: 'decision', text: 'Between.' },
    ]), ref, true)).toThrow(ViewError);
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

describe('a record the page may ask the host to read', () => {
  it('names a known record policy: Only me or projects, never the retired organization-wide (Team) policy', () => {
    for (const policy_id of ['restricted-reviewer-person-v2', 'project-members-readable-person-v1']) expect(isRecordRef({ record_sha256: sha('5'), policy_id })).toBe(true);
    expect(isRecordRef({ record_sha256: sha('5'), policy_id: 'organization-member-readable-person-v2' })).toBe(false);
  });
});

describe('an approved record shows only what the source pane needs', () => {
  const asked = { record_sha256: sha('5'), policy_id: 'project-members-readable-person-v1' } as const;
  const item = (kind: string, id: string, text: string, extra: Record<string, unknown> = {}) => ({ id, kind, text, ...extra });
  const reply = (brief: Record<string, unknown>, change: (record: Record<string, unknown>) => void = () => undefined) => {
    const record: Record<string, unknown> = {
      position: 1, approval_id: 'apr_1', record_sha256: sha('5'),
      envelope: { record_sha256: sha('5'), body: { event: {
        kind: 'approved', policy_id: 'project-members-readable-person-v1', approved_snapshot: { approved_payload: { brief: {
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
      participants: ['Maya Chen', 'Ari'], participants_more: false, visibility: 'project',
      decisions: { more: false, items: [{ text: 'Ship annual plans first.', status: 'proposed', excerpts: [
        { quote: 'Annual first.', at: '2026-09-15T17:12:00Z' }, { quote: 'Two' }, { quote: 'Three' },
      ], atom_id: atomOf(sha('5'), 'd1') }] },
      actions: { more: false, items: [{ text: 'Update pricing.', excerpts: [], atom_id: atomOf(sha('5'), 'a1') }] },
      rationales: { more: false, items: [{ text: 'It funds the launch.', excerpts: [], atom_id: atomOf(sha('5'), 'r1') }] },
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
      { text: 'Send the quote.', excerpts: [], atom_id: atomOf(sha('5'), 'a1') },
      { text: 'Book the venue.', owner: 'Priya Shah', excerpts: [], atom_id: atomOf(sha('5'), 'a2') },
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
  const OTHER = 'prj_22222222-2222-4222-8222-222222222222';
  const DOCUMENT = `doc_${'e'.repeat(64)}`;

  it('a saved original leaves its path behind', () => {
    expect(savedOriginalView({ ok: true, result: { document_id: DOCUMENT, output_path: '/Users/someone/Plan.pdf', content_length: 1, sha256: sha('1') } },
      DOCUMENT)).toBeNull();
    expect(() => savedOriginalView({ ok: true, result: { document_id: `doc_${'f'.repeat(64)}`, output_path: '/x' } }, DOCUMENT)).toThrow(ViewError);
  });

  it('members are only for the project asked for, and a project read only that project', () => {
    const members = { schema_version: 1, kind: 'echo-project-members-v1', project_id: PROJECT, next_cursor: null,
      items: [{ membership_id: MEMBERSHIP('1'), display_name: 'Ari', role: 'lead' }] };
    expect(membersView(members, PROJECT).items).toEqual([{ membership_id: MEMBERSHIP('1'), display_name: 'Ari', role: 'lead' }]);
    expect(() => membersView(members, OTHER)).toThrow(ViewError);
    const summary = { schema_version: 2, kind: 'echo-project-summary-v2', project_id: PROJECT, name: 'Apollo', created_at: AT, role: 'member', status: 'active' };
    expect(projectView(summary, PROJECT)).toEqual({ project_id: PROJECT, name: 'Apollo', created_at: AT, role: 'member', status: 'active' });
    expect(() => projectView(summary, OTHER)).toThrow(ViewError);
  });

  it('the organization directory is a name and a membership id for each person', () => {
    const people = { schema_version: 1, kind: 'echo-organization-directory-v1', next_cursor: 'AQ', items: [{ membership_id: MEMBERSHIP('2'), display_name: 'Raj' }] };
    expect(directoryView(people)).toEqual({ items: [{ membership_id: MEMBERSHIP('2'), display_name: 'Raj' }], next_cursor: 'AQ' });
    expect(directoryView({ ...people, items: [], next_cursor: null })).toEqual({ items: [], next_cursor: null });
  });

  it('a change is made only by the receipt for exactly that request and change', () => {
    const receipt = { schema_version: 1, kind: 'echo-project-mutation-receipt-v1', request_id: REQUEST('1'), project_id: PROJECT, operation: 'member_set',
      membership_id: MEMBERSHIP('2'), received_at: AT, state: 'applied' };
    const add = { kind: 'member-add' as const, project_id: PROJECT, membership_id: MEMBERSHIP('2') };
    expect(changeView(receipt, REQUEST('1'), add)).toBeNull();
    expect(() => changeView(receipt, REQUEST('2'), add)).toThrow(ViewError);
    expect(() => changeView(receipt, REQUEST('1'), { ...add, membership_id: MEMBERSHIP('3') })).toThrow(ViewError);
    expect(() => changeView(receipt, REQUEST('1'), { ...add, kind: 'member-remove' })).toThrow(ViewError);
    const link = { ok: true, result: { schema_version: 1, kind: 'echo-person-document-association-receipt-v1', request_id: REQUEST('1'), project_id: PROJECT,
      document_id: DOCUMENT, operation: 'dissociate', received_at: AT, state: 'applied' } };
    expect(changeView(link, REQUEST('1'), { kind: 'document-dissociate', project_id: PROJECT, document_id: DOCUMENT })).toBeNull();
    expect(() => changeView(link, REQUEST('1'), { kind: 'document-associate', project_id: PROJECT, document_id: DOCUMENT })).toThrow(ViewError);
  });

  it('a create is made only by the receipt for exactly that request', () => {
    const receipt = { schema_version: 1, kind: 'echo-project-create-receipt-v1', request_id: REQUEST('1'), project_id: PROJECT, created_at: AT, state: 'created' };
    expect(createdView(receipt, REQUEST('1'))).toEqual({ project_id: PROJECT });
    expect(() => createdView(receipt, REQUEST('2'))).toThrow(ViewError);
  });

  it('a project setting is made only by its matching V1 receipt', () => {
    const receipt = { schema_version: 1, kind: 'echo-project-settings-receipt-v1', request_id: REQUEST('1'), project_id: PROJECT,
      operation: 'archive', received_at: AT, state: 'applied' };
    expect(projectSettingsView(receipt, REQUEST('1'), PROJECT, 'archive')).toEqual({ request_id: REQUEST('1'), project_id: PROJECT, operation: 'archive' });
    expect(() => projectSettingsView(receipt, REQUEST('2'), PROJECT, 'archive')).toThrow(ViewError);
    expect(() => projectSettingsView({ ...receipt, operation: 'leave' }, REQUEST('1'), PROJECT, 'archive')).toThrow(ViewError);
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

// Citations as the Authority sends them, for the Ask tests below.
const record = { kind: 'approved_record', atom_id: sha('1'), record_sha256: sha('2'), policy_id: 'project-members-readable-person-v1' };
/** A passage of an original, its anchor told apart by `anchor`: an answer cites each passage once. */
const passage = (anchor = '6') => ({ kind: 'source_revision', source_id: `source:${'3'.repeat(64)}`, revision_id: 'r1', source_sha256: sha('4'),
  representation_sha256: sha('5'), anchor_sha256: sha(anchor) });
const coordinates = (anchor = '6') => ({ source_id: `source:${'3'.repeat(64)}`, revision_id: 'r1', source_sha256: sha('4'), representation_sha256: sha('5'),
  anchor_sha256: sha(anchor) });
const ticket = { kind: 'ticket', label: 'ECHO-7 · Jira launch', visibility: 'only_me', citation: { kind: 'ticket', tool_id: 'jira', external_scope_id: 'private-tenant',
  ticket_id: '10007', permalink: 'https://example.atlassian.net/browse/ECHO-7', text_sha256: sha('7') } };
const named = { citation: record, kind: 'decision', label: 'Tuesday sync', visibility: 'team', ref: `meeting:${sha('2')}` };
const namedSource = { kind: 'record', label: 'Tuesday sync', record: { record_sha256: sha('2'), policy_id: 'project-members-readable-person-v1' }, atom_id: sha('1') };
/** A V8 answer whose one statement cites its first source, private as that source is. */
const v8 = (citations: readonly Record<string, unknown>[]) => ({ schema_version: 8, kind: 'echo-clean-person-answer-v8', scope: { kind: 'global' }, outcome: 'answered', citations,
  parts: [{ question: 'What did we ship?', status: 'answered', statements: [{ text: 'Ship it.', citation_indexes: [0],
    private: ['only_me', 'approver_only'].includes(String(citations[0]?.visibility)) }] }] });

describe('an Ask citation opens the exact item it cites', () => {
  const sources = (citations: readonly Record<string, unknown>[]) => answerView({ ok: true, result: v8(citations) }, { kind: 'global' }).sources;

  it('keeps what each citation opens: its record item, and its note, document or imported meeting', () => {
    const note = `ctx_${'8'.repeat(64)}`;
    const imported = `cap_${'9'.repeat(64)}`;
    const document = `doc_${'a'.repeat(64)}`;
    expect(visible(sources([
      named,
      { citation: passage('a'), kind: 'note', label: 'Launch notes', visibility: 'only_me', ref: `note:${note}` },
      { citation: passage('b'), kind: 'imported_meeting', label: 'Kickoff', visibility: 'only_me', ref: `imported_meeting:${imported}` },
      { citation: { ...passage('c'), document_id: document }, kind: 'document_passage', label: 'Plan.md', visibility: 'team', ref: `document:${document}` },
      { citation: { ...passage('d'), document_id: document }, kind: 'document_passage', label: 'Plan.md', visibility: 'team' },
      { citation: passage('f'), kind: 'note', label: 'Older note', visibility: 'team' },
    ]))).toEqual([
      namedSource,
      { kind: 'original', label: 'Launch notes', ref: coordinates('a'), item: { kind: 'note', id: note }, private: true },
      { kind: 'original', label: 'Kickoff', ref: coordinates('b'), item: { kind: 'imported_meeting', id: imported }, private: true },
      { kind: 'original', label: 'Plan.md', ref: { ...coordinates('c'), document_id: document }, item: { kind: 'document', id: document } },
      { kind: 'original', label: 'Plan.md', ref: { ...coordinates('d'), document_id: document }, item: { kind: 'document', id: document } },
      { kind: 'original', label: 'Older note', ref: coordinates('f') },
    ]);
  });
});

describe('Ask progress lines and the receipt (ADR-0039)', () => {
  it('carries each step of a working Ask, and nothing else a line holds', () => {
    expect(askStepView({ ok: true, progress: { type: 'stage', stage: 'reading', pending: 3 } })).toEqual({ type: 'stage', stage: 'reading', pending: 3 });
    expect(askStepView({ ok: true, progress: { type: 'stage', stage: 'checking_access' } })).toEqual({ type: 'stage', stage: 'checking_access' });
    expect(askStepView({ ok: true, progress: { type: 'searched', sources: [{ kind: 'meetings' }, { kind: 'tickets', tool_id: 'jira' }], found: 22 } }))
      .toEqual({ type: 'searched', sources: [{ kind: 'meetings' }, { kind: 'tickets', tool_id: 'jira' }], found: 22 });
    const read = askStepView({ ok: true, progress: { type: 'read', items: [named, ticket] } });
    expect(read).toEqual({ type: 'read', items: [
      namedSource,
      { kind: 'ticket', tool_id: 'jira', label: 'ECHO-7 · Jira launch', permalink: 'https://example.atlassian.net/browse/ECHO-7' },
    ] });
    expect(JSON.stringify(read)).not.toContain('private-tenant');
  });
});

// A follow-up as an answer and Ask progress cite it (ADR-0040).
const followUp = { citation: { kind: 'follow_up', item_id: 'itm_launch-1' }, kind: 'follow_up', label: 'Ship the launch checklist', visibility: 'team', ref: 'follow_up:itm_launch-1' };
const followUpSource = { kind: 'follow_up', label: 'Ship the launch checklist', item_id: 'itm_launch-1' };

describe('follow-ups in an answer and its progress (ADR-0040)', () => {
  it('reads an answer whose source is a follow-up, by its item id alone, beside a decision and a ticket', () => {
    const answer = answerView({ ok: true, result: v8([followUp, named, ticket]) }, { kind: 'global' });
    expect(visible(answer.sources)).toEqual([followUpSource, namedSource,
      { kind: 'ticket', tool_id: 'jira', label: 'ECHO-7 · Jira launch', permalink: 'https://example.atlassian.net/browse/ECHO-7', private: true }]);
    expect(JSON.stringify({ ...answer, sources: visible(answer.sources) })).not.toContain('follow_up:');
  });

  it('carries a step that searched follow-ups or read one', () => {
    expect(askStepView({ ok: true, progress: { type: 'searched', sources: [{ kind: 'meetings' }, { kind: 'follow_ups' }], found: 9 } }))
      .toEqual({ type: 'searched', sources: [{ kind: 'meetings' }, { kind: 'follow_ups' }], found: 9 });
    expect(askStepView({ ok: true, progress: { type: 'read', items: [followUp, named] } })).toEqual({ type: 'read', items: [followUpSource, namedSource] });
  });
});

// Your workspace and your tools' containers as an answer and Ask progress cite them (research tool contract v1).
const PROJECT = 'prj_6b0f8a52-55a4-4f6e-9a39-6d3c8c3c2a10';
const MEMBER = 'mem_0f1e2d3c-4b5a-4968-8778-695a4b3c2d1e';
const project = { citation: { kind: 'project', project_id: PROJECT }, kind: 'project', label: 'Thermal recovery', visibility: 'project', ref: `project:${PROJECT}` };
const person = { citation: { kind: 'person', membership_id: MEMBER }, kind: 'person', label: 'Mara Lind', visibility: 'team' };
const tool = { citation: { kind: 'tool', tool_id: 'jira' }, kind: 'tool', label: 'Jira', visibility: 'only_me', ref: 'tool:jira' };
const containerCitation = { kind: 'tool_container', tool_id: 'jira', external_scope_id: 'cloud-1', container: 'jira_project', container_id: '10001',
  permalink: 'https://example.atlassian.net/browse/THERM' };
const container = { citation: containerCitation, kind: 'tool_container', label: 'Thermal', visibility: 'only_me', key: 'THERM' };
const workspaceSources = [
  { kind: 'project', label: 'Thermal recovery', project_id: PROJECT },
  { kind: 'person', label: 'Mara Lind', membership_id: MEMBER },
  { kind: 'tool', label: 'Jira', tool_id: 'jira' },
  { kind: 'container', tool_id: 'jira', label: 'Thermal', permalink: 'https://example.atlassian.net/browse/THERM', container: 'jira_project', key: 'THERM' },
];

describe('your workspace and your tools\' containers in an answer and its progress (research tool contract v1)', () => {
  it('reads an answer that cites your project, a person, a tool and a Jira project, by what each names, beside a follow-up, a decision and a ticket', () => {
    const answer = answerView({ ok: true, result: v8([project, person, tool, container, followUp, named, ticket]) }, { kind: 'global' });
    // The tool, the Jira project and the ticket only you can read.
    const [ours, mara, jira, therm] = workspaceSources;
    expect(visible(answer.sources)).toEqual([ours, mara, { ...jira, private: true }, { ...therm, private: true }, followUpSource, namedSource,
      { kind: 'ticket', tool_id: 'jira', label: 'ECHO-7 · Jira launch', permalink: 'https://example.atlassian.net/browse/ECHO-7', private: true }]);
    // A container's scope and its own id in its tool stay behind, as a ticket's do; refs stay with the host: all of them only inside
    // what a follow-up sends back as it came.
    for (const behind of ['cloud-1', '10001', 'project:', 'tool:', 'tool_container']) {
      expect(JSON.stringify({ ...answer, sources: visible(answer.sources) })).not.toContain(behind);
    }
  });

  it('keeps a container with no key, and a Confluence space, each by its link', () => {
    const { key: _key, ...unkeyed } = container;
    const space = { ...container, label: 'Thermal team', key: 'THT', citation: { ...containerCitation, tool_id: 'confluence', container: 'confluence_space',
      container_id: '98765', permalink: 'https://example.atlassian.net/wiki/spaces/THT' } };
    const [jira, confluence] = visible(answerView({ ok: true, result: v8([unkeyed, space]) }, { kind: 'global' }).sources);
    expect(jira).toEqual({ kind: 'container', tool_id: 'jira', label: 'Thermal', permalink: containerCitation.permalink, container: 'jira_project', private: true });
    expect(jira).not.toHaveProperty('key');
    expect(confluence).toEqual({ kind: 'container', tool_id: 'confluence', label: 'Thermal team', permalink: 'https://example.atlassian.net/wiki/spaces/THT',
      container: 'confluence_space', key: 'THT', private: true });
  });

  it('carries a step that searched your workspace or a tool\'s containers, or read one of them', () => {
    const sources = [{ kind: 'meetings' }, { kind: 'projects' }, { kind: 'people' }, { kind: 'tools' }, { kind: 'containers', tool_id: 'jira' }];
    expect(askStepView({ ok: true, progress: { type: 'searched', sources, found: 9 } })).toEqual({ type: 'searched', sources, found: 9 });
    expect(askStepView({ ok: true, progress: { type: 'read', items: [project, person, tool, container] } })).toEqual({ type: 'read', items: workspaceSources });
  });
});

describe('a streamed answer\'s receipt (ADR-0039, ADR-0040, ADR-0043)', () => {
  // A receipt, and the rows it names as they cross: what was searched, and the items read, of any kind an answer cites.
  const meetings = { looked_through: 14, elapsed_ms: 48_000, rows: [{ type: 'searched', sources: [{ kind: 'meetings' }], found: 6 }, { type: 'read', items: [named] }] };
  const followUps = { looked_through: 2, elapsed_ms: 31_000, rows: [{ type: 'searched', sources: [{ kind: 'follow_ups' }], found: 3 }, { type: 'read', items: [followUp, named] }] };
  const workspace = { looked_through: 4, elapsed_ms: 31_000, rows: [
    { type: 'searched', sources: [{ kind: 'projects' }, { kind: 'containers', tool_id: 'jira' }], found: 9 }, { type: 'read', items: [project, person, tool, container] },
  ] };
  const namedMeeting = [{ type: 'searched', sources: [{ kind: 'meetings' }], found: 6 }, { type: 'read', items: [namedSource] }];
  it.each([
    { read: 'a decision', answer: v8([named]), receipt: meetings, rows: namedMeeting },
    { read: 'a follow-up', answer: v8([followUp]), receipt: followUps, rows: [{ type: 'searched', sources: [{ kind: 'follow_ups' }], found: 3 }, { type: 'read', items: [followUpSource, namedSource] }] },
    { read: 'your workspace', answer: v8([project]), receipt: workspace, rows: [
      { type: 'searched', sources: [{ kind: 'projects' }, { kind: 'containers', tool_id: 'jira' }], found: 9 }, { type: 'read', items: workspaceSources },
    ] },
    // A receipt with no search is still one.
    { read: 'only what it read', answer: v8([named]), receipt: { looked_through: 1, elapsed_ms: 1_000, rows: [{ type: 'read', items: [named] }] }, rows: [{ type: 'read', items: [namedSource] }] },
  ])('keeps the receipt of an answer that read $read as it came', ({ answer, receipt, rows }) => {
    expect(answerView({ ok: true, result: answer, receipt }, { kind: 'global' }).receipt)
      .toEqual({ looked_through: receipt.looked_through, rows });
  });

  it('comes only with a streamed answer, and never with an answer from before V8, which no Ask asks now', () => {
    expect(answerView({ ok: true, result: v8([named]) }, { kind: 'global' }).receipt).toBeUndefined();
    expect(() => answerView({ ok: true, result: v8([named]), receipt: { ...meetings, looked_through: -1 } }, { kind: 'global' })).toThrow(ViewError);
    for (const version of [4, 5, 6, 7]) {
      const older = { ...v8([named]), schema_version: version, kind: `echo-clean-person-answer-v${version}` };
      expect(() => answerView({ ok: true, result: older }, { kind: 'global' })).toThrow(ViewError);
      expect(() => answerView({ ok: true, result: older, receipt: meetings }, { kind: 'global' })).toThrow(ViewError);
    }
  });

  it('reads a Mine answer as any other, with its receipt when it streamed', () => {
    const mine = { kind: 'mine' } as const;
    const answer = { ...v8([named]), scope: mine };
    expect(answerView({ ok: true, result: answer }, mine)).toMatchObject({ scope: mine, sources: [namedSource] });
    expect(answerView({ ok: true, result: answer, receipt: meetings }, mine).receipt).toEqual({ looked_through: 14, rows: namedMeeting });
  });
});

describe('a laid-out answer (answer layout v1, ADR-0045)', () => {
  const scope = { kind: 'global' } as const;
  const question = 'Can DVT-R2 run on the reduced test scope?';

  it('carries the fixture\'s layout as the client validated it; an answer to an Ask that did not ask for it has none, and reads the same', () => {
    const laid = answerView({ ok: true, result: layoutAnswer(question, scope, true) }, scope);
    const layout = laid.parts[0]!.layout!;
    expect(layout.map(block => block.kind)).toEqual(['lead', 'heading', 'bullets', 'heading', 'table']);
    expect(layout[4]).toMatchObject({ kind: 'table', statements: [5, 6, 7, 8], columns: ['Action', 'Owner', 'Due', 'Status'] });
    const plain = answerView({ ok: true, result: layoutAnswer(question, scope, false) }, scope);
    expect(plain.parts[0]).not.toHaveProperty('layout');
    expect(plain.parts[0]!.statements).toEqual(laid.parts[0]!.statements);
    // The plain reading, for Copy answer, stays the statements, in order, without what research did not cover.
    expect(laid.text).toBe(plain.text);
    expect(laid.text).not.toContain('THERM meetings in range');
  });

  it('marks a cited item only you or the approver can read as private, for the lock on a table row that cites it', () => {
    const laid = answerView({ ok: true, result: layoutAnswer(question, scope, true) }, scope);
    // Three team pages, then three tickets only you can read.
    expect(laid.sources.map(source => source.private ?? false)).toEqual([false, false, false, true, true, true]);
    const approver = answerView({ ok: true, result: v8([{ ...named, visibility: 'approver_only' }]) }, scope);
    expect(approver.sources[0]).toMatchObject({ kind: 'record', private: true });
    // A progress row's items and a receipt's never carry it: only an answer's sources do.
    expect(askStepView({ ok: true, progress: { type: 'read', items: [ticket] } })).toEqual({ type: 'read', items: [
      { kind: 'ticket', tool_id: 'jira', label: 'ECHO-7 · Jira launch', permalink: 'https://example.atlassian.net/browse/ECHO-7' }] });
  });

  it('refuses a layout that leaves a statement out, or a row that cites what its statements do not', () => {
    const answer = layoutAnswer(question, scope, true) as { parts: { layout: Record<string, unknown>[] }[] };
    const [part] = answer.parts;
    const dropped = { ...answer, parts: [{ ...part, layout: part!.layout.slice(0, 3) }] };
    expect(() => answerView({ ok: true, result: dropped }, scope)).toThrow(ViewError);
    const table = part!.layout[4] as { rows: { cells: string[]; citation_indexes: number[] }[] };
    const wrong = { ...answer, parts: [{ ...part, layout: [...part!.layout.slice(0, 4), { ...table, rows: [{ ...table.rows[0], citation_indexes: [0] }, ...table.rows.slice(1)] }] }] };
    expect(() => answerView({ ok: true, result: wrong }, scope)).toThrow(ViewError);
  });
});

describe('an answer on the Ask timeline, and the two reads beside it (ADR-0047)', () => {
  const scope = { kind: 'global' } as const;
  const page = { kind: 'page', label: 'DVT plan', visibility: 'team', citation: { kind: 'page', tool_id: 'confluence', external_scope_id: 'cloud-1', page_id: '31010',
    section_id: 'summary', version: '3', permalink: 'https://example.atlassian.net/wiki/pages/viewpage.action?pageId=31010', text_sha256: sha('9') } };
  const note = { citation: passage('a'), kind: 'note', label: 'Launch notes', visibility: 'team' };
  /** The last line `person ask --progress` printed: a V8 answer, with what an Ask that carried `previous` adds (`fields`). */
  const line = (fields: Record<string, unknown>) => ({ ok: true, result: { ...v8([ticket]), ...fields } });

  it('keeps every source\'s citation as the answer carried it, and the evidence citation of each that can change or go', () => {
    const cited = [named, ticket, followUp, page, note, project, person, tool, container];
    const answer = answerView({ ok: true, result: v8(cited) }, scope);
    answer.sources.forEach((source, at) => expect(source.cited).toEqual(cited[at]));
    // A record's item, a ticket, a follow-up, a page and an original's passage can change or go: what a check asks about, kept once.
    expect(answer.sources.map(checkOf)).toEqual([record, ticket.citation, followUp.citation, page.citation, passage('a'),
      undefined, undefined, undefined, undefined]);
    for (const source of answer.sources) expect(source).not.toHaveProperty('check');
    // A progress row's items keep neither: only an answer's sources are checked or carried back.
    expect(JSON.stringify(askStepView({ ok: true, progress: { type: 'read', items: cited } }))).not.toMatch(/"cited"|"check"/u);
  });

  it('reads the full question an answer answers, and Ask again\'s "since", whose citations are the answer\'s own', () => {
    const since = { statements: [{ text: 'ECHO-7 moved to In Progress.', citation_indexes: [0], private: true }] };
    const answer = answerView(line({ question: 'Who owns ECHO-7?', since }), scope);
    expect(answer).toMatchObject({ outcome: 'answered', question: 'Who owns ECHO-7?', since: since.statements, text: 'Ship it.' });
    // Nothing material changed: an empty list, which the page says as "Nothing changed since".
    expect(answerView(line({ question: 'Who owns ECHO-7?', since: { statements: [] } }), scope).since).toEqual([]);
    // A "since" sentence that cites what the answer does not is not the client's output.
    expect(() => answerView(line({ question: 'Who owns ECHO-7?', since: { statements: [{ text: 'Moved.', citation_indexes: [1], private: false }] } }), scope))
      .toThrow(ViewError);
    expect(() => answerView(line({ question: 7 }), scope)).toThrow(ViewError);
    // An answer to an Ask that carried nothing says none of it.
    const plain = answerView(line({}), scope);
    for (const key of ['question', 'since', 'choices']) expect(plain).not.toHaveProperty(key);
  });

  it('reads "Which one?": two to four choices, and no part; never the off_scope outcome that left the contract', () => {
    const choices = [{ label: 'THERM-482 · Sensor drift', question: 'Who owns THERM-482?' }, { label: 'THERM-490 · DVT retest', question: 'Who owns THERM-490?' }];
    // "Which one?" names the question asked, and says nothing else.
    const clarify = (fields: Record<string, unknown>) => line({ outcome: 'clarify', citations: [], parts: [], question: 'Who owns it?', choices, ...fields });
    expect(answerView(clarify({}), scope)).toEqual({ text: '', scope, sources: [], parts: [], outcome: 'clarify', question: 'Who owns it?', choices });
    expect(() => answerView(clarify({ choices: choices.slice(0, 1) }), scope)).toThrow(ViewError);
    expect(() => answerView(line({ outcome: 'clarify', citations: [], parts: [], question: 'Who owns it?' }), scope)).toThrow(ViewError);
    expect(() => answerView(clarify({ choices: [...choices, { label: 'More' }] }), scope)).toThrow(ViewError);
    // `off_scope` left the contract (C4; no current path produces it): an answer that says it is not one the page reads.
    expect(() => answerView(line({ outcome: 'off_scope' }), scope)).toThrow(ViewError);
  });

  it('reads a source check (C1): a state per item asked, in order, and a readable ticket\'s marker; anything else is not its output', () => {
    const check = (items: unknown[]) => ({ schema_version: 1, kind: 'echo-person-ask-check-v1', items });
    const marker = sha('c');
    expect(askCheckView(check([{ state: 'same', marker }, { state: 'changed' }, { state: 'unreadable' }, { state: 'unknown' }]), 4))
      .toEqual({ items: [{ state: 'same', marker }, { state: 'changed' }, { state: 'unreadable' }, { state: 'unknown' }] });
    expect(() => askCheckView(check([{ state: 'same' }]), 2)).toThrow(ViewError);
    expect(() => askCheckView(check([{ state: 'gone' }]), 1)).toThrow(ViewError);
    expect(() => askCheckView(check([{ state: 'same', marker: 'v2' }]), 1)).toThrow(ViewError);
    expect(() => askCheckView(check([{ state: 'same', why: 'deleted' }]), 1)).toThrow(ViewError);
    expect(() => askCheckView({ ...check([{ state: 'same' }]), text: 'x' }, 1)).toThrow(ViewError);
    expect(() => askCheckView({ ...check([{ state: 'same' }]), kind: 'echo-person-ask-check-v2' }, 1)).toThrow(ViewError);
  });

  it('reads project activity (C2): each project you are in once, with its newest arrival or none', () => {
    const activity = (items: unknown[]) => ({ schema_version: 1, kind: 'echo-person-project-activity-v1', items });
    const other = 'prj_22222222-2222-4222-8222-222222222222';
    expect(projectActivityView(activity([{ project_id: PROJECT, latest_at: AT }, { project_id: other, latest_at: null }])))
      .toEqual({ items: [{ project_id: PROJECT, latest_at: AT }, { project_id: other, latest_at: null }] });
    expect(() => projectActivityView(activity([{ project_id: PROJECT, latest_at: AT }, { project_id: PROJECT, latest_at: null }]))).toThrow(ViewError);
    expect(() => projectActivityView(activity([{ project_id: 'Apollo', latest_at: null }]))).toThrow(ViewError);
    expect(() => projectActivityView(activity([{ project_id: PROJECT, latest_at: 'yesterday' }]))).toThrow(ViewError);
    expect(() => projectActivityView(activity([{ project_id: PROJECT, latest_at: null, by: MEMBER }]))).toThrow(ViewError);
    expect(() => projectActivityView(activity(Array.from({ length: 501 }, (_, at) => ({ project_id: `prj_${String(at).padStart(8, '0')}-2222-4222-8222-222222222222`,
      latest_at: null }))))).toThrow(ViewError);
  });
});
