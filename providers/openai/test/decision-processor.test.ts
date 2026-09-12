import type { AdapterConfig } from '@echo-brain/organization-processing/core';
import { describe, expect, it } from 'vitest';
import { createOpenAiDecisionProcessor } from '../src/llm/openai-decision-processor.js';

describe('openai decision processor configuration', () => {
  it('requires credentials and rejects endpoint overrides', () => {
    const config: AdapterConfig = {
      adapter_id: 'llm', instance_id: 'local', credential_ref: 'fixture:credential',
      settings: { provider: 'openai', model: 'gpt-model' },
    };
    const instance = createOpenAiDecisionProcessor(config);
    expect(instance.validateConfig(config)).toEqual({ ok: true, errors: [] });
    const { credential_ref: _reference, ...missing } = config;
    expect(instance.validateConfig(missing).errors).toContain('credential_ref is required by the openai provider');
    expect(instance.validateConfig({ ...config, settings: { ...config.settings, base_url: 'https://attacker.invalid' } }).ok).toBe(false);
  });

  it('reports unauthorized before transport when a hosted credential cannot resolve', async () => {
    const instance = createOpenAiDecisionProcessor({
      adapter_id: 'llm',
      instance_id: 'hosted',
      credential_ref: 'env:OPENAI_API_KEY',
      settings: { provider: 'openai', model: 'gpt-model' },
    });
    await expect(instance.healthCheck()).resolves.toMatchObject({
      status: 'unauthorized',
      details: { provider: 'openai', model: 'gpt-model' },
    });
  });
});
