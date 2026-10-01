import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { canonicalSha256 } from '@echo-brain/federation-protocol';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import { JiraConnectionStoreV1 } from '../src/jira-connection-store-v1.js';
import { createJiraPersonConnectionV1 } from '../src/jira-person-connection-v1.js';
import type { PersonLiveEvidenceReleaseV1 } from '@echo-brain/organization-authority-kernel/shared/person-live-evidence-v1';
import type { JiraNangoV1 } from '../src/jira-nango-v1.js';

const cloud = '00000000-0000-4000-8000-000000000007';
const site = 'https://echo-fixture.atlassian.net';
const person = { organization_id: 'org_00000000-0000-4000-8000-000000000001', principal_id: 'person-fixture', membership_id: 'mem_00000000-0000-4000-8000-000000000001' };
function fixture() {
  const database = new Database(':memory:'); const store = new JiraConnectionStoreV1(database);
  let active = true; let account = 'synthetic-account'; let resourceCloud = cloud; let resourceSite = site; let scopes = ['read:jira-work', 'read:jira-user'];
  let pendingTags: Readonly<Record<string, string>> = {}; let refresh = 0; let connectionIndex = 0; let denied = false; let hook: ((url: string, init: RequestInit) => Promise<void> | void) | undefined;
  const connections = new Map<string, { readonly tags: Readonly<Record<string, string>>; readonly updated_at?: string }>();
  const finishAuthorization = () => { const reference = `synthetic-nango-reference-${++connectionIndex}`; connections.set(reference, { tags: pendingTags }); return reference; };
  const nango: JiraNangoV1 = {
    connect: vi.fn(async (value) => { pendingTags = value; return { link: 'https://connect.nango.dev/synthetic-consent' }; }),
    connection: vi.fn(async reference => {
      const metadata = connections.get(reference);
      if (metadata === undefined) throw new AuthorityOperationError('unauthorized', 'Fixture connection is absent');
      return { tags: metadata.tags, access_token: `synthetic-access-${++refresh}`, updated_at: metadata.updated_at ?? new Date(Date.UTC(2026, 9, 1, 0, 0, refresh)).toISOString() };
    }),
    find: vi.fn(async tags => {
      const matches = [...connections].filter(([, metadata]) => Object.entries(tags).every(([key, value]) => metadata.tags[key] === value));
      if (matches.length > 1) throw new AuthorityOperationError('unauthorized', 'Fixture connections are ambiguous');
      return matches[0]?.[0];
    }),
    disconnect: vi.fn(async reference => { connections.delete(reference); }),
  };
  const transport = vi.fn(async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const parsed = new URL(String(url)); await hook?.(String(url), init!);
    let body: unknown;
    if (parsed.pathname === '/oauth/token/accessible-resources') body = [{ id: resourceCloud, url: resourceSite, scopes }];
    else if (parsed.pathname.endsWith('/myself')) body = { accountId: account, active: true, accountType: 'atlassian' };
    else if (parsed.pathname.endsWith('/search/jql')) body = { issues: [{ id: '10001' }], isLast: true };
    else if (parsed.pathname.endsWith('/issue/10001')) {
      if (denied) return new Response('', { status: 403 });
      body = { id: '10001', key: 'ECHO-1', self: `${site}/rest/api/3/issue/10001`, fields: { summary: 'Synthetic launch', project: { id: '10000', key: 'ECHO', self: `${site}/rest/api/3/project/10000` }, assignee: null, duedate: null, created: '2026-10-01T00:00:00.000+0000', status: { name: 'Open' }, description: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Synthetic Friday' }] }] } } };
    } else throw new Error('Unexpected fake Jira request');
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  });
  const authenticate = vi.fn((token: string) => {
    if (!active) throw new AuthorityOperationError('unauthorized', 'Fixture membership revoked');
    return { ...person, ...(token === 'synthetic-person-two' ? { principal_id: 'person-two', membership_id: 'mem_00000000-0000-4000-8000-000000000002' } : {}), authorization_sha256: canonicalSha256({ session: token }) };
  });
  const service = createJiraPersonConnectionV1({ store, nango, cloud_id: cloud, fetch: transport as typeof fetch, authenticate });
  const audit = { record: vi.fn(async (release: PersonLiveEvidenceReleaseV1) => canonicalSha256(release)) };
  const token = 'synthetic-echo-access';
  async function connected() { const begun = await service.connect({ access_token: token }); finishAuthorization(); await service.complete({ access_token: token, attempt: begun.attempt }); return begun; }
  return { database, store, service, nango, transport, authenticate, audit, token, connected, finishAuthorization,
    seedConnection: (reference: string, tags: Readonly<Record<string, string>>, updated_at?: string) => { connections.set(reference, { tags, updated_at }); },
    setActive: (value: boolean) => { active = value; }, setAccount: (value: string) => { account = value; }, setCloud: (value: string) => { resourceCloud = value; }, setSite: (value: string) => { resourceSite = value; }, setScopes: (value: string[]) => { scopes = value; }, setDenied: () => { denied = true; }, setHook: (value: typeof hook) => { hook = value; } };
}

describe('Nango-backed personal Jira connection', () => {
  it('binds consent to the authenticated tenure, verifies Jira, persists only compact custody and keeps refresh outside grant identity', async () => {
    const f = fixture(); try {
      await f.connected(); const before = f.store.current(person)!;
      const source = await f.service.source({ access_token: f.token, audit: f.audit });
      const result = await source!.search({ query: 'launch' }); await source!.revalidate({});
      expect(result.items[0]).toMatchObject({ kind: 'ticket', text: 'ECHO-1: Synthetic launch\n\nSynthetic Friday' });
      expect(f.store.current(person)).toEqual(before);
      expect(new JiraConnectionStoreV1(f.database).current(person)).toEqual(before);
      expect(f.transport.mock.calls.every(([, init]) => init!.redirect === 'error' && new Headers(init!.headers).get('authorization')?.startsWith('Bearer synthetic-access-'))).toBe(true);
      const stored = JSON.stringify(f.database.prepare('SELECT * FROM jira_person_binding_v1').all());
      for (const excluded of ['synthetic-access-', 'Synthetic Friday', 'Synthetic launch', 'refresh_token', 'connect.nango.dev']) expect(stored).not.toContain(excluded);
      expect(f.database.prepare('SELECT * FROM jira_person_attempt_v1').all()).toEqual([]);
      expect(f.audit.record).toHaveBeenCalledTimes(1);
    } finally { f.database.close(); }
  });

  it('refuses cross-person completion and another connection attempt before making Jira calls', async () => {
    const f = fixture(); try {
      const begun = await f.service.connect({ access_token: f.token });
      await expect(f.service.complete({ access_token: 'synthetic-person-two', attempt: begun.attempt, connection: 'stolen' })).rejects.toMatchObject({ code: 'unauthorized' });
      expect(f.nango.connection).not.toHaveBeenCalled();
      f.seedConnection('stolen', { organization_id: person.organization_id, end_user_id: 'person-two', echo_membership: person.membership_id, echo_attempt: begun.attempt });
      await expect(f.service.complete({ access_token: f.token, attempt: begun.attempt, connection: 'stolen' })).rejects.toMatchObject({ code: 'unauthorized' });
      expect(f.transport).not.toHaveBeenCalled();
    } finally { f.database.close(); }
  });

  it.each(['tenant', 'scope', 'account', 'site'])('refuses changed verified %s and never audits evidence', async mismatch => {
    const f = fixture(); try {
      await f.connected();
      if (mismatch === 'tenant') f.setCloud('00000000-0000-4000-8000-000000000008');
      if (mismatch === 'scope') f.setScopes(['read:jira-work']);
      if (mismatch === 'account') f.setAccount('another-account');
      if (mismatch === 'site') f.setSite('https://another-fixture.atlassian.net');
      await expect(f.service.source({ access_token: f.token, audit: f.audit })).rejects.toBeInstanceOf(AuthorityOperationError);
      expect(f.audit.record).not.toHaveBeenCalled();
    } finally { f.database.close(); }
  });

  it.each(['disconnect', 'membership', 'reconnect'])('discards an in-flight Jira read after %s', async revoke => {
    const f = fixture(); try {
      await f.connected(); const source = await f.service.source({ access_token: f.token, audit: f.audit });
      f.setHook(async url => {
        if (!url.endsWith('/search/jql')) return;
        f.setHook(undefined);
        if (revoke === 'membership') f.setActive(false);
        else if (revoke === 'disconnect') await f.service.disconnect({ access_token: f.token });
        else await f.service.connect({ access_token: f.token });
      });
      await expect(source!.search({ query: 'launch' })).rejects.toBeInstanceOf(AuthorityOperationError);
      expect(f.audit.record).not.toHaveBeenCalled();
    } finally { f.database.close(); }
  });

  it('requires fresh consent for reconnect, refuses an old refreshed connection and pins the verified account', async () => {
    const f = fixture(); try {
      await f.connected(); const old = f.store.current(person)!; const source = await f.service.source({ access_token: f.token, audit: f.audit });
      const again = await f.service.connect({ access_token: f.token });
      expect(f.nango.disconnect).toHaveBeenLastCalledWith(old.reference, undefined);
      expect(f.nango.connect).toHaveBeenLastCalledWith(expect.objectContaining({ echo_attempt: again.attempt }), undefined);
      expect(again.attempt).not.toBe(old.attempt);
      // Even stale remote metadata with a newer refresh timestamp cannot
      // prove that the user completed this fresh nonce-bound authorization.
      f.seedConnection(old.reference, { organization_id: person.organization_id, end_user_id: person.principal_id, echo_membership: person.membership_id, echo_attempt: old.attempt }, '2099-10-01T00:00:00.000Z');
      await expect(f.service.complete({ access_token: f.token, attempt: again.attempt, connection: old.reference })).rejects.toMatchObject({ code: 'unauthorized' });
      await expect(f.service.complete({ access_token: f.token, attempt: again.attempt })).rejects.toMatchObject({ code: 'unauthorized' });
      expect(f.store.current(person)).toMatchObject({ active: false, version: old.version });
      const fresh = f.finishAuthorization();
      f.setAccount('another-account');
      await expect(f.service.complete({ access_token: f.token, attempt: again.attempt, connection: fresh })).rejects.toMatchObject({ code: 'unauthorized' });
      expect(f.store.current(person)).toMatchObject({ active: false, version: old.version });
      f.setAccount(old.binding.external_subject_id);
      await f.service.complete({ access_token: f.token, attempt: again.attempt });
      expect(f.store.current(person)).toMatchObject({ active: true, reference: fresh, attempt: again.attempt });
      expect(f.store.current(person)!.binding.read_grant_sha256).not.toBe(old.binding.read_grant_sha256);
      await expect(source!.search({ query: 'launch' })).rejects.toMatchObject({ code: 'stale_access_state' });
    } finally { f.database.close(); }
  });

  it('connects afresh after disconnect deleted the remote reference, while retaining the verified account fence', async () => {
    const f = fixture(); try {
      await f.connected(); await f.service.disconnect({ access_token: f.token });
      const next = await f.service.connect({ access_token: f.token });
      expect(f.nango.connect).toHaveBeenLastCalledWith(expect.objectContaining({ echo_attempt: next.attempt }), undefined);
      const fresh = f.finishAuthorization();
      await f.service.complete({ access_token: f.token, attempt: next.attempt });
      expect(f.store.current(person)).toMatchObject({ active: true, reference: fresh });
    } finally { f.database.close(); }
  });

  it('revokes before remote cleanup and retries an inactive retained reference before fresh consent', async () => {
    const f = fixture(); try {
      await f.connected(); const old = f.store.current(person)!;
      vi.mocked(f.nango.disconnect).mockImplementationOnce(async reference => {
        expect(reference).toBe(old.reference);
        expect(f.store.current(person)).toMatchObject({ active: false });
        throw new Error('Synthetic cleanup unavailable');
      });
      await expect(f.service.connect({ access_token: f.token })).rejects.toThrow('cleanup unavailable');
      expect(f.nango.connect).toHaveBeenCalledTimes(1);
      const again = await f.service.connect({ access_token: f.token });
      expect(f.nango.disconnect).toHaveBeenNthCalledWith(2, old.reference, undefined);
      expect(f.nango.connect).toHaveBeenCalledTimes(2);
      f.finishAuthorization();
      await f.service.complete({ access_token: f.token, attempt: again.attempt });
      expect(f.store.current(person)).toMatchObject({ active: true });
    } finally { f.database.close(); }
  });

  it.each(['membership', 'cancellation'])('starts no fresh Connect after %s during remote cleanup', async change => {
    const f = fixture(); try {
      await f.connected(); const old = f.store.current(person)!; const controller = new AbortController();
      vi.mocked(f.nango.disconnect).mockImplementationOnce(async () => {
        if (change === 'membership') f.setActive(false);
        else controller.abort();
      });
      await expect(f.service.connect({ access_token: f.token, signal: controller.signal })).rejects.toThrow();
      expect(f.nango.disconnect).toHaveBeenLastCalledWith(old.reference, controller.signal);
      expect(f.nango.connect).toHaveBeenCalledTimes(1);
      expect(f.store.current(person)).toMatchObject({ active: false });
    } finally { f.database.close(); }
  });

  it('disconnect revokes locally even when Nango deletion fails', async () => {
    const f = fixture(); try {
      await f.connected(); vi.mocked(f.nango.disconnect).mockRejectedValueOnce(new Error('synthetic private deletion failure'));
      await expect(f.service.disconnect({ access_token: f.token })).rejects.toThrow();
      expect(await f.service.source({ access_token: f.token, audit: f.audit })).toBeUndefined();
    } finally { f.database.close(); }
  });

  it('keeps inventory/open/edited item identity stable while retaining every citation revision for visibility fences', async () => {
    const f = fixture(); try {
      await f.connected(); const source = await f.service.source({ access_token: f.token, audit: f.audit });
      const inventory = await source!.list({});
      const opened = await source!.open({ item: inventory.items[0]!.id });
      expect(opened.items[0]!.id).toBe(inventory.items[0]!.id);
      expect(opened.items[0]!.citation.text_sha256).not.toBe(inventory.items[0]!.citation.text_sha256);
      await source!.revalidate({});
      f.setDenied(); await expect(source!.revalidate({})).rejects.toMatchObject({ code: 'unauthorized' });
    } finally { f.database.close(); }
  });

  it('denied visibility and audit failure suppress release, including inventory and revocation during audit', async () => {
    const f = fixture(); try {
      await f.connected(); const source = await f.service.source({ access_token: f.token, audit: f.audit });
      const listed = await source!.list({}); expect(listed.items[0]).not.toHaveProperty('text');
      f.setDenied(); await expect(source!.revalidate({})).rejects.toMatchObject({ code: 'unauthorized' });
      const g = fixture(); try {
        await g.connected(); const other = await g.service.source({ access_token: g.token, audit: g.audit });
        g.audit.record.mockRejectedValueOnce(new Error('synthetic audit failure'));
        await expect(other!.search({ query: 'launch' })).rejects.toMatchObject({ code: 'unavailable' });
        g.audit.record.mockImplementationOnce(async release => { await g.service.disconnect({ access_token: g.token }); return canonicalSha256(release); });
        await expect(other!.search({ query: 'launch' })).rejects.toMatchObject({ code: 'stale_access_state' });
      } finally { g.database.close(); }
    } finally { f.database.close(); }
  });

  it('passes cancellation through credential retrieval and performs no subsequent Jira fetch or audit', async () => {
    const f = fixture(); try {
      await f.connected(); const source = await f.service.source({ access_token: f.token, audit: f.audit });
      const abort = new AbortController(); const calls = f.transport.mock.calls.length;
      vi.mocked(f.nango.connection).mockImplementationOnce(async (_ref, signal) => { expect(signal).toBeDefined(); abort.abort(); return { tags: {}, access_token: 'synthetic-unused' }; });
      await expect(source!.search({ query: 'launch', signal: abort.signal })).rejects.toThrow();
      expect(f.transport).toHaveBeenCalledTimes(calls); expect(f.audit.record).not.toHaveBeenCalled();
    } finally { f.database.close(); }
  });
});
