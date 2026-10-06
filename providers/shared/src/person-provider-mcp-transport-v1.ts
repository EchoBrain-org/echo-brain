import { randomUUID } from 'node:crypto';
import { createParser } from 'eventsource-parser';
import { readBoundedTextResponseV1, BoundedJsonResponseErrorV1, type BoundedResponseOptionsV1 } from './bounded-json-response-v1.js';
import { createPersonProviderJsonTransportV1, type PersonProviderAuthenticatedFetchV1 } from './person-provider-json-transport-v1.js';
import type { PersonProviderV1 } from './person-provider-v1.js';

/** Stateless read-only MCP calls reuse the HTTP, cancellation and credential boundary. */
export function createPersonProviderMcpTransportV1(
  provider: PersonProviderV1,
  authenticated: PersonProviderAuthenticatedFetchV1,
  endpoint: string,
) {
  type Request = { readonly name: string; readonly arguments: Readonly<Record<string, unknown>>; readonly id: string; readonly signal?: AbortSignal };
  const transport = createPersonProviderJsonTransportV1<Request>(provider, authenticated,
    input => ({ url: new URL(endpoint), method: 'POST', body: { jsonrpc: '2.0', id: input.id, method: 'tools/call', params: { name: input.name, arguments: input.arguments } } }),
    { accept: 'application/json, text/event-stream', decode: decodeMcpResponse },
  );
  return Object.freeze({
    binding: transport.binding,
    async call(name: string, args: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<string> {
      const id = randomUUID();
      const envelopes = provider.array(await transport.request({ name, arguments: args, id, signal }), 32).map(provider.record);
      const responses = envelopes.filter(value => value.id === id);
      if (responses.length !== 1 || envelopes.some(value => value.id !== undefined && value.id !== id)) provider.failure('invalid_output');
      const response = responses[0]!;
      if (response.jsonrpc !== '2.0') provider.failure('invalid_output');
      if (response.error !== undefined) provider.failure('unavailable');
      const result = provider.record(response.result);
      if (result.isError === true) provider.failure('unavailable');
      const content = provider.array(result.content, 1).map(provider.record);
      if (content.length !== 1 || content[0]!.type !== 'text' || typeof content[0]!.text !== 'string') provider.failure('invalid_output');
      return content[0]!.text;
    },
  });
}

async function decodeMcpResponse(response: Response, options: BoundedResponseOptionsV1): Promise<unknown> {
  const type = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
  if (type !== 'application/json' && type !== 'text/event-stream') throw new BoundedJsonResponseErrorV1('invalid_json');
  const text = await readBoundedTextResponseV1(response, options);
  try {
    if (text === undefined) throw new Error();
    if (type === 'application/json') return [JSON.parse(text)];
    const events: unknown[] = [];
    const parser = createParser({ maxBufferSize: options.maxBytes,
      onEvent(event) { if (events.length >= 32) throw new Error(); events.push(JSON.parse(event.data)); },
      onError() { throw new Error(); },
    });
    parser.feed(text);
    parser.reset({ consume: true });
    return events;
  } catch { throw new BoundedJsonResponseErrorV1('invalid_json'); }
}
