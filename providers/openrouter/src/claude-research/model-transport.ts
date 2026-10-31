import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { request } from 'node:https';
import { randomBytes } from 'node:crypto';
import { messageUsageObserverV1, type ClaudeMessageMetadataV1 } from './message-usage.js';
import { observeCoreModelMetadataV1, observeCoreRuntimeV1, annotateCoreRuntimeV1 } from '@echo-brain/organization-authority-kernel/shared/core-runtime-observation-v1';

interface ClaudeModelForwardV1 {
  readonly req: IncomingMessage; readonly res: ServerResponse; readonly body: Buffer; readonly path: string; readonly signal: AbortSignal;
}
export type ClaudeModelForwarderV1 = (input: ClaudeModelForwardV1) => Promise<ClaudeMessageMetadataV1>;

/** The SDK already received this HTTP response and owns its retry policy. The shared limiter still observes the failure. */
export class ClaudeModelResponseErrorV1 extends Error {
  readonly diagnostic;
  constructor(status: number) {
    super('Research provider request failed');
    this.diagnostic = { failure_class: 'adapter_http' as const, http_status: status };
  }
}

/** Content-free network failure; the SDK may retry through fresh admission. */
export class ClaudeModelTransportErrorV1 extends Error {
  readonly diagnostic = { failure_class: 'adapter_transport' as const, http_status: null };
  constructor() { super('Research provider transport failed'); }
}

/** Fixed upstream, no redirects; the service credential never enters the SDK child, logs or returned errors. */
export function openRouterClaudeForwarderV1(credential: () => string, model: string): ClaudeModelForwarderV1 {
  return providerForwarderV1({ model, provider: 'openrouter', hostname: 'openrouter.ai', path_prefix: '/api',
    authorization: () => `Bearer ${credential()}` });
}

/** The user's native Claude process supplies its own auth; it is forwarded only to Anthropic and never retained. */
export function claudeAccountForwarderV1(model: string): ClaudeModelForwarderV1 {
  return providerForwarderV1({ model, provider: 'anthropic', hostname: 'api.anthropic.com', path_prefix: '',
    authorization: req => {
      const value = req.headers.authorization;
      if (typeof value !== 'string' || !value.startsWith('Bearer ') || value === 'Bearer echo-loopback-only' || req.headers['x-api-key'] !== undefined) {
        throw new Error('Personal Claude authentication unavailable');
      }
      return value;
    } });
}

function providerForwarderV1(options: {
  readonly model: string; readonly provider: 'openrouter' | 'anthropic';
  readonly hostname: string; readonly path_prefix: string;
  readonly authorization: (req: IncomingMessage) => string;
}): ClaudeModelForwarderV1 {
  const { model, provider } = options;
  return input => observeCoreRuntimeV1('model_call', async () => {
    observeCoreModelMetadataV1({ provider, model });
    const result = await new Promise<ClaudeMessageMetadataV1>((resolve, reject) => {
      const transportFailed = () => reject(input.signal.aborted ? input.signal.reason : new ClaudeModelTransportErrorV1());
      const headers: Record<string, string> = { authorization: options.authorization(input.req), 'content-type': 'application/json',
        'content-length': String(input.body.length), 'accept-encoding': 'identity' };
      for (const key of ['anthropic-version', 'anthropic-beta', ...(provider === 'anthropic' ? ['user-agent', 'x-app'] : [])]) {
        const value = input.req.headers[key]; if (typeof value === 'string') headers[key] = value;
      }
      const upstream = request({ hostname: options.hostname, port: 443, method: 'POST', path: `${options.path_prefix}${input.path}`, headers, signal: input.signal }, reply => {
        annotateCoreRuntimeV1({ counts: { http_status: reply.statusCode ?? 0 } });
        const usage = messageUsageObserverV1(true);
        reply.on('data', chunk => usage.write(chunk));
        input.res.writeHead(reply.statusCode ?? 502, { 'content-type': reply.headers['content-type'] ?? 'application/json' });
        reply.pipe(input.res);
        reply.on('end', () => {
          const status = reply.statusCode ?? 502;
          if (status >= 400) reject(new ClaudeModelResponseErrorV1(status));
          else resolve(usage.end());
        });
        reply.on('error', transportFailed);
        reply.on('aborted', transportFailed);
      });
      upstream.on('error', transportFailed);
      upstream.end(input.body);
    });
    observeCoreModelMetadataV1({ provider, model, ...(result.finish_reason === undefined ? {} : { finish_reason: result.finish_reason }) });
    if (result.usage !== undefined) annotateCoreRuntimeV1({ counts: { ...result.usage } });
    return result;
  });
}

/** Request-local gateway: only model endpoints, with an exact-body admission before forwarding any bytes. */
export async function startClaudeModelTransportV1(input: {
  readonly signal: AbortSignal;
  readonly forward: ClaudeModelForwarderV1;
  readonly admit: (body: Buffer, operation: 'messages' | 'count_tokens', forward: (signal: AbortSignal) => Promise<ClaudeMessageMetadataV1>) => Promise<unknown>;
}) {
  input.signal.throwIfAborted();
  const prefix = `/${randomBytes(24).toString('hex')}`, pending = new Set<AbortController>();
  let stopped = false, forwarded = 0;
  const server = createServer(async (req, res) => {
    let url: URL;
    try { url = new URL(req.url ?? '', 'http://127.0.0.1'); }
    catch { res.writeHead(404); res.end(); return; }
    const path = url.pathname.slice(prefix.length);
    if (!url.pathname.startsWith(`${prefix}/`) || req.method !== 'POST' || !['/v1/messages', '/v1/messages/count_tokens'].includes(path)) { res.writeHead(404); res.end(); return; }
    const abort = new AbortController(); pending.add(abort);
    const signal = AbortSignal.any([input.signal, abort.signal]);
    res.on('close', () => abort.abort());
    try {
      if (stopped) throw new Error('Research stopped');
      signal.throwIfAborted();
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      await input.admit(body, path.endsWith('count_tokens') ? 'count_tokens' : 'messages', async admittedSignal => {
        const checked = AbortSignal.any([signal, admittedSignal]); checked.throwIfAborted();
        if (stopped) throw new Error('Research stopped');
        forwarded++;
        return input.forward({ req, res, path: `${path}${url.search}`, body, signal: checked });
      });
    } catch (error) {
      // A provider refusal has already been delivered to the SDK. A retry must
      // return through admission; it must not poison the permission fence.
      if (error instanceof ClaudeModelResponseErrorV1 && res.writableEnded) return;
      if (error instanceof ClaudeModelTransportErrorV1 && !signal.aborted) {
        if (!res.headersSent) { res.writeHead(502, { 'content-type': 'application/json' }); res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'Research provider unavailable.' } })); }
        else res.destroy();
        return;
      }
      stopped = true;
      if (!res.headersSent) { res.writeHead(403, { 'content-type': 'application/json' }); res.end(JSON.stringify({ type: 'error', error: { type: 'permission_error', message: 'Research access stopped.' } })); }
      else res.destroy();
    } finally { pending.delete(abort); }
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (address === null || typeof address === 'string') { server.close(); throw new Error('Research transport unavailable'); }
  const close = () => { stopped = true; for (const abort of pending) abort.abort(); server.closeAllConnections(); server.close(); };
  input.signal.addEventListener('abort', close, { once: true });
  if (input.signal.aborted) close();
  return { base_url: `http://127.0.0.1:${address.port}${prefix}`, forwarded: () => forwarded,
    close() { input.signal.removeEventListener('abort', close); close(); } };
}
