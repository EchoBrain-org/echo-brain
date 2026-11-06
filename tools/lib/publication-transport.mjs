import { request } from 'node:https';
import { Readable } from 'node:stream';

// Publishing interleaves public reads with synchronous archive validation and
// AWS subprocesses. A pooled socket can expire while the event loop is blocked.
// Give each GET its own connection; never retry a write or follow a redirect.
export function publicationFetch(input, options = {}, requestHttps = request) {
  const url = new URL(String(input));
  if (url.protocol !== 'https:' || url.username || url.password || options.redirect !== 'manual' || (options.method && options.method !== 'GET')) {
    return Promise.reject(new Error('public_request_invalid'));
  }
  return new Promise((resolve, reject) => {
    const req = requestHttps(url, { method: 'GET', agent: false, headers: options.headers, signal: options.signal }, response => {
      const headers = new Headers();
      for (const [key, values] of Object.entries(response.headers)) {
        for (const value of [values].flat()) if (value !== undefined) headers.append(key, value);
      }
      const status = response.statusCode;
      if (!Number.isInteger(status) || status < 200 || status > 599) { response.destroy(); reject(new Error('public_response_invalid')); return; }
      const body = [204, 205, 304].includes(status) ? null : Readable.toWeb(response);
      if (body === null) response.resume();
      resolve(new Response(body, { status, headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

// Explicit vocabulary only: exception messages, URLs and AWS stderr can contain
// private values. Historical receipts without last_failure remain readable.
const CODES = new Set([
  'publication_inputs_changed', 'replacement_inputs_changed', 'predecessor_feed_changed',
  'published_object_metadata_mismatch', 'published_object_headers_mismatch',
  'published_object_digest_mismatch', 'published_object_size_mismatch',
  'public_object_digest_mismatch', 'public_object_headers_mismatch', 'public_object_size_mismatch',
  'immutable_artifact_mismatch', 'put_object_result_unconfirmed',
  'public_connection_failed', 'operation_timed_out', 'publication_operation_failed',
  'insufficient_metadata_validity', 'accepted_server_status_required',
  'accepted_server_status_stale', 'accepted_server_status_mismatch',
]);
export function publicationFailure(error, replacement) {
  const transport = error?.cause?.code ?? error?.code;
  const code = ['UND_ERR_SOCKET', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT'].includes(transport)
    ? 'public_connection_failed'
    : ['AbortError', 'TimeoutError'].includes(error?.name) ? 'operation_timed_out'
      : CODES.has(error?.message) ? error.message : 'publication_operation_failed';
  return { code, recovery: replacement ? 'replace-status' : 'status' };
}
