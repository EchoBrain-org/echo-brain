import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { request } from 'node:https';
import { randomBytes } from 'node:crypto';
import { messageUsageObserverV1, type ClaudeMessageMetadataV1 } from './message-usage.js';
import { observeCoreModelMetadataV1, observeCoreRuntimeV1, annotateCoreRuntimeV1 } from '@echo-brain/organization-authority-kernel/shared/core-runtime-observation-v1';
import { isContextWindowRefusal } from '@echo-brain/organization-processing/llm/llm-provider';
import { UNBILLED_REFUSAL_STATUSES_V1 } from '../unbilled-refusal-v1.js';

interface ClaudeModelForwardV1 {
  readonly req: IncomingMessage; readonly res: ServerResponse; readonly body: Buffer; readonly path: string; readonly signal: AbortSignal;
  /**
   * Called at each piece of model output in the provider's reply (a content, tool-input or thinking delta, or the stop;
   * never a `ping` keep-alive), and at each piece of a reply that is not a stream: liveness for a caller timing silence,
   * never a clock.
   */
  readonly alive?: () => void;
}
export type ClaudeModelForwarderV1 = (input: ClaudeModelForwardV1) => Promise<ClaudeMessageMetadataV1>;

/** The SDK already received this HTTP response and owns its retry policy. The shared limiter still observes the failure. */
export class ClaudeModelResponseErrorV1 extends Error {
  readonly diagnostic;
  /**
   * `contextWindow`: the provider refused a prompt past the model's own context window (its error message says so).
   * Carried as a content-free flag, never the message itself.
   */
  constructor(status: number, contextWindow = false) {
    super('Research provider request failed');
    // A rate-limited or overloaded refusal generated nothing: marked unbilled where the model gate reads it.
    this.diagnostic = { failure_class: 'adapter_http' as const, http_status: status, ...(contextWindow ? { context_window: true as const } : {}),
      ...(UNBILLED_REFUSAL_STATUSES_V1.has(status) ? { unbilled: true as const } : {}) };
  }
}

/**
 * Content-free network failure. `unbilled`: no connection to the provider was ever established (refused, DNS, TLS), so
 * no byte of the request reached it; any later failure, or a stream cut before its terminal event, leaves the
 * generation's billing unknown.
 */
export class ClaudeModelTransportErrorV1 extends Error {
  readonly diagnostic: { readonly failure_class: 'adapter_transport'; readonly http_status: null; readonly unbilled?: true };
  constructor(readonly unbilled = false) {
    super('Research provider transport failed');
    // Where the model gate reads it; a failure whose billing is unknown carries no flag.
    this.diagnostic = { failure_class: 'adapter_transport', http_status: null, ...(unbilled ? { unbilled: true as const } : {}) };
  }
}


/**
 * True only for a failed model request that provably cost nothing: refused before the upstream accepted it, or refused
 * with an explicit rate-limit or overloaded status. The SDK's retry of anything else could repeat a billed generation.
 */
export function claudeModelFailureUnbilledV1(error: unknown): boolean {
  if (error instanceof ClaudeModelTransportErrorV1) return error.unbilled;
  return error instanceof ClaudeModelResponseErrorV1 && UNBILLED_REFUSAL_STATUSES_V1.has(error.diagnostic.http_status);
}

/** A model request refused because an earlier one in the same session failed with its billing unknown. */
export class ClaudeModelRepeatRefusedErrorV1 extends Error {
  constructor() { super('A model request after a possibly billed failure is not repeated'); this.name = 'ClaudeModelRepeatRefusedErrorV1'; }
}

/** Fixed upstream, no redirects; the service credential never enters the SDK child, logs or returned errors. */
export function openRouterClaudeForwarderV1(credential: () => string, model: string): ClaudeModelForwarderV1 {
  return providerForwarderV1({ model, provider: 'openrouter', hostname: 'openrouter.ai', path_prefix: '/api',
    authorization: () => `Bearer ${credential()}` });
}

/** The user's native Claude process supplies its own auth; it is forwarded only to Anthropic and never retained. */
export function claudeAccountForwarderV1(model: string, options: { readonly model_call_observed?: true } = {}): ClaudeModelForwarderV1 {
  return providerForwarderV1({ model, provider: 'anthropic', hostname: 'api.anthropic.com', path_prefix: '',
    ...options,
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
  /** Extraction's neutral processor already owns the single model-call observation. */
  readonly model_call_observed?: true;
}): ClaudeModelForwarderV1 {
  const { model, provider } = options;
  return input => {
    const call = async () => {
    observeCoreModelMetadataV1({ provider, model });
    const result = await new Promise<ClaudeMessageMetadataV1>((resolve, reject) => {
      // Never delivered only while no connection to the provider was established (refused, DNS, TLS before the request):
      // once one is, any byte of the request may have reached it, whatever the local write reported.
      let connected = false;
      const transportFailed = () => reject(input.signal.aborted ? input.signal.reason : new ClaudeModelTransportErrorV1(!connected));
      const headers: Record<string, string> = { authorization: options.authorization(input.req), 'content-type': 'application/json',
        'content-length': String(input.body.length), 'accept-encoding': 'identity' };
      for (const key of ['anthropic-version', 'anthropic-beta', ...(provider === 'anthropic' ? ['user-agent', 'x-app'] : [])]) {
        const value = input.req.headers[key]; if (typeof value === 'string') headers[key] = value;
      }
      const upstream = request({ hostname: options.hostname, port: 443, method: 'POST', path: `${options.path_prefix}${input.path}`, headers, signal: input.signal }, reply => {
        // A reply means the upstream received the request.
        connected = true;
        annotateCoreRuntimeV1({ counts: { http_status: reply.statusCode ?? 0 } });
        const streamed = String(reply.headers['content-type'] ?? '').includes('text/event-stream');
        const usage = messageUsageObserverV1(true, streamed ? input.alive : undefined);
        // A refusal's body is read only to tell a context-window refusal by its message; it never leaves this function.
        const refusal: Buffer[] = [];
        reply.on('data', chunk => { if (!streamed) input.alive?.(); usage.write(chunk); if ((reply.statusCode ?? 502) >= 400) refusal.push(Buffer.from(chunk)); });
        input.res.writeHead(reply.statusCode ?? 502, { 'content-type': reply.headers['content-type'] ?? 'application/json' });
        // The SDK's response is ended here only once the reply is known finished: a cut stream must reach it as a broken
        // connection, not a clean end it could read as complete.
        reply.pipe(input.res, { end: false });
        reply.on('end', () => {
          const status = reply.statusCode ?? 502;
          if (status >= 400) {
            let body: unknown;
            try { body = JSON.parse(Buffer.concat(refusal).toString('utf8')) as unknown; } catch { body = undefined; }
            input.res.end();
            reject(new ClaudeModelResponseErrorV1(status, isContextWindowRefusal(status, body)));
            return;
          }
          const metadata = usage.end();
          // A stream that ended cleanly before the message's terminal event was cut in transit after the model ran:
          // a failed call whose billing is unknown, never a finished reply.
          if (streamed && !usage.finished()) { reject(new ClaudeModelTransportErrorV1(false)); return; }
          input.res.end();
          resolve(metadata);
        });
        reply.on('error', transportFailed);
        reply.on('aborted', transportFailed);
      });
      upstream.on('socket', socket => {
        // A reused connection is already established; a new one is once its TLS handshake completes.
        if (!socket.connecting) connected = true;
        else socket.once('secureConnect', () => { connected = true; });
      });
      upstream.on('error', transportFailed);
      upstream.end(input.body);
    });
    observeCoreModelMetadataV1({ provider, model, ...(result.finish_reason === undefined ? {} : { finish_reason: result.finish_reason }) });
    if (result.usage !== undefined) annotateCoreRuntimeV1({ counts: { ...result.usage } });
    return result;
    };
    return options.model_call_observed ? call() : observeCoreRuntimeV1('model_call', call);
  };
}

/** Request-local gateway: only model endpoints, with an exact-body admission before forwarding any bytes. */
export async function startClaudeModelTransportV1(input: {
  readonly signal: AbortSignal;
  readonly forward: ClaudeModelForwarderV1;
  /**
   * `forward` takes the admission's signal and its `progress`, which it calls at each piece of model output in the
   * forwarded reply, so the admitting gate restarts its silence timer for this request.
   */
  readonly admit: (body: Buffer, operation: 'messages' | 'count_tokens', forward: (signal: AbortSignal, progress?: () => void) => Promise<ClaudeMessageMetadataV1>) => Promise<unknown>;
  /** Called at each piece of model output in any forwarded reply (see ClaudeModelForwardV1). */
  readonly alive?: () => void;
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
      await input.admit(body, path.endsWith('count_tokens') ? 'count_tokens' : 'messages', async (admittedSignal, progress) => {
        const checked = AbortSignal.any([signal, admittedSignal]); checked.throwIfAborted();
        if (stopped) throw new Error('Research stopped');
        forwarded++;
        const alive = input.alive === undefined && progress === undefined ? undefined : () => { input.alive?.(); progress?.(); };
        return input.forward({ req, res, path: `${path}${url.search}`, body, signal: checked, ...(alive === undefined ? {} : { alive }) });
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
