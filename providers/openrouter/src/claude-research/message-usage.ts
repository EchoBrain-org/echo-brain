import { StringDecoder } from 'node:string_decoder';
import type { StructuredGenerationUsageV1 } from '@echo-brain/organization-authority-kernel/answer-composition/structured-generation-v1';

export interface ClaudeMessageMetadataV1 { readonly usage?: StructuredGenerationUsageV1; readonly finish_reason?: string; readonly content?: readonly unknown[] }
/** Retains numeric usage and finish metadata while the unmodified SSE bytes pass through. */
export function messageUsageObserverV1(capture = false) {
  const decoder = new StringDecoder('utf8');
  let pending = '', input: number | undefined, output: number | undefined, cached = 0, created = 0, finish: string | undefined;
  const blocks = new Map<number, { type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: unknown; json: string }>();
  const count = (value: unknown): number | undefined => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  const line = (value: string) => {
    if (!value.startsWith('data:')) return;
    let event; try { event = JSON.parse(value.slice(5).trim()); } catch { return; }
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
    if (event?.type === 'message_delta' && typeof event.delta?.stop_reason === 'string') finish = event.delta.stop_reason;
  };
  const accept = (text: string) => { pending += text; let end; while ((end = pending.indexOf('\n')) !== -1) { line(pending.slice(0, end)); pending = pending.slice(end + 1); } };
  return {
    write: (chunk: Buffer) => accept(decoder.write(chunk)),
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
