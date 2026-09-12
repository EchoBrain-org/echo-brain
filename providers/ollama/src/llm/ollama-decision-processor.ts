import type { AdapterConfig } from "@echo-brain/organization-processing/core";
import { createLlmDecisionProcessor, llmProcessingVersion } from "@echo-brain/organization-processing/llm/llm-decision-processor";
import { type LlmCredentialResolver } from "@echo-brain/organization-processing/llm/llm-provider";
import { OllamaClient, DEFAULT_OLLAMA_BASE_URL } from "./ollama-client.js";

export function validateOllamaDecisionProcessorConfig(config: AdapterConfig): readonly string[] {
  const errors: string[] = [];
  const settings = new Set(['provider', 'model', 'request_timeout_ms', 'max_output_tokens', 'base_url']);
  for (const key of Object.keys(config.settings)) if (!settings.has(key)) errors.push(`settings.${key} is not supported`);
  if (config.settings['provider'] !== undefined && config.settings['provider'] !== 'ollama') errors.push('settings.provider must be ollama');
  if (config.credential_ref !== undefined) errors.push('credential_ref is not supported by the Ollama provider');
  const baseUrl = config.settings['base_url'];
  if (baseUrl !== undefined) {
    try {
      const url = new URL(String(baseUrl));
      if (url.protocol !== 'http:' && url.protocol !== 'https:') errors.push('settings.base_url must be an HTTP(S) URL');
    } catch { errors.push('settings.base_url must be an HTTP(S) URL'); }
  }
  return errors;
}

export function ollamaProcessingVersion(config: AdapterConfig): string {
  return llmProcessingVersion(config, 'ollama', typeof config.settings['base_url'] === 'string' ? config.settings['base_url'] : DEFAULT_OLLAMA_BASE_URL);
}

export function createOllamaDecisionProcessor(config: AdapterConfig, options: {
  credentialResolver?: LlmCredentialResolver;
  fetchImpl?: typeof fetch;
  now?: () => string;
  now_ms?: () => number;
} = {}) {
  const timeout = config.settings['request_timeout_ms'];
  return createLlmDecisionProcessor(config, {
    client: new OllamaClient({
      ...(typeof config.settings['base_url'] === 'string' ? { baseUrl: config.settings['base_url'] } : {}),
      ...(typeof timeout === 'number' ? { requestTimeoutMs: timeout } : {}),
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    }),
    validateProviderConfig: validateOllamaDecisionProcessorConfig,
    identityEndpoint: typeof config.settings['base_url'] === 'string' ? config.settings['base_url'] : DEFAULT_OLLAMA_BASE_URL,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.now_ms === undefined ? {} : { now_ms: options.now_ms }),
  });
}
