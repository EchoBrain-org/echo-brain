import { AdapterError, type AdapterConfig } from '@echo-brain/organization-processing/core';
import { createLlmDecisionProcessor } from '@echo-brain/organization-processing/llm/llm-decision-processor';
import { isRecord, providerStatusError, StructuredGenerationAttemptError, type LlmProviderClient, type StructuredGenerationFailureObservation } from '@echo-brain/organization-processing/llm/llm-provider';
import type { StructuredGenerationUsageV1 } from '@echo-brain/organization-authority-kernel/answer-composition/structured-generation-v1';
import { annotateCoreRuntimeV1, observeCoreModelMetadataV1 } from '@echo-brain/organization-authority-kernel/shared/core-runtime-observation-v1';
import { CLAUDE_ACCOUNT_MODEL_V1, claudeAccountEnvironmentV1, type ClaudeAccountProfileV1 } from '../claude-research/account-profile.js';
import { createClaudeAccountStructuredGenerationV1, ClaudeSingleGenerationLimitErrorV1 } from '../claude-research/structured-generation.js';
import { claudeAccountForwarderV1, type ClaudeModelForwarderV1 } from '../claude-research/model-transport.js';
import type { runClaudeStructuredV1 } from '../claude-research/sdk-client.js';
import { CLAUDE_ACCOUNT_DECISION_PROCESSOR_PROVIDER_V1, CLAUDE_ACCOUNT_DECISION_PROCESSOR_TRANSPORT_V1, CLAUDE_ACCOUNT_DECISION_PROCESSOR_TIMEOUT_MS_V1,
  claudeAccountDecisionProcessorCredentialReferenceV1 } from '../claude-account-decision-processor-config-v1.js';

interface ClaudeAccountDecisionProcessorOptionsV1 {
  readonly account: ClaudeAccountProfileV1;
  readonly limit?: <T>(signal: AbortSignal | undefined, op: () => Promise<T>) => Promise<T>;
  /** Offline transport/session seams; production construction always uses native account authentication. */
  readonly forward?: ClaudeModelForwarderV1;
  readonly run?: typeof runClaudeStructuredV1;
}

function usageObservation(usage: StructuredGenerationUsageV1 | undefined, stopReason: string | undefined): StructuredGenerationFailureObservation {
  return {
    ...(usage?.input_tokens == null ? {} : { inputTokens: usage.input_tokens }),
    ...(usage?.output_tokens == null ? {} : { outputTokens: usage.output_tokens }),
    ...(usage?.total_tokens == null ? {} : { totalTokens: usage.total_tokens }),
    ...(usage?.cached_input_tokens == null ? {} : { cachedInputTokens: usage.cached_input_tokens }),
    ...(usage?.reasoning_tokens == null ? {} : { reasoningTokens: usage.reasoning_tokens }),
    ...(stopReason === undefined ? {} : { stopReason }),
  };
}

function extractionFailure(error: unknown): AdapterError {
  if (error instanceof AdapterError) return error;
  if (error instanceof ClaudeSingleGenerationLimitErrorV1) return new AdapterError('permanently_rejected', 'Claude account extraction exceeded its single generation allowance', false);
  if (isRecord(error) && isRecord(error['diagnostic'])) {
    const diagnostic = error['diagnostic'];
    if (diagnostic['failure_class'] === 'adapter_http' && typeof diagnostic['http_status'] === 'number') {
      // No provider billing guarantee: native refusals never authorize a free automatic retry.
      return providerStatusError('Claude account', diagnostic['http_status']);
    }
    if (diagnostic['failure_class'] === 'adapter_timeout') return new AdapterError('timeout', 'Claude account extraction timed out', true);
    if (diagnostic['failure_class'] === 'adapter_response') return new AdapterError('permanently_rejected', 'Claude account extraction returned no structured result', false);
  }
  return new AdapterError('unknown_outcome', 'Claude account extraction did not complete', false);
}

/** One native session and one forwarded generation per durable extraction attempt. */
export function createClaudeAccountLlmProviderClientV1(options: ClaudeAccountDecisionProcessorOptionsV1 & { readonly request_timeout_ms?: number }): LlmProviderClient {
  const account = Object.freeze({ home_directory: options.account.home_directory, executable_path: options.account.executable_path });
  claudeAccountDecisionProcessorCredentialReferenceV1(account);
  const port = createClaudeAccountStructuredGenerationV1({ account, model: CLAUDE_ACCOUNT_MODEL_V1, max_model_requests: 1,
    forward: options.forward ?? claudeAccountForwarderV1(CLAUDE_ACCOUNT_MODEL_V1, { model_call_observed: true }),
    ...(options.run === undefined ? {} : { run: options.run }) });
  const assertModel = (model: string) => {
    if (model !== CLAUDE_ACCOUNT_MODEL_V1) throw new AdapterError('invalid_config', 'Claude account extraction model is invalid', false);
  };
  return {
    provider: CLAUDE_ACCOUNT_DECISION_PROCESSOR_PROVIDER_V1,
    async verifyModel(model, signal) {
      signal?.throwIfAborted(); assertModel(model);
      try { await claudeAccountEnvironmentV1(account, signal ?? new AbortController().signal); }
      catch { signal?.throwIfAborted(); throw new AdapterError('unauthorized', 'Personal Claude sign-in is unavailable', false); }
    },
    async generateStructured(request) {
      request.signal?.throwIfAborted(); assertModel(request.model);
      const generate = async () => {
        request.signal?.throwIfAborted();
        let observation: StructuredGenerationFailureObservation = {};
        try {
          const value = await port.generate_with_admission!({ model: request.model, system_prompt: request.systemPrompt, user_prompt: request.userPrompt,
            schema: request.schema, max_output_tokens: request.maxOutputTokens,
            timeout_ms: options.request_timeout_ms ?? CLAUDE_ACCOUNT_DECISION_PROCESSOR_TIMEOUT_MS_V1,
            ...(request.signal === undefined ? {} : { signal: request.signal }) }, async (admission, forward) => {
            admission.signal?.throwIfAborted();
            const result = await forward(admission.signal ?? new AbortController().signal);
            observation = usageObservation(result.usage, result.finish_reason);
            return result.value;
          });
          const content = JSON.stringify(value);
          if (content === undefined) throw new AdapterError('permanently_rejected', 'Claude account extraction returned no structured result', false);
          return { content, ...observation };
        } catch (error) {
          // The core owns this attempt's span. Retain real response usage even if native result parsing later failed.
          annotateCoreRuntimeV1({ counts: { input_tokens: observation.inputTokens ?? null, output_tokens: observation.outputTokens ?? null,
            total_tokens: observation.totalTokens ?? null, cached_input_tokens: observation.cachedInputTokens ?? null, reasoning_tokens: observation.reasoningTokens ?? null } });
          observeCoreModelMetadataV1({ provider: CLAUDE_ACCOUNT_DECISION_PROCESSOR_PROVIDER_V1, model: request.model,
            ...(observation.stopReason === undefined ? {} : { finish_reason: observation.stopReason }) });
          request.signal?.throwIfAborted();
          const failure = extractionFailure(error);
          if (Object.keys(observation).length !== 0) throw new StructuredGenerationAttemptError(failure.code, failure.message, failure.retryable, observation);
          throw failure;
        }
      };
      // Admission wait precedes native startup and timeout, matching the existing extraction limiter.
      return options.limit === undefined ? generate() : options.limit(request.signal, generate);
    },
  };
}

export function createClaudeAccountDecisionProcessorV1(config: AdapterConfig, options: ClaudeAccountDecisionProcessorOptionsV1) {
  const reference = claudeAccountDecisionProcessorCredentialReferenceV1(options.account);
  return createLlmDecisionProcessor(config, {
    client: createClaudeAccountLlmProviderClientV1({ ...options,
      ...(typeof config.settings['request_timeout_ms'] === 'number' ? { request_timeout_ms: config.settings['request_timeout_ms'] } : {}) }),
    identityEndpoint: CLAUDE_ACCOUNT_DECISION_PROCESSOR_TRANSPORT_V1,
    validateProviderConfig: candidate => {
      const errors: string[] = [];
      const settings = new Set(['provider', 'model', 'request_timeout_ms', 'max_output_tokens']);
      for (const key of Object.keys(candidate.settings)) if (!settings.has(key)) errors.push(`settings.${key} is not supported`);
      if (candidate.settings['provider'] !== CLAUDE_ACCOUNT_DECISION_PROCESSOR_PROVIDER_V1) errors.push('settings.provider must be claude-account');
      if (candidate.settings['model'] !== CLAUDE_ACCOUNT_MODEL_V1) errors.push('settings.model must use the selected Claude account model');
      if (candidate.credential_ref !== reference) errors.push('credential_ref must match the selected native Claude account');
      return errors;
    },
  });
}
