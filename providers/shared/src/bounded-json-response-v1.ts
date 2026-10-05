/** Fixed transport errors never contain a request, response, or credential. */
export class BoundedJsonResponseErrorV1 extends Error {
  constructor(readonly code: 'transport' | 'oversized' | 'invalid_json') {
    super(code === 'transport' ? 'The response stream failed'
      : code === 'oversized' ? 'The response is oversized' : 'The response is not valid JSON');
    this.name = 'BoundedJsonResponseErrorV1';
  }
}

/** Bound fetch and stream implementations even when they ignore cancellation. */
export function abortableProviderOperationV1<T>(
  operation: () => Promise<T>, signal: AbortSignal, discard?: (value: T) => void,
): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    const done = () => signal.removeEventListener('abort', abort);
    try {
      operation().then(value => {
        done();
        if (signal.aborted) { discard?.(value); reject(signal.reason); }
        else resolve(value);
      }, error => { done(); reject(error); });
    } catch (error) { done(); reject(error); }
  });
}

/** Cleanup must not let an uncooperative response extend the request deadline. */
export function disposeProviderResponseV1(response: Response | undefined): void {
  if (response?.body !== undefined && response.body !== null && !response.body.locked) {
    try { void response.body.cancel().catch(() => {}); } catch { /* best effort */ }
  }
}

/** Providers retain HTTP status/media-type policy and map these errors themselves. */
export async function readBoundedJsonResponseV1(response: Response, options: {
  readonly maxBytes: number;
  readonly signal: AbortSignal;
  readonly emptyBody?: 'undefined';
  /** Keep providers' established header policy; streamed bytes are always bounded. */
  readonly contentLength?: 'decimal' | 'canonical' | 'ignore';
}): Promise<unknown> {
  options.signal.throwIfAborted();
  const declared = response.headers.get('content-length');
  if (options.contentLength !== 'ignore' && declared !== null) {
    const format = options.contentLength === 'canonical' ? /^(?:0|[1-9][0-9]*)$/ : /^\d+$/;
    if (!format.test(declared) || !Number.isSafeInteger(Number(declared)) || Number(declared) > options.maxBytes) {
      disposeProviderResponseV1(response);
      throw new BoundedJsonResponseErrorV1('oversized');
    }
  }
  if (response.body === null) {
    if (options.emptyBody === 'undefined') return undefined;
    throw new BoundedJsonResponseErrorV1('invalid_json');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try { chunk = await abortableProviderOperationV1(() => reader.read(), options.signal); }
      catch { options.signal.throwIfAborted(); throw new BoundedJsonResponseErrorV1('transport'); }
      options.signal.throwIfAborted();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > options.maxBytes) throw new BoundedJsonResponseErrorV1('oversized');
      chunks.push(chunk.value);
    }
    if (total === 0 && options.emptyBody === 'undefined') return undefined;
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown; }
    catch { throw new BoundedJsonResponseErrorV1('invalid_json'); }
  } finally {
    try { void reader.cancel().catch(() => {}); } catch { /* best effort */ }
    reader.releaseLock();
  }
}
