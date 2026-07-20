import type { AdapterInstanceConfig, JsonObject } from '../../core/index.js';
import { LLM_DECISION_PROCESSOR_PROMPT_VERSION } from '../../adapters/decision-processors/llm/llm-decision-processor.js';
import { canonicalJson } from './canonical-json.js';
import type { AdapterCapability } from './contracts.js';

/**
 * The signed binding snapshot includes code-owned identity facts that are not
 * user-configurable runtime settings. Runtime config itself remains unchanged.
 */
export function identityBindingConfigurationSnapshot(
  capability: AdapterCapability,
  config: AdapterInstanceConfig,
): JsonObject {
  const settings = JSON.parse(canonicalJson(config.settings)) as JsonObject;
  if (capability === 'decision-processor' && config.adapter_id === 'llm') {
    return {
      ...settings,
      prompt_version: LLM_DECISION_PROCESSOR_PROMPT_VERSION,
    };
  }
  return settings;
}
