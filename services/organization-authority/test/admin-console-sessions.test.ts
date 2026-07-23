import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { InMemoryAdminConsoleSessionStore } from '../src/presentation/admin-console/sessions.js';

const CLIENT_A = `cid_${Buffer.alloc(32, 0x11).toString('base64url')}`;
const CLIENT_B = `cid_${Buffer.alloc(32, 0x22).toString('base64url')}`;

function deterministicRandom(
  bytes: readonly number[],
): (length: number) => Uint8Array {
  let index = 0;
  return (length) => {
    const value = bytes[index];
    if (value === undefined) throw new Error('test randomness was exhausted');
    index += 1;
    return new Uint8Array(length).fill(value);
  };
}

function sessionProof(created: { session_cookie_value: string }): {
  kind: 'session';
  client_id: string;
  session_cookie_value: string;
} {
  return {
    kind: 'session',
    client_id: CLIENT_A,
    session_cookie_value: created.session_cookie_value,
  };
}

describe('in-memory administrator console sessions', () => {
  it('requires strict positive bounds and valid injected providers', () => {
    for (const sessionTtl of [0, -1, 1.5, Number.POSITIVE_INFINITY]) {
      expect(
        () =>
          new InMemoryAdminConsoleSessionStore({
            session_ttl_ms: sessionTtl,
            maximum_sessions: 1,
          }),
      ).toThrow('session TTL must be a positive integer');
    }
    for (const maximumSessions of [0, -1, 1.5, Number.POSITIVE_INFINITY]) {
      expect(
        () =>
          new InMemoryAdminConsoleSessionStore({
            session_ttl_ms: 1,
            maximum_sessions: maximumSessions,
          }),
      ).toThrow('maximum sessions must be a positive integer');
    }

    const invalidClock = new InMemoryAdminConsoleSessionStore({
      session_ttl_ms: 1_000,
      maximum_sessions: 1,
      now: () => 1.5,
    });
    expect(() => invalidClock.create(CLIENT_A)).toThrow(
      'clock must return valid epoch milliseconds',
    );

    const shortRandom = new InMemoryAdminConsoleSessionStore({
      session_ttl_ms: 1_000,
      maximum_sessions: 1,
      now: () => 1_000,
      random_bytes: () => new Uint8Array(31),
    });
    expect(() => shortRandom.create(CLIENT_A)).toThrow(
      'randomness must return exactly 32 bytes',
    );

    const repeatedRandom = new InMemoryAdminConsoleSessionStore({
      session_ttl_ms: 1_000,
      maximum_sessions: 1,
      now: () => 1_000,
      random_bytes: (length) => new Uint8Array(length).fill(1),
    });
    expect(() => repeatedRandom.create(CLIENT_A)).toThrow(
      'session secrets could not be generated',
    );
    expect(() =>
      repeatedRandom.create('cid_not-a-canonical-client-identity'),
    ).toThrow('client identity is not canonical');
  });

  it('creates distinct opaque secrets, retains only digests, and returns safe snapshots', () => {
    const now = Date.parse('2026-07-22T12:00:00.000Z');
    const store = new InMemoryAdminConsoleSessionStore({
      session_ttl_ms: 60_000,
      maximum_sessions: 10,
      now: () => now,
      random_bytes: deterministicRandom([1, 2]),
    });

    const created = store.create(CLIENT_A);
    expect(created.session_cookie_value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(created.csrf_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(created.session_cookie_value).not.toBe(created.csrf_token);
    expect(created.session).toEqual({
      client_id: CLIENT_A,
      created_at: '2026-07-22T12:00:00.000Z',
      expires_at: '2026-07-22T12:01:00.000Z',
    });
    expect(Object.isFrozen(created)).toBe(true);
    expect(Object.isFrozen(created.session)).toBe(true);

    const first = store.verify(sessionProof(created));
    const second = store.verify(sessionProof(created));
    expect(first).toEqual(created.session);
    expect(second).toEqual(created.session);
    expect(first).not.toBe(second);
    expect(Object.isFrozen(first)).toBe(true);

    const retained = (
      store as unknown as {
        sessions: Map<string, { csrf_sha256: Buffer; [key: string]: unknown }>;
      }
    ).sessions;
    expect([...retained.keys()]).toEqual([
      createHash('sha256')
        .update(created.session_cookie_value, 'ascii')
        .digest('hex'),
    ]);
    const stored = [...retained.values()][0]!;
    expect(
      stored.csrf_sha256.equals(
        createHash('sha256').update(created.csrf_token, 'ascii').digest(),
      ),
    ).toBe(true);
    expect(Object.values(stored)).not.toContain(created.session_cookie_value);
    expect(Object.values(stored)).not.toContain(created.csrf_token);
  });

  it('binds verification to the canonical client and uses CSRF for mutations', () => {
    const store = new InMemoryAdminConsoleSessionStore({
      session_ttl_ms: 60_000,
      maximum_sessions: 2,
      now: () => 1_000,
      random_bytes: deterministicRandom([1, 2]),
    });
    const created = store.create(CLIENT_A);

    expect(
      store.verify({
        kind: 'session',
        client_id: CLIENT_B,
        session_cookie_value: created.session_cookie_value,
      }),
    ).toBeNull();
    expect(
      store.verify({
        kind: 'mutation',
        client_id: CLIENT_A,
        session_cookie_value: created.session_cookie_value,
        csrf_token: Buffer.alloc(32, 3).toString('base64url'),
      }),
    ).toBeNull();
    expect(
      store.verify({
        kind: 'mutation',
        client_id: CLIENT_A,
        session_cookie_value: created.session_cookie_value,
        csrf_token: 'malformed',
      }),
    ).toBeNull();
    expect(
      store.verify({
        kind: 'mutation',
        client_id: CLIENT_A,
        session_cookie_value: created.session_cookie_value,
        csrf_token: created.csrf_token,
      }),
    ).toEqual(created.session);
  });

  it('expires on access and a new store naturally forgets every session', () => {
    let now = 10_000;
    const store = new InMemoryAdminConsoleSessionStore({
      session_ttl_ms: 100,
      maximum_sessions: 1,
      now: () => now,
      random_bytes: deterministicRandom([1, 2]),
    });
    const created = store.create(CLIENT_A);

    now = 10_099;
    expect(store.verify(sessionProof(created))).not.toBeNull();
    now = 10_100;
    expect(store.verify(sessionProof(created))).toBeNull();
    expect(
      store.revoke({
        client_id: CLIENT_A,
        session_cookie_value: created.session_cookie_value,
        csrf_token: created.csrf_token,
      }),
    ).toBe(false);

    const restarted = new InMemoryAdminConsoleSessionStore({
      session_ttl_ms: 100,
      maximum_sessions: 1,
      now: () => now,
      random_bytes: deterministicRandom([3, 4]),
    });
    expect(restarted.verify(sessionProof(created))).toBeNull();
  });

  it('evicts the oldest-expiring session deterministically, including ties', () => {
    let now = 1_000;
    const store = new InMemoryAdminConsoleSessionStore({
      session_ttl_ms: 1_000,
      maximum_sessions: 2,
      now: () => now,
      random_bytes: deterministicRandom([1, 2, 3, 4, 5, 6]),
    });
    const first = store.create(CLIENT_A);
    now = 1_100;
    const second = store.create(CLIENT_A);
    now = 1_200;
    const third = store.create(CLIENT_A);

    expect(store.verify(sessionProof(first))).toBeNull();
    expect(store.verify(sessionProof(second))).not.toBeNull();
    expect(store.verify(sessionProof(third))).not.toBeNull();

    const tied = new InMemoryAdminConsoleSessionStore({
      session_ttl_ms: 1_000,
      maximum_sessions: 2,
      now: () => 5_000,
      random_bytes: deterministicRandom([7, 8, 9, 10, 11, 12]),
    });
    const tiedFirst = tied.create(CLIENT_A);
    const tiedSecond = tied.create(CLIENT_A);
    const tiedThird = tied.create(CLIENT_A);
    expect(tied.verify(sessionProof(tiedFirst))).toBeNull();
    expect(tied.verify(sessionProof(tiedSecond))).not.toBeNull();
    expect(tied.verify(sessionProof(tiedThird))).not.toBeNull();
  });

  it('revokes only with the bound client and constant-time CSRF proof', () => {
    const store = new InMemoryAdminConsoleSessionStore({
      session_ttl_ms: 60_000,
      maximum_sessions: 2,
      now: () => 1_000,
      random_bytes: deterministicRandom([1, 2]),
    });
    const created = store.create(CLIENT_A);
    const wrongCsrf = Buffer.alloc(32, 3).toString('base64url');

    expect(
      store.revoke({
        client_id: CLIENT_A,
        session_cookie_value: created.session_cookie_value,
        csrf_token: wrongCsrf,
      }),
    ).toBe(false);
    expect(
      store.revoke({
        client_id: CLIENT_B,
        session_cookie_value: created.session_cookie_value,
        csrf_token: created.csrf_token,
      }),
    ).toBe(false);
    expect(store.verify(sessionProof(created))).not.toBeNull();
    expect(
      store.revoke({
        client_id: CLIENT_A,
        session_cookie_value: created.session_cookie_value,
        csrf_token: created.csrf_token,
      }),
    ).toBe(true);
    expect(store.verify(sessionProof(created))).toBeNull();
    expect(
      store.revoke({
        client_id: CLIENT_A,
        session_cookie_value: created.session_cookie_value,
        csrf_token: created.csrf_token,
      }),
    ).toBe(false);
  });
});
