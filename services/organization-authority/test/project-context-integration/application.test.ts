import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canonicalSha256 } from '@echo-brain/federation-protocol';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import { createProjectContextApplicationV1 } from '../../src/application/project-context-application-v1.js';
import { authorization } from '../fixtures/project-context-sqlite.js';
import { SyntheticProjectHarness, PEOPLE, SCENARIO } from './synthetic-harness.js';

let h: SyntheticProjectHarness;
beforeEach(() => { h = new SyntheticProjectHarness(); });
afterEach(() => h.close());

function application() {
  const authenticate = vi.fn((person: string) => {
    if (!Object.hasOwn(PEOPLE, person)) throw new AuthorityOperationError('unauthorized', 'request failed');
    return authorization(PEOPLE[person as keyof typeof PEOPLE]);
  });
  return { app: createProjectContextApplicationV1({ repository: h.repository, authenticate }), authenticate };
}

describe('PC-06 committed PC-02 application + real V7 (fixture Person authentication)', () => {
  it('carries the two-project scenario through all sixteen application operations', () => {
    const { app } = application();
    const create = (name: string) => app.createProject('alice', { schema_version: 1, kind: 'echo-project-create-v1', request_id: h.requestId(), name }).project_id;
    const alpha = create('Synthetic Alpha');
    const beta = create('Synthetic Beta');
    const member = (project_id: string, membership_id: string) => app.setMember('alice', { schema_version: 1, kind: 'echo-project-member-set-v1', request_id: h.requestId(), project_id, membership_id, role: 'member' });
    member(alpha, PEOPLE.bob.membership_id);
    member(beta, PEOPLE.carol.membership_id);
    expect(app.listProjects('bob', {}).items.map(item => item.project_id)).toEqual([alpha]);
    expect(app.readProject('carol', beta)).toMatchObject({ project_id: beta, role: 'member' });
    expect(app.listMembers('bob', { project_id: alpha, limit: 10 }).items).toHaveLength(2);
    expect(app.searchDirectory('alice', { project_id: alpha, query: 'dana', limit: 10 }).items).toEqual([expect.objectContaining({ membership_id: PEOPLE.dana.membership_id })]);
    expect(() => app.searchDirectory('bob', { project_id: alpha, query: 'dana', limit: 10 })).toThrow(expect.objectContaining({ code: 'not_found' }));

    const privateNote = app.submitUpload('alice', h.draft(alpha, { kind: 'only_me' }, SCENARIO.originals.private));
    const team = app.submitUpload('alice', h.draft(alpha, { kind: 'team' }));
    const draft = h.draft(beta, { kind: 'project', project_id: alpha }, SCENARIO.originals.cross);
    const cross = app.submitUpload('alice', draft);
    expect(app.submitUpload('alice', draft)).toEqual(cross);
    expect(app.uploadStatus('alice', draft.request_id)).toMatchObject({ metadata: 'pending', audience: draft.audience, project_id: beta });
    expect(app.feed('bob', { project_id: alpha, limit: 10 }).items.map(item => item.context_id)).toEqual([team.context_id]);
    expect(app.search('bob', { project_id: alpha, query: 'meridian', limit: 10 }).items.map(item => item.context_id)).toEqual([team.context_id]);
    expect(app.readContext('bob', alpha, team.context_id).text).toBe(SCENARIO.originals.team.text);
    expect(app.readUpload('bob', cross.context_id)).toMatchObject({ text: draft.text, audience: draft.audience });
    expect(app.searchUploads('carol', { query: 'meridian', limit: 10 }).results.map(item => item.context_id)).toEqual([team.context_id]);
    for (const context of [privateNote.context_id, cross.context_id]) {
      expect(() => app.readUpload('carol', context)).toThrow(expect.objectContaining({ code: 'not_found' }));
    }

    app.dissociateContext('alice', { schema_version: 1, kind: 'echo-project-context-dissociate-v1', request_id: h.requestId(), project_id: beta, context_id: cross.context_id });
    app.associateContext('alice', { schema_version: 1, kind: 'echo-project-context-associate-v1', request_id: h.requestId(), project_id: alpha, context_id: cross.context_id });
    expect(app.readContext('bob', alpha, cross.context_id).text).toBe(draft.text);
    expect(app.uploadStatus('alice', draft.request_id).project_id).toBe(beta);
    app.removeMember('alice', { schema_version: 1, kind: 'echo-project-member-remove-v1', request_id: h.requestId(), project_id: alpha, membership_id: PEOPLE.bob.membership_id });
    expect(() => app.readUpload('bob', cross.context_id)).toThrow(expect.objectContaining({ code: 'not_found' }));
    expect(app.readUpload('bob', team.context_id).text).toBe(SCENARIO.originals.team.text);
  });

  it('rejects caller authorization facts before writes and reauthenticates immediately before release', () => {
    const s = h.seed();
    const { app, authenticate } = application();
    const draft = h.draft(s.alpha, { kind: 'project', project_id: s.alpha });
    expect(() => app.submitUpload('nobody', draft)).toThrow(expect.objectContaining({ code: 'unauthorized' }));
    expect(() => app.submitUpload('alice', { ...draft, membership_id: PEOPLE.carol.membership_id })).toThrow(expect.objectContaining({ code: 'invalid_request' }));
    expect(h.database.prepare('SELECT count(*) AS n FROM authority_person_updates_v2 WHERE request_id = ?').get(draft.request_id)).toEqual({ n: 0 });
    authenticate.mockClear();
    app.readContext('bob', s.alpha, s.project.context_id);
    expect(authenticate).toHaveBeenCalledTimes(2);
    expect(authenticate.mock.calls).toEqual([['bob'], ['bob']]);
    const audits = h.database.prepare('SELECT count(*) AS n FROM authority_project_read_audit_v1').get();
    authenticate.mockImplementationOnce(() => authorization(PEOPLE.bob))
      .mockImplementationOnce(() => authorization(PEOPLE.bob, { session_state_sha256: canonicalSha256('revoked synthetic session') }));
    const released: unknown[] = [];
    expect(() => released.push(app.readContext('bob', s.alpha, s.project.context_id))).toThrow(expect.objectContaining({ code: 'stale_access_state' }));
    expect(released).toEqual([]);
    expect(h.database.prepare('SELECT count(*) AS n FROM authority_project_read_audit_v1').get()).toEqual(audits);
  });

  it('reconciles an application receipt after simulated lost delivery and repository restart', () => {
    const s = h.seed();
    const { app } = application();
    const draft = h.draft(s.beta, { kind: 'project', project_id: s.alpha });
    const committed = app.submitUpload('alice', draft);
    // No receipt is handed to a client; application has already committed.
    h.restart();
    const restarted = application().app;
    expect(restarted.uploadStatus('alice', draft.request_id)).toMatchObject({ context_id: committed.context_id, audience: draft.audience, project_id: s.beta });
    expect(restarted.submitUpload('alice', draft)).toEqual(committed);
    expect(() => restarted.submitUpload('alice', { ...draft, audience: { kind: 'team' } })).toThrow(expect.objectContaining({ code: 'conflict' }));
    expect(restarted.readUpload('bob', committed.context_id).text).toBe(draft.text);
    expect(() => restarted.readContext('carol', s.beta, committed.context_id)).toThrow(expect.objectContaining({ code: 'not_found' }));
  });
});
