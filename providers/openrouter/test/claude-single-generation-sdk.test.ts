import { expect, it } from 'vitest';
import { runClaudeStructuredV1 } from '../src/claude-research/sdk-client.js';
import { startClaudeModelTransportV1 } from '../src/claude-research/model-transport.js';

it('completes native StructuredOutput with exactly one Messages request and no token-count request', async () => {
  const model = 'claude-sonnet-5-5';
  const signal = AbortSignal.timeout(25_000);
  const operations: string[] = [];
  const requests: unknown[] = [];
  let messages = 0;
  const transport = await startClaudeModelTransportV1({
    signal,
    admit: (_body, operation, send) => {
      operations.push(operation);
      if (operation !== 'messages' || operations.length !== 1) throw new Error('Only one Messages request is admitted');
      return send(signal);
    },
    forward: async ({ body, res }) => {
      messages++;
      const input = JSON.parse(body.toString());
      requests.push({ model: input.model, max_tokens: input.max_tokens, stream: input.stream, tools: input.tools?.map((tool: { name: string }) => tool.name) });
      const content = { type: 'tool_use', id: 'toolu_single_generation', name: 'StructuredOutput', input: { finished: true } };
      const message = {
        id: 'msg_single_generation', type: 'message', role: 'assistant', model,
        content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 },
      };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const event of [
        { type: 'message_start', message },
        { type: 'content_block_start', index: 0, content_block: { ...content, input: {} } },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(content.input) } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 10 } },
        { type: 'message_stop' },
      ]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      res.end();
      return {};
    },
  });
  try {
    const result = await runClaudeStructuredV1({
      prompt: 'Synthetic fixture: return finished true.',
      system: 'Use StructuredOutput to return finished true.',
      schema: { type: 'object', additionalProperties: false, required: ['finished'], properties: { finished: { type: 'boolean' } } },
      model, base_url: transport.base_url, signal, max_output_tokens: 8192, single_generation: true,
    });
    expect(result).toEqual({ finished: true });
    expect(operations).toEqual(['messages']);
    expect(messages).toBe(1);
    expect(transport.forwarded()).toBe(1);
    expect(requests).toEqual([{ model, max_tokens: 8192, stream: true, tools: expect.arrayContaining(['StructuredOutput']) }]);
  } finally {
    transport.close();
  }
}, 30_000);
