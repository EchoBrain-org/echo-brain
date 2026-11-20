import { expect, it } from 'vitest';
import type { StructuredGenerationInput } from '@echo-brain/organization-authority-kernel/answer-composition/structured-generation-v1';
import { createOpenRouterStructuredGenerationAdapter } from '../src/adapters/answer-composition/openrouter/openrouter-structured-generation-adapter.js';
import { messageUsageObserverV1 } from '../src/claude-research/message-usage.js';
import { createClaudeAccountStructuredGenerationV1 } from '../src/claude-research/structured-generation.js';
import { createClaudeResearchDriverV1 } from '../src/claude-research/driver.js';

it('reports progress to the gate at each piece of OpenRouter model output, never at a keep-alive', async () => {
  const events = [': OPENROUTER PROCESSING', ': OPENROUTER PROCESSING', 'data: {"choices":[{"delta":{"reasoning":"think"}}]}',
    'data: {"choices":[{"delta":{"content":"{\\"ok\\":"}}]}', 'data: {"choices":[{"delta":{"content":"true}"},"finish_reason":"stop"}]}', 'data: [DONE]'];
  const fetchImpl = (async () => new Response(new ReadableStream<Uint8Array>({ start(controller) {
    for (const event of events) controller.enqueue(new TextEncoder().encode(`${event}\n\n`));
    controller.close();
  } }), { headers: { 'content-type': 'text/event-stream' } })) as unknown as typeof fetch;
  let progress = 0;
  const adapter = createOpenRouterStructuredGenerationAdapter({ credential_ref: 'fixture', credential_resolver: () => 'SECRET', fetch_impl: fetchImpl });
  await expect(adapter.generate({ model: 'anthropic/claude-sonnet-5.5', system_prompt: 's', user_prompt: 'u', schema: { type: 'object' },
    max_output_tokens: 100, timeout_ms: 1_000, on_progress: () => { progress += 1; } })).resolves.toEqual({ ok: true });
  expect(progress).toBe(3);
});

it('passes research model output to the gate\'s per-request progress', async () => {
  const model = 'anthropic/claude-sonnet-5.5';
  let gateProgress = 0;
  const driver = createClaudeResearchDriverV1({ model,
    forward: async ({ res, alive }) => { for (let piece = 0; piece < 4; piece += 1) alive?.(); res.end('{}'); return {}; },
    run: async input => { await (await fetch(`${input.base_url}/v1/messages`, { method: 'POST', body: JSON.stringify({ model, messages: [] }) })).text(); },
  });
  await driver.run({ initial: {}, question: true, list_available: false, signal: new AbortController().signal, silence_ms: 60_000, call: async () => ({}),
    model_request: async (_request, send) => (await send(new AbortController().signal, () => { gateProgress += 1; })).value });
  expect(gateProgress).toBe(4);
});

it('counts only Anthropic events that carry model output as progress, never ping or message_start', () => {
  let produced = 0;
  const observer = messageUsageObserverV1(false, () => { produced += 1; });
  for (const event of [
    { type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 0 } } }, { type: 'ping' }, { type: 'ping' },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'a' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'b' } }, { type: 'ping' },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
  ]) observer.write(Buffer.from(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
  observer.end();
  expect(produced).toBe(4);
});

it('passes Claude-account model output to the admitting gate per request and to the caller, and honours the gate\'s abort', async () => {
  const model = 'claude-sonnet-5-5';
  const input: StructuredGenerationInput = { model, system_prompt: 'Synthetic writer instructions', user_prompt: '{"evidence":"E1"}',
    schema: { type: 'object' }, max_output_tokens: 1500, timeout_ms: 20_000 };
  let callerProgress = 0, gateProgress = 0, seenSignal: AbortSignal | undefined;
  const gateAbort = new AbortController();
  const port = createClaudeAccountStructuredGenerationV1({ account: { home_directory: '/synthetic', executable_path: '/synthetic/claude' }, model,
    forward: async ({ res, alive, signal }) => {
      seenSignal = signal;
      for (let piece = 0; piece < 3; piece += 1) alive?.();
      res.end('{}');
      return { content: [], finish_reason: 'stop' };
    },
    run: async request => {
      const response = await fetch(`${request.base_url}/v1/messages`, { method: 'POST',
        body: JSON.stringify({ model, max_tokens: 1500, system: input.system_prompt, messages: [{ role: 'user', content: input.user_prompt }] }) });
      await response.text();
      return { answer: 'x' };
    },
  });
  await port.generate_with_admission!({ ...input, on_progress: () => { callerProgress += 1; } },
    async (_request, forward) => (await (forward as (signal: AbortSignal, progress: () => void) => Promise<{ value: unknown }>)(gateAbort.signal, () => { gateProgress += 1; })).value);
  expect([callerProgress, gateProgress]).toEqual([3, 3]);
  gateAbort.abort();
  expect(seenSignal?.aborted).toBe(true);
});
