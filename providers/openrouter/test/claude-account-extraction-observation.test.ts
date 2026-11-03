import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import * as https from 'node:https';
import { PassThrough } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import type { MeetingDocument } from '@echo-brain/organization-processing/core';
import { observeCoreRuntimeV1, type CoreRuntimeObservationV1 } from '@echo-brain/organization-authority-kernel/shared/core-runtime-observation-v1';
import { createClaudeAccountDecisionProcessorV1 } from '../src/llm/claude-account-decision-processor.js';
import { claudeAccountDecisionProcessorCredentialReferenceV1, fixedClaudeAccountDecisionProcessorConfigV1 } from '../src/claude-account-decision-processor-config-v1.js';
import { ClaudeResearchResultErrorV1 } from '../src/claude-research/sdk-client.js';

vi.mock('node:https', async importOriginal => ({ ...await importOriginal<typeof import('node:https')>(), request: vi.fn() }));
afterEach(() => { vi.resetAllMocks(); });
const account = { home_directory: '/synthetic/owner', executable_path: '/synthetic/claude' };
const meeting: MeetingDocument = { schema_version: 1, id: 'synthetic-meeting', title: 'Synthetic', participants: [], artifacts: [],
  capture: { state: 'complete', components: [{ kind: 'notes', state: 'available' }] },
  content: [{ id: 'note', kind: 'note', text: 'A synthetic observation.' }],
  provenance: { source: { kind: 'meeting-source', adapter_id: 'synthetic', instance_id: 'synthetic', version: '1.0.0' },
    external_id: 'synthetic', canonical_revision: 'sha256:synthetic', observed_at: '2026-11-03T00:00:00.000Z', normalizer_version: '1.0.0' } };

it.each([false, true])('records one extraction attempt and its actual usage when SDK failure=%s', async fail => {
  const events: CoreRuntimeObservationV1[] = [];
  vi.mocked(https.request).mockImplementation((...args: Parameters<typeof https.request>) => {
    expect(args[0]).toMatchObject({ hostname: 'api.anthropic.com', path: '/v1/messages' });
    const receive = args.find(value => typeof value === 'function') as (reply: IncomingMessage) => void;
    return Object.assign(new EventEmitter(), { end() {
      const reply = Object.assign(new PassThrough(), { statusCode: 200, headers: { 'content-type': 'text/event-stream' } });
      receive(reply as unknown as IncomingMessage);
      const data = [
        { type: 'message_start', message: { usage: { input_tokens: 11, output_tokens: 0 } } },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 7 } },
      ];
      reply.end(data.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''));
    } }) as unknown as ReturnType<typeof https.request>;
  });
  const processor = createClaudeAccountDecisionProcessorV1(
    fixedClaudeAccountDecisionProcessorConfigV1('synthetic', claudeAccountDecisionProcessorCredentialReferenceV1(account)),
    { account, run: async input => {
      const response = await fetch(`${input.base_url}/v1/messages`, { method: 'POST', headers: { authorization: 'Bearer synthetic-native-account' },
        body: JSON.stringify({ model: input.model, max_tokens: input.max_output_tokens, system: input.system,
          messages: [{ role: 'user', content: input.prompt }] }) });
      await response.text();
      if (fail) throw new ClaudeResearchResultErrorV1();
      return { signals: [] };
    } },
  );
  const operation = observeCoreRuntimeV1('extraction', () => processor.extract(meeting,
    { processor_version: processor.identity.version, input_fingerprint: 'sha256:synthetic' }), { observer: event => { events.push(event); } });
  if (fail) await expect(operation).rejects.toMatchObject({ code: 'permanently_rejected' });
  else await expect(operation).resolves.toMatchObject({ signals: [] });
  expect(https.request).toHaveBeenCalledTimes(1);
  const calls = events.filter(event => event.phase === 'model_call' && event.event !== 'started');
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ event: fail ? 'failed' : 'succeeded', counts: { active_models: 1, input_tokens: 11, output_tokens: 7, total_tokens: 18 } });
});
