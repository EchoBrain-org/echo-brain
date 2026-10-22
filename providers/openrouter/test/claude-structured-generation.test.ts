import { expect, it, vi } from 'vitest';
import type { StructuredGenerationInput, StructuredGenerationRequestV1 } from '@echo-brain/organization-authority-kernel/answer-composition/structured-generation-v1';
import { createClaudeAccountStructuredGenerationV1 } from '../src/claude-research/structured-generation.js';
import { ClaudeModelResponseErrorV1 } from '../src/claude-research/model-transport.js';
import { ClaudeResearchResultErrorV1 } from '../src/claude-research/sdk-client.js';

const model = 'claude-sonnet-5-5';
const account = { home_directory: '/synthetic/owner', executable_path: '/synthetic/claude' };
const input: StructuredGenerationInput = { model, system_prompt: 'Synthetic writer instructions', user_prompt: '{"evidence":"Synthetic E1"}',
  schema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] }, max_output_tokens: 1500, timeout_ms: 20_000 };
const body = JSON.stringify({ model, max_tokens: 1500, system: input.system_prompt, messages: [{ role: 'user', content: input.user_prompt }] });

it('uses native account writing with the original evidence/schema and fresh admission for every request', async () => {
  const requests: StructuredGenerationRequestV1[] = [];
  let admitted = 0, forwarded = 0;
  const port = createClaudeAccountStructuredGenerationV1({ account, model,
    forward: async ({ res }) => { expect(admitted).toBe(++forwarded); res.end('{}'); return { content: [{ type: 'text', text: 'synthetic' }], finish_reason: 'stop' }; },
    run: async request => {
      expect(request).toMatchObject({ account, schema: input.schema, prompt: input.user_prompt, system: input.system_prompt, max_output_tokens: 1500 });
      for (const path of ['messages', 'messages/count_tokens', 'messages']) {
        const response = await fetch(`${request.base_url}/v1/${path}`, { method: 'POST', body });
        expect(response.status).toBe(200); await response.text();
      }
      return { answer: 'Synthetic E1' };
    },
  });
  await expect(port.generate(input)).rejects.toThrow('per-request admission');
  await expect(port.generate_with_admission!(input, async (request, forward) => {
    admitted++; requests.push(request); return (await forward(new AbortController().signal)).value;
  })).resolves.toEqual({ answer: 'Synthetic E1' });
  expect(requests.map(request => request.operation)).toEqual(['messages', 'count_tokens', 'messages']);
  expect(requests.every(request => /^sha256:[a-f0-9]{64}$/u.test(request.body_sha256))).toBe(true);
  expect(requests[0]!.diagnostic_input).toMatchObject({ model });
  expect(requests[0]!.signal?.aborted).toBe(true);
});

it('refuses an SDK request exceeding the admitted writer allowance', async () => {
  const forward = vi.fn();
  const port = createClaudeAccountStructuredGenerationV1({ account, model, forward,
    run: async request => {
      await fetch(`${request.base_url}/v1/messages`, { method: 'POST', body: body.replace('1500', '32000') }).catch(() => undefined);
      return {};
    },
  });
  await expect(port.generate_with_admission!(input, async (_request, send) => (await send(new AbortController().signal)).value)).rejects.toThrow('output allowance');
  expect(forward).not.toHaveBeenCalled();
});

it.each(['model', 'evidence'] as const)('refuses a native writer that changes its %s before forwarding', async field => {
  const forward = vi.fn();
  const port = createClaudeAccountStructuredGenerationV1({ account, model, forward,
    run: async request => {
      await fetch(`${request.base_url}/v1/messages`, { method: 'POST', body: field === 'model' ? body.replace(model, 'other-model') : body.replace('Synthetic E1', 'different evidence') }).catch(() => undefined);
      return {};
    },
  });
  await expect(port.generate_with_admission!(input, async (_request, send) => (await send(new AbortController().signal)).value)).rejects.toThrow();
  expect(forward).not.toHaveBeenCalled();
});

it('preserves a native provider failure instead of switching to a shared account or hiding its status', async () => {
  const port = createClaudeAccountStructuredGenerationV1({ account, model,
    forward: async ({ res }) => { res.writeHead(429); res.end('{}'); throw new ClaudeModelResponseErrorV1(429); },
    run: async request => {
      expect((await fetch(`${request.base_url}/v1/messages`, { method: 'POST', body })).status).toBe(429);
      throw new ClaudeResearchResultErrorV1();
    },
  });
  await expect(port.generate_with_admission!(input, async (_request, send) => (await send(new AbortController().signal)).value)).rejects.toMatchObject({ diagnostic: { http_status: 429 } });
});

it('cannot succeed without any admitted model request', async () => {
  const port = createClaudeAccountStructuredGenerationV1({ account, model, run: async () => ({ answer: 'not admitted' }) });
  await expect(port.generate_with_admission!(input, vi.fn())).rejects.toThrow('did not use model admission');
});

it('reports an expired queued admission as a retryable adapter timeout', async () => {
  const port = createClaudeAccountStructuredGenerationV1({ account, model,
    run: async request => {
      await fetch(`${request.base_url}/v1/messages`, { method: 'POST', body }).catch(() => undefined);
      throw new ClaudeResearchResultErrorV1();
    },
  });
  await expect(port.generate_with_admission!({ ...input, timeout_ms: 100 }, request => new Promise((_resolve, reject) => {
    request.signal!.throwIfAborted();
    request.signal!.addEventListener('abort', () => reject(request.signal!.reason), { once: true });
  }))).rejects.toMatchObject({ diagnostic: { failure_class: 'adapter_timeout', http_status: null } });
});
