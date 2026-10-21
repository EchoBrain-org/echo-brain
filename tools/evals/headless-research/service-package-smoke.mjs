// No remote endpoint, provider credentials or user data. Also runs inside the
// built Authority image to prove its production dependency closure and SDK MCP.
import assert from 'node:assert/strict';
import { createClaudeResearchDriverV1 } from '../../../providers/openrouter/dist/claude-research/driver.js';

const model = 'anthropic/claude-sonnet-5.5';
const signal = AbortSignal.timeout(45_000);
const actions = [], admitted = [];
let calls = 0;
const driver = createClaudeResearchDriverV1({ model, forward: async ({ body, res, path }) => {
  const input = JSON.parse(body.toString());
  assert.equal(input.model, model);
  if (path.includes('count_tokens')) { res.end('{"input_tokens":10}'); return {}; }
  calls++;
  const action = actions.length === 0 ? 'search' : actions.length === 1 ? 'finish' : 'StructuredOutput';
  const name = input.tools.find(tool => tool.name === action || tool.name.endsWith(`__${action}`))?.name;
  assert.ok(name, `Packaged SDK did not advertise ${action}`);
  const args = action === 'search' ? { query: 'synthetic package check' }
    : action === 'finish' ? { completed: true, parts: [{ question: 'Package check', notes: 'Synthetic proof.', needs: [{ need: 'proof', kind: 'content', status: 'found', evidence: ['E1'] }] }] }
    : { finished: true };
  const content = { type: 'tool_use', id: `toolu_synthetic_${calls}`, name, input: args };
  const message = { id: `msg_synthetic_${calls}`, type: 'message', role: 'assistant', model, content: [content], stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 } };
  if (input.stream) {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const event of [
      { type: 'message_start', message: { ...message, content: [], stop_reason: null } },
      { type: 'content_block_start', index: 0, content_block: { ...content, input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(args) } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: 10 } },
      { type: 'message_stop' },
    ]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    res.end();
  } else { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(message)); }
  return {};
} });
await driver.run({ initial: { question: 'Synthetic package check' }, question: true, list_available: false, signal,
  remaining: () => 45_000,
  model_request: async (request, forward) => { admitted.push(request); return (await forward(signal)).value; },
  call: async (name, args) => {
    actions.push(name);
    if (name === 'search') return { results: [{ id: 'E1', text: 'Synthetic proof.', full_text: true }] };
    assert.equal(name, 'finish'); assert.equal(args.completed, true);
    return { accepted: true, completed: true };
  },
});
assert.deepEqual(actions, ['search', 'finish']);
assert.ok(calls >= 3);
assert.ok(admitted.length >= calls);
assert.ok(admitted[1].payload_digests.length >= 2, 'The admitted body must include the actual tool result.');
process.stdout.write(JSON.stringify({ ok: true, sdk: 'packaged', model_requests: calls, admitted_requests: admitted.length, tools: actions }) + '\n');
