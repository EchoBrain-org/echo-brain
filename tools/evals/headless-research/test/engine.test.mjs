import { test } from 'node:test';
import assert from 'node:assert/strict';
import { messageUsageObserver } from '../message-usage.mjs';
import { startModelFence } from '../model-fence.mjs';

test('streamed usage counts cache tokens once and never retains generated content', () => {
  const observer = messageUsageObserver();
  const events = [
    { type: 'message_start', message: { usage: { input_tokens: 10, cache_read_input_tokens: 20, cache_creation_input_tokens: 30, output_tokens: 0 } } },
    { type: 'content_block_delta', delta: { text: 'Private synthetic content é🌱' } },
    { type: 'message_delta', usage: { output_tokens: 5 }, delta: { stop_reason: 'tool_use' } },
  ];
  const bytes = Buffer.from(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''));
  for (const byte of bytes) observer.write(Buffer.from([byte]));
  assert.deepEqual(observer.end(), { finish_reason: 'tool_use', usage: { input_tokens: 60, output_tokens: 5, total_tokens: 65, cached_input_tokens: 20, reasoning_tokens: null } });
  assert.deepEqual(messageUsageObserver().end(), {});
});

test('the request wrapper admits exact bytes before forwarding, and a rejection sends nothing', async () => {
  let sent = 0, deny = false;
  const admitted = [];
  const fence = await startModelFence({ check: async () => {}, around: async ({ body, path, forward }) => {
    assert.equal(sent, admitted.length); if (deny) throw new Error('revoked');
    admitted.push({ body: body.toString(), path }); return forward();
  }, forward: async ({ res }) => { sent++; res.writeHead(200); res.end('{}'); } });
  try {
    const base = fence.environment().ANTHROPIC_BASE_URL;
    for (const body of ['initial', 'retry', 'compaction']) assert.equal((await fetch(`${base}/v1/messages?beta=true`, { method: 'POST', body })).status, 200);
    assert.deepEqual(admitted.map(value => value.body), ['initial', 'retry', 'compaction']);
    deny = true;
    assert.equal((await fetch(`${base}/v1/messages`, { method: 'POST', body: 'revoked' })).status, 403);
    assert.equal(sent, 3); assert.equal(fence.stats().forwarded, 3);
  } finally { fence.close(); }
});
