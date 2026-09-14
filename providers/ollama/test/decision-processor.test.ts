import type { AdapterConfig } from '@echo-brain/organization-processing/core';
import { describe, expect, it } from 'vitest';
import { createOllamaDecisionProcessor, ollamaProcessingVersion } from '../src/llm/ollama-decision-processor.js';
const config: AdapterConfig = { adapter_id: 'llm', instance_id: 'local', settings: { model: 'qwen3:4b' } };
describe('Ollama decision processor configuration', () => {
  it('requires a model, rejects credentials and unknown settings, and permits a local endpoint', () => {
    const instance = createOllamaDecisionProcessor(config);
    expect(instance.validateConfig({ ...config, settings: {} }).ok).toBe(false);
    expect(instance.validateConfig({ ...config, settings: { ...config.settings, temperature: 1 } }).ok).toBe(false);
    expect(instance.validateConfig({ ...config, credential_ref: 'fixture:unneeded' }).ok).toBe(false);
    expect(instance.validateConfig({ ...config, settings: { ...config.settings, base_url: 'http://127.0.0.1:11434', request_timeout_ms: 60_000 } })).toEqual({ ok: true, errors: [] });
  });
  it('preserves the default provider identity and includes endpoint changes in processing identity', () => {
    expect(ollamaProcessingVersion({ ...config, settings: { ...config.settings, provider: 'ollama' } })).toBe(ollamaProcessingVersion(config));
    expect(ollamaProcessingVersion({ ...config, settings: { ...config.settings, base_url: 'http://127.0.0.1:11434' } })).toBe(ollamaProcessingVersion(config));
    expect(ollamaProcessingVersion({ ...config, settings: { ...config.settings, base_url: 'http://127.0.0.1:11435' } })).not.toBe(ollamaProcessingVersion(config));
  });
});
