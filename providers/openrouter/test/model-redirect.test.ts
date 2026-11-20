import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import * as https from 'node:https';
import { PassThrough } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { createOpenRouterStructuredGenerationAdapter } from '../src/adapters/answer-composition/openrouter/openrouter-structured-generation-adapter.js';
import { OpenRouterClient } from '../src/llm/openrouter-client.js';
import { openRouterClaudeForwarderV1, startClaudeModelTransportV1 } from '../src/claude-research/model-transport.js';

vi.mock('node:https', async importOriginal => ({ ...await importOriginal<typeof import('node:https')>(), request: vi.fn() }));
afterEach(() => { vi.resetAllMocks(); });

const request = { model: 'anthropic/claude-sonnet-5.5', system_prompt: 's', user_prompt: 'u', schema: { type: 'object' }, max_output_tokens: 10, timeout_ms: 1_000 } as const;
const extraction = { model: 'provider-model', systemPrompt: 'system', userPrompt: 'user', schema: { type: 'object' }, maxOutputTokens: 10 };
const redirected = (seen: RequestInit[]) => (async (_url: string, init: RequestInit) => {
  seen.push(init);
  return new Response(null, { status: 307, headers: { location: 'https://elsewhere.example/api/v1/chat/completions' } });
}) as unknown as typeof fetch;

it('never lets fetch re-send an OpenRouter answer request by redirect, and fails a redirect with billing unknown', async () => {
  const seen: RequestInit[] = [];
  const adapter = createOpenRouterStructuredGenerationAdapter({ credential_ref: 'fixture', credential_resolver: () => 'SECRET', fetch_impl: redirected(seen) });
  const failure = await adapter.generate(request).catch((error: unknown) => error as { diagnostic: Record<string, unknown> });
  expect(seen.map(init => init.redirect)).toEqual(['error']);
  expect(failure.diagnostic).toMatchObject({ failure_class: 'adapter_transport' });
  expect(failure.diagnostic).not.toHaveProperty('unbilled');
});

it('never lets fetch re-send an OpenRouter extraction by redirect, and fails a redirect as possibly billed', async () => {
  const seen: RequestInit[] = [];
  const client = new OpenRouterClient({ credentialRef: 'openrouter', credentialResolver: () => 'secret', fetchImpl: redirected(seen) });
  await expect(client.generateStructured(extraction)).rejects.toMatchObject({ unbilled: false, message: expect.stringContaining('redirect') });
  expect(seen.map(init => init.redirect)).toEqual(['error']);
});

it('fails a redirect from the Claude upstream with billing unknown instead of passing it to the SDK', async () => {
  vi.mocked(https.request).mockImplementation((...args: Parameters<typeof https.request>) => {
    const receive = args.find(value => typeof value === 'function') as (reply: IncomingMessage) => void;
    return Object.assign(new EventEmitter(), { end() {
      queueMicrotask(() => {
        const reply = Object.assign(new PassThrough(), { statusCode: 308, headers: { location: 'https://elsewhere.example/v1/messages' } });
        receive(reply as unknown as IncomingMessage);
        reply.end();
      });
    } }) as unknown as ReturnType<typeof https.request>;
  });
  let failure: unknown;
  const transport = await startClaudeModelTransportV1({ signal: new AbortController().signal, forward: openRouterClaudeForwarderV1(() => 'synthetic credential', 'anthropic/claude-sonnet-5.5'),
    admit: async (_body, _operation, send) => send(new AbortController().signal).catch((error: unknown) => { failure = error; throw error; }) });
  try {
    const response = await fetch(`${transport.base_url}/v1/messages`, { method: 'POST', body: '{}', redirect: 'manual' });
    expect(response.status).toBe(502);
    expect(response.headers.get('location')).toBeNull();
  } finally { transport.close(); }
  expect(failure).toMatchObject({ unbilled: false, diagnostic: { failure_class: 'adapter_transport' } });
});
