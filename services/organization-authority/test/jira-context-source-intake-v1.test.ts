import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createJiraCloudTransportV1 } from '../../../providers/jira/src/jira-cloud-transport-v1.js';
import type { ContextIntakeAuthorityV1, ContextIntakePolicyV1 } from '../src/application/context-intake-v1.js';
import { createJiraContextIntakeV1 } from '../src/composition/provider-context-intakes-v1.js';
import { retainedContextCapturesV1 } from './fixtures/context-capture-reader-v1.js';
import { OWNER, projectContextDatabase } from './fixtures/project-context-sqlite.js';

const databases: Database.Database[] = [];
const cloudid = '22222222-2222-4222-8222-222222222222';
const origin = 'https://context-fixture.atlassian.net';
const api = `/ex/jira/${cloudid}/rest/api/3`;
const sourceInstanceId = `jira-cloud:${cloudid}:project:ECHO`;
const binding = Object.freeze({
  organization_id: OWNER.organization_id,
  principal_id: 'person_jira_context',
  membership_id: 'membership_jira_context',
  tool_id: 'jira' as const,
  external_scope_id: cloudid,
  external_subject_id: 'jira-account-context',
  read_grant_sha256: `sha256:${'b'.repeat(64)}` as const,
});
const scope = Object.freeze({
  organization_id: OWNER.organization_id,
  custody_ref: `membership:${binding.membership_id}`,
  access_policy_ref: 'jira-context-capture',
  analysis_policy: 'on_request' as const,
});

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function response(value: unknown): Response {
  return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
}

function issue(updated = '2026-10-02T12:34:56.000+0000', summary = 'Keep context intake inactive') {
  return {
    id: '10001', key: 'ECHO-1', self: `${origin}/rest/api/3/issue/10001`,
    fields: {
      summary, project: { id: '10000', key: 'ECHO', self: `${origin}/rest/api/3/project/10000` },
      created: '2026-10-01T00:00:00.000+0000', updated, status: { name: 'Open' },
      assignee: { displayName: 'Ada', accountId: 'account-ada' }, duedate: '2026-10-08', labels: ['context'], priority: { name: 'High' },
      description: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Provider text must not be retained for Jira pointers.' }] }] },
    },
  };
}

function database(): Database.Database {
  const value = projectContextDatabase(); databases.push(value); return value;
}

function retainedPointerPolicy(): ContextIntakePolicyV1 {
  return { disposition: 'retained', scope, permitted_representations: ['pointer'] };
}

function fixture(options: {
  readonly compositionCurrent?: () => Promise<void>;
  readonly authority?: ContextIntakeAuthorityV1;
} = {}) {
  let currentIssue = issue(); const calls: URL[] = [];
  const fetch = vi.fn(async (url: string) => {
    const target = new URL(url); calls.push(target);
    if (target.pathname === '/oauth/token/accessible-resources') return response([{ id: cloudid, url: origin, scopes: ['read:jira-work', 'read:jira-user'] }]);
    if (target.pathname === `${api}/myself`) return response({ accountId: binding.external_subject_id, active: true, accountType: 'atlassian' });
    if (target.pathname === `${api}/project/ECHO`) return response(currentIssue.fields.project);
    if (target.pathname === `${api}/search/jql`) return response({ isLast: true, issues: [{ id: '10001' }] });
    if (target.pathname === `${api}/issue/10001`) return response(currentIssue);
    throw new Error(`unexpected Jira request ${target.pathname}`);
  });
  const compositionCurrent = vi.fn(async () => options.compositionCurrent?.());
  const authority = options.authority ?? { select: () => retainedPointerPolicy(), requireCurrent: () => undefined } satisfies ContextIntakeAuthorityV1;
  const transport = createJiraCloudTransportV1({ binding, fetch });
  const intake = (value?: Database.Database, representation: 'pointer' | 'excerpt' = 'pointer') => createJiraContextIntakeV1({
    transport, project: 'ECHO', representation,
    source_instance_id: sourceInstanceId, organization_id: OWNER.organization_id, authority,
    require_read_current: compositionCurrent, ...(value === undefined ? {} : { retention: { disposition: 'retained', database: value } }),
    now: () => new Date('2026-10-03T00:00:00.000Z'),
  });
  return { calls, fetch, compositionCurrent, intake, setIssue(value: ReturnType<typeof issue>) { currentIssue = value; } };
}

describe('Jira retained pointer context intake V1', () => {
  it('keeps an unspecified Jira retention binding request-only', async () => {
    const authority: ContextIntakeAuthorityV1 = {
      select: () => ({ disposition: 'request_only', scope, permitted_representations: ['pointer'] }),
      requireCurrent: () => undefined,
    };
    const f = fixture({ authority });

    await expect(f.intake().pull()).resolves.toMatchObject({ captures: [{ admission: 'request_only' }] });
  });

  it('refuses an Authority retained selection when Jira retention was omitted and persists no rows', async () => {
    const value = database();
    const f = fixture({ authority: { select: () => retainedPointerPolicy(), requireCurrent: () => undefined } });

    await expect(f.intake().pull()).rejects.toThrow('Context source retention or organization differs from its configured binding');
    expect(retainedContextCapturesV1(value, OWNER.organization_id)).toEqual([]);
  });

  it('retains only selected pointer metadata, deduplicates a replay, and persists a changed revision', async () => {
    const value = database(); const f = fixture(); const intake = f.intake(value);

    const first = await intake.pull();
    const firstCapture = first.captures[0]!.source;
    expect(first.captures).toMatchObject([{ admission: 'admitted', source: {
      item: { external_id: 'issue:10001' }, content: {
        representation: { kind: 'pointer', pointer: `${origin}/browse/ECHO-1` },
        payload: { key: 'ECHO-1', status: 'Open', labels: ['context'], assignee_ref: 'jira:account:account-ada' },
      },
    } }]);
    expect(firstCapture.content.representation).not.toHaveProperty('text');
    expect(firstCapture.content.representation).not.toHaveProperty('passages');
    expect(retainedContextCapturesV1(value, OWNER.organization_id)).toEqual([
      expect.objectContaining({ source: firstCapture, scope }),
    ]);

    const replay = await intake.pull();
    expect(replay.captures).toMatchObject([{ admission: 'duplicate', source: { revision: { revision_id: firstCapture.revision.revision_id } } }]);

    f.setIssue(issue('2026-10-02T13:34:56.000+0000', 'Retain selected metadata only'));
    const changed = await intake.pull();
    expect(changed.captures).toMatchObject([{ admission: 'admitted' }]);
    expect(changed.captures[0]!.source.revision.revision_id).not.toBe(firstCapture.revision.revision_id);
    expect(retainedContextCapturesV1(value, OWNER.organization_id)).toHaveLength(2);
    expect(f.calls.some(call => call.pathname === `${api}/issue/10001`)).toBe(true);
  });

  it('reselects the Authority custody policy inside the SQLite source-admission transaction', async () => {
    const value = database(); let selectedInTransaction = false;
    const authority: ContextIntakeAuthorityV1 = {
      select: () => {
        if (value.inTransaction) selectedInTransaction = true;
        return retainedPointerPolicy();
      },
      requireCurrent: () => { if (value.inTransaction) throw new Error('Jira retention revoked at admission'); },
    };
    const f = fixture({ authority });

    await expect(f.intake(value).pull()).rejects.toThrow('Jira retention revoked at admission');
    expect(selectedInTransaction).toBe(true);
    expect(retainedContextCapturesV1(value, OWNER.organization_id)).toEqual([]);
  });

  it('does not retain provider bytes when the person-bound Jira grant is revoked during the pull', async () => {
    let checks = 0;
    const f = fixture({ compositionCurrent: async () => { checks += 1; if (checks === 2) throw new Error('Jira read grant revoked'); } });
    const value = database();

    await expect(f.intake(value).pull()).rejects.toThrow('Jira read grant revoked');
    expect(f.calls.some(call => call.pathname === `${api}/issue/10001`)).toBe(true);
    expect(retainedContextCapturesV1(value, OWNER.organization_id)).toEqual([]);
  });

  it('rejects a wrong person-bound Jira read grant before provider I/O', async () => {
    const f = fixture({ compositionCurrent: async () => { throw new Error('wrong Jira read grant'); } });

    await expect(f.intake(database()).pull()).rejects.toThrow('wrong Jira read grant');
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it('refuses retained Jira excerpts at construction', () => {
    const f = fixture();
    expect(() => f.intake(database(), 'excerpt')).toThrow('Jira retained context requires pointer representation');
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it('refuses a Jira transport for another organization at construction', () => {
    const fetch = vi.fn();
    const foreignTransport = createJiraCloudTransportV1({ binding: { ...binding, organization_id: 'org_other' }, fetch });

    expect(() => createJiraContextIntakeV1({
      transport: foreignTransport, project: 'ECHO', representation: 'pointer',
      source_instance_id: sourceInstanceId, organization_id: OWNER.organization_id,
      authority: { select: () => retainedPointerPolicy(), requireCurrent: () => undefined }, require_read_current: () => undefined,
    })).toThrow('Jira context source differs from its configured organization');
    expect(fetch).not.toHaveBeenCalled();
  });
});
