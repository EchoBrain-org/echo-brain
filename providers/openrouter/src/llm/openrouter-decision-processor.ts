import type { AdapterConfig } from "@echo-brain/organization-processing/core";
import { createLlmDecisionProcessor, llmProcessingVersion } from "@echo-brain/organization-processing/llm/llm-decision-processor";
import { nonEmptyString, type LlmCredentialResolver } from "@echo-brain/organization-processing/llm/llm-provider";
import { OpenRouterClient } from "./openrouter-client.js";

export function validateOpenRouterDecisionProcessorConfig(config: AdapterConfig): readonly string[] {
  const errors: string[] = [];
  const settings = new Set(['provider', 'model', 'request_timeout_ms', 'max_output_tokens']);
  for (const key of Object.keys(config.settings)) if (!settings.has(key)) errors.push(`settings.${key} is not supported`);
  if (config.settings['provider'] !== undefined && config.settings['provider'] !== 'openrouter') errors.push('settings.provider must be openrouter');
  if (!nonEmptyString(config.credential_ref)) errors.push('credential_ref is required by the openrouter provider');
  if (config.settings['base_url'] !== undefined) errors.push('settings.base_url is not supported by the OpenRouter provider');
  if (nonEmptyString(config.settings['model']) && !/^[^/\s]+\/[^/\s]+$/u.test(config.settings['model'])) errors.push('settings.model must use the author/model-slug form for OpenRouter');
  return errors;
}

export function openrouterProcessingVersion(config: AdapterConfig): string {
  return llmProcessingVersion(config, 'openrouter', null);
}

export function createOpenRouterDecisionProcessor(config: AdapterConfig, options: {
  credentialResolver?: LlmCredentialResolver;
  fetchImpl?: typeof fetch;
  now?: () => string;
  now_ms?: () => number;
} = {}) {
  const timeout = config.settings['request_timeout_ms'];
  return createLlmDecisionProcessor(config, {
    client: new OpenRouterClient({
      credentialRef: config.credential_ref ?? '',
      credentialResolver: options.credentialResolver ?? (() => undefined),
      ...(typeof timeout === 'number' ? { requestTimeoutMs: timeout } : {}),
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    }),
    validateProviderConfig: validateOpenRouterDecisionProcessorConfig,
    identityEndpoint: null,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.now_ms === undefined ? {} : { now_ms: options.now_ms }),
  });
}
