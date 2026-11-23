import Database from 'better-sqlite3';
import { canonicalSha256 } from '@echo-brain/federation-protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GRANOLA_PERSON_PROVIDER_V1 } from '../../granola/src/granola-mcp-v1.js';
import { createPersonConnectionLifecycleV1 } from '../src/person-connection-lifecycle-v1.js';
import { PersonConnectionStoreV1 } from '../src/person-connection-store-v1.js';
import type { NangoPersonConnectionV1 } from '../src/nango-person-connection-v1.js';

const person = Object.freeze({ organization_id: 'org-fixture', principal_id: 'person-fixture', membership_id: 'membership-fixture' });
const workspace = '00000000-0000-4000-8000-000000000007';
const account = 'fixture@example.test';
const origin = 'https://mcp.granola.ai';
const reference = 'connection-fixture';
const request = 'https://mcp.granola.ai/mcp';

function abortError() { return new DOMException('The operation was aborted', 'AbortError'); }

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(resolvePromise => { resolve = resolvePromise; });
  return { promise, resolve };
}

const databases: Database.Database[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  vi.useRealTimers();
});

function useClock() {
  vi.useFakeTimers({ toFake: ['Date', 'performance'] });
  vi.setSystemTime(new Date('2026-10-08T00:00:00.000Z'));
}

function fixture(input: { readonly connection?: ReturnType<typeof vi.fn>; readonly fetch?: ReturnType<typeof vi.fn> } = {}) {
  const database = new Database(':memory:');
  databases.push(database);
  const store = new PersonConnectionStoreV1(database, GRANOLA_PERSON_PROVIDER_V1);
  const attempt = store.begin(person);
  const stored = store.complete(person, attempt.attempt, reference, workspace, account, origin);
  const tags = Object.freeze({ organization_id: person.organization_id, end_user_id: person.principal_id, echo_membership: person.membership_id, echo_attempt: attempt.attempt });
  const connection = input.connection ?? vi.fn(async () => ({ tags, access_token: 'synthetic-access-token' }));
  const providerFetch = input.fetch ?? vi.fn(async () => new Response('{}', { headers: { 'content-type': 'application/json' } }));
  const lifecycle = createPersonConnectionLifecycleV1({
    provider: GRANOLA_PERSON_PROVIDER_V1,
    store,
    nango: { connection, connect: vi.fn(), find: vi.fn(), disconnect: vi.fn() } as unknown as NangoPersonConnectionV1,
    fetch: providerFetch as unknown as typeof fetch,
    authenticate: () => ({ ...person, authorization_sha256: canonicalSha256(person) }),
    verify: vi.fn(),
  });
  const session = lifecycle.open(person, () => {});
  return {
    store, stored, lifecycle, session, connection, providerFetch,
    credential: (access_token: string, expires_at?: string) => ({ tags: { ...tags }, access_token, ...(expires_at === undefined ? {} : { expires_at }) }),
    bearers: () => providerFetch.mock.calls.map(([, init]) => new Headers((init as RequestInit).headers).get('authorization')),
  };
}

function transportInit(signal?: AbortSignal): RequestInit {
  return { redirect: 'error', ...(signal === undefined ? {} : { signal }) };
}

describe('person connection lifecycle request credential reuse', () => {
  it('reads a connection once for sequential and concurrent calls through one opened transport', async () => {
    const subject = fixture();
    await subject.session.transport.fetch(request, transportInit());
    await Promise.all([
      subject.session.transport.fetch(request, transportInit()),
      subject.session.transport.fetch(request, transportInit()),
      subject.session.transport.fetch(request, transportInit()),
    ]);

    expect(subject.connection).toHaveBeenCalledTimes(1);
    expect(subject.connection.mock.calls[0]![0]).toBe(reference);
    expect(subject.connection.mock.calls[0]![1]).toBeInstanceOf(AbortSignal);
    expect(subject.bearers()).toEqual(Array(4).fill('Bearer synthetic-access-token'));
  });

  it('keeps credentials scoped to an opened transport instead of reusing them across requests', async () => {
    const subject = fixture();
    const second = subject.lifecycle.open(person, () => {});
    await subject.session.transport.fetch(request, transportInit());
    await second.transport.fetch(request, transportInit());

    expect(subject.connection).toHaveBeenCalledTimes(2);
    for (const call of subject.connection.mock.calls) {
      expect(call[0]).toBe(reference);
      expect(call[1]).toBeInstanceOf(AbortSignal);
    }
  });

  it('shares a fresh near-expiry credential with its original concurrent waiters before renewing later', async () => {
    type Connection = Awaited<ReturnType<NangoPersonConnectionV1['connection']>>;
    useClock();
    const initial = deferred<Connection>();
    const connection = vi.fn((_reference: string, _signal?: AbortSignal): Promise<Connection> => initial.promise);
    const subject = fixture({ connection });
    const first = subject.session.transport.fetch(request, transportInit());
    const second = subject.session.transport.fetch(request, transportInit());
    initial.resolve(subject.credential('synthetic-near-expiry-token', '2026-10-08T00:00:30.000Z'));

    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    connection.mockResolvedValueOnce(subject.credential('synthetic-renewed-token', '2026-10-08T01:00:00.000Z'));
    await expect(subject.session.transport.fetch(request, transportInit())).resolves.toBeInstanceOf(Response);

    expect(connection).toHaveBeenCalledTimes(2);
    expect(subject.bearers()).toEqual(['Bearer synthetic-near-expiry-token', 'Bearer synthetic-near-expiry-token', 'Bearer synthetic-renewed-token']);
  });

  it('hands off a cached lease that ages while its resolved promise is awaited before provider I/O', async () => {
    useClock();
    const subject = fixture();
    subject.connection
      .mockResolvedValueOnce(subject.credential('synthetic-old-token'))
      .mockResolvedValueOnce(subject.credential('synthetic-renewed-token'));
    await expect(subject.session.transport.fetch(request, transportInit())).resolves.toBeInstanceOf(Response);

    const agingRead = subject.session.transport.fetch(request, transportInit());
    await Promise.resolve();
    vi.advanceTimersByTime(5 * 60_000);
    await expect(agingRead).resolves.toBeInstanceOf(Response);

    expect(subject.connection).toHaveBeenCalledTimes(2);
    expect(subject.bearers()).toEqual(['Bearer synthetic-old-token', 'Bearer synthetic-renewed-token']);
  });

  it('does not let a wall-clock rollback extend reuse of a known-expiry credential', async () => {
    useClock();
    const subject = fixture();
    subject.connection
      .mockResolvedValueOnce(subject.credential('synthetic-first-token', '2026-10-08T00:02:00.000Z'))
      .mockResolvedValueOnce(subject.credential('synthetic-renewed-token', '2026-10-08T01:00:00.000Z'));

    await expect(subject.session.transport.fetch(request, transportInit())).resolves.toBeInstanceOf(Response);
    await vi.advanceTimersByTimeAsync(61_000);
    vi.setSystemTime(new Date('2026-10-07T23:00:00.000Z'));
    await expect(subject.session.transport.fetch(request, transportInit())).resolves.toBeInstanceOf(Response);

    expect(subject.connection).toHaveBeenCalledTimes(2);
    expect(subject.bearers()).toEqual(['Bearer synthetic-first-token', 'Bearer synthetic-renewed-token']);
  });

  it('shares one concurrent renewal after the cache-age cap', async () => {
    type Connection = Awaited<ReturnType<NangoPersonConnectionV1['connection']>>;
    useClock();
    const renewal = deferred<Connection>();
    const subject = fixture();
    subject.connection
      .mockResolvedValueOnce(subject.credential('synthetic-first-token'))
      .mockImplementationOnce(() => renewal.promise);
    await expect(subject.session.transport.fetch(request, transportInit())).resolves.toBeInstanceOf(Response);
    await vi.advanceTimersByTimeAsync(5 * 60_000);

    const first = subject.session.transport.fetch(request, transportInit());
    const second = subject.session.transport.fetch(request, transportInit());
    renewal.resolve(subject.credential('synthetic-renewed-token'));

    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(subject.connection).toHaveBeenCalledTimes(2);
    expect(subject.bearers()).toEqual(['Bearer synthetic-first-token', 'Bearer synthetic-renewed-token', 'Bearer synthetic-renewed-token']);
  });

  it('refuses an already-expired newly fetched credential before provider I/O', async () => {
    useClock();
    const subject = fixture();
    subject.connection.mockResolvedValueOnce(subject.credential('synthetic-expired-token', '2026-10-07T23:59:59.999Z'));

    await expect(subject.session.transport.fetch(request, transportInit())).rejects.toMatchObject({ code: 'unavailable' });
    expect(subject.connection).toHaveBeenCalledTimes(1);
    expect(subject.providerFetch).not.toHaveBeenCalled();
  });

  it('does not let an old delayed 401 evict a credential renewed by the cache-age cap', async () => {
    const firstProviderResponse = deferred<Response>();
    const firstProviderRead = deferred<void>();
    let providerReads = 0;
    const providerFetch = vi.fn(async () => {
      providerReads += 1;
      if (providerReads === 1) {
        firstProviderRead.resolve();
        return firstProviderResponse.promise;
      }
      return new Response('{}');
    });
    useClock();
    const subject = fixture({ fetch: providerFetch });
    subject.connection
      .mockResolvedValueOnce(subject.credential('synthetic-old-token'))
      .mockResolvedValueOnce(subject.credential('synthetic-renewed-token'));

    const slowOldRead = subject.session.transport.fetch(request, transportInit());
    await firstProviderRead.promise;
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await expect(subject.session.transport.fetch(request, transportInit())).resolves.toBeInstanceOf(Response);
    firstProviderResponse.resolve(new Response('{}', { status: 401 }));
    await expect(slowOldRead).resolves.toMatchObject({ status: 401 });
    await expect(subject.session.transport.fetch(request, transportInit())).resolves.toBeInstanceOf(Response);

    expect(subject.connection).toHaveBeenCalledTimes(2);
    expect(subject.bearers()).toEqual(['Bearer synthetic-old-token', 'Bearer synthetic-renewed-token', 'Bearer synthetic-renewed-token']);
  });

  it('lets an aborted caller leave a shared in-flight credential read usable by another caller', async () => {
    const lookup = deferred<{ readonly tags: Readonly<Record<string, string>>; readonly access_token: string }>();
    const connection = vi.fn(() => lookup.promise);
    const subject = fixture({ connection });
    const aborting = new AbortController();
    const cancelled = subject.session.transport.fetch(request, transportInit(aborting.signal));
    const active = subject.session.transport.fetch(request, transportInit());
    aborting.abort();
    lookup.resolve(subject.credential('synthetic-access-token'));

    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
    await expect(active).resolves.toBeInstanceOf(Response);
    expect(connection).toHaveBeenCalledTimes(1);
    expect(subject.providerFetch).toHaveBeenCalledTimes(1);
  });

  it('does not retain a failed credential lookup as a usable credential', async () => {
    const subject = fixture();
    subject.connection.mockRejectedValueOnce(new Error('synthetic Nango outage'));

    await expect(subject.session.transport.fetch(request, transportInit())).rejects.toThrow('synthetic Nango outage');
    await expect(subject.session.transport.fetch(request, transportInit())).resolves.toBeInstanceOf(Response);
    expect(subject.connection).toHaveBeenCalledTimes(2);
    expect(subject.providerFetch).toHaveBeenCalledTimes(1);
  });

  it.each([401, 403])('evicts a resolved credential after provider auth rejection %i without retrying that provider read', async status => {
    const subject = fixture();
    subject.connection
      .mockResolvedValueOnce(subject.credential('synthetic-expired-token'))
      .mockResolvedValueOnce(subject.credential('synthetic-fresh-token'));
    subject.providerFetch
      .mockResolvedValueOnce(new Response('{}', { status, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response('{}', { headers: { 'content-type': 'application/json' } }));

    await expect(subject.session.transport.fetch(request, transportInit())).resolves.toMatchObject({ status });
    await expect(subject.session.transport.fetch(request, transportInit())).resolves.toBeInstanceOf(Response);

    expect(subject.connection).toHaveBeenCalledTimes(2);
    expect(subject.bearers()).toEqual(['Bearer synthetic-expired-token', 'Bearer synthetic-fresh-token']);
  });

  it('does not let a delayed old 401 evict a fresh credential lookup', async () => {
    const firstProviderResponse = deferred<Response>();
    const firstProviderRead = deferred<void>();
    let providerReads = 0;
    const providerFetch = vi.fn(async () => {
      providerReads += 1;
      if (providerReads === 1) {
        firstProviderRead.resolve();
        return firstProviderResponse.promise;
      }
      if (providerReads === 2) return new Response('{}', { status: 401 });
      return new Response('{}');
    });
    const subject = fixture({ fetch: providerFetch });
    subject.connection
      .mockResolvedValueOnce(subject.credential('synthetic-old-token'))
      .mockResolvedValueOnce(subject.credential('synthetic-fresh-token'));

    const slowOldRead = subject.session.transport.fetch(request, transportInit());
    await firstProviderRead.promise;
    await expect(subject.session.transport.fetch(request, transportInit())).resolves.toMatchObject({ status: 401 });
    await expect(subject.session.transport.fetch(request, transportInit())).resolves.toBeInstanceOf(Response);
    firstProviderResponse.resolve(new Response('{}', { status: 401 }));
    await expect(slowOldRead).resolves.toMatchObject({ status: 401 });
    await expect(subject.session.transport.fetch(request, transportInit())).resolves.toBeInstanceOf(Response);

    expect(subject.connection).toHaveBeenCalledTimes(2);
    expect(subject.bearers()).toEqual(['Bearer synthetic-old-token', 'Bearer synthetic-old-token', 'Bearer synthetic-fresh-token', 'Bearer synthetic-fresh-token']);
  });

  it('does not retain a connection whose ownership tags fail validation', async () => {
    const subject = fixture();
    subject.connection
      .mockResolvedValueOnce({ tags: { organization_id: 'other-org', end_user_id: person.principal_id, echo_membership: person.membership_id, echo_attempt: subject.stored.attempt }, access_token: 'synthetic-wrong-owner-token' })
      .mockResolvedValueOnce(subject.credential('synthetic-access-token'));

    await expect(subject.session.transport.fetch(request, transportInit())).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(subject.session.transport.fetch(request, transportInit())).resolves.toBeInstanceOf(Response);
    expect(subject.connection).toHaveBeenCalledTimes(2);
    expect(subject.providerFetch).toHaveBeenCalledTimes(1);
  });

  it('evicts a cached credential if its mutable ownership tags become invalid', async () => {
    const subject = fixture();
    const mutableTags: Record<string, string> = { organization_id: person.organization_id, end_user_id: person.principal_id, echo_membership: person.membership_id, echo_attempt: subject.stored.attempt };
    subject.connection
      .mockResolvedValueOnce({ tags: mutableTags, access_token: 'synthetic-mutable-token' })
      .mockResolvedValueOnce(subject.credential('synthetic-fresh-token'));

    await expect(subject.session.transport.fetch(request, transportInit())).resolves.toBeInstanceOf(Response);
    mutableTags.organization_id = 'other-org';
    await expect(subject.session.transport.fetch(request, transportInit())).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(subject.session.transport.fetch(request, transportInit())).resolves.toBeInstanceOf(Response);

    expect(subject.connection).toHaveBeenCalledTimes(2);
    expect(subject.bearers()).toEqual(['Bearer synthetic-mutable-token', 'Bearer synthetic-fresh-token']);
  });

  it('cancels an unshared lookup after every waiter aborts and starts a fresh lookup later', async () => {
    type Connection = Awaited<ReturnType<NangoPersonConnectionV1['connection']>>;
    const connection = vi.fn((_reference: string, signal?: AbortSignal): Promise<Connection> => new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(abortError()), { once: true });
    }));
    const subject = fixture({ connection });
    const first = new AbortController();
    const second = new AbortController();
    const one = subject.session.transport.fetch(request, transportInit(first.signal));
    const two = subject.session.transport.fetch(request, transportInit(second.signal));
    first.abort(); second.abort();

    await expect(one).rejects.toMatchObject({ name: 'AbortError' });
    await expect(two).rejects.toMatchObject({ name: 'AbortError' });
    connection.mockResolvedValueOnce(subject.credential('synthetic-access-token'));

    await expect(subject.session.transport.fetch(request, transportInit())).resolves.toBeInstanceOf(Response);
    expect(connection).toHaveBeenCalledTimes(2);
    expect(subject.providerFetch).toHaveBeenCalledTimes(1);
  });

  it('keeps the ownership-tag and current-grant fences in front of provider reads when a credential is reused', async () => {
    const subject = fixture();
    await subject.session.transport.fetch(request, transportInit());
    subject.store.revoke(person);

    await expect(subject.session.transport.fetch(request, transportInit())).rejects.toMatchObject({ code: 'stale_access_state' });
    expect(subject.connection).toHaveBeenCalledTimes(1);
    expect(subject.providerFetch).toHaveBeenCalledTimes(1);
  });
});

const otherAccount = 'other@example.test';
const otherWorkspace = '00000000-0000-4000-8000-000000000008';

/** One person's consent flow over a real store; the test sets the account and workspace the provider verifies. */
function consent() {
  const database = new Database(':memory:');
  databases.push(database);
  const store = new PersonConnectionStoreV1(database, GRANOLA_PERSON_PROVIDER_V1);
  const verified = { account, workspace };
  const connections = new Map<string, Readonly<Record<string, string>>>();
  let pending: Readonly<Record<string, string>> = {}, consents = 0;
  const nango = {
    connect: vi.fn(async (tags: Readonly<Record<string, string>>) => { pending = tags; return { link: 'https://connect.nango.dev/fixture' }; }),
    find: vi.fn(async (tags: Readonly<Record<string, string>>) => [...connections].find(([, saved]) => saved.echo_attempt === tags.echo_attempt)?.[0]),
    connection: vi.fn(async (saved: string) => ({ tags: connections.get(saved)!, access_token: 'synthetic-access-token' })),
    disconnect: vi.fn(async (saved: string, _signal?: AbortSignal) => { connections.delete(saved); }),
  };
  const { application } = createPersonConnectionLifecycleV1({
    provider: GRANOLA_PERSON_PROVIDER_V1, store, nango, fetch: vi.fn() as unknown as typeof fetch,
    authenticate: () => ({ ...person, authorization_sha256: canonicalSha256(person) }),
    verify: async (_authenticated, input) => { input.require_account(verified.account); return { account_id: verified.account, scope_id: verified.workspace, origin }; },
  });
  const session = { access_token: 'person-session' };
  /** The person approves the pending consent in the browser. */
  const approve = () => { connections.set(`connection-${++consents}`, pending); };
  return { store, nango, application, session, approve, tool: () => application.tool(session),
    /** Connect, approve as this account in this workspace, and read the attempt's outcome. */
    async connectAs(who = account, where = workspace) {
      verified.account = who; verified.workspace = where;
      const begun = await application.connect(session);
      approve();
      return application.status({ ...session, attempt: begun.attempt });
    },
  };
}

describe('person connection account pin', () => {
  it('accepts whichever account and workspace the provider verifies once the person has disconnected', async () => {
    const subject = consent();
    expect(await subject.connectAs()).toMatchObject({ status: 'complete' });
    const first = subject.store.current(person)!;

    expect(await subject.application.disconnect(subject.session)).toEqual({ schema_version: 1, connected: false });
    expect(subject.nango.disconnect).toHaveBeenLastCalledWith(first.reference, undefined);
    expect(subject.tool()).toMatchObject({ personal_status: 'unlinked', external_scope_id: null, external_subject_id: null });

    expect(await subject.connectAs(otherAccount, otherWorkspace)).toMatchObject({ status: 'complete', failure_reason: null });
    expect(subject.tool()).toMatchObject({ personal_status: 'linked', external_scope_id: otherWorkspace, external_subject_id: otherAccount });
  });

  it.each([['account', otherAccount, workspace], ['workspace', account, otherWorkspace]] as const)('refuses another %s on a reconnect without a Disconnect', async (_what, who, where) => {
    const subject = consent();
    await subject.connectAs();

    expect(await subject.connectAs(who, where)).toMatchObject({ status: 'failed', failure_reason: 'account_mismatch' });
    // The refused reconnect leaves the connection switched off and still pinned; the first account is still accepted.
    expect(subject.tool()).toMatchObject({ personal_status: 'revoked' });
    expect(await subject.connectAs(who, where)).toMatchObject({ status: 'failed', failure_reason: 'account_mismatch' });
    expect(await subject.connectAs()).toMatchObject({ status: 'complete' });
    expect(subject.tool()).toMatchObject({ personal_status: 'linked', external_scope_id: workspace, external_subject_id: account });
  });

  it('keeps the pin on a connection the system switched off, until the person disconnects', async () => {
    const subject = consent();
    await subject.connectAs();
    const first = subject.store.current(person)!;
    // As a provider does when it sees another account behind the grant.
    subject.store.revoke(person);
    expect(subject.tool()).toMatchObject({ personal_status: 'revoked' });
    expect(await subject.connectAs(otherAccount, otherWorkspace)).toMatchObject({ status: 'failed', failure_reason: 'account_mismatch' });

    await subject.application.disconnect(subject.session);
    expect(subject.nango.disconnect).toHaveBeenLastCalledWith(first.reference, undefined);
    expect(subject.tool()).toMatchObject({ personal_status: 'unlinked' });
    expect(await subject.connectAs(otherAccount, otherWorkspace)).toMatchObject({ status: 'complete' });
    expect(subject.tool()).toMatchObject({ personal_status: 'linked', external_scope_id: otherWorkspace, external_subject_id: otherAccount });
  });

  it('disconnects a switched-off connection as it does a live one', async () => {
    const subject = consent();
    await subject.connectAs();
    subject.store.revoke(person);
    expect(subject.tool()).toMatchObject({ personal_status: 'revoked' });

    expect(await subject.application.disconnect(subject.session)).toEqual({ schema_version: 1, connected: false });
    expect(subject.tool()).toMatchObject({ personal_status: 'unlinked' });
    expect(subject.store.current(person)).toBeUndefined();
  });

  it.each(['a first consent', 'a reconnect'])('cancels %s still pending when the person disconnects, so a late approval binds nothing', async pending => {
    const subject = consent();
    if (pending === 'a reconnect') await subject.connectAs();
    const begun = await subject.application.connect(subject.session);

    await subject.application.disconnect(subject.session);
    expect(await subject.application.status({ ...subject.session, attempt: begun.attempt })).toMatchObject({ status: 'cancelled', failure_reason: null });
    subject.approve();
    expect(await subject.application.status({ ...subject.session, attempt: begun.attempt })).toMatchObject({ status: 'cancelled' });
    expect(subject.tool()).toMatchObject({ personal_status: 'unlinked' });
  });

  it('keeps a switched-off connection and its pin while its remote grant could not be deleted, and finishes on the next Disconnect', async () => {
    const subject = consent();
    await subject.connectAs();
    const first = subject.store.current(person)!;
    subject.nango.disconnect.mockRejectedValueOnce(new Error('synthetic Nango outage'));

    await expect(subject.application.disconnect(subject.session)).rejects.toThrow('synthetic Nango outage');
    // Local revocation won, and the reference stays so the remote deletion can be tried again.
    expect(subject.tool()).toMatchObject({ personal_status: 'revoked' });
    expect(subject.store.current(person)).toMatchObject({ active: false, reference: first.reference });
    expect(await subject.connectAs(otherAccount, otherWorkspace)).toMatchObject({ status: 'failed', failure_reason: 'account_mismatch' });

    await subject.application.disconnect(subject.session);
    expect(subject.nango.disconnect).toHaveBeenLastCalledWith(first.reference, undefined);
    expect(subject.tool()).toMatchObject({ personal_status: 'unlinked' });
    expect(await subject.connectAs(otherAccount, otherWorkspace)).toMatchObject({ status: 'complete' });
  });

  it('keeps a connection completed while its Disconnect was still deleting the former grant', async () => {
    const subject = consent();
    await subject.connectAs();
    const deleting = deferred<void>();
    subject.nango.disconnect.mockImplementationOnce(() => deleting.promise);

    const disconnecting = subject.application.disconnect(subject.session);
    expect(await subject.connectAs()).toMatchObject({ status: 'complete' });
    const fresh = subject.store.current(person)!;
    deleting.resolve();
    await disconnecting;

    expect(subject.store.current(person)).toEqual(fresh);
    expect(subject.tool()).toMatchObject({ personal_status: 'linked' });
  });
});
