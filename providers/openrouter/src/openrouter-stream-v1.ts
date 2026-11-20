/**
 * OpenRouter Chat Completions replies read as they arrive. A streamed reply (server-sent events) is parsed event by event
 * while it is read and assembled into the one JSON reply it stands for, so callers read the same object either way and
 * no raw stream text is retained: comments are dropped as they arrive and each event is discarded once read. Reading
 * reports progress for what the model produced (content, reasoning, refusal, tool-call text, the finish reason) and for
 * the bytes of an event still arriving; OpenRouter's keep-alive comments and empty events are not progress.
 */

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/**
 * The text one OpenRouter reply can keep, from the model profile's own output maximum: the content, reasoning, refusal
 * and tool-call text the model produced, in UTF-8 bytes as decoded (escapes count once). No output token decodes to
 * 4 KiB, and 256 more such allowances hold the framing kept beside it (a choice error, a non-streamed refusal). What is
 * discarded as read (comments, repeated routing metadata, usage) never counts. One stream line still being read, and a
 * non-streamed body, may hold six wire bytes per kept byte (`\u00e9` for `é`): see `openRouterLineCapacityV1`.
 */
export function openRouterReplyCapacityBytesV1(maxOutputTokens: number): number {
  return (Math.max(0, maxOutputTokens) + 256) * 4096;
}

/** The characters one stream line, or a non-streamed body, may hold: its kept text with every byte JSON-escaped. */
function openRouterLineCapacityV1(capacityBytes: number): number {
  return capacityBytes * 6;
}

const utf8 = new TextEncoder();
function bytesOf(text: string): number {
  return utf8.encode(text).byteLength;
}

/** The reply's kept text, or one line of it, passed its capacity (`openRouterReplyCapacityBytesV1`) while it was read. */
export class OpenRouterReplyTooLargeErrorV1 extends Error {
  constructor(readonly capacity_bytes: number) {
    super(`OpenRouter reply passed its ${capacity_bytes}-byte transport capacity`);
    this.name = 'OpenRouterReplyTooLargeErrorV1';
  }
}

/** The stream closed cleanly in the middle of an event: a transport loss after the model may have run, never a reply. */
export class OpenRouterStreamCutErrorV1 extends Error {
  constructor() { super('OpenRouter stream closed in the middle of an event'); this.name = 'OpenRouterStreamCutErrorV1'; }
}

/** A streamed reply arrives assembled; any other reply arrives as its whole body text. */
export type OpenRouterReplyV1 =
  | { readonly streamed: true; readonly payload: Record<string, unknown>; readonly bytes: number }
  | { readonly streamed: false; readonly text: string; readonly bytes: number };

/** True when the reply is a stream of server-sent events. */
function isOpenRouterStreamV1(response: Response): boolean {
  return (response.headers.get('content-type') ?? '').includes('text/event-stream');
}

/**
 * Assembles a stream one line at a time: every top-level field as the last event that carried it (id, provider, model,
 * usage, error and the like), and its first choice's message (content, refusal and tool calls, each call's arguments
 * joined in order), finish reason and error. Reasoning text counts as progress and is not retained.
 */
class OpenRouterStreamAssemblerV1 {
  constructor(private readonly capacityBytes: number) {}
  private kept = 0;
  private readonly root: Record<string, unknown> = {};
  private content = '';
  private refusal = '';
  /** Tool calls by the provider's index, which is taken only as the next index or one already seen. */
  private readonly calls = new Map<number, { id?: unknown; type?: unknown; name: string; arguments: string }>();
  private finishReason: unknown;
  private choiceError: unknown;

  /** Takes one line; true when it carried something the model produced. Throws SyntaxError on an event that is not JSON. */
  line(line: string): boolean {
    if (!line.startsWith('data:')) return false;
    const data = line.slice('data:'.length).trim();
    if (data === '' || data === '[DONE]') return false;
    const event = record(JSON.parse(data) as unknown);
    if (event === undefined) return false;
    for (const [key, value] of Object.entries(event)) if (key !== 'choices' && value !== undefined && value !== null) this.root[key] = value;
    const choice = Array.isArray(event['choices']) ? event['choices'].map(record).find(value => value !== undefined) : undefined;
    if (choice === undefined) return false;
    let produced = false;
    const delta = record(choice['delta']) ?? {};
    if (typeof delta['content'] === 'string' && delta['content'] !== '') { this.keep(delta['content']); this.content += delta['content']; produced = true; }
    if (typeof delta['refusal'] === 'string' && delta['refusal'] !== '') { this.keep(delta['refusal']); this.refusal += delta['refusal']; produced = true; }
    // Reasoning is the model's output and counts against what it can produce, though its text is not retained.
    if (typeof delta['reasoning'] === 'string' && delta['reasoning'] !== '') { this.keep(delta['reasoning']); produced = true; }
    if (Array.isArray(delta['reasoning_details']) && delta['reasoning_details'].length > 0) produced = true;
    for (const raw of Array.isArray(delta['tool_calls']) ? delta['tool_calls'] : []) {
      const call = record(raw);
      if (call === undefined) continue;
      const index = call['index'] === undefined ? this.calls.size : call['index'];
      // Calls are numbered 0, 1, 2... as they start: any other index is a malformed event, never an array position.
      if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0 || index > this.calls.size) throw new SyntaxError('OpenRouter tool call index is out of sequence');
      let kept = this.calls.get(index);
      if (kept === undefined) this.calls.set(index, kept = { name: '', arguments: '' });
      if (call['id'] !== undefined) kept.id = call['id'];
      if (call['type'] !== undefined) kept.type = call['type'];
      const fn = record(call['function']);
      if (typeof fn?.['name'] === 'string' && fn['name'] !== '') { this.keep(fn['name']); kept.name += fn['name']; produced = true; }
      if (typeof fn?.['arguments'] === 'string' && fn['arguments'] !== '') { this.keep(fn['arguments']); kept.arguments += fn['arguments']; produced = true; }
    }
    if (choice['finish_reason'] !== undefined && choice['finish_reason'] !== null) { this.finishReason = choice['finish_reason']; produced = true; }
    if (choice['error'] !== undefined && choice['error'] !== null) { this.choiceError = choice['error']; produced = true; }
    return produced;
  }

  private keep(text: string): void {
    this.kept += bytesOf(text);
    if (this.kept > this.capacityBytes) throw new OpenRouterReplyTooLargeErrorV1(this.capacityBytes);
  }

  /** The JSON reply the stream stands for. A stream that never sent a finish reason has none here. */
  payload(): Record<string, unknown> {
    const toolCalls = [...this.calls.keys()].sort((a, b) => a - b).map(index => this.calls.get(index)!).map(call => ({ ...(call.id === undefined ? {} : { id: call.id }),
      type: call.type ?? 'function', function: { name: call.name, arguments: call.arguments } }));
    const message = { content: this.content, ...(this.refusal === '' ? {} : { refusal: this.refusal }), ...(toolCalls.length === 0 ? {} : { tool_calls: toolCalls }) };
    return { ...this.root, choices: [{ message, ...(this.finishReason === undefined ? {} : { finish_reason: this.finishReason }),
      ...(this.choiceError === undefined ? {} : { error: this.choiceError }) }] };
  }
}

/**
 * Reads the reply as it arrives, holding what it keeps to `capacity_bytes` while reading. A stream is parsed line by
 * line: a comment line is dropped as it arrives, an event is assembled and discarded once its line ends, and `progress`
 * is called for each event the model produced something in and for each piece of an event line still arriving. Any
 * other reply is the reply itself, so each piece of it is progress. Throws OpenRouterReplyTooLargeErrorV1 past the
 * capacity, SyntaxError on a stream event that is not JSON, and the reader's own error when the body fails or is aborted.
 */
export async function readOpenRouterReplyV1(response: Response, options: {
  readonly capacity_bytes: number;
  readonly progress: () => void;
}): Promise<OpenRouterReplyV1> {
  const streamed = isOpenRouterStreamV1(response);
  const decoder = new TextDecoder();
  const assembler = new OpenRouterStreamAssemblerV1(options.capacity_bytes);
  const lineCapacity = openRouterLineCapacityV1(options.capacity_bytes);
  let bytes = 0;
  // The stream line being read, unless it is a comment, which is dropped as it arrives.
  let text = '';
  let comment = false;
  const hold = (more: string): void => {
    if (comment) return;
    if (text === '' && more.startsWith(':')) { comment = true; return; }
    text += more;
    if (text.length > lineCapacity) throw new OpenRouterReplyTooLargeErrorV1(options.capacity_bytes);
  };
  const take = (piece: string, final: boolean): void => {
    if (!streamed) {
      text += piece;
      if (text.length > lineCapacity) throw new OpenRouterReplyTooLargeErrorV1(options.capacity_bytes);
      return;
    }
    let produced = false;
    let rest = piece;
    let end: number;
    while ((end = rest.indexOf('\n')) !== -1) {
      hold(rest.slice(0, end));
      rest = rest.slice(end + 1);
      if (!comment && assembler.line(text.replace(/\r$/u, ''))) produced = true;
      text = ''; comment = false;
    }
    hold(rest);
    if (final && text !== '') {
      // The stream closed with an event line unfinished: if it does not parse, the connection was cut mid-event (a
      // transport loss, billing unknown), not a malformed reply.
      try { if (assembler.line(text.replace(/\r$/u, ''))) produced = true; }
      catch (error) { if (error instanceof SyntaxError) throw new OpenRouterStreamCutErrorV1(); throw error; }
      text = '';
    }
    // Bytes of a data line still arriving are progress too: one large event (a long tool argument) can take longer than
    // the silence period to arrive. A keep-alive comment or a control field (`event:`, `id:`, `retry:`) never is.
    if (produced || (rest !== '' && text.startsWith('data:'))) options.progress();
  };
  if (response.body !== null) {
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (!streamed) options.progress();
        take(decoder.decode(value, { stream: true }), false);
      }
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      throw error;
    }
  }
  take(decoder.decode(), true);
  return streamed ? { streamed: true, payload: assembler.payload(), bytes } : { streamed: false, text, bytes };
}
