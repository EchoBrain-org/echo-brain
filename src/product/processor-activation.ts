import {
  diagnoseAdapterInstance,
  type AdapterDiagnostic,
} from './adapter-diagnostics.js';
import {
  createConfiguredDecisionProcessor,
  type CreateConfiguredAdapterRegistryOptions,
  type ProductAdapterFactoryRegistry,
} from './adapter-factories.js';
import type { ProductRuntimeConfig } from './config.js';

export class DecisionProcessorActivationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DecisionProcessorActivationError';
  }
}

export interface VerifyDecisionProcessorActivationOptions
  extends CreateConfiguredAdapterRegistryOptions {
  healthTimeoutMs?: number;
}

async function constructConfiguredProcessor(
  config: ProductRuntimeConfig,
  factories: ProductAdapterFactoryRegistry,
  options: CreateConfiguredAdapterRegistryOptions,
): Promise<Awaited<ReturnType<typeof createConfiguredDecisionProcessor>>> {
  const processor = config.decision_processor;
  if (factories.get('decision-processor', processor.adapter_id) === undefined) {
    throw new DecisionProcessorActivationError(
      `decision processor '${processor.adapter_id}' is not installed in this package`,
    );
  }
  try {
    return await createConfiguredDecisionProcessor(config, factories, options);
  } catch (error) {
    throw new DecisionProcessorActivationError(
      `decision processor '${processor.adapter_id}/${processor.instance_id}' could not be constructed: ${(error as Error).message}`,
    );
  }
}

/**
 * Offline package-compatibility proof: the configured decision processor's
 * factory must be installed in this package and the adapter's own static
 * validation must pass. No health check runs and no provider is contacted,
 * so package-only re-pins of an unchanged configuration never depend on
 * provider uptime.
 */
export async function verifyDecisionProcessorCompatibility(
  config: ProductRuntimeConfig,
  factories: ProductAdapterFactoryRegistry,
  options: CreateConfiguredAdapterRegistryOptions = {},
): Promise<void> {
  const processor = config.decision_processor;
  const adapter = await constructConfiguredProcessor(config, factories, options);
  let validation: ReturnType<typeof adapter.validateConfig>;
  try {
    validation = adapter.validateConfig(processor);
  } catch {
    throw new DecisionProcessorActivationError(
      `decision processor '${processor.adapter_id}/${processor.instance_id}' configuration validation failed unexpectedly`,
    );
  }
  if (!validation.ok) {
    throw new DecisionProcessorActivationError(
      `decision processor '${processor.adapter_id}/${processor.instance_id}' configuration is invalid: ${
        validation.errors.length === 0
          ? 'adapter configuration is invalid'
          : validation.errors.join('; ')
      }`,
    );
  }
}

/**
 * Prove the configured decision processor can actually run on this installed
 * package before a changed configuration is accepted: its factory must be
 * installed, the adapter's own static validation must pass, and one live
 * health check against the configured provider/model must report healthy.
 * Reconfigure triggers this on the whole canonical configuration hash — V1
 * is deliberately conservative because no prior-config state is persisted to
 * isolate a processor-only change. Credential-file policy runs in the
 * operator before this proof; the live check additionally proves the
 * resolved credential works.
 */
export async function verifyDecisionProcessorActivation(
  config: ProductRuntimeConfig,
  factories: ProductAdapterFactoryRegistry,
  options: VerifyDecisionProcessorActivationOptions = {},
): Promise<AdapterDiagnostic> {
  const processor = config.decision_processor;
  const adapter = await constructConfiguredProcessor(config, factories, options);
  const diagnostic = await diagnoseAdapterInstance(
    'decision-processor',
    processor,
    adapter,
    options.healthTimeoutMs ?? 10_000,
  );
  if (diagnostic.status !== 'healthy') {
    throw new DecisionProcessorActivationError(
      `decision processor '${processor.adapter_id}/${processor.instance_id}' failed its live activation check (${diagnostic.status})${
        diagnostic.message === undefined ? '' : `: ${diagnostic.message}`
      }`,
    );
  }
  return diagnostic;
}
