import { readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { PersonClient } from '../../src/product/person-client/client.js';
import { PersonSessionStore } from '../../src/product/person-client/session-store.js';
import { signedInHome } from './signed-in-home.js';
import { PersonSessionOperations } from '../../src/product/person-client/session-operations.js';

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
