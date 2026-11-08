import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdtempSync, readdirSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { setImmediate, setTimeout } from 'node:timers/promises';
import { expect, it, vi } from 'vitest';
import type { PersonContextMutationError } from '../../src/product/person-client/authority-client.js';
import { PersonClient } from '../../src/product/person-client/client.js';
import { PersonClientSessionUnavailableError, PersonSessionStore } from '../../src/product/person-client/session-store.js';
import { signedInHome } from './signed-in-home.js';
import { PersonSessionOperations } from '../../src/product/person-client/session-operations.js';

it('rejects a signed-out read without creating coordination files or sending a request', async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'echo-signed-out-read-')));
  let sent = false;
  const client = new PersonClient({ home_directory: home, fetch: async () => { sent = true; throw new Error('Unexpected request'); } });
  try {
    await expect(client.records()).rejects.toThrow('Person session is unavailable; sign in again');
    expect(sent).toBe(false);
    expect(readdirSync(home)).toEqual([]);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

it('waits for another client using the same session before rotating its access credential', async () => {
  const now = '2026-11-05T07:00:00.000Z';
  const home = signedInHome({ prefix: 'echo-refresh-in-flight-', now });
  const stored = new PersonSessionStore(home).read();
  let releaseRead!: () => void;
  const reading = new Promise<void>(resolve => { releaseRead = resolve; });
  let readStarted!: () => void;
  const started = new Promise<void>(resolve => { readStarted = resolve; });
  const events: string[] = [];
  const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
    status, headers: { 'content-type': 'application/json' },
  });
  const fetch: typeof globalThis.fetch = async input => {
    const path = new URL(String(input)).pathname;
    if (path === '/v2/session/refresh') {
      events.push('rotated');
      return reply({ ...stored.session, access_token: 'B'.repeat(43), refresh_token: 'S'.repeat(43),
        access_expires_at: '2026-11-05T19:00:00.000Z' });
    }
    expect(path).toBe('/v1/person/records');
    events.push('read-started');
    readStarted();
    await reading;
    // The real Authority revokes the previous access credential on refresh.
    if (events.includes('rotated')) return reply({ error: { code: 'unauthorized', message: 'request failed' } }, 401);
    events.push('read-finished');
    return reply({ schema_version: 1, kind: 'echo-clean-person-record-list-v1', records: [] });
  };
  const first = new PersonClient({ home_directory: home, now: () => now, fetch });
  const second = new PersonClient({ home_directory: home, now: () => now, fetch });
  const read = first.records();
  await started;
  const refresh = second.refresh();
  // Attach rejection handlers before testing the ordering, so a failed proof
  // still drains both operations and leaves no pending work behind.
  const settled = Promise.allSettled([read, refresh]);
  try {
    await setImmediate();
    expect(events).toEqual(['read-started']);
    releaseRead();
    const result = await settled;
    expect(result.map(value => value.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(events).toEqual(['read-started', 'read-finished', 'rotated']);
  } finally {
    releaseRead();
    await settled;
    rmSync(home, { recursive: true, force: true });
  }
});

it('coordinates a terminal read and desktop refresh in separate processes', async () => {
  const now = '2026-11-05T07:00:00.000Z';
  const home = signedInHome({ prefix: 'echo-refresh-processes-', now });
  const clientModuleUrl = new URL('../../src/product/person-client/dist/client.js', import.meta.url).href;
  const source = `
    import { PersonClient } from ${JSON.stringify(clientModuleUrl)};
    const [home, action, now] = process.argv.slice(1);
    const client = new PersonClient({ home_directory: home, now: () => now, fetch: async input => {
      const path = new URL(String(input)).pathname;
      if (path === '/v2/session/refresh') {
        process.send('rotated');
        const { PersonSessionStore } = await import(${JSON.stringify(new URL('../../src/product/person-client/dist/session-store.js', import.meta.url).href)});
        const { readFileSync } = await import('node:fs');
        const stored = JSON.parse(readFileSync(new PersonSessionStore(home).paths.refreshing, 'utf8'));
        return Response.json({ ...stored.session, access_token: 'B'.repeat(43), refresh_token: 'S'.repeat(43) });
      }
      process.send('reading');
      await new Promise(resolve => process.once('message', resolve));
      return Response.json({ schema_version: 1, kind: 'echo-clean-person-record-list-v1', records: [] });
    }});
    const pending = action === 'read' ? client.records() : client.refresh();
    process.send('started');
    try { await pending; process.send('finished'); process.disconnect(); }
    catch { process.send('failed'); process.exitCode = 1; process.disconnect(); }
  `;
  const children: ReturnType<typeof spawn>[] = [];
  const launch = (action: string) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source, home, action, now], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    children.push(child);
    return child;
  };
  try {
    const reader = launch('read');
    const events: string[] = [];
    reader.on('message', message => events.push(`read:${message}`));
    while (!events.includes('read:reading')) await once(reader, 'message');
    const writer = launch('refresh');
    writer.on('message', message => events.push(`refresh:${message}`));
    while (!events.includes('refresh:started')) await once(writer, 'message');
    expect(readdirSync(join(new PersonSessionStore(home).paths.directory, 'operations')).some(name => name.startsWith(`refresh-${writer.pid}-`))).toBe(true);
    expect(events).not.toContain('refresh:rotated');
    const exits = Promise.all(children.map(child => once(child, 'exit')));
    reader.send('finish');
    expect(await exits).toEqual([[0, null], [0, null]]);
    expect(events.indexOf('read:finished')).toBeLessThan(events.indexOf('refresh:rotated'));
  } finally {
    children.forEach(child => { if (child.exitCode === null) child.kill(); });
    rmSync(home, { recursive: true, force: true });
  }
});

it('allows concurrent reads and cancels a read waiting for refresh without sending it', async () => {
  const home = signedInHome({ prefix: 'echo-refresh-cancel-', now: '2026-11-05T07:00:00.000Z' });
  const gate = new PersonSessionOperations(new PersonSessionStore(home).paths.directory);
  let finish!: () => void;
  const hold = new Promise<void>(resolve => { finish = resolve; });
  let reads = 0;
  const first = gate.read(async () => { reads += 1; await hold; });
  const second = gate.read(async () => { reads += 1; await hold; });
  expect(reads).toBe(2);
  const refresh = gate.refresh(() => true, async () => undefined);
  const controller = new AbortController();
  let sent = false;
  const waiting = gate.read(async () => { sent = true; }, controller.signal);
  controller.abort();
  try {
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
    expect(sent).toBe(false);
  } finally {
    finish();
    await Promise.all([first, second, refresh]);
    expect(readdirSync(join(new PersonSessionStore(home).paths.directory, 'operations'))).toEqual([]);
    rmSync(home, { recursive: true, force: true });
  }
});

it('refreshes before a read whose remaining access lifetime is shorter than its request deadline', async () => {
  const home = signedInHome({ prefix: 'echo-refresh-headroom-', now: '2026-11-05T07:00:00.000Z' });
  const stored = new PersonSessionStore(home).read();
  const paths: string[] = [];
  const client = new PersonClient({ home_directory: home, now: () => '2026-11-05T07:09:50.000Z', fetch: async (input, init) => {
    const path = new URL(String(input)).pathname;
    paths.push(path);
    if (path === '/v2/session/refresh') return Response.json({ ...stored.session, access_token: 'B'.repeat(43), refresh_token: 'S'.repeat(43), access_expires_at: '2026-11-05T19:00:00.000Z' });
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${'B'.repeat(43)}`);
    return Response.json({ schema_version: 1, kind: 'echo-clean-person-record-list-v1', records: [] });
  } });
  try {
    await client.records();
    expect(paths).toEqual(['/v2/session/refresh', '/v1/person/records']);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

it('removes only a verified dead process entry and rejects an unsafe entry', async () => {
  const home = signedInHome({ prefix: 'echo-refresh-stale-', now: '2026-11-05T07:00:00.000Z' });
  const directory = new PersonSessionStore(home).paths.directory;
  const gate = new PersonSessionOperations(directory);
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await once(child, 'exit');
  try {
    await gate.read(async () => undefined); // Prepare the private directory.
    const operations = join(directory, 'operations');
    const stale = join(operations, `read-${child.pid}-00000000-0000-4000-8000-000000000001`);
    writeFileSync(stale, '', { mode: 0o600 });
    await gate.refresh(() => true, async () => undefined);
    expect(readdirSync(operations)).toEqual([]);
    writeFileSync(join(operations, `read-${process.pid}-00000000-0000-4000-8000-000000000002`), '', { mode: 0o644 });
    let sent = false;
    await expect(gate.read(async () => { sent = true; })).rejects.toThrow('Unsafe Person session operation');
    expect(sent).toBe(false);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

it('cancels an early refresh waiting for another read without claiming or rotating a credential', async () => {
  const home = signedInHome({ prefix: 'echo-refresh-wait-cancel-', now: '2026-11-05T07:00:00.000Z' });
  const stored = new PersonSessionStore(home).read();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void;
  const reading = new Promise<void>(resolve => { started = resolve; });
  const paths: string[] = [];
  const fetch: typeof globalThis.fetch = async input => {
    const path = new URL(String(input)).pathname;
    paths.push(path);
    if (path === '/v2/session/refresh') return Response.json({ ...stored.session, access_token: 'B'.repeat(43), refresh_token: 'S'.repeat(43), access_expires_at: '2026-11-05T19:00:00.000Z' });
    expect(path).toBe('/v1/person/records'); started(); await held;
    return Response.json({ schema_version: 1, kind: 'echo-clean-person-record-list-v1', records: [] });
  };
  const read = new PersonClient({ home_directory: home, now: () => '2026-11-05T07:00:00.000Z', fetch }).records();
  await reading;
  const controller = new AbortController();
  const ask = new PersonClient({ home_directory: home, now: () => '2026-11-05T07:09:00.000Z', fetch }).askWithLiveSources('What needs attention?', undefined, controller.signal);
  const outcome = ask.then(() => 'answered', error => error.name);
  try {
    await setImmediate();
    controller.abort();
    expect(await Promise.race([outcome, setTimeout(200).then(() => 'still waiting')])).toBe('AbortError');
    expect(paths).toEqual(['/v1/person/records']);
    expect(readdirSync(join(new PersonSessionStore(home).paths.directory, 'operations')).every(name => name.startsWith('read-'))).toBe(true);
  } finally {
    release(); await Promise.allSettled([read, ask]); rmSync(home, { recursive: true, force: true });
  }
});

it('finishes an already submitted refresh after cancellation without sending the cancelled Ask', async () => {
  const home = signedInHome({ prefix: 'echo-refresh-submitted-cancel-', now: '2026-11-05T07:00:00.000Z' });
  const store = new PersonSessionStore(home), stored = store.read();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void;
  const submitted = new Promise<void>(resolve => { started = resolve; });
  const paths: string[] = [];
  const client = new PersonClient({ home_directory: home, now: () => '2026-11-05T07:09:00.000Z', fetch: async input => {
    paths.push(new URL(String(input)).pathname); started(); await held;
    return Response.json({ ...stored.session, access_token: 'B'.repeat(43), refresh_token: 'S'.repeat(43), access_expires_at: '2026-11-05T19:00:00.000Z' });
  } });
  const controller = new AbortController();
  const ask = client.askWithLiveSources('What needs attention?', undefined, controller.signal);
  const rejected = expect(ask).rejects.toMatchObject({ name: 'AbortError' });
  try {
    await submitted; controller.abort(); release(); await rejected;
    expect(paths).toEqual(['/v2/session/refresh']);
    expect(store.read().session.access_token).toBe('B'.repeat(43));
  } finally { release(); await Promise.allSettled([ask]); rmSync(home, { recursive: true, force: true }); }
});

const records = () => Response.json({ schema_version: 1, kind: 'echo-clean-person-record-list-v1', records: [] });

it('keeps an entry whose process it may not signal until nobody renews it', async () => {
  const home = signedInHome({ prefix: 'echo-refresh-unsignalled-', now: '2026-11-05T07:00:00.000Z' });
  const directory = new PersonSessionStore(home).paths.directory;
  const gate = new PersonSessionOperations(directory);
  // A sandboxed client is refused (EPERM) even a live process of the same user, as it is another user's process.
  const unsignalled = 999_999;
  const kill = process.kill.bind(process);
  const spy = vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: string | number) => {
    if (pid === unsignalled) throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
    return kill(pid, signal);
  }) as typeof process.kill);
  const controller = new AbortController();
  try {
    await gate.read(async () => undefined); // Prepare the private directory.
    const operations = join(directory, 'operations');
    const entry = join(operations, `read-${unsignalled}-${randomUUID()}`);
    writeFileSync(entry, '', { mode: 0o600 });
    let refreshed = false;
    const refresh = gate.refresh(() => true, async () => { refreshed = true; }, controller.signal);
    refresh.catch(() => undefined);
    await setTimeout(200);
    expect(refreshed).toBe(false);
    expect(existsSync(entry)).toBe(true);
    const unrenewed = new Date(Date.now() - 11 * 60_000);
    utimesSync(entry, unrenewed, unrenewed);
    await refresh;
    expect(refreshed).toBe(true);
    expect(readdirSync(operations)).toEqual([]);
  } finally { controller.abort(); spy.mockRestore(); rmSync(home, { recursive: true, force: true }); }
});

it('removes an entry nobody renews, whatever process has its ID now', async () => {
  const home = signedInHome({ prefix: 'echo-refresh-unrenewed-', now: '2026-11-05T07:00:00.000Z' });
  const directory = new PersonSessionStore(home).paths.directory;
  const gate = new PersonSessionOperations(directory);
  const controller = new AbortController();
  try {
    await gate.read(async () => undefined); // Prepare the private directory.
    const operations = join(directory, 'operations');
    // This test's own process stands in for a live process that reused a crashed client's PID.
    const left = join(operations, `read-${process.pid}-${randomUUID()}`);
    writeFileSync(left, '', { mode: 0o600 });
    const unrenewed = new Date(Date.now() - 11 * 60_000);
    utimesSync(left, unrenewed, unrenewed);
    const refresh = gate.refresh(() => true, async () => 'refreshed', controller.signal);
    refresh.catch(() => undefined);
    await expect(Promise.race([refresh, setTimeout(1_000, 'still waiting')])).resolves.toBe('refreshed');
    expect(readdirSync(operations)).toEqual([]);
  } finally { controller.abort(); rmSync(home, { recursive: true, force: true }); }
});

it('keeps an entry whose owner stalled for minutes, as on a slow file', async () => {
  const home = signedInHome({ prefix: 'echo-refresh-stalled-owner-', now: '2026-11-05T07:00:00.000Z' });
  const directory = new PersonSessionStore(home).paths.directory;
  const gate = new PersonSessionOperations(directory);
  const controller = new AbortController();
  try {
    await gate.read(async () => undefined); // Prepare the private directory.
    const operations = join(directory, 'operations');
    // Another live client whose event loop has blocked its renewals for five minutes.
    const stalled = join(operations, `read-${process.pid}-${randomUUID()}`);
    writeFileSync(stalled, '', { mode: 0o600 });
    const renewed = new Date(Date.now() - 5 * 60_000);
    utimesSync(stalled, renewed, renewed);
    let refreshed = false;
    const refresh = gate.refresh(() => true, async () => { refreshed = true; }, controller.signal);
    refresh.catch(() => undefined);
    await setTimeout(200);
    expect(refreshed).toBe(false);
    expect(existsSync(stalled)).toBe(true);
  } finally { controller.abort(); rmSync(home, { recursive: true, force: true }); }
});

it('lets the first refresh after a crash proceed once the left entry goes unrenewed', async () => {
  const home = signedInHome({ prefix: 'echo-refresh-after-crash-', now: '2026-11-05T07:00:00.000Z' });
  const directory = new PersonSessionStore(home).paths.directory;
  const gate = new PersonSessionOperations(directory);
  try {
    await gate.read(async () => undefined); // Prepare the private directory.
    const operations = join(directory, 'operations');
    // Left by a crash a moment ago; this test's own live process stands in for whatever has its PID now.
    writeFileSync(join(operations, `read-${process.pid}-${randomUUID()}`), '', { mode: 0o600 });
    const refresh = gate.refresh(() => true, async () => 'refreshed');
    await setTimeout(100);
    // Ten and a half minutes pass: the left entry missed its renewals, and the refresh's own entry stays.
    const realNow = Date.now.bind(Date);
    vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 10.5 * 60_000);
    await expect(refresh).resolves.toBe('refreshed');
    expect(readdirSync(operations)).toEqual([]);
  } finally { vi.restoreAllMocks(); rmSync(home, { recursive: true, force: true }); }
});

it('renews its own entries while their operations run', async () => {
  const home = signedInHome({ prefix: 'echo-refresh-renewed-', now: '2026-11-05T07:00:00.000Z' });
  const directory = new PersonSessionStore(home).paths.directory;
  const gate = new PersonSessionOperations(directory);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void;
  const reading = new Promise<void>(resolve => { started = resolve; });
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const read = gate.read(async () => { started(); await held; });
  try {
    await reading;
    const operations = join(directory, 'operations');
    const [name] = readdirSync(operations);
    const unrenewed = new Date(Date.now() - 10 * 60_000);
    utimesSync(join(operations, name!), unrenewed, unrenewed);
    vi.advanceTimersByTime(30_000);
    expect(lstatSync(join(operations, name!)).mtimeMs).toBeGreaterThan(Date.now() - 5_000);
  } finally {
    release();
    await read;
    vi.useRealTimers();
    rmSync(home, { recursive: true, force: true });
  }
});

it('ignores a file in the operations directory that no client wrote', async () => {
  const now = '2026-11-05T07:00:00.000Z';
  const home = signedInHome({ prefix: 'echo-refresh-foreign-file-', now });
  const client = new PersonClient({ home_directory: home, now: () => now, fetch: async () => records() });
  try {
    await client.records();
    const foreign = join(new PersonSessionStore(home).paths.directory, 'operations', '.DS_Store');
    writeFileSync(foreign, 'x', { mode: 0o644 });
    await client.records();
    expect(existsSync(foreign)).toBe(true);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

it('clears every operation entry when someone signs in again or signs out', async () => {
  const now = '2026-11-05T07:00:00.000Z';
  const home = signedInHome({ prefix: 'echo-refresh-clear-', now });
  const store = new PersonSessionStore(home);
  const saved = store.read();
  const operations = join(store.paths.directory, 'operations');
  const client = new PersonClient({ home_directory: home, now: () => now, fetch: async input =>
    new URL(String(input)).pathname === '/v2/session/revocations' ? new Response(null, { status: 204 }) : records() });
  const unsafe = () => writeFileSync(join(operations, `read-${process.pid}-${randomUUID()}`), '', { mode: 0o644 });
  try {
    await client.records();
    unsafe();
    await expect(client.records()).rejects.toThrow('Unsafe Person session operation');
    store.install(saved.authority_origin, saved.authority_id, saved.session);
    expect(existsSync(operations)).toBe(false);
    await client.records();
    unsafe();
    await client.logout();
    expect(existsSync(operations)).toBe(false);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

it('returns a read\'s result after signing in again cleared its entry', async () => {
  const home = signedInHome({ prefix: 'echo-refresh-cleared-read-', now: '2026-11-05T07:00:00.000Z' });
  const store = new PersonSessionStore(home);
  const saved = store.read();
  const gate = new PersonSessionOperations(store.paths.directory);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void;
  const reading = new Promise<void>(resolve => { started = resolve; });
  const read = gate.read(async () => { started(); await held; return 'result'; });
  try {
    await reading;
    store.install(saved.authority_origin, saved.authority_id, saved.session);
    release();
    await expect(read).resolves.toBe('result');
  } finally { release(); await Promise.allSettled([read]); rmSync(home, { recursive: true, force: true }); }
});

it('registers a refresh again when signing in or out cleared its intent, and waits for reads begun since', async () => {
  const home = signedInHome({ prefix: 'echo-refresh-cleared-intent-', now: '2026-11-05T07:00:00.000Z' });
  const directory = new PersonSessionStore(home).paths.directory;
  const operations = join(directory, 'operations');
  const order: string[] = [];
  // Another client's refresh holds the single-use claim; this one waits its turn.
  let releaseOther!: () => void;
  const otherHeld = new Promise<void>(resolve => { releaseOther = resolve; });
  let otherStarted!: () => void;
  const otherRefreshing = new Promise<void>(resolve => { otherStarted = resolve; });
  const other = new PersonSessionOperations(directory).refresh(() => true, async () => { otherStarted(); await otherHeld; });
  await otherRefreshing;
  let free = false;
  const refresh = new PersonSessionOperations(directory).refresh(() => (free ? true : undefined), async () => { order.push('rotated'); });
  let releaseRead!: () => void;
  const readHeld = new Promise<void>(resolve => { releaseRead = resolve; });
  let read: Promise<void> | undefined;
  try {
    await setTimeout(100); // The refresh waits for the claim.
    rmSync(operations, { recursive: true, force: true }); // Signing in or out clears every entry.
    read = new PersonSessionOperations(directory).read(async () => { order.push('read-started'); await readHeld; order.push('read-finished'); });
    free = true;
    await setTimeout(100);
    expect(order).toEqual(['read-started']);
    expect(readdirSync(operations).some(name => name.startsWith('refresh-'))).toBe(true);
    releaseRead();
    await refresh;
    expect(order).toEqual(['read-started', 'read-finished', 'rotated']);
  } finally {
    releaseRead(); releaseOther();
    await Promise.allSettled([other, refresh, read]);
    rmSync(home, { recursive: true, force: true });
  }
});

it('ends a refresh queued behind one the Authority refused as signed out, leaving no claim', async () => {
  const now = '2026-11-05T07:00:00.000Z';
  const home = signedInHome({ prefix: 'echo-refresh-queued-refused-', now });
  const store = new PersonSessionStore(home);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let sent!: () => void;
  const firstSent = new Promise<void>(resolve => { sent = resolve; });
  let refreshes = 0;
  const fetch: typeof globalThis.fetch = async input => {
    expect(new URL(String(input)).pathname).toBe('/v2/session/refresh');
    refreshes += 1; sent(); await held;
    return Response.json({ error: { code: 'unauthorized', message: 'person authentication failed' } }, { status: 401 });
  };
  const first = new PersonClient({ home_directory: home, now: () => now, fetch }).refresh();
  await firstSent;
  const second = new PersonClient({ home_directory: home, now: () => now, fetch }).refresh();
  const settled = Promise.allSettled([first, second]);
  try {
    await setTimeout(100); // The second waits for the first's single-use claim.
    release();
    const [, queued] = await settled;
    const reason = queued.status === 'rejected' ? queued.reason : undefined;
    expect(reason).toBeInstanceOf(PersonClientSessionUnavailableError);
    expect((reason as PersonClientSessionUnavailableError).code).toBe('sign_in_required');
    expect(refreshes).toBe(1);
    expect([store.paths.live, store.paths.refreshing, store.paths.refresh_claim].filter(existsSync)).toEqual([]);
  } finally { release(); await settled; rmSync(home, { recursive: true, force: true }); }
});

it('ends a refresh that waited for a read while the person signed out as signed out, leaving no claim', async () => {
  const now = '2026-11-05T07:00:00.000Z';
  const home = signedInHome({ prefix: 'echo-refresh-queued-logout-', now });
  const store = new PersonSessionStore(home);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void;
  const reading = new Promise<void>(resolve => { started = resolve; });
  const fetch: typeof globalThis.fetch = async input => {
    const path = new URL(String(input)).pathname;
    if (path === '/v2/session/revocations') return new Response(null, { status: 204 });
    expect(path).toBe('/v1/person/records');
    started(); await held;
    return records();
  };
  const read = new PersonClient({ home_directory: home, now: () => now, fetch }).records();
  await reading;
  const refresh = new PersonClient({ home_directory: home, now: () => now, fetch }).refresh();
  const settled = Promise.allSettled([read, refresh]);
  try {
    await setTimeout(50); // The refresh waits for the read.
    await new PersonClient({ home_directory: home, now: () => now, fetch }).logout();
    release();
    const [, waited] = await settled;
    const reason = waited.status === 'rejected' ? waited.reason : undefined;
    expect(reason).toBeInstanceOf(PersonClientSessionUnavailableError);
    expect([store.paths.live, store.paths.refreshing, store.paths.refresh_claim].filter(existsSync)).toEqual([]);
    await expect(new PersonClient({ home_directory: home, now: () => now, fetch }).refresh())
      .rejects.toThrow('Person session is unavailable; sign in again');
  } finally { release(); await settled; rmSync(home, { recursive: true, force: true }); }
});

it('reports a wait that runs out as ECHO unavailable, not as a sign-in requirement', async () => {
  const now = '2026-11-05T07:00:00.000Z';
  const home = signedInHome({ prefix: 'echo-refresh-wait-deadline-', now });
  const directory = new PersonSessionStore(home).paths.directory;
  let sent = false;
  const client = new PersonClient({ home_directory: home, now: () => now, fetch: async () => { sent = true; return records(); } });
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void;
  const refreshing = new Promise<void>(resolve => { started = resolve; });
  // Another client's refresh, still running when this request's wait runs out.
  const refresh = new PersonSessionOperations(directory).refresh(() => true, async () => { started(); await held; });
  await refreshing;
  const settled = Promise.allSettled([refresh]);
  try {
    const create = client.context('createProject', { schema_version: 1, kind: 'echo-project-create-v1', request_id: randomUUID(), name: 'Waiting project' });
    const failed = create.then(() => undefined, (error: unknown) => error as PersonContextMutationError);
    await setTimeout(50);
    const realNow = Date.now.bind(Date);
    vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 11.5 * 60_000);
    const error = await failed;
    expect({ name: error?.name, code: error?.code, outcome: error?.mutation_outcome })
      .toEqual({ name: 'PersonContextMutationError', code: 'unavailable', outcome: 'not_submitted' });
    expect(sent).toBe(false);
  } finally { vi.restoreAllMocks(); release(); await settled; rmSync(home, { recursive: true, force: true }); }
});
