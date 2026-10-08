import Database from 'better-sqlite3';
import { canonicalSha256 } from '@echo-brain/federation-protocol';
import { describe, expect, it, vi } from 'vitest';
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
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  return { promise, resolve, reject };
}

function fixture(input: { readonly connection?: ReturnType<typeof vi.fn>; readonly fetch?: ReturnType<typeof vi.fn> } = {}) {
  const database = new Database(':memory:');
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
  return { database, store, stored, lifecycle, connection, providerFetch };
}

function transportInit(signal?: AbortSignal): RequestInit {
  return { redirect: 'error', ...(signal === undefined ? {} : { signal }) };
}

describe('person connection lifecycle request credential reuse', () => {
  it('reads a connection once for sequential and concurrent calls through one opened transport', async () => {
    const subject = fixture();
    try {
      const session = subject.lifecycle.open(person, () => {});
      await session.transport.fetch(request, transportInit());
      await Promise.all([
        session.transport.fetch(request, transportInit()),
        session.transport.fetch(request, transportInit()),
        session.transport.fetch(request, transportInit()),
      ]);

      expect(subject.connection).toHaveBeenCalledTimes(1);
      expect(subject.connection.mock.calls[0]![0]).toBe(reference);
      expect(subject.connection.mock.calls[0]![1]).toBeInstanceOf(AbortSignal);
      expect(subject.providerFetch).toHaveBeenCalledTimes(4);
      for (const [, init] of subject.providerFetch.mock.calls) {
        expect(new Headers((init as RequestInit).headers).get('authorization')).toBe('Bearer synthetic-access-token');
      }
    } finally { subject.database.close(); }
  });

  it('keeps credentials scoped to an opened transport instead of reusing them across requests', async () => {
    const subject = fixture();
    try {
      const first = subject.lifecycle.open(person, () => {});
      const second = subject.lifecycle.open(person, () => {});
      await first.transport.fetch(request, transportInit());
      await second.transport.fetch(request, transportInit());

      expect(subject.connection).toHaveBeenCalledTimes(2);
      for (const call of subject.connection.mock.calls) {
        expect(call[0]).toBe(reference);
        expect(call[1]).toBeInstanceOf(AbortSignal);
      }
    } finally { subject.database.close(); }
  });

  it('renews an unknown-expiry credential after the five minute per-transport cache cap', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'performance'] });
    vi.setSystemTime(new Date('2026-10-08T00:00:00.000Z'));
    const subject = fixture();
    try {
      const session = subject.lifecycle.open(person, () => {});
      subject.connection
        .mockResolvedValueOnce({ tags: { organization_id: person.organization_id, end_user_id: person.principal_id, echo_membership: person.membership_id, echo_attempt: subject.stored.attempt }, access_token: 'synthetic-first-token' })
        .mockResolvedValueOnce({ tags: { organization_id: person.organization_id, end_user_id: person.principal_id, echo_membership: person.membership_id, echo_attempt: subject.stored.attempt }, access_token: 'synthetic-renewed-token' });

      await expect(session.transport.fetch(request, transportInit())).resolves.toBeInstanceOf(Response);
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      await expect(session.transport.fetch(request, transportInit())).resolves.toBeInstanceOf(Response);

      expect(subject.connection).toHaveBeenCalledTimes(2);
      expect(new Headers((subject.providerFetch.mock.calls[1]![1] as RequestInit).headers).get('authorization')).toBe('Bearer synthetic-renewed-token');
    } finally {
      subject.database.close();
      vi.useRealTimers();
    }
  });

  it('uses a near-expiry fresh credential once but immediately renews before a second provider read', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'performance'] });
    vi.setSystemTime(new Date('2026-10-08T00:00:00.000Z'));
    const subject = fixture();
    try {
      const session = subject.lifecycle.open(person, () => {});
      subject.connection
        .mockResolvedValueOnce({ tags: { organization_id: person.organization_id, end_user_id: person.principal_id, echo_membership: person.membership_id, echo_attempt: subject.stored.attempt }, access_token: 'synthetic-near-expiry-token', expires_at: '2026-10-08T00:00:30.000Z' })
        .mockResolvedValueOnce({ tags: { organization_id: person.organization_id, end_user_id: person.principal_id, echo_membership: person.membership_id, echo_attempt: subject.stored.attempt }, access_token: 'synthetic-renewed-token', expires_at: '2026-10-08T01:00:00.000Z' });

      await expect(session.transport.fetch(request, transportInit())).resolves.toBeInstanceOf(Response);
      await expect(session.transport.fetch(request, transportInit())).resolves.toBeInstanceOf(Response);

      expect(subject.connection).toHaveBeenCalledTimes(2);
      expect(subject.providerFetch).toHaveBeenCalledTimes(2);
      expect(new Headers((subject.providerFetch.mock.calls[0]![1] as RequestInit).headers).get('authorization')).toBe('Bearer synthetic-near-expiry-token');
      expect(new Headers((subject.providerFetch.mock.calls[1]![1] as RequestInit).headers).get('authorization')).toBe('Bearer synthetic-renewed-token');
    } finally {
      subject.database.close();
      vi.useRealTimers();
    }
  });

  it('shares a fresh near-expiry credential with its original concurrent waiters before renewing later', async () => {
    type Connection = Awaited<ReturnType<NangoPersonConnectionV1['connection']>>;
    vi.useFakeTimers({ toFake: ['Date', 'performance'] });
    vi.setSystemTime(new Date('2026-10-08T00:00:00.000Z'));
    const initial = deferred<Connection>();
    const connection = vi.fn((_reference: string, _signal?: AbortSignal): Promise<Connection> => initial.promise);
    const subject = fixture({ connection });
    try {
      const session = subject.lifecycle.open(person, () => {});
      const first = session.transport.fetch(request, transportInit());
      const second = session.transport.fetch(request, transportInit());
      initial.resolve({
        tags: { organization_id: person.organization_id, end_user_id: person.principal_id, echo_membership: person.membership_id, echo_attempt: subject.stored.attempt },
        access_token: 'synthetic-near-expiry-token', expires_at: '2026-10-08T00:00:30.000Z',
      });

      await expect(Promise.all([first, second])).resolves.toHaveLength(2);
      connection.mockResolvedValueOnce({
        tags: { organization_id: person.organization_id, end_user_id: person.principal_id, echo_membership: person.membership_id, echo_attempt: subject.stored.attempt },
        access_token: 'synthetic-renewed-token', expires_at: '2026-10-08T01:00:00.000Z',
      });
      await expect(session.transport.fetch(request, transportInit())).resolves.toBeInstanceOf(Response);

      expect(connection).toHaveBeenCalledTimes(2);
      expect(subject.providerFetch).toHaveBeenCalledTimes(3);
      expect(new Headers((subject.providerFetch.mock.calls[0]![1] as RequestInit).headers).get('authorization')).toBe('Bearer synthetic-near-expiry-token');
      expect(new Headers((subject.providerFetch.mock.calls[1]![1] as RequestInit).headers).get('authorization')).toBe('Bearer synthetic-near-expiry-token');
      expect(new Headers((subject.providerFetch.mock.calls[2]![1] as RequestInit).headers).get('authorization')).toBe('Bearer synthetic-renewed-token');
    } finally {
      subject.database.close();
      vi.useRealTimers();
    }
  });

  it('hands off a cached lease that ages while its resolved promise is awaited before provider I/O', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'performance'] });
    vi.setSystemTime(new Date('2026-10-08T00:00:00.000Z'));
    const subject = fixture();
    try {
      const session = subject.lifecycle.open(person, () => {});
      subject.connection
        .mockResolvedValueOnce({ tags: { organization_id: person.organization_id, end_user_id: person.principal_id, echo_membership: person.membership_id, echo_attempt: subject.stored.attempt }, access_token: 'synthetic-old-token' })
        .mockResolvedValueOnce({ tags: { organization_id: person.organization_id, end_user_id: person.principal_id, echo_membership: person.membership_id, echo_attempt: subject.stored.attempt }, access_token: 'synthetic-renewed-token' });
      await expect(session.transport.fetch(request, transportInit())).resolves.toBeInstanceOf(Response);

      const agingRead = session.transport.fetch(request, transportInit());
      await Promise.resolve();
      vi.advanceTimersByTime(5 * 60_000);
      await expect(agingRead).resolves.toBeInstanceOf(Response);

      expect(subject.connection).toHaveBeenCalledTimes(2);
      expect(subject.providerFetch).toHaveBeenCalledTimes(2);
      expect(new Headers((subject.providerFetch.mock.calls[1]![1] as RequestInit).headers).get('authorization')).toBe('Bearer synthetic-renewed-token');
    } finally {
      subject.database.close();
      vi.useRealTimers();
    }
  });

  it('does not let a wall-clock rollback extend reuse of a known-expiry credential', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'performance'] });
    vi.setSystemTime(new Date('2026-10-08T00:00:00.000Z'));
    const subject = fixture();
    try {
      const session = subject.lifecycle.open(person, () => {});
      subject.connection
        .mockResolvedValueOnce({ tags: { organization_id: person.organization_id, end_user_id: person.principal_id, echo_membership: person.membership_id, echo_attempt: subject.stored.attempt }, access_token: 'synthetic-first-token', expires_at: '2026-10-08T00:02:00.000Z' })
        .mockResolvedValueOnce({ tags: { organization_id: person.organization_id, end_user_id: person.principal_id, echo_membership: person.membership_id, echo_attempt: subject.stored.attempt }, access_token: 'synthetic-renewed-token', expires_at: '2026-10-08T01:00:00.000Z' });

      await expect(session.transport.fetch(request, transportInit())).resolves.toBeInstanceOf(Response);
      await vi.advanceTimersByTimeAsync(61_000);
      vi.setSystemTime(new Date('2026-10-07T23:00:00.000Z'));
      await expect(session.transport.fetch(request, transportInit())).resolves.toBeInstanceOf(Response);

      expect(subject.connection).toHaveBeenCalledTimes(2);
      expect(new Headers((subject.providerFetch.mock.calls[1]![1] as RequestInit).headers).get('authorization')).toBe('Bearer synthetic-renewed-token');
    } finally {
      subject.database.close();
      vi.useRealTimers();
    }
  });

  it('shares one concurrent renewal after the cache-age cap', async () => {
    type Connection = Awaited<ReturnType<NangoPersonConnectionV1['connection']>>;
    vi.useFakeTimers({ toFake: ['Date', 'performance'] });
    vi.setSystemTime(new Date('2026-10-08T00:00:00.000Z'));
    const renewal = deferred<Connection>();
    const subject = fixture();
    try {
      const session = subject.lifecycle.open(person, () => {});
      subject.connection
        .mockResolvedValueOnce({ tags: { organization_id: person.organization_id, end_user_id: person.principal_id, echo_membership: person.membership_id, echo_attempt: subject.stored.attempt }, access_token: 'synthetic-first-token' })
        .mockImplementationOnce(() => renewal.promise);
      await expect(session.transport.fetch(request, transportInit())).resolves.toBeInstanceOf(Response);
      await vi.advanceTimersByTimeAsync(5 * 60_000);

      const first = session.transport.fetch(request, transportInit());
      const second = session.transport.fetch(request, transportInit());
      renewal.resolve({ tags: { organization_id: person.organization_id, end_user_id: person.principal_id, echo_membership: person.membership_id, echo_attempt: subject.stored.attempt }, access_token: 'synthetic-renewed-token' });

      await expect(Promise.all([first, second])).resolves.toHaveLength(2);
      expect(subject.connection).toHaveBeenCalledTimes(2);
      expect(subject.providerFetch).toHaveBeenCalledTimes(3);
      expect(new Headers((subject.providerFetch.mock.calls[1]![1] as RequestInit).headers).get('authorization')).toBe('Bearer synthetic-renewed-token');
      expect(new Headers((subject.providerFetch.mock.calls[2]![1] as RequestInit).headers).get('authorization')).toBe('Bearer synthetic-renewed-token');
    } finally {
      subject.database.close();
      vi.useRealTimers();
    }
  });

  it('refuses an already-expired newly fetched credential before provider I/O', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'performance'] });
    vi.setSystemTime(new Date('2026-10-08T00:00:00.000Z'));
    const subject = fixture();
    try {
      const session = subject.lifecycle.open(person, () => {});
      subject.connection.mockResolvedValueOnce({
        tags: { organization_id: person.organization_id, end_user_id: person.principal_id, echo_membership: person.membership_id, echo_attempt: subject.stored.attempt },
        access_token: 'synthetic-expired-token', expires_at: '2026-10-07T23:59:59.999Z',
      });

      await expect(session.transport.fetch(request, transportInit())).rejects.toMatchObject({ code: 'unavailable' });
      expect(subject.connection).toHaveBeenCalledTimes(1);
      expect(subject.providerFetch).not.toHaveBeenCalled();
    } finally {
      subject.database.close();
      vi.useRealTimers();
    }
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
    vi.useFakeTimers({ toFake: ['Date', 'performance'] });
    vi.setSystemTime(new Date('2026-10-08T00:00:00.000Z'));
    const subject = fixture({ fetch: providerFetch });
    try {
      const session = subject.lifecycle.open(person, () => {});
      subject.connection
        .mockResolvedValueOnce({ tags: { organization_id: person.organization_id, end_user_id: person.principal_id, echo_membership: person.membership_id, echo_attempt: subject.stored.attempt }, access_token: 'synthetic-old-token' })
        .mockResolvedValueOnce({ tags: { organization_id: person.organization_id, end_user_id: person.principal_id, echo_membership: person.membership_id, echo_attempt: subject.stored.attempt }, access_token: 'synthetic-renewed-token' });

      const slowOldRead = session.transport.fetch(request, transportInit());
      await firstProviderRead.promise;
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      await expect(session.transport.fetch(request, transportInit())).resolves.toBeInstanceOf(Response);
      firstProviderResponse.resolve(new Response('{}', { status: 401 }));
      await expect(slowOldRead).resolves.toMatchObject({ status: 401 });
      await expect(session.transport.fetch(request, transportInit())).resolves.toBeInstanceOf(Response);

      expect(subject.connection).toHaveBeenCalledTimes(2);
      expect(new Headers((subject.providerFetch.mock.calls[1]![1] as RequestInit).headers).get('authorization')).toBe('Bearer synthetic-renewed-token');
      expect(new Headers((subject.providerFetch.mock.calls[2]![1] as RequestInit).headers).get('authorization')).toBe('Bearer synthetic-renewed-token');
    } finally {
      subject.database.close();
      vi.useRealTimers();
    }
  });

  it('lets an aborted caller leave a shared in-flight credential read usable by another caller', async () => {
    const lookup = deferred<{ readonly tags: Readonly<Record<string, string>>; readonly access_token: string }>();
    const connection = vi.fn(() => lookup.promise);
    const subject = fixture({ connection });
    try {
      const session = subject.lifecycle.open(person, () => {});
      const aborting = new AbortController();
      const cancelled = session.transport.fetch(request, transportInit(aborting.signal));
      const active = session.transport.fetch(request, transportInit());
      aborting.abort();
      lookup.resolve({
        tags: { organization_id: person.organization_id, end_user_id: person.principal_id, echo_membership: person.membership_id, echo_attempt: subject.stored.attempt },
        access_token: 'synthetic-access-token',
      });

      await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
      await expect(active).resolves.toBeInstanceOf(Response);
      expect(connection).toHaveBeenCalledTimes(1);
      expect(subject.providerFetch).toHaveBeenCalledTimes(1);
    } finally { subject.database.close(); }
  });

  it('does not retain a failed credential lookup as a usable credential', async () => {
    const subject = fixture();
    try {
      const session = subject.lifecycle.open(person, () => {});
      subject.connection.mockRejectedValueOnce(new Error('synthetic Nango outage'));

      await expect(session.transport.fetch(request, transportInit())).rejects.toThrow('synthetic Nango outage');
      await expect(session.transport.fetch(request, transportInit())).resolves.toBeInstanceOf(Response);
      expect(subject.connection).toHaveBeenCalledTimes(2);
      expect(subject.providerFetch).toHaveBeenCalledTimes(1);
    } finally { subject.database.close(); }
  });

  it.each([401, 403])('evicts a resolved credential after provider auth rejection %i without retrying that provider read', async status => {
    const subject = fixture();
    try {
      const session = subject.lifecycle.open(person, () => {});
      subject.connection
        .mockResolvedValueOnce({ tags: { organization_id: person.organization_id, end_user_id: person.principal_id, echo_membership: person.membership_id, echo_attempt: subject.stored.attempt }, access_token: 'synthetic-expired-token' })
        .mockResolvedValueOnce({ tags: { organization_id: person.organization_id, end_user_id: person.principal_id, echo_membership: person.membership_id, echo_attempt: subject.stored.attempt }, access_token: 'synthetic-fresh-token' });
      subject.providerFetch
        .mockResolvedValueOnce(new Response('{}', { status, headers: { 'content-type': 'application/json' } }))
        .mockResolvedValueOnce(new Response('{}', { headers: { 'content-type': 'application/json' } }));

      await expect(session.transport.fetch(request, transportInit())).resolves.toMatchObject({ status });
      await expect(session.transport.fetch(request, transportInit())).resolves.toBeInstanceOf(Response);

      expect(subject.connection).toHaveBeenCalledTimes(2);
      expect(subject.providerFetch).toHaveBeenCalledTimes(2);
      expect(new Headers((subject.providerFetch.mock.calls[0]![1] as RequestInit).headers).get('authorization')).toBe('Bearer synthetic-expired-token');
      expect(new Headers((subject.providerFetch.mock.calls[1]![1] as RequestInit).headers).get('authorization')).toBe('Bearer synthetic-fresh-token');
    } finally { subject.database.close(); }
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
    try {
      const session = subject.lifecycle.open(person, () => {});
      subject.connection
        .mockResolvedValueOnce({ tags: { organization_id: person.organization_id, end_user_id: person.principal_id, echo_membership: person.membership_id, echo_attempt: subject.stored.attempt }, access_token: 'synthetic-old-token' })
        .mockResolvedValueOnce({ tags: { organization_id: person.organization_id, end_user_id: person.principal_id, echo_membership: person.membership_id, echo_attempt: subject.stored.attempt }, access_token: 'synthetic-fresh-token' });

      const slowOldRead = session.transport.fetch(request, transportInit());
      await firstProviderRead.promise;
      await expect(session.transport.fetch(request, transportInit())).resolves.toMatchObject({ status: 401 });
      await expect(session.transport.fetch(request, transportInit())).resolves.toBeInstanceOf(Response);
      firstProviderResponse.resolve(new Response('{}', { status: 401 }));
      await expect(slowOldRead).resolves.toMatchObject({ status: 401 });
      await expect(session.transport.fetch(request, transportInit())).resolves.toBeInstanceOf(Response);

      expect(subject.connection).toHaveBeenCalledTimes(2);
      expect(subject.providerFetch).toHaveBeenCalledTimes(4);
      expect(new Headers((subject.providerFetch.mock.calls[3]![1] as RequestInit).headers).get('authorization')).toBe('Bearer synthetic-fresh-token');
    } finally { subject.database.close(); }
  });

  it('does not retain a connection whose ownership tags fail validation', async () => {
    const subject = fixture();
    try {
      const session = subject.lifecycle.open(person, () => {});
      subject.connection
        .mockResolvedValueOnce({ tags: { organization_id: 'other-org', end_user_id: person.principal_id, echo_membership: person.membership_id, echo_attempt: subject.stored.attempt }, access_token: 'synthetic-wrong-owner-token' })
        .mockResolvedValueOnce({ tags: { organization_id: person.organization_id, end_user_id: person.principal_id, echo_membership: person.membership_id, echo_attempt: subject.stored.attempt }, access_token: 'synthetic-access-token' });

      await expect(session.transport.fetch(request, transportInit())).rejects.toMatchObject({ code: 'unauthorized' });
      await expect(session.transport.fetch(request, transportInit())).resolves.toBeInstanceOf(Response);
      expect(subject.connection).toHaveBeenCalledTimes(2);
      expect(subject.providerFetch).toHaveBeenCalledTimes(1);
    } finally { subject.database.close(); }
  });

  it('evicts a cached credential if its mutable ownership tags become invalid', async () => {
    const subject = fixture();
    const mutableTags: Record<string, string> = { organization_id: person.organization_id, end_user_id: person.principal_id, echo_membership: person.membership_id, echo_attempt: subject.stored.attempt };
    try {
      const session = subject.lifecycle.open(person, () => {});
      subject.connection
        .mockResolvedValueOnce({ tags: mutableTags, access_token: 'synthetic-mutable-token' })
        .mockResolvedValueOnce({ tags: { organization_id: person.organization_id, end_user_id: person.principal_id, echo_membership: person.membership_id, echo_attempt: subject.stored.attempt }, access_token: 'synthetic-fresh-token' });

      await expect(session.transport.fetch(request, transportInit())).resolves.toBeInstanceOf(Response);
      mutableTags.organization_id = 'other-org';
      await expect(session.transport.fetch(request, transportInit())).rejects.toMatchObject({ code: 'unauthorized' });
      await expect(session.transport.fetch(request, transportInit())).resolves.toBeInstanceOf(Response);

      expect(subject.connection).toHaveBeenCalledTimes(2);
      expect(subject.providerFetch).toHaveBeenCalledTimes(2);
      expect(new Headers((subject.providerFetch.mock.calls[1]![1] as RequestInit).headers).get('authorization')).toBe('Bearer synthetic-fresh-token');
    } finally { subject.database.close(); }
  });

  it('cancels an unshared lookup after every waiter aborts and starts a fresh lookup later', async () => {
    type Connection = Awaited<ReturnType<NangoPersonConnectionV1['connection']>>;
    const connection = vi.fn((_reference: string, signal?: AbortSignal): Promise<Connection> => new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(abortError()), { once: true });
    }));
    const subject = fixture({ connection });
    try {
      const session = subject.lifecycle.open(person, () => {});
      const first = new AbortController();
      const second = new AbortController();
      const one = session.transport.fetch(request, transportInit(first.signal));
      const two = session.transport.fetch(request, transportInit(second.signal));
      first.abort(); second.abort();

      await expect(one).rejects.toMatchObject({ name: 'AbortError' });
      await expect(two).rejects.toMatchObject({ name: 'AbortError' });
      connection.mockResolvedValueOnce({
        tags: { organization_id: person.organization_id, end_user_id: person.principal_id, echo_membership: person.membership_id, echo_attempt: subject.stored.attempt },
        access_token: 'synthetic-access-token',
      });

      await expect(session.transport.fetch(request, transportInit())).resolves.toBeInstanceOf(Response);
      expect(connection).toHaveBeenCalledTimes(2);
      expect(subject.providerFetch).toHaveBeenCalledTimes(1);
    } finally { subject.database.close(); }
  });

  it('keeps the ownership-tag and current-grant fences in front of provider reads when a credential is reused', async () => {
    const subject = fixture();
    try {
      const session = subject.lifecycle.open(person, () => {});
      await session.transport.fetch(request, transportInit());
      subject.store.revoke(person);

      await expect(session.transport.fetch(request, transportInit())).rejects.toMatchObject({ code: 'stale_access_state' });
      expect(subject.connection).toHaveBeenCalledTimes(1);
      expect(subject.providerFetch).toHaveBeenCalledTimes(1);
    } finally { subject.database.close(); }
  });
});
