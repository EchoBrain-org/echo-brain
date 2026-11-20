/**
 * OpenRouter Chat Completions replies read as they arrive. A streamed reply (server-sent events) is assembled into the
 * one JSON reply it stands for, so callers read the same object either way; reading calls `alive` at every piece, which
 * is how a caller tells a reply that keeps arriving from one that went silent.
 */

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** The whole body as text, calling `alive` at each piece that arrives. */
export async function readOpenRouterBodyV1(response: Response, alive: () => void): Promise<string> {
  if (response.body === null) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    alive();
    text += decoder.decode(value, { stream: true });
  }
}

/** True when the reply is a stream of server-sent events. */
export function isOpenRouterStreamV1(response: Response): boolean {
  return (response.headers.get('content-type') ?? '').includes('text/event-stream');
}

/**
 * A streamed reply as the JSON reply it stands for: every top-level field as the last event that carried it (id,
 * provider, model, usage, error and the like), and its first choice's message (content, refusal and tool calls, each
 * call's arguments joined in order), finish reason and error. Comment lines (OpenRouter's keep-alives) carry nothing.
 * Throws SyntaxError on an event that is not JSON.
 */
export function assembledOpenRouterStreamV1(body: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  let content = '';
  let refusal = '';
  const calls: { id?: unknown; type?: unknown; name: string; arguments: string }[] = [];
  let finishReason: unknown;
  let choiceError: unknown;
  for (const line of body.split(/\r?\n/u)) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice('data:'.length).trim();
    if (data === '' || data === '[DONE]') continue;
    const event = record(JSON.parse(data) as unknown);
    if (event === undefined) continue;
    for (const [key, value] of Object.entries(event)) if (key !== 'choices' && value !== undefined && value !== null) root[key] = value;
    const choice = Array.isArray(event['choices']) ? event['choices'].map(record).find(value => value !== undefined) : undefined;
    if (choice === undefined) continue;
    const delta = record(choice['delta']) ?? {};
    if (typeof delta['content'] === 'string') content += delta['content'];
    if (typeof delta['refusal'] === 'string') refusal += delta['refusal'];
    for (const raw of Array.isArray(delta['tool_calls']) ? delta['tool_calls'] : []) {
      const call = record(raw);
      if (call === undefined) continue;
      const index = typeof call['index'] === 'number' ? call['index'] : calls.length;
      const kept = calls[index] ?? (calls[index] = { name: '', arguments: '' });
      if (call['id'] !== undefined) kept.id = call['id'];
      if (call['type'] !== undefined) kept.type = call['type'];
      const fn = record(call['function']);
      if (typeof fn?.['name'] === 'string') kept.name += fn['name'];
      if (typeof fn?.['arguments'] === 'string') kept.arguments += fn['arguments'];
    }
    if (choice['finish_reason'] !== undefined && choice['finish_reason'] !== null) finishReason = choice['finish_reason'];
    if (choice['error'] !== undefined && choice['error'] !== null) choiceError = choice['error'];
  }
  const toolCalls = calls.filter(call => call !== undefined).map(call => ({ ...(call.id === undefined ? {} : { id: call.id }),
    type: call.type ?? 'function', function: { name: call.name, arguments: call.arguments } }));
  const message = { content, ...(refusal === '' ? {} : { refusal }), ...(toolCalls.length === 0 ? {} : { tool_calls: toolCalls }) };
  return { ...root, choices: [{ message, ...(finishReason === undefined ? {} : { finish_reason: finishReason }), ...(choiceError === undefined ? {} : { error: choiceError }) }] };
}
