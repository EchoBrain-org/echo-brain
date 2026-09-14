import type { AdapterConfig } from '@echo-brain/organization-processing/core';
import { describe, expect, it } from 'vitest';
import { createAnthropicDecisionProcessor } from '../src/llm/anthropic-decision-processor.js';

describe('anthropic decision processor configuration', () => {
  it('requires credentials and rejects endpoint overrides', () => {
    const config: AdapterConfig = {
      adapter_id: 'llm', instance_id: 'local', credential_ref: 'fixture:credential',
      settings: { provider: 'anthropic', model: 'claude-model' },
    };
    const instance = createAnthropicDecisionProcessor(config);
    expect(instance.validateConfig(config)).toEqual({ ok: true, errors: [] });
    const { credential_ref: _reference, ...missing } = config;
    expect(instance.validateConfig(missing).errors).toContain('credential_ref is required by the anthropic provider');
    expect(instance.validateConfig({ ...config, settings: { ...config.settings, base_url: 'https://attacker.invalid' } }).ok).toBe(false);
  });
});
