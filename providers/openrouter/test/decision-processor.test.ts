import type { AdapterConfig } from '@echo-brain/organization-processing/core';
import { describe, expect, it } from 'vitest';
import { createOpenRouterDecisionProcessor } from '../src/llm/openrouter-decision-processor.js';

describe('openrouter decision processor configuration', () => {
  it('requires credentials and rejects endpoint overrides', () => {
    const config: AdapterConfig = {
      adapter_id: 'llm', instance_id: 'local', credential_ref: 'fixture:credential',
      settings: { provider: 'openrouter', model: 'anthropic/claude-model' },
    };
    const instance = createOpenRouterDecisionProcessor(config);
    expect(instance.validateConfig(config)).toEqual({ ok: true, errors: [] });
    const { credential_ref: _reference, ...missing } = config;
    expect(instance.validateConfig(missing).errors).toContain('credential_ref is required by the openrouter provider');
    expect(instance.validateConfig({ ...config, settings: { ...config.settings, base_url: 'https://attacker.invalid' } }).ok).toBe(false);
  });
});
