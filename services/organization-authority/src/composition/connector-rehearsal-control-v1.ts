import { createServer, request as requestHttp, type Server } from 'node:http';
import type { Socket } from 'node:net';
import {
  chmodSync,
  lstatSync,
  unlinkSync,
} from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

const MAXIMUM_REQUEST_BYTES = 16 * 1024;
const MAXIMUM_RESPONSE_BYTES = 64 * 1024;
const SERVER_DEADLINE_MS = 120_000;
const CLIENT_DEADLINE_MS = 120_000;
const FAILURE = Object.freeze({
  schema_version: 1,
  ok: false,
  error: 'connector_rehearsal_control_failed',
});

export interface ConnectorRehearsalControlServerV1 {
  close(): Promise<void>;
}

export interface OpenConnectorRehearsalControlInputV1 {
  readonly socket_path: string;
  readonly handle: (input: unknown, signal: AbortSignal) => Promise<unknown>;
  readonly signal?: AbortSignal;
}

export interface RequestConnectorRehearsalControlInputV1 {
  readonly socket_path: string;
  readonly input: unknown;
  readonly signal?: AbortSignal;
}

interface SocketIdentity {
  readonly dev: number;
  readonly ino: number;
}

function failed(): Error {
  return new Error('Connector rehearsal control request failed');
}

function currentUid(): number {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error('Connector rehearsal control requires a local user');
  return uid;
}

function assertCanonicalSocketPath(path: string): string {
  if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path || path === resolve('/')) {
    throw new Error('Connector rehearsal control socket path is invalid');
  }
  return path;
}

function assertPrivateParent(path: string): void {
  const parent = dirname(path);
  let state;
  try {
    state = lstatSync(parent);
  } catch {
    throw new Error('Connector rehearsal control socket parent is unavailable');
  }
  if (
    state.isSymbolicLink() ||
    !state.isDirectory() ||
    state.uid !== currentUid() ||
    (state.mode & 0o777) !== 0o700
  ) {
    throw new Error('Connector rehearsal control socket parent is not private');
  }
}

function assertSocketAbsent(path: string): void {
  try {
    lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new Error('Connector rehearsal control socket is unavailable');
  }
  throw new Error('Connector rehearsal control socket already exists');
}

function checkedSocket(path: string): SocketIdentity {
  assertPrivateParent(path);
  let state;
  try {
    state = lstatSync(path);
  } catch {
    throw failed();
  }
  if (!state.isSocket() || state.uid !== currentUid() || (state.mode & 0o777) !== 0o600) {
    throw failed();
  }
  return Object.freeze({ dev: state.dev, ino: state.ino });
}

function json(value: unknown, maximum: number): Buffer {
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw failed();
  }
  if (encoded === undefined || Buffer.byteLength(encoded, 'utf8') > maximum) throw failed();
  return Buffer.from(encoded, 'utf8');
}

function send(response: import('node:http').ServerResponse, status: number, value: unknown): void {
  let body: Buffer;
  try {
    body = json(value, MAXIMUM_RESPONSE_BYTES);
  } catch {
    body = Buffer.from(JSON.stringify(FAILURE), 'utf8');
    status = 500;
  }
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.byteLength),
    'cache-control': 'no-store',
  });
  response.end(body);
}

interface RequestScope {
  readonly signal: AbortSignal;
  dispose(): void;
}

function requestSignal(request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse, parent: AbortSignal | undefined): RequestScope {
  const abort = new AbortController();
  const deadline = AbortSignal.timeout(SERVER_DEADLINE_MS);
  const signal = parent === undefined ? AbortSignal.any([abort.signal, deadline]) : AbortSignal.any([abort.signal, deadline, parent]);
  const stop = () => abort.abort(new DOMException('Cancelled', 'AbortError'));
  const destroy = () => {
    if (!request.destroyed) request.destroy();
  };
  const responseClosed = () => {
    if (!response.writableEnded) stop();
  };
  request.once('aborted', stop);
  response.once('close', responseClosed);
  signal.addEventListener('abort', destroy, { once: true });
  return Object.freeze({
    signal,
    dispose() {
      request.removeListener('aborted', stop);
      response.removeListener('close', responseClosed);
      signal.removeEventListener('abort', destroy);
    },
  });
}

async function readRequest(request: import('node:http').IncomingMessage, signal: AbortSignal): Promise<unknown> {
  if (request.method !== 'POST' || request.url !== '/') throw failed();
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    signal.throwIfAborted();
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += value.byteLength;
    if (bytes > MAXIMUM_REQUEST_BYTES) throw failed();
    chunks.push(value);
  }
  signal.throwIfAborted();
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw failed();
  }
}

function listen(server: Server, path: string): Promise<void> {
  return new Promise((resolveListen, rejectListen) => {
    const reject = () => rejectListen(new Error('Connector rehearsal control socket could not start'));
    server.once('error', reject);
    server.listen(path, () => {
      server.removeListener('error', reject);
      resolveListen();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolveClose) => {
    server.close(() => resolveClose());
  });
}

/**
 * Starts one private, local-only control socket. The caller owns authorization
 * and response shape; this transport never logs request or response bodies.
 */
export async function openConnectorRehearsalControlV1(
  input: OpenConnectorRehearsalControlInputV1,
): Promise<ConnectorRehearsalControlServerV1> {
  if (input === null || typeof input !== 'object' || typeof input.handle !== 'function') {
    throw new Error('Connector rehearsal control configuration is invalid');
  }
  const socketPath = assertCanonicalSocketPath(input.socket_path);
  assertPrivateParent(socketPath);
  assertSocketAbsent(socketPath);
  input.signal?.throwIfAborted();
  const inFlight = new Set<Promise<void>>();
  const stopping = new AbortController();
  const connections = new Set<Socket>();
  const server = createServer((request, response) => {
    const operation = (async () => {
      const scope = requestSignal(request, response, input.signal === undefined
        ? stopping.signal
        : AbortSignal.any([stopping.signal, input.signal]));
      try {
        const body = await readRequest(request, scope.signal);
        scope.signal.throwIfAborted();
        const result = await input.handle(body, scope.signal);
        scope.signal.throwIfAborted();
        send(response, 200, { schema_version: 1, ok: true, result });
      } catch {
        if (!response.writableEnded && !response.destroyed) send(response, 500, FAILURE);
      } finally {
        scope.dispose();
      }
    })();
    inFlight.add(operation);
    void operation.finally(() => inFlight.delete(operation));
  });
  server.on('connection', (connection) => {
    connections.add(connection);
    connection.once('close', () => connections.delete(connection));
  });
  try {
    await listen(server, socketPath);
    chmodSync(socketPath, 0o600);
  } catch (error) {
    try { await closeServer(server); } catch { /* no listener may have started */ }
    throw error instanceof Error && error.message === 'Connector rehearsal control socket could not start'
      ? error
      : new Error('Connector rehearsal control socket could not start');
  }
  const ownedSocket = checkedSocket(socketPath);
  let closed: Promise<void> | undefined;
  return Object.freeze({
    close(): Promise<void> {
      if (closed !== undefined) return closed;
      closed = (async () => {
        stopping.abort(new DOMException('Closed', 'AbortError'));
        // Stop accepting before waiting for cooperative handlers. A close
        // caller must never leave a window for another control request.
        const serverClosed = closeServer(server);
        const deadline = AbortSignal.timeout(SERVER_DEADLINE_MS);
        const settled = Promise.allSettled([...inFlight]);
        const settledBeforeDeadline = await Promise.race([
          settled.then(() => true),
          new Promise<boolean>((resolveDeadline) => deadline.addEventListener('abort', () => resolveDeadline(false), { once: true })),
        ]);
        if (!settledBeforeDeadline) {
          for (const connection of connections) connection.destroy();
        }
        await serverClosed;
        try {
          const current = lstatSync(socketPath);
          if (current.isSocket() && current.uid === currentUid() && current.dev === ownedSocket.dev && current.ino === ownedSocket.ino) {
            unlinkSync(socketPath);
          }
        } catch {
          // A replaced or already-removed path is deliberately left alone.
        }
      })();
      return closed;
    },
  });
}

/** Sends one bounded JSON request to a private rehearsal control socket. */
export async function requestConnectorRehearsalControlV1(
  input: RequestConnectorRehearsalControlInputV1,
): Promise<unknown> {
  let socketPath: string;
  let body: Buffer;
  try {
    if (input === null || typeof input !== 'object') throw new Error('invalid');
    socketPath = assertCanonicalSocketPath(input.socket_path);
    checkedSocket(socketPath);
    input.signal?.throwIfAborted();
    body = json(input.input, MAXIMUM_REQUEST_BYTES);
  } catch {
    throw failed();
  }
  const deadline = AbortSignal.timeout(CLIENT_DEADLINE_MS);
  const signal = input.signal === undefined ? deadline : AbortSignal.any([input.signal, deadline]);
  return await new Promise<unknown>((resolveRequest, rejectRequest) => {
    let complete = false;
    const finish = (operation: () => void): void => {
      if (complete) return;
      complete = true;
      signal.removeEventListener('abort', abort);
      operation();
    };
    // A rehearsal may stop and reopen at the same socket path. Never reuse an
    // idle connection belonging to the previous Authority process.
    const request = requestHttp({ socketPath, agent: false, path: '/', method: 'POST', headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-length': String(body.byteLength),
    } }, (response) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on('data', (chunk: Buffer | string) => {
        const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += value.byteLength;
        if (bytes > MAXIMUM_RESPONSE_BYTES) request.destroy(failed());
        else chunks.push(value);
      });
      response.once('error', () => finish(() => rejectRequest(failed())));
      response.once('end', () => {
        if (bytes > MAXIMUM_RESPONSE_BYTES || response.statusCode !== 200) {
          finish(() => rejectRequest(failed()));
          return;
        }
        try {
          const decoded = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
          if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) throw new Error('invalid');
          const record = decoded as Record<string, unknown>;
          if (record.schema_version !== 1 || record.ok !== true || Object.keys(record).sort().join(',') !== 'ok,result,schema_version') throw new Error('invalid');
          finish(() => resolveRequest(record.result));
        } catch {
          finish(() => rejectRequest(failed()));
        }
      });
    });
    const abort = () => request.destroy(failed());
    signal.addEventListener('abort', abort, { once: true });
    request.once('error', () => finish(() => rejectRequest(failed())));
    request.end(body);
  });
}
