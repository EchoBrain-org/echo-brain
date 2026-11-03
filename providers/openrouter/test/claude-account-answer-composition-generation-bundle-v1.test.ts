import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import * as https from 'node:https';
import { PassThrough } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import type { AgenticResearchDriverSessionV1 } from '@echo-brain/organization-authority-kernel/answer-composition/agentic-ask-v1';
import type { StructuredGenerationInput } from '@echo-brain/organization-authority-kernel/answer-composition/structured-generation-v1';
import { createClaudeAccountAnswerCompositionGenerationBundleV1 } from '../src/claude-account-answer-composition-generation-bundle-v1.js';
import { CLAUDE_ACCOUNT_MODEL_V1 } from '../src/claude-research/account-profile.js';
import { runClaudeResearchV1, runClaudeStructuredV1 } from '../src/claude-research/sdk-client.js';

vi.mock('../src/claude-research/sdk-client.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/claude-research/sdk-client.js')>(),
  runClaudeResearchV1: vi.fn(),
  runClaudeStructuredV1: vi.fn(),
}));
vi.mock('node:https', async importOriginal => ({
  ...await importOriginal<typeof import('node:https')>(),
  request: vi.fn(),
}));
afterEach(() => { vi.resetAllMocks(); });

const account = { home_directory: '/synthetic/account', executable_path: '/synthetic/claude' };
const model = CLAUDE_ACCOUNT_MODEL_V1;
const writerInput: StructuredGenerationInput = {
  model, system_prompt: 'Write from synthetic evidence', user_prompt: 'Synthetic E1',
  schema: { type: 'object' }, max_output_tokens: 100, timeout_ms: 20_000,
};
function researchSession(): AgenticResearchDriverSessionV1 {
  return {
    initial: { evidence: 'Synthetic E1' }, question: true, list_available: false,
    signal: new AbortController().signal, remaining: () => 20_000, call: async () => ({}),
    model_request: async (request, send) => {
      expect(request.model).toBe(model);
      return (await send(new AbortController().signal)).value;
    },
  };
}

it('uses the same native Sonnet account for default research and admitted writing', async () => {
  const destinations: unknown[] = [];
  vi.mocked(https.request).mockImplementation((...args: Parameters<typeof https.request>) => {
    destinations.push(args[0]);
    const receive = args.find(value => typeof value === 'function') as (reply: IncomingMessage) => void;
    return Object.assign(new EventEmitter(), { end() {
      const reply = Object.assign(new PassThrough(), { statusCode: 200, headers: { 'content-type': 'application/json' } });
      receive(reply as unknown as IncomingMessage); reply.end('{}');
    } }) as unknown as ReturnType<typeof https.request>;
  });
  const session = researchSession();
  vi.mocked(runClaudeResearchV1).mockImplementation(async request => {
    expect(request).toMatchObject({ account, model, prompt: JSON.stringify(session.initial) });
    const reply = await fetch(`${request.base_url}/v1/messages`, {
      method: 'POST', headers: { authorization: 'Bearer synthetic-native-account' },
      body: JSON.stringify({ model: request.model, messages: [{ role: 'user', content: request.prompt }] }),
    });
    expect(reply.status).toBe(200); await reply.text();
  });
  vi.mocked(runClaudeStructuredV1).mockImplementation(async request => {
    expect(request).toMatchObject({ account, model, prompt: writerInput.user_prompt, schema: writerInput.schema });
    const reply = await fetch(`${request.base_url}/v1/messages`, {
      method: 'POST', headers: { authorization: 'Bearer synthetic-native-account' },
      body: JSON.stringify({ model: request.model, max_tokens: request.max_output_tokens,
        system: request.system, messages: [{ role: 'user', content: request.prompt }] }),
    });
    expect(reply.status).toBe(200); await reply.text();
    return { answer: 'Synthetic E1' };
  });
  const binding = createClaudeAccountAnswerCompositionGenerationBundleV1({ account }).load();
  expect(binding.personal_research).toBeUndefined();
  expect(binding.generation).toEqual({ generation_adapter_id: 'claude-account-research-writer-v1',
    planner_model: 'claude-sonnet-5-5', answer_model: 'claude-sonnet-5-5', timeout_ms: 60_000, context_tokens: 131_072 });
  await binding.research_driver!.run(session);
  await expect(binding.structured_output.generate_with_admission!(writerInput, async (request, send) => {
    expect(request.model).toBe(model);
    return (await send(new AbortController().signal)).value;
  })).resolves.toEqual({ answer: 'Synthetic E1' });
  expect(runClaudeResearchV1).toHaveBeenCalledTimes(1);
  expect(runClaudeStructuredV1).toHaveBeenCalledTimes(1);
  expect(destinations).toEqual(Array.from({ length: 2 }, () => expect.objectContaining({
    hostname: 'api.anthropic.com', path: '/v1/messages',
    headers: expect.objectContaining({ authorization: 'Bearer synthetic-native-account' }),
  })));
});

it.each(['research', 'writing'] as const)('propagates native %s failure without invoking an alternate model route', async path => {
  const failure = new Error('Synthetic personal-account unavailable');
  vi.mocked(runClaudeResearchV1).mockRejectedValue(failure);
  vi.mocked(runClaudeStructuredV1).mockRejectedValue(failure);
  const binding = createClaudeAccountAnswerCompositionGenerationBundleV1({ account }).load();
  const result = path === 'research'
    ? binding.research_driver!.run(researchSession())
    : binding.structured_output.generate_with_admission!(writerInput, vi.fn());
  await expect(result).rejects.toBe(failure);
  expect(https.request).not.toHaveBeenCalled();
  expect(runClaudeResearchV1).toHaveBeenCalledTimes(path === 'research' ? 1 : 0);
  expect(runClaudeStructuredV1).toHaveBeenCalledTimes(path === 'writing' ? 1 : 0);
});
