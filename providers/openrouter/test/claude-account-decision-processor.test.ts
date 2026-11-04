import { describe, expect, it, vi } from 'vitest';
import type { MeetingDocument } from '@echo-brain/organization-processing/core';
import { StructuredGenerationAttemptError } from '@echo-brain/organization-processing/llm/llm-provider';
import { createClaudeAccountDecisionProcessorBundleV1 } from '../src/claude-account-decision-processor-bundle-v1.js';
import { claudeAccountDecisionProcessorConfigurationSha256V1, claudeAccountDecisionProcessorCredentialReferenceV1,
  CLAUDE_ACCOUNT_DECISION_PROCESSOR_RUNTIME_VERSION_V1, fixedClaudeAccountDecisionProcessorConfigV1 } from '../src/claude-account-decision-processor-config-v1.js';
import { createClaudeAccountDecisionProcessorV1, createClaudeAccountLlmProviderClientV1 } from '../src/llm/claude-account-decision-processor.js';
import { OPENROUTER_DECISION_PROCESSOR_RUNTIME_VERSION_V1, openRouterDecisionProcessorConfigurationSha256V1 } from '../src/openrouter-decision-processor-config-v1.js';
import { ClaudeModelResponseErrorV1, ClaudeModelTransportErrorV1 } from '../src/claude-research/model-transport.js';
import { ClaudeResearchResultErrorV1, type runClaudeStructuredV1 } from '../src/claude-research/sdk-client.js';

const account = { home_directory: '/synthetic/owner', executable_path: '/synthetic/claude' };
const model = 'claude-sonnet-5-5';
const request = { model, systemPrompt: 'Synthetic instructions', userPrompt: 'Synthetic evidence',
  schema: { type: 'object' }, maxOutputTokens: 8192 };
const source = { adapter_id: 'synthetic-source', instance_id: 'synthetic-source', version: '1.0.0',
  custodian_sha256: `sha256:${'a'.repeat(64)}`, credential_reference_sha256: `sha256:${'b'.repeat(64)}` } as const;

async function send(input: Parameters<typeof runClaudeStructuredV1>[0]) {
  const response = await fetch(`${input.base_url}/v1/messages`, { method: 'POST', body: JSON.stringify({
    model: input.model, max_tokens: input.max_output_tokens, system: input.system, messages: [{ role: 'user', content: input.prompt }],
  }) });
  await response.text();
  return response;
}

describe('native Claude extraction commitments', () => {
  it('binds new processing/configuration and account references without reading any credential', () => {
    const selected = { ...account };
    const bundle = createClaudeAccountDecisionProcessorBundleV1({ account: selected });
    const processor = bundle.current_commitments('fixed-processor');
    const admission = { source: { adapter_id: 'synthetic-source', instance_id: 'synthetic-source', version: '1.0.0',
      cursor: 'opaque', cutoff_at: '2026-11-03T00:00:00.000Z' }, processor };
    expect(processor.version).toBe(CLAUDE_ACCOUNT_DECISION_PROCESSOR_RUNTIME_VERSION_V1);
    expect(processor.version).not.toBe(OPENROUTER_DECISION_PROCESSOR_RUNTIME_VERSION_V1);
    expect(processor.configuration_sha256).toBe(claudeAccountDecisionProcessorConfigurationSha256V1());
    expect(processor.configuration_sha256).not.toBe(openRouterDecisionProcessorConfigurationSha256V1());
    expect(() => bundle.create_processor(admission)).toThrow('commitments were not checked');
    bundle.assert_admission_commitments({ source, processor });
    selected.home_directory = '/synthetic/changed';
    expect(bundle.current_commitments('fixed-processor')).toEqual(processor);
    expect(bundle.create_processor(admission).identity).toMatchObject({ adapter_id: 'llm', instance_id: 'fixed-processor', version: processor.version });
    for (const changed of [
      { ...processor, version: OPENROUTER_DECISION_PROCESSOR_RUNTIME_VERSION_V1 },
      { ...processor, configuration_sha256: openRouterDecisionProcessorConfigurationSha256V1() },
      createClaudeAccountDecisionProcessorBundleV1({ account: { ...account, home_directory: '/different/owner' } }).current_commitments('fixed-processor'),
      createClaudeAccountDecisionProcessorBundleV1({ account: { ...account, executable_path: '/different/claude' } }).current_commitments('fixed-processor'),
    ]) expect(() => bundle.assert_admission_commitments({ source, processor: changed })).toThrow('differs from the admitted processor commitment');
    expect(() => bundle.create_processor({ ...admission, processor: { ...processor, configuration_sha256: openRouterDecisionProcessorConfigurationSha256V1() } })).toThrow('differs from the admitted processor');
    expect(() => bundle.create_processor({ ...admission, processor: { ...processor, instance_id: 'unchecked-instance' } })).toThrow('commitments were not checked');
  });

  it('rejects invalid account references and model/provider/endpoint overrides', () => {
    expect(() => createClaudeAccountDecisionProcessorBundleV1({ account: { ...account, home_directory: 'relative' } })).toThrow('profile is invalid');
    const config = fixedClaudeAccountDecisionProcessorConfigV1('fixed-processor', claudeAccountDecisionProcessorCredentialReferenceV1(account));
    const processor = createClaudeAccountDecisionProcessorV1(config, { account });
    expect(processor.validateConfig(config).ok).toBe(true);
    const overrides: Record<string, string>[] = [{ model: 'other' }, { provider: 'openrouter' }, { base_url: 'https://other.invalid' }];
    for (const settings of overrides) {
      expect(processor.validateConfig({ ...config, settings: { ...config.settings, ...settings } }).ok).toBe(false);
    }
    expect(processor.validateConfig({ ...config, credential_ref: 'file:/synthetic/openrouter-key' }).ok).toBe(false);
  });
});

it('runs the unchanged extraction prompt, schema and evidence checks through one native generation', async () => {
  const config = fixedClaudeAccountDecisionProcessorConfigV1('fixed-processor', claudeAccountDecisionProcessorCredentialReferenceV1(account));
  const forward = vi.fn(async ({ res }) => { res.end('{}'); return {}; });
  const processor = createClaudeAccountDecisionProcessorV1(config, { account, forward,
    run: async input => {
      expect(input).toMatchObject({ account, model, max_output_tokens: 8192, single_generation: true });
      expect(input.system).toContain('Extract only explicit decisions, actions, and rationales');
      expect(input.prompt).toContain('Use vendor X for hosting');
      expect(input.schema).toMatchObject({ required: ['signals'], additionalProperties: false });
      await send(input);
      const signal = (text: string, evidence_units: string[]) => ({ kind: 'decision', text, status: 'decided', owner: null,
        due_at: null, confidence: 0.9, evidence_units, supports_decision_indexes: [] });
      return { signals: [signal('Use vendor X for hosting', ['N1']), signal('Invented evidence', ['N999'])] };
    },
  });
  const meeting: MeetingDocument = { schema_version: 1, id: 'synthetic-meeting', title: 'Synthetic decision',
    capture: { state: 'complete', components: [{ kind: 'notes', state: 'available' }] }, participants: [],
    content: [{ id: 'note', kind: 'note', text: 'Use vendor X for hosting' }], artifacts: [],
    provenance: { source: { kind: 'meeting-source', adapter_id: 'synthetic-source', instance_id: 'synthetic-source', version: '1.0.0' },
      external_id: 'synthetic-meeting', canonical_revision: 'sha256:synthetic', observed_at: '2026-11-03T00:00:00.000Z', normalizer_version: '1.0.0' } };
  const result = await processor.extract(meeting, { processor_version: processor.identity.version, input_fingerprint: 'sha256:synthetic' });
  expect(result.signals).toHaveLength(1);
  expect(result.signals[0]!.text).toBe('Use vendor X for hosting');
  expect(forward).toHaveBeenCalledTimes(1);
});

it('retains only actual provider usage on success and on a later SDK failure', async () => {
  const metadata = { usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18, cached_input_tokens: 3, reasoning_tokens: null }, finish_reason: 'stop' };
  for (const fail of [false, true]) {
    const client = createClaudeAccountLlmProviderClientV1({ account,
      forward: async ({ res }) => { res.end('{}'); return metadata; },
      run: async input => { await send(input); if (fail) throw new ClaudeResearchResultErrorV1(); return { signals: [] }; },
    });
    if (fail) {
      const failure = await client.generateStructured(request).catch(error => error);
      expect(failure).toBeInstanceOf(StructuredGenerationAttemptError);
      expect(failure).toMatchObject({ code: 'permanently_rejected', unbilled: false,
        observation: { inputTokens: 11, outputTokens: 7, totalTokens: 18, cachedInputTokens: 3, stopReason: 'stop' } });
      expect(failure.observation).not.toHaveProperty('reasoningTokens');
    } else {
      const result = await client.generateStructured(request);
      expect(result).toEqual({ content: '{"signals":[]}', inputTokens: 11, outputTokens: 7, totalTokens: 18, cachedInputTokens: 3, stopReason: 'stop' });
    }
  }
});

it.each([['http', 'rate_limited'], ['transport', 'unknown_outcome']] as const)('maps %s failures without authorizing a free retry', async (kind, code) => {
  const client = createClaudeAccountLlmProviderClientV1({ account,
    forward: async ({ res }) => {
      if (kind === 'http') { res.writeHead(429); res.end('{}'); throw new ClaudeModelResponseErrorV1(429); }
      throw new ClaudeModelTransportErrorV1();
    },
    run: async input => { await send(input); throw new ClaudeResearchResultErrorV1(); },
  });
  await expect(client.generateStructured(request)).rejects.toMatchObject({ code, unbilled: false });
});

it('refuses SDK retry after a provider rejection without a second upstream generation', async () => {
  const forward = vi.fn(async ({ res }) => { res.writeHead(429); res.end('{}'); throw new ClaudeModelResponseErrorV1(429); });
  const client = createClaudeAccountLlmProviderClientV1({ account, forward,
    run: async input => { await send(input); await send(input).catch(() => undefined); throw new ClaudeResearchResultErrorV1(); },
  });
  await expect(client.generateStructured(request)).rejects.toMatchObject({ code: 'permanently_rejected', unbilled: false });
  expect(forward).toHaveBeenCalledTimes(1);
});

it('does not invent usage when the native response supplies none', async () => {
  const client = createClaudeAccountLlmProviderClientV1({ account,
    forward: async ({ res }) => { res.end('{}'); return {}; },
    run: async input => { await send(input); return { signals: [] }; },
  });
  await expect(client.generateStructured(request)).resolves.toEqual({ content: '{"signals":[]}' });
});

it('never starts a native session after queued extraction was cancelled', async () => {
  let release!: () => void;
  const queued = new Promise<void>(resolve => { release = resolve; });
  const stop = new AbortController();
  const run = vi.fn();
  const client = createClaudeAccountLlmProviderClientV1({ account, run,
    limit: async (_signal, op) => { await queued; return op(); },
  });
  const pending = client.generateStructured({ ...request, signal: stop.signal });
  stop.abort(new DOMException('synthetic cancellation', 'AbortError')); release();
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  expect(run).not.toHaveBeenCalled();
});

it('starts the timeout after limiter admission and preserves cancellation while forwarding', async () => {
  let release!: () => void;
  let started = false;
  const queued = new Promise<void>(resolve => { release = resolve; });
  const stop = new AbortController();
  const forward = vi.fn(async ({ signal }) => new Promise<never>((_resolve, reject) => {
    signal.throwIfAborted(); signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    stop.abort(new DOMException('synthetic cancellation', 'AbortError'));
  }));
  const client = createClaudeAccountLlmProviderClientV1({ account, request_timeout_ms: 50, forward,
    limit: async (signal, op) => { expect(signal).toBe(stop.signal); await queued; return op(); },
    run: async input => { started = true; await send(input).catch(() => undefined); throw new ClaudeResearchResultErrorV1(); },
  });
  const pending = client.generateStructured({ ...request, signal: stop.signal });
  await new Promise(resolve => setTimeout(resolve, 70));
  expect(started).toBe(false); release();
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  expect(forward).toHaveBeenCalledTimes(1);
});

it('reports timeout and rejects a wrong model before native startup', async () => {
  const run = vi.fn(async (input: Parameters<typeof runClaudeStructuredV1>[0]) => {
    await new Promise<void>(resolve => input.signal.addEventListener('abort', () => resolve(), { once: true }));
    throw new ClaudeResearchResultErrorV1();
  });
  const client = createClaudeAccountLlmProviderClientV1({ account, request_timeout_ms: 10, run });
  await expect(client.generateStructured({ ...request, model: 'wrong' })).rejects.toMatchObject({ code: 'invalid_config' });
  expect(run).not.toHaveBeenCalled();
  await expect(client.generateStructured(request)).rejects.toMatchObject({ code: 'timeout', unbilled: false });
});
