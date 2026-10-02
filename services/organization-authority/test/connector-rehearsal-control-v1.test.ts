import { chmodSync, existsSync, lstatSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { request as requestHttp } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  openConnectorRehearsalControlV1,
  requestConnectorRehearsalControlV1,
} from '../src/composition/connector-rehearsal-control-v1.js';

const directories: string[] = [];

function socketPath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'echo-rehearsal-control-'));
  chmodSync(directory, 0o700);
  directories.push(directory);
  return join(directory, 'control.sock');
}

afterEach(() => {
  while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true });
});

describe('connector rehearsal control V1', () => {
  it('passes one bounded JSON body over a current-user private socket and removes it at close', async () => {
    const socket_path = socketPath();
    const handle = vi.fn(async (input: unknown) => ({ receipt: (input as { command: string }).command }));
    const server = await openConnectorRehearsalControlV1({ socket_path, handle });
    const state = lstatSync(socket_path);
    expect(state.isSocket()).toBe(true);
    expect(state.uid).toBe(process.getuid?.());
    expect(state.mode & 0o777).toBe(0o600);

    await expect(requestConnectorRehearsalControlV1({ socket_path, input: { command: 'capture', access_token: 'private-token' } }))
      .resolves.toEqual({ receipt: 'capture' });
    expect(handle).toHaveBeenCalledWith({ command: 'capture', access_token: 'private-token' }, expect.any(AbortSignal));

    await server.close();
    expect(existsSync(socket_path)).toBe(false);
  });

  it('rejects oversized bodies and returns fixed errors without provider text', async () => {
    const socket_path = socketPath();
    const handle = vi.fn(async () => { throw new Error('provider body contains private meeting text'); });
    const server = await openConnectorRehearsalControlV1({ socket_path, handle });
    await expect(requestConnectorRehearsalControlV1({ socket_path, input: { body: 'x'.repeat(16 * 1024) } }))
      .rejects.toThrow('Connector rehearsal control request failed');
    expect(handle).not.toHaveBeenCalled();
    await expect(requestConnectorRehearsalControlV1({ socket_path, input: { command: 'capture' } }))
      .rejects.toThrow('Connector rehearsal control request failed');
    const aborted = new AbortController();
    aborted.abort(new Error('private cancellation detail'));
    await expect(requestConnectorRehearsalControlV1({ socket_path, input: {}, signal: aborted.signal }))
      .rejects.toThrow('Connector rehearsal control request failed');
    await server.close();
  });

  it('aborts an in-flight provider operation when the caller disconnects', async () => {
    const socket_path = socketPath();
    let began!: () => void;
    const started = new Promise<void>(resolve => { began = resolve; });
    const server = await openConnectorRehearsalControlV1({
      socket_path,
      handle: async (_input, signal) => {
        began();
        await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
        return {};
      },
    });
    const controller = new AbortController();
    const pending = requestConnectorRehearsalControlV1({ socket_path, input: { command: 'capture' }, signal: controller.signal });
    await started;
    controller.abort(new DOMException('Cancelled', 'AbortError'));
    await expect(pending).rejects.toThrow('Connector rehearsal control request failed');
    await server.close();
  });

  it('refuses a symlinked socket parent before connecting', async () => {
    const socket_path = socketPath();
    const server = await openConnectorRehearsalControlV1({ socket_path, handle: async () => ({ ok: true }) });
    const aliasParent = mkdtempSync(join(tmpdir(), 'echo-rehearsal-control-alias-'));
    directories.push(aliasParent);
    const alias = join(aliasParent, 'private');
    symlinkSync(join(socket_path, '..'), alias);
    await expect(requestConnectorRehearsalControlV1({ socket_path: join(alias, 'control.sock'), input: {} }))
      .rejects.toThrow('Connector rehearsal control request failed');
    await server.close();
  });

  it('stops accepting and aborts a partial request while close waits for handlers', async () => {
    const socket_path = socketPath();
    const server = await openConnectorRehearsalControlV1({ socket_path, handle: async () => ({ ok: true }) });
    const partial = requestHttp({ socketPath: socket_path, path: '/', method: 'POST', headers: { 'content-length': '100' } });
    partial.on('error', () => undefined);
    partial.write('{"partial":');
    const closing = server.close();
    await expect(requestConnectorRehearsalControlV1({ socket_path, input: {} }))
      .rejects.toThrow('Connector rehearsal control request failed');
    await expect(Promise.race([
      closing,
      new Promise<void>((_resolve, reject) => setTimeout(() => reject(new Error('control close timed out')), 1_000)),
    ])).resolves.toBeUndefined();
  });
});
