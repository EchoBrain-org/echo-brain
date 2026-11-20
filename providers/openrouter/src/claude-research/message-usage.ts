import { StringDecoder } from 'node:string_decoder';
import type { StructuredGenerationUsageV1 } from '@echo-brain/organization-authority-kernel/answer-composition/structured-generation-v1';

export interface ClaudeMessageMetadataV1 { readonly usage?: StructuredGenerationUsageV1; readonly finish_reason?: string; readonly content?: readonly unknown[] }
/**
 * Model events that carry something the model produced: a content block opening or growing (text, tool input, thinking)
 * and the reply's stop. `message_start` and `ping` (Anthropic's keep-alive) carry nothing produced.
 */
const PRODUCED_EVENTS = new Set(['content_block_start', 'content_block_delta', 'message_delta']);

/**
 * Retains numeric usage and finish metadata while the unmodified SSE bytes pass through, and calls `produced` at each
 * event that carries model output (see PRODUCED_EVENTS) and at each piece of such an event's data line as it arrives:
 * the liveness a caller timing silence reads.
 */
export function messageUsageObserverV1(capture = false, produced?: () => void) {
  const decoder = new StringDecoder('utf8');
  let pending = '', input: number | undefined, output: number | undefined, cached = 0, created = 0, finish: string | undefined, stopped = false;
  const blocks = new Map<number, { type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: unknown; json: string }>();
  const count = (value: unknown): number | undefined => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  const line = (value: string) => {
    if (!value.startsWith('data:')) return;
    let event; try { event = JSON.parse(value.slice(5).trim()); } catch { return; }
    if (typeof event?.type === 'string' && PRODUCED_EVENTS.has(event.type)) produced?.();
    if (event?.type === 'message_stop') stopped = true;
    // The selected private trace receives visible text/tool output; reasoning blocks are not retained.
    if (capture && Number.isSafeInteger(event?.index)) {
      const block = event.content_block;
      if (event.type === 'content_block_start' && block?.type === 'text' && typeof block.text === 'string') blocks.set(event.index, { type: 'text', text: block.text });
      if (event.type === 'content_block_start' && block?.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') blocks.set(event.index, { type: 'tool_use', id: block.id, name: block.name, input: block.input ?? {}, json: '' });
      const current = blocks.get(event.index);
      if (event.type === 'content_block_delta' && current?.type === 'text' && typeof event.delta?.text === 'string') current.text += event.delta.text;
      if (event.type === 'content_block_delta' && current?.type === 'tool_use' && typeof event.delta?.partial_json === 'string') current.json += event.delta.partial_json;
    }
    const usage = event?.type === 'message_start' ? event.message?.usage : event?.type === 'message_delta' ? event.usage : undefined;
    if (usage) {
      input = count(usage.input_tokens) ?? input; output = count(usage.output_tokens) ?? output;
      cached = count(usage.cache_read_input_tokens) ?? cached; created = count(usage.cache_creation_input_tokens) ?? created;
    }
    // ECHO's vocabulary: end_turn and tool_use are normal stops, max_tokens a length stop.
    const stop = event?.type === 'message_delta' ? event.delta?.stop_reason : undefined;
    if (typeof stop === 'string') finish = stop === 'end_turn' || stop === 'tool_use' ? 'stop' : stop === 'max_tokens' ? 'length' : stop;
  };
  // The current event's type, from its `event:` line or the `"type"` its data line opens with.
  let eventName: string | undefined;
  const accept = (text: string) => {
    let rest = text;
    let end;
    while ((end = rest.indexOf('\n')) !== -1) {
      const full = (pending + rest.slice(0, end)).replace(/\r$/u, '');
      pending = ''; rest = rest.slice(end + 1);
      if (full.startsWith('event:')) eventName = full.slice('event:'.length).trim();
      else if (full === '') eventName = undefined;
      line(full);
    }
    pending += rest;
    // Bytes of a model-output event's data line still arriving are progress: one long delta can take longer than the
    // silence period to arrive. Control fields, `ping` and `message_start` never are.
    if (rest !== '' && pending.startsWith('data:')) {
      const type = eventName ?? /"type"\s*:\s*"([a-z_]+)"/u.exec(pending.slice(0, 256))?.[1];
      if (type !== undefined && PRODUCED_EVENTS.has(type)) produced?.();
    }
  };
  return {
    write: (chunk: Buffer) => accept(decoder.write(chunk)),
    /** True once the message's terminal event (`message_stop`) arrived: the reply finished rather than being cut. */
    finished: () => stopped,
    end(): ClaudeMessageMetadataV1 {
      accept(decoder.end()); if (pending) line(pending); pending = '';
      const totalInput = input === undefined ? undefined : input + cached + created;
      return { ...(finish === undefined ? {} : { finish_reason: finish }),
        ...(capture ? { content: [...blocks.values()].map(block => {
          if (block.type === 'text') return block;
          const { json, ...tool } = block;
          if (json) { try { return { ...tool, input: JSON.parse(json) }; } catch { return { ...tool, input: null }; } }
          return tool;
        }) } : {}),
        ...(totalInput === undefined || output === undefined ? {} : { usage: { input_tokens: totalInput, output_tokens: output, total_tokens: totalInput + output, cached_input_tokens: cached, reasoning_tokens: null } }) };
    },
  };
}
