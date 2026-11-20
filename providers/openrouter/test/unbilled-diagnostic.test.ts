import { expect, it } from 'vitest';
import type { StructuredGenerationInput } from '@echo-brain/organization-authority-kernel/answer-composition/structured-generation-v1';
import { createOpenRouterStructuredGenerationAdapter } from '../src/adapters/answer-composition/openrouter/openrouter-structured-generation-adapter.js';
import { ClaudeModelResponseErrorV1, ClaudeModelTransportErrorV1 } from '../src/claude-research/model-transport.js';
import { createClaudeAccountStructuredGenerationV1 } from '../src/claude-research/structured-generation.js';
import { ClaudeResearchResultErrorV1 } from '../src/claude-research/sdk-client.js';

const request = { model: 'anthropic/claude-sonnet-5.5', system_prompt: 's', user_prompt: 'u', schema: { type: 'object' }, max_output_tokens: 10, timeout_ms: 1_000 } as const;
const adapter = (fetchImpl: typeof fetch) => createOpenRouterStructuredGenerationAdapter({ credential_ref: 'fixture', credential_resolver: () => 'SECRET', fetch_impl: fetchImpl });
const failed = (code: string) => (async () => { throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('synthetic'), { code }) }); }) as unknown as typeof fetch;
const status = (value: number) => (async () => new Response('{"error":{"message":"synthetic","code":' + value + '}}', { status: value, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
const diagnostic = async (fetchImpl: typeof fetch) => {
  try { await adapter(fetchImpl).generate(request); } catch (error) { return (error as { diagnostic: Record<string, unknown> }).diagnostic; }
  throw new Error('expected a failure');
};

it.each(['ECONNREFUSED', 'ENOTFOUND', 'UND_ERR_CONNECT_TIMEOUT'])('marks an OpenRouter call that failed to connect (%s) unbilled where the gate reads it', async code => {
  expect(await diagnostic(failed(code))).toMatchObject({ failure_class: 'adapter_transport', unbilled: true });
});

it.each([429, 503, 529])('marks an OpenRouter %i refusal, documented as refused before generation, unbilled', async value => {
  expect(await diagnostic(status(value))).toMatchObject({ http_status: value, unbilled: true });
});

it('leaves a failure whose billing is unknown unmarked: a connection lost after sending, a permanent refusal, a cut stream', async () => {
  expect(await diagnostic(failed('ECONNRESET'))).not.toHaveProperty('unbilled');
  expect(await diagnostic(status(400))).not.toHaveProperty('unbilled');
  // A gateway 5xx can arrive after the upstream generated: not proof nothing was billed.
  for (const value of [500, 502, 504, 402]) expect(await diagnostic(status(value))).not.toHaveProperty('unbilled');
  const cut = (async () => new Response('data: {"choices":[{"delta":{"content":"{}"}}]}\n\n', { headers: { 'content-type': 'text/event-stream' } })) as unknown as typeof fetch;
  expect(await diagnostic(cut)).not.toHaveProperty('unbilled');
});

it('carries a Claude failure\'s known-unbilled outcome on its diagnostic, and nothing when billing is unknown', () => {
  expect(new ClaudeModelTransportErrorV1(true).diagnostic).toEqual({ failure_class: 'adapter_transport', http_status: null, unbilled: true });
  expect(new ClaudeModelTransportErrorV1().diagnostic).toEqual({ failure_class: 'adapter_transport', http_status: null });
  expect(new ClaudeModelResponseErrorV1(529).diagnostic).toMatchObject({ http_status: 529, unbilled: true });
  expect(new ClaudeModelResponseErrorV1(500).diagnostic).not.toHaveProperty('unbilled');
});

it('hands the gate the Claude-account writer\'s unbilled failure with its flag', async () => {
  const model = 'claude-sonnet-5-5';
  const input: StructuredGenerationInput = { model, system_prompt: 'Synthetic writer instructions', user_prompt: '{"evidence":"E1"}', schema: { type: 'object' }, max_output_tokens: 1500, timeout_ms: 20_000 };
  const body = JSON.stringify({ model, max_tokens: 1500, system: input.system_prompt, messages: [{ role: 'user', content: input.user_prompt }] });
  const port = createClaudeAccountStructuredGenerationV1({ account: { home_directory: '/synthetic', executable_path: '/synthetic/claude' }, model,
    forward: async () => { throw new ClaudeModelTransportErrorV1(true); },
    run: async run => { expect((await fetch(`${run.base_url}/v1/messages`, { method: 'POST', body })).status).toBe(502); throw new ClaudeResearchResultErrorV1(); } });
  await expect(port.generate_with_admission!(input, async (_request, send) => (await send(new AbortController().signal, () => undefined)).value))
    .rejects.toMatchObject({ diagnostic: { failure_class: 'adapter_transport', unbilled: true } });
});
