/**
 * OpenRouter Chat Completions replies read as they arrive. A streamed reply (server-sent events) is parsed event by event
 * while it is read and assembled into the one JSON reply it stands for, so callers read the same object either way and
 * no raw stream text is retained. Reading reports progress only for what the model produced (content, reasoning,
 * refusal, tool-call text, the finish reason); OpenRouter's keep-alive comments and empty events are not progress.
 */

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/**
 * The bytes one OpenRouter reply can carry, from the model profile's own output maximum: each output token (reasoning
 * or reply) arrives in at most one event, and an event's JSON envelope with its tokens fits in 4 KiB; 256 more events
 * hold the framing (role, finish, usage, routing metadata, reasoning signatures) and a non-streamed reply or refusal.
 * This is the response transport's capacity: a reply past it is not one the model could have produced.
 */
export function openRouterReplyCapacityBytesV1(maxOutputTokens: number): number {
  return (Math.max(0, maxOutputTokens) + 256) * 4096;
}

/** The reply passed its transport capacity (`openRouterReplyCapacityBytesV1`) while it was read. */
export class OpenRouterReplyTooLargeErrorV1 extends Error {
  constructor(readonly capacity_bytes: number) {
    super(`OpenRouter reply passed its ${capacity_bytes}-byte transport capacity`);
    this.name = 'OpenRouterReplyTooLargeErrorV1';
  }
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
  private readonly root: Record<string, unknown> = {};
  private content = '';
  private refusal = '';
  private readonly calls: { id?: unknown; type?: unknown; name: string; arguments: string }[] = [];
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
    if (typeof delta['content'] === 'string' && delta['content'] !== '') { this.content += delta['content']; produced = true; }
    if (typeof delta['refusal'] === 'string' && delta['refusal'] !== '') { this.refusal += delta['refusal']; produced = true; }
    if ((typeof delta['reasoning'] === 'string' && delta['reasoning'] !== '') || (Array.isArray(delta['reasoning_details']) && delta['reasoning_details'].length > 0)) produced = true;
    for (const raw of Array.isArray(delta['tool_calls']) ? delta['tool_calls'] : []) {
      const call = record(raw);
      if (call === undefined) continue;
      const index = typeof call['index'] === 'number' ? call['index'] : this.calls.length;
      const kept = this.calls[index] ?? (this.calls[index] = { name: '', arguments: '' });
      if (call['id'] !== undefined) kept.id = call['id'];
      if (call['type'] !== undefined) kept.type = call['type'];
      const fn = record(call['function']);
      if (typeof fn?.['name'] === 'string' && fn['name'] !== '') { kept.name += fn['name']; produced = true; }
      if (typeof fn?.['arguments'] === 'string' && fn['arguments'] !== '') { kept.arguments += fn['arguments']; produced = true; }
    }
    if (choice['finish_reason'] !== undefined && choice['finish_reason'] !== null) { this.finishReason = choice['finish_reason']; produced = true; }
    if (choice['error'] !== undefined && choice['error'] !== null) { this.choiceError = choice['error']; produced = true; }
    return produced;
  }

  /** The JSON reply the stream stands for. A stream that never sent a finish reason has none here. */
  payload(): Record<string, unknown> {
    const toolCalls = this.calls.filter(call => call !== undefined).map(call => ({ ...(call.id === undefined ? {} : { id: call.id }),
      type: call.type ?? 'function', function: { name: call.name, arguments: call.arguments } }));
    const message = { content: this.content, ...(this.refusal === '' ? {} : { refusal: this.refusal }), ...(toolCalls.length === 0 ? {} : { tool_calls: toolCalls }) };
    return { ...this.root, choices: [{ message, ...(this.finishReason === undefined ? {} : { finish_reason: this.finishReason }),
      ...(this.choiceError === undefined ? {} : { error: this.choiceError }) }] };
  }
}

/**
 * Reads the reply as it arrives, holding it to `capacity_bytes` while reading. A stream is parsed event by event and
 * `progress` is called for each event the model produced something in; any other reply is the reply itself, so each
 * piece of it is progress. Throws OpenRouterReplyTooLargeErrorV1 past the capacity, SyntaxError on a stream event that
 * is not JSON, and the reader's own error when the body fails or is aborted.
 */
export async function readOpenRouterReplyV1(response: Response, options: {
  readonly capacity_bytes: number;
  readonly progress: () => void;
}): Promise<OpenRouterReplyV1> {
  const streamed = isOpenRouterStreamV1(response);
  const decoder = new TextDecoder();
  const assembler = new OpenRouterStreamAssemblerV1();
  let bytes = 0;
  let text = '';
  const take = (piece: string, final: boolean): void => {
    text += piece;
    if (!streamed) return;
    let end: number;
    while ((end = text.indexOf('\n')) !== -1) {
      const line = text.slice(0, end).replace(/\r$/u, '');
      text = text.slice(end + 1);
      if (assembler.line(line)) options.progress();
    }
    if (final && text !== '') { if (assembler.line(text)) options.progress(); text = ''; }
  };
  if (response.body !== null) {
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > options.capacity_bytes) throw new OpenRouterReplyTooLargeErrorV1(options.capacity_bytes);
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
