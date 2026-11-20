import { annotateCoreRuntimeV1 } from '@echo-brain/organization-authority-kernel/shared/core-runtime-observation-v1';

/**
 * One OpenRouter call, shared by the answer adapter and the extraction client. The request is never re-sent by a
 * redirect (the first endpoint may already have run and billed it). The call is stalled only when the model produces
 * nothing for the silence period: keep-alive comments, control fields and events without model output are not
 * progress, while the bytes of an event still arriving hold the period until that event ends, so one long event sent
 * in fragments is never cut off. A streamed reply is assembled as it is read into the JSON reply it stands for, and
 * what it retains is held to the model's own maximum output.
 */

/** A streamed reply arrives assembled; any other reply arrives as its whole body text. */
export type OpenRouterReplyV1 =
  | { readonly streamed: true; readonly payload: Record<string, unknown>; readonly bytes: number }
  | { readonly streamed: false; readonly text: string; readonly bytes: number };

/**
 * Why a call failed. `response` is present once OpenRouter answered. `unsent`: the connection was never made (name
 * resolution, connect, TLS), so the request was not delivered and cannot have been billed.
 *  - `timeout`: the silence period passed. `cancelled`: the caller's signal aborted.
 *  - `transport`: the connection failed. `redirect`: OpenRouter answered with a redirect, which is not followed.
 *  - `too_large`: the reply passed its capacity. `not_json`: a stream event that is not a valid event.
 *  - `cut`: the stream closed in the middle of an event, after the model may have run.
 */
export class OpenRouterCallFailureV1 extends Error {
  constructor(
    readonly kind: 'timeout' | 'cancelled' | 'transport' | 'redirect' | 'too_large' | 'not_json' | 'cut',
    readonly response?: Response,
    readonly unsent = false,
  ) {
    super(`OpenRouter call failed (${kind})`);
    this.name = 'OpenRouterCallFailureV1';
  }
}

const CONNECT_FAILURE_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT',
  'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID',
]);

function connectFailure(error: unknown): boolean {
  for (let cause: unknown = error, depth = 0; cause instanceof Error && depth < 4; cause = cause.cause, depth += 1) {
    const code = (cause as { readonly code?: unknown }).code;
    if (typeof code === 'string' && CONNECT_FAILURE_CODES.has(code)) return true;
  }
  return false;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Assembles a stream one event line at a time: each top-level field as its last value, and the first choice's message
 * (content, refusal, tool calls with their arguments joined in order), finish reason and error. Reasoning is progress
 * and is discarded as read. Every retained byte is charged against `capacity` (a field replaced by a later value
 * counts only its current value), so a reply cannot retain more than its capacity.
 */
class OpenRouterStreamAssemblerV1 {
  private kept = 0;
  private readonly fieldBytes = new Map<string, number>();
  private readonly root: Record<string, unknown> = {};
  private content = '';
  private refusal = '';
  private readonly calls: Array<{ id?: unknown; type?: unknown; name: string; arguments: string }> = [];
  private finishReason: unknown;
  private choiceError: unknown;

  constructor(private readonly capacity: number) {}

  private charge(bytes: number): void {
    this.kept += bytes;
    if (this.kept > this.capacity) throw new OpenRouterCallFailureV1('too_large');
  }

  private keep(value: string): string {
    this.charge(Buffer.byteLength(value));
    return value;
  }

  /** Takes one line; true when it carried model output. Throws SyntaxError on an event that is not valid. */
  line(line: string): boolean {
    if (!line.startsWith('data:')) return false;
    const data = line.slice('data:'.length).trim();
    if (data === '' || data === '[DONE]') return false;
    const event = record(JSON.parse(data) as unknown);
    if (event === undefined) return false;
    for (const [key, value] of Object.entries(event)) {
      if (key === 'choices' || value === undefined || value === null) continue;
      const size = Buffer.byteLength(key) + Buffer.byteLength(JSON.stringify(value));
      this.charge(size - (this.fieldBytes.get(key) ?? 0));
      this.fieldBytes.set(key, size);
      this.root[key] = value;
    }
    const choice = Array.isArray(event['choices']) ? event['choices'].map(record).find(value => value !== undefined) : undefined;
    if (choice === undefined) return false;
    const delta = record(choice['delta']) ?? {};
    let produced = false;
    if (text(delta['content']) !== '') { this.content += this.keep(text(delta['content'])); produced = true; }
    if (text(delta['refusal']) !== '') { this.refusal += this.keep(text(delta['refusal'])); produced = true; }
    if (text(delta['reasoning']) !== '' || (Array.isArray(delta['reasoning_details']) && delta['reasoning_details'].length > 0)) produced = true;
    for (const raw of Array.isArray(delta['tool_calls']) ? delta['tool_calls'] : []) {
      const call = record(raw);
      if (call === undefined) continue;
      const index = call['index'] ?? this.calls.length;
      // Calls are numbered 0, 1, 2... as they start: any other index is a malformed event, never an array position.
      if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0 || index > this.calls.length) throw new SyntaxError('OpenRouter tool call index is out of sequence');
      const kept = this.calls[index] ??= { name: '', arguments: '' };
      if (kept.id === undefined && call['id'] !== undefined && call['id'] !== null) { this.keep(JSON.stringify(call['id'])); kept.id = call['id']; }
      if (kept.type === undefined && call['type'] !== undefined && call['type'] !== null) { this.keep(JSON.stringify(call['type'])); kept.type = call['type']; }
      const fn = record(call['function']);
      if (text(fn?.['name']) !== '') { kept.name += this.keep(text(fn?.['name'])); produced = true; }
      if (text(fn?.['arguments']) !== '') { kept.arguments += this.keep(text(fn?.['arguments'])); produced = true; }
    }
    if (choice['finish_reason'] !== undefined && choice['finish_reason'] !== null) { this.keep(JSON.stringify(choice['finish_reason'])); this.finishReason = choice['finish_reason']; produced = true; }
    if (choice['error'] !== undefined && choice['error'] !== null) { this.keep(JSON.stringify(choice['error'])); this.choiceError = choice['error']; produced = true; }
    return produced;
  }

  /** The JSON reply the stream stands for. A stream that never sent a finish reason has none here. */
  payload(): Record<string, unknown> {
    const toolCalls = this.calls.map(call => ({ ...(call.id === undefined ? {} : { id: call.id }), type: call.type ?? 'function',
      function: { name: call.name, arguments: call.arguments } }));
    const message = { content: this.content, ...(this.refusal === '' ? {} : { refusal: this.refusal }), ...(toolCalls.length === 0 ? {} : { tool_calls: toolCalls }) };
    return { ...this.root, choices: [{ message, ...(this.finishReason === undefined ? {} : { finish_reason: this.finishReason }),
      ...(this.choiceError === undefined ? {} : { error: this.choiceError }) }] };
  }
}

/**
 * Sends one request and reads its reply. `on_progress` is called at each piece of model output and each piece of an
 * event still arriving. Throws OpenRouterCallFailureV1 for every failure of the call itself; a refusal status is a
 * returned reply for the caller to read.
 */
export async function callOpenRouterV1(input: {
  readonly fetch: typeof fetch;
  readonly url: string;
  readonly init: RequestInit;
  readonly signal?: AbortSignal;
  readonly silence_ms: number;
  /** The model's maximum output for this call (0 for a lookup that generates nothing). */
  readonly max_output_tokens: number;
  readonly on_progress?: () => void;
}): Promise<{ readonly response: Response; readonly reply: OpenRouterReplyV1 }> {
  // No output token decodes to more than 4 KiB, and 256 more such allowances hold the framing kept beside the output.
  const capacity = (Math.max(0, input.max_output_tokens) + 256) * 4096;
  // One line still being read, or a non-streamed body, is held before it is decoded: up to six wire bytes per kept
  // byte (`é` for `é`).
  const lineCapacity = capacity * 6;
  const silence = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastOutput = Date.now();
  let lastPiece = 0;
  // Whether a data line is part-way through arriving: its bytes hold the period until it ends.
  let partial = false;
  const stalled = (): void => silence.abort(new DOMException('OpenRouter sent nothing for the silence period', 'TimeoutError'));
  const watch = (): void => {
    clearTimeout(timer);
    const left = Math.max(lastOutput, partial ? lastPiece : 0) + input.silence_ms - Date.now();
    // Ends at once when overdue, so a later line's first bytes cannot hold a period that has already run out.
    if (left <= 0) stalled(); else timer = setTimeout(stalled, left);
  };
  let response: Response | undefined;
  const failure = (error: unknown): OpenRouterCallFailureV1 => {
    if (error instanceof OpenRouterCallFailureV1) return new OpenRouterCallFailureV1(error.kind, response, error.unsent);
    if (silence.signal.aborted) return new OpenRouterCallFailureV1('timeout', response);
    if (input.signal?.aborted === true) return new OpenRouterCallFailureV1('cancelled', response);
    if (error instanceof Error && error.name === 'TimeoutError') return new OpenRouterCallFailureV1('timeout', response);
    if (error instanceof SyntaxError) return new OpenRouterCallFailureV1('not_json', response);
    return new OpenRouterCallFailureV1('transport', response, response === undefined && connectFailure(error));
  };
  watch();
  try {
    response = await input.fetch(input.url, { ...input.init, redirect: 'error',
      signal: input.signal === undefined ? silence.signal : AbortSignal.any([silence.signal, input.signal]) });
    annotateCoreRuntimeV1({ counts: { http_status: response.status } });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => undefined);
      throw new OpenRouterCallFailureV1('redirect', response);
    }
    const streamed = (response.headers.get('content-type') ?? '').includes('text/event-stream');
    const assembler = new OpenRouterStreamAssemblerV1(capacity);
    const decoder = new TextDecoder();
    let bytes = 0;
    // The line being read (a comment line is dropped as it arrives), or the whole body when not streamed.
    let line = '';
    let comment = false;
    const hold = (more: string): void => {
      if (comment) return;
      if (streamed && line === '' && more.startsWith(':')) { comment = true; return; }
      line += more;
      if (line.length > lineCapacity) throw new OpenRouterCallFailureV1('too_large', response);
    };
    const take = (piece: string): void => {
      if (piece === '') return;
      if (!streamed) {
        hold(piece);
        lastOutput = Date.now();
        input.on_progress?.();
        return;
      }
      let produced = false;
      let rest = piece;
      for (let end = rest.indexOf('\n'); end !== -1; end = rest.indexOf('\n')) {
        hold(rest.slice(0, end));
        rest = rest.slice(end + 1);
        if (!comment && assembler.line(line.replace(/\r$/u, ''))) { produced = true; lastOutput = Date.now(); }
        // A line that ended with no model output gives back any hold its bytes had: the period runs from the last output.
        else if (Date.now() - lastOutput >= input.silence_ms) { stalled(); throw silence.signal.reason; }
        line = ''; comment = false;
      }
      hold(rest);
      partial = line.startsWith('data:');
      const arriving = partial && rest !== '';
      if (arriving) lastPiece = Date.now();
      if (produced || arriving) input.on_progress?.();
    };
    if (response.body !== null) {
      const reader = response.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          take(decoder.decode(value, { stream: true }));
          watch();
          silence.signal.throwIfAborted();
        }
      } catch (error) {
        await reader.cancel().catch(() => undefined);
        throw error;
      }
    }
    take(decoder.decode());
    if (!streamed) return { response, reply: { streamed: false, text: line, bytes } };
    if (line !== '') {
      // The stream closed with an event unfinished: a line that does not parse was cut in transit, not malformed.
      try { assembler.line(line.replace(/\r$/u, '')); }
      catch (error) { throw error instanceof SyntaxError ? new OpenRouterCallFailureV1('cut', response) : error; }
    }
    return { response, reply: { streamed: true, payload: assembler.payload(), bytes } };
  } catch (error) {
    throw failure(error);
  } finally {
    clearTimeout(timer);
  }
}
