import { StringDecoder } from 'node:string_decoder';

/** Retain only numeric usage/finish metadata while the original SSE bytes pass through. */
export function messageUsageObserver() {
  const decoder = new StringDecoder('utf8');
  let pending = '', input, output, cached = 0, created = 0, finish;
  const count = value => Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  const line = value => {
    if (!value.startsWith('data:')) return;
    let event; try { event = JSON.parse(value.slice(5).trim()); } catch { return; }
    const usage = event.type === 'message_start' ? event.message?.usage : event.type === 'message_delta' ? event.usage : undefined;
    if (usage) {
      input = count(usage.input_tokens) ?? input; output = count(usage.output_tokens) ?? output;
      cached = count(usage.cache_read_input_tokens) ?? cached; created = count(usage.cache_creation_input_tokens) ?? created;
    }
    if (event.type === 'message_delta' && typeof event.delta?.stop_reason === 'string') finish = event.delta.stop_reason;
  };
  const accept = text => { pending += text; let end; while ((end = pending.indexOf('\n')) !== -1) { line(pending.slice(0, end)); pending = pending.slice(end + 1); } };
  return {
    write: chunk => accept(decoder.write(chunk)),
    end() {
      accept(decoder.end()); if (pending) line(pending); pending = '';
      const totalInput = input === undefined ? undefined : input + cached + created;
      return { ...(finish === undefined ? {} : { finish_reason: finish }),
        ...(totalInput === undefined || output === undefined ? {} : { usage: { input_tokens: totalInput, output_tokens: output, total_tokens: totalInput + output, cached_input_tokens: cached, reasoning_tokens: null } }) };
    },
  };
}
