import { afterEach, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import type { Options, query } from '@anthropic-ai/claude-agent-sdk';
import { canonicalSha256 } from '@echo-brain/federation-protocol';
import type { AgenticResearchDriverSessionV1 } from '@echo-brain/organization-authority-kernel/answer-composition/agentic-ask-v1';
import { runClaudeResearchV1 } from '../src/claude-research/sdk-client.js';
import { ClaudeModelResponseErrorV1, startClaudeModelTransportV1 } from '../src/claude-research/model-transport.js';
import { createClaudeResearchDriverV1 } from '../src/claude-research/driver.js';
import { messageUsageObserverV1 } from '../src/claude-research/message-usage.js';

afterEach(() => vi.unstubAllEnvs());
const model = 'anthropic/claude-sonnet-5.5';

it('fences every exact request including retries and count_tokens, and closes on revocation', async () => {
  const bodies: string[] = []; let revoked = false, calls = 0;
  const fence = await startClaudeModelTransportV1({ signal: new AbortController().signal,
    admit: async (body, _operation, send) => { if (revoked) throw new Error('revoked'); bodies.push(body.toString()); return send(new AbortController().signal); },
    forward: async ({ res }) => { calls++; res.end('{}'); return {}; },
  });
  try {
    for (const [path, body] of [['messages', 'initial'], ['messages', 'retry'], ['messages/count_tokens', 'count']]) {
      expect((await fetch(`${fence.base_url}/v1/${path}`, { method: 'POST', body })).status).toBe(200);
    }
    expect(bodies).toEqual(['initial', 'retry', 'count']); expect(calls).toBe(3);
    expect((await fetch(`${fence.base_url}/v1/models`)).status).toBe(404);
    // A malformed absolute-form HTTP target must not reject the server's async handler.
    const address = new URL(fence.base_url);
    const malformed = await new Promise<number | undefined>((resolve, reject) => {
      const request = httpRequest({ hostname: address.hostname, port: address.port, method: 'POST', path: 'http://[' }, response => { response.resume(); resolve(response.statusCode); });
      request.on('error', reject); request.end();
    });
    expect(malformed).toBe(404);
    revoked = true;
    expect((await fetch(`${fence.base_url}/v1/messages`, { method: 'POST', body: 'blocked' })).status).toBe(403);
    expect(calls).toBe(3);
  } finally { fence.close(); }
});

it('isolates the packaged SDK environment and removes its temporary home after completion', async () => {
  vi.stubEnv('ECHO_SYNTHETIC_HOST_SECRET', 'must-not-reach-child');
  let options: Options | undefined;
  const fake = ((input: Parameters<typeof query>[0]) => {
    options = input.options;
    return Object.assign((async function* () {
      const child = options!.spawnClaudeCodeProcess!({ command: process.execPath,
        args: ['-e', 'process.stdout.write(JSON.stringify({hasHostSecret:!!process.env.ECHO_SYNTHETIC_HOST_SECRET,home:process.env.HOME,token:process.env.ANTHROPIC_AUTH_TOKEN}))'],
        env: { ECHO_SYNTHETIC_HOST_SECRET: 'injected-by-parent' }, signal: new AbortController().signal });
      let text = ''; for await (const chunk of child.stdout) text += chunk.toString();
      expect(JSON.parse(text)).toEqual({ hasHostSecret: false, home: options!.cwd, token: 'echo-loopback-only' });
      yield { type: 'result', subtype: 'success', is_error: false };
    })(), { close() {} });
  }) as unknown as typeof query;
  await runClaudeResearchV1({ prompt: 'synthetic', system: 'synthetic', model, base_url: 'http://127.0.0.1:1/fixture',
    signal: new AbortController().signal, servers: {}, tools: ['mcp__echo_research__search'] }, fake);
  expect(options).toMatchObject({ tools: [], settingSources: [], plugins: [], persistSession: false, permissionMode: 'dontAsk' });
  expect(options!.pathToClaudeCodeExecutable).toBeUndefined();
  expect(options!.maxTurns).toBeUndefined(); expect(options!.maxBudgetUsd).toBeUndefined();
  expect(existsSync(options!.cwd!)).toBe(false);
});

it('delivers provider errors to the SDK and freshly admits its retry without latching an access failure', async () => {
  let checks = 0, forwards = 0;
  const errors: unknown[] = [];
  const driver = createClaudeResearchDriverV1({ model,
    forward: async ({ res }) => {
      if (++forwards === 1) {
        res.writeHead(429, { 'content-type': 'application/json' }); res.end('{"error":"synthetic rate limit"}');
        throw new ClaudeModelResponseErrorV1(429);
      }
      res.end('{}'); return {};
    },
    run: async input => {
      const send = () => fetch(`${input.base_url}/v1/messages`, { method: 'POST', body: JSON.stringify({ model, messages: [] }) });
      expect((await send()).status).toBe(429);
      expect((await send()).status).toBe(200);
    },
  });
  await driver.run({ initial: {}, question: true, list_available: false, signal: new AbortController().signal,
    remaining: () => 60_000, call: async () => ({}), model_request: async (_request, send) => {
      checks++;
      try { return (await send(new AbortController().signal)).value; }
      catch (error) { errors.push(error); throw error; }
    },
  });
  expect(checks).toBe(2); expect(forwards).toBe(2);
  expect(errors).toEqual([expect.objectContaining({ diagnostic: { failure_class: 'adapter_http', http_status: 429 } })]);
});

it('aborts in-flight provider work and closes the request gateway when the caller leaves', async () => {
  const cancel = new AbortController();
  let started!: () => void, aborted = false;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const transport = await startClaudeModelTransportV1({ signal: cancel.signal,
    admit: (_body, _operation, send) => send(cancel.signal),
    forward: async ({ signal }) => {
      started();
      await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }, { once: true }));
      return {};
    },
  });
  const pending = fetch(`${transport.base_url}/v1/messages`, { method: 'POST', body: '{}' }).catch(() => undefined);
  try { await ready; cancel.abort(); await pending; expect(aborted).toBe(true); }
  finally { transport.close(); }
});

it('admits the exact initial packet and refuses an unexpected model before forwarding', async () => {
  const initial = { question: 'synthetic only' }, requests: unknown[] = [];
  let forwarded = 0;
  const session: AgenticResearchDriverSessionV1 = { initial, question: true, list_available: true,
    signal: new AbortController().signal, remaining: () => 60_000, call: async () => ({}),
    model_request: async (request, send) => { requests.push(request); return (await send(new AbortController().signal)).value; },
  };
  const make = (requestedModel: string) => createClaudeResearchDriverV1({ model,
    forward: async ({ res }) => { forwarded++; res.end('{}'); return {}; },
    run: async input => { await fetch(`${input.base_url}/v1/messages`, { method: 'POST', body: JSON.stringify({ model: requestedModel, messages: [{ role: 'user', content: input.prompt }], max_tokens: 100 }) }); },
  });
  await make(model).run(session);
  expect(requests).toEqual([expect.objectContaining({ model, payload_digests: [canonicalSha256(initial)], diagnostic_input: expect.objectContaining({ model }) })]);
  await expect(make('unexpected').run(session)).rejects.toThrow('Unexpected SDK model route');
  expect(forwarded).toBe(1);
});

it('counts streaming usage and captures visible tool output without reasoning or transport headers', () => {
  const observer = messageUsageObserverV1(true);
  const events = [
    { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 20, cache_creation_input_tokens: 30 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: 'not retained' } },
    { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tool1', name: 'search', input: {} } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"query":"synthetic é"}' } },
    { type: 'message_delta', usage: { output_tokens: 5 }, delta: { stop_reason: 'tool_use' } },
  ];
  const bytes = Buffer.from(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''));
  for (const byte of bytes) observer.write(Buffer.from([byte]));
  expect(observer.end()).toEqual({ finish_reason: 'tool_use', usage: { input_tokens: 60, output_tokens: 5, total_tokens: 65, cached_input_tokens: 20, reasoning_tokens: null },
    content: [{ type: 'tool_use', id: 'tool1', name: 'search', input: { query: 'synthetic é' } }] });
});

it('runs the packaged SDK executable against a synthetic local Messages endpoint', async () => {
  const signal = AbortSignal.timeout(25_000);
  let calls = 0;
  const transport = await startClaudeModelTransportV1({ signal,
    admit: (_body, _operation, send) => send(signal),
    forward: async ({ body, res, path }) => {
      const input = JSON.parse(body.toString()); expect(input.model).toBe(model);
      if (path.includes('count_tokens')) { res.end(JSON.stringify({ input_tokens: 10 })); return {}; }
      calls++;
      const structured = input.tools?.find((tool: { name: string }) => tool.name === 'StructuredOutput');
      const content = calls === 1 && structured
        ? { type: 'tool_use', id: 'toolu_synthetic_1', name: 'StructuredOutput', input: { finished: true } }
        : { type: 'text', text: '{"finished":true}' };
      const message = { id: `msg_synthetic_${calls}`, type: 'message', role: 'assistant', model, content: [content], stop_reason: content.type === 'tool_use' ? 'tool_use' : 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 } };
      if (input.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const event of [
          { type: 'message_start', message: { ...message, content: [], stop_reason: null } },
          { type: 'content_block_start', index: 0, content_block: content },
          { type: 'content_block_stop', index: 0 },
          { type: 'message_delta', delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: 10 } },
          { type: 'message_stop' },
        ]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        res.end();
      } else { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(message)); }
      return {};
    },
  });
  try {
    await runClaudeResearchV1({ prompt: 'Synthetic fixture: finish successfully.', system: 'Use StructuredOutput to return finished true.',
      model, base_url: transport.base_url, signal, servers: {}, tools: [] });
    expect(calls).toBeGreaterThan(0);
  } finally { transport.close(); }
}, 30_000);
