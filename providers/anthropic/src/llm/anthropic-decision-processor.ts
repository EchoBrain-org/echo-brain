import type { AdapterConfig } from "@echo-brain/organization-processing/core";
import { createLlmDecisionProcessor, llmProcessingVersion } from "@echo-brain/organization-processing/llm/llm-decision-processor";
import { nonEmptyString, type LlmCredentialResolver } from "@echo-brain/organization-processing/llm/llm-provider";
import { AnthropicClient } from "./anthropic-client.js";

export function validateAnthropicDecisionProcessorConfig(config: AdapterConfig): readonly string[] {
  const errors: string[] = [];
  const settings = new Set(['provider', 'model', 'request_timeout_ms', 'max_output_tokens']);
  for (const key of Object.keys(config.settings)) if (!settings.has(key)) errors.push(`settings.${key} is not supported`);
  if (config.settings['provider'] !== undefined && config.settings['provider'] !== 'anthropic') errors.push('settings.provider must be anthropic');
  if (!nonEmptyString(config.credential_ref)) errors.push('credential_ref is required by the anthropic provider');
  if (config.settings['base_url'] !== undefined) errors.push('settings.base_url is not supported by the Anthropic provider');
  return errors;
}

export function anthropicProcessingVersion(config: AdapterConfig): string {
  return llmProcessingVersion(config, 'anthropic', null);
}

export function createAnthropicDecisionProcessor(config: AdapterConfig, options: {
  credentialResolver?: LlmCredentialResolver;
  fetchImpl?: typeof fetch;
  now?: () => string;
  now_ms?: () => number;
} = {}) {
  const timeout = config.settings['request_timeout_ms'];
  return createLlmDecisionProcessor(config, {
    client: new AnthropicClient({
      credentialRef: config.credential_ref ?? '',
      credentialResolver: options.credentialResolver ?? (() => undefined),
      ...(typeof timeout === 'number' ? { requestTimeoutMs: timeout } : {}),
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    }),
    validateProviderConfig: validateAnthropicDecisionProcessorConfig,
    identityEndpoint: null,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.now_ms === undefined ? {} : { now_ms: options.now_ms }),
  });
}
