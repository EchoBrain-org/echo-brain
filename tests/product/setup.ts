import dgram from 'node:dgram';
import dns from 'node:dns';
import http from 'node:http';
import http2 from 'node:http2';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import tls from 'node:tls';
import { afterAll, beforeEach } from 'vitest';
import { installSanitizedChildGuard } from '../../src/product/spawn-sanitized-child.js';

const CREDENTIAL_KEY =
  /(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|GRANOLA|ANTHROPIC|OPENAI)/i;
const BLOCKED_NETWORK_MESSAGE = 'product hermeticity guard blocked an outbound-capable network API';

declare global {
  var __ECHO_PRODUCT_HERMETICITY_GUARD__:
    | {
        active: true;
        intercepted: readonly string[];
      }
    | undefined;
  var __ECHO_PRODUCT_ARTIFACT_DIR__: string | undefined;
}

type MutableRecord = Record<PropertyKey, unknown>;

function blockedNetwork(): never {
  throw new Error(BLOCKED_NETWORK_MESSAGE);
}

function replaceFunction(
  target: MutableRecord,
  key: PropertyKey,
  replacement: (...args: never[]) => never,
): () => void {
  const original = target[key];
  target[key] = replacement;
  return () => {
    target[key] = original;
  };
}

const originalEnvironment = process.env;
const environmentSnapshot = { ...originalEnvironment };
globalThis.__ECHO_PRODUCT_ARTIFACT_DIR__ = originalEnvironment.ECHO_PRODUCT_ARTIFACT_DIR;
for (const key of Object.keys(originalEnvironment)) {
  if (key.startsWith('ECHO_') || CREDENTIAL_KEY.test(key)) delete originalEnvironment[key];
}
process.env = new Proxy(originalEnvironment, {
  get(target, property, receiver) {
    if (typeof property === 'string' && CREDENTIAL_KEY.test(property)) {
      throw new Error(
        `product hermeticity guard blocked credential environment access: ${property}`,
      );
    }
    return Reflect.get(target, property, receiver);
  },
});

const restorers: Array<() => void> = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = blockedNetwork;
restorers.push(() => {
  globalThis.fetch = originalFetch;
});

restorers.push(
  replaceFunction(net.Socket.prototype as unknown as MutableRecord, 'connect', blockedNetwork),
  replaceFunction(tls as unknown as MutableRecord, 'connect', blockedNetwork),
  replaceFunction(http as unknown as MutableRecord, 'request', blockedNetwork),
  replaceFunction(http as unknown as MutableRecord, 'get', blockedNetwork),
  replaceFunction(https as unknown as MutableRecord, 'request', blockedNetwork),
  replaceFunction(https as unknown as MutableRecord, 'get', blockedNetwork),
  replaceFunction(http2 as unknown as MutableRecord, 'connect', blockedNetwork),
  replaceFunction(dgram as unknown as MutableRecord, 'createSocket', blockedNetwork),
  replaceFunction(dns as unknown as MutableRecord, 'lookup', blockedNetwork),
);

for (const [key, value] of Object.entries(dns.promises)) {
  if (typeof value === 'function') {
    restorers.push(replaceFunction(dns.promises as unknown as MutableRecord, key, blockedNetwork));
  }
}
syncBuiltinESMExports();

const restoreChildProcess = installSanitizedChildGuard();
globalThis.__ECHO_PRODUCT_HERMETICITY_GUARD__ = {
  active: true,
  intercepted: [
    'fetch',
    'net.Socket.connect',
    'tls.connect',
    'http.request',
    'https.request',
    'http2.connect',
    'dgram.createSocket',
    'dns.lookup',
    'dns.promises',
    'child_process.spawn',
    'child_process.exec',
    'child_process.execFile',
    'child_process.fork',
  ],
};

beforeEach(() => {
  if (globalThis.__ECHO_PRODUCT_HERMETICITY_GUARD__?.active !== true) {
    throw new Error('product hermeticity setup is not active for this test file');
  }
});

afterAll(() => {
  restoreChildProcess();
  for (const restore of restorers.reverse()) restore();
  syncBuiltinESMExports();
  process.env = originalEnvironment;
  for (const key of Object.keys(originalEnvironment)) delete originalEnvironment[key];
  Object.assign(originalEnvironment, environmentSnapshot);
  delete globalThis.__ECHO_PRODUCT_HERMETICITY_GUARD__;
  delete globalThis.__ECHO_PRODUCT_ARTIFACT_DIR__;
});
