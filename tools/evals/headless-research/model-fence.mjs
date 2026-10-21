import { createServer } from 'node:http';
import { request as upstreamRequest } from 'node:https';
import { randomBytes } from 'node:crypto';
import { messageUsageObserver } from './message-usage.mjs';

/** A local experiment transport. Never log/persist headers, credentials, request bodies or the private route. */
export async function startModelFence({ check, signal, onEvent = () => {}, forward = forwardAnthropic, around }) {
  const prefix = `/${randomBytes(24).toString('hex')}`, pending = new Set();
  let terminal, closed = false, requests = 0, forwarded = 0, denied = 0;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const path = url.pathname.slice(prefix.length);
    if (!url.pathname.startsWith(`${prefix}/`) || req.method !== 'POST' || !['/v1/messages', '/v1/messages/count_tokens'].includes(path)) {
      res.writeHead(404); res.end(); return;
    }
    requests++;
    const abort = new AbortController(); pending.add(abort);
    const cancel = () => abort.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    res.on('close', cancel);
    try {
      if (terminal || closed || signal?.aborted) throw new Error('model_access_stopped');
      // Buffer without a prototype size ceiling, then revalidate immediately before any bytes leave this process.
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      await check();
      if (terminal || closed || signal?.aborted || abort.signal.aborted) throw new Error('model_access_stopped');
      const send = async (checkedSignal = abort.signal) => {
        const active = AbortSignal.any([abort.signal, checkedSignal]);
        active.throwIfAborted();
        forwarded++; onEvent({ event: 'model_request_authorized', request: requests, operation: path.endsWith('count_tokens') ? 'count_tokens' : 'messages' });
        return forward({ req, res, path: `${path}${url.search}`, body, signal: active });
      };
      if (around) await around({ body, path, forward: send }); else await send();
    } catch {
      terminal = new Error('model_access_stopped'); denied++;
      onEvent({ event: 'model_request_stopped', request: requests });
      if (!res.headersSent) { res.writeHead(403, { 'content-type': 'application/json' }); res.end(JSON.stringify({ type: 'error', error: { type: 'permission_error', message: 'Staging trial access check failed.' } })); }
      else res.destroy();
    } finally { pending.delete(abort); signal?.removeEventListener('abort', cancel); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${server.address().port}${prefix}`;
  const stop = () => { closed = true; for (const abort of pending) abort.abort(); server.closeAllConnections(); server.close(); };
  signal?.addEventListener('abort', stop, { once: true });
  return Object.freeze({
    environment() { if (closed || terminal || signal?.aborted) throw new Error('model_access_stopped'); return { ANTHROPIC_BASE_URL: base, CLAUDE_CODE_GATEWAY_HINT_HEADERS: '1' }; },
    stats: () => ({ requests, forwarded, denied, stopped: Boolean(terminal || closed || signal?.aborted) }),
    close() { signal?.removeEventListener('abort', stop); stop(); },
  });
}

/** Fixed HTTPS upstream; credentials stay in transport memory and are never returned to an agent. No redirects. */
function forwardAnthropic({ req, res, path, body, signal }) {
  return new Promise((resolve, reject) => {
    const headers = { ...req.headers, host: 'api.anthropic.com', 'content-length': String(body.length), 'accept-encoding': 'identity' };
    for (const name of ['connection', 'transfer-encoding', 'proxy-authorization', 'proxy-connection']) delete headers[name];
    const upstream = upstreamRequest({ hostname: 'api.anthropic.com', port: 443, method: 'POST', path, headers, signal }, reply => {
      const usage = messageUsageObserver();
      reply.on('data', chunk => usage.write(chunk));
      res.writeHead(reply.statusCode, reply.headers); reply.pipe(res);
      reply.on('end', () => resolve(usage.end())); reply.on('error', reject);
    });
    upstream.on('error', reject); upstream.end(body);
  });
}
