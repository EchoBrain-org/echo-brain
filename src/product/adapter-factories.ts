import {
  AdapterRegistry,
  adapterInstanceKey,
  type AdapterConfig,
  type AdapterKind,
  type AnyAdapter,
} from '../core/index.js';
import type { ProductRuntimeConfig } from './config.js';

export interface ProductAdapterFactoryContext {
  stateDirectory: string;
  environment: NodeJS.ProcessEnv;
  now: () => string;
}

export interface ProductAdapterFactory {
  readonly kind: AdapterKind;
  readonly adapter_id: string;
  create(
    config: AdapterConfig,
    context: ProductAdapterFactoryContext,
  ): AnyAdapter | Promise<AnyAdapter>;
}

function factoryKey(kind: AdapterKind, adapterId: string): string {
  return `${kind}:${adapterId}`;
}

export class ProductAdapterFactoryRegistry {
  private readonly factories = new Map<string, ProductAdapterFactory>();

  register(factory: ProductAdapterFactory): void {
    const key = factoryKey(factory.kind, factory.adapter_id);
    if (this.factories.has(key)) {
      throw new Error(`adapter factory already registered: ${key}`);
    }
    this.factories.set(key, factory);
  }

  get(kind: AdapterKind, adapterId: string): ProductAdapterFactory | undefined {
    return this.factories.get(factoryKey(kind, adapterId));
  }

  list(): readonly ProductAdapterFactory[] {
    return [...this.factories.values()];
  }
}

export interface CreateConfiguredAdapterRegistryOptions {
  environment?: NodeJS.ProcessEnv;
  now?: () => string;
}

async function createAdapter(
  factories: ProductAdapterFactoryRegistry,
  kind: AdapterKind,
  config: AdapterConfig,
  context: ProductAdapterFactoryContext,
): Promise<AnyAdapter> {
  const factory = factories.get(kind, config.adapter_id);
  if (factory === undefined) {
    throw new Error(
      `${kind} adapter factory '${config.adapter_id}' is not installed`,
    );
  }
  const adapter = await factory.create(config, context);
  if (
    adapter.identity.kind !== kind ||
    adapter.identity.adapter_id !== config.adapter_id ||
    adapter.identity.instance_id !== config.instance_id
  ) {
    throw new Error(
      `adapter factory returned mismatched identity for ${adapterInstanceKey(
        kind,
        config.adapter_id,
        config.instance_id,
      )}`,
    );
  }
  return adapter;
}

export async function createConfiguredAdapterRegistry(
  config: ProductRuntimeConfig,
  factories: ProductAdapterFactoryRegistry,
  options: CreateConfiguredAdapterRegistryOptions = {},
): Promise<AdapterRegistry> {
  const context: ProductAdapterFactoryContext = {
    stateDirectory: config.state_dir,
    environment: options.environment ?? process.env,
    now: options.now ?? (() => new Date().toISOString()),
  };
  const requested: Array<{ kind: AdapterKind; config: AdapterConfig }> = [
    ...config.meeting_sources.map((adapterConfig) => ({
      kind: 'meeting-source' as const,
      config: adapterConfig,
    })),
    { kind: 'decision-processor', config: config.decision_processor },
    ...config.communication_channels.map((adapterConfig) => ({
      kind: 'communication-channel' as const,
      config: adapterConfig,
    })),
  ];
  const missing = requested
    .filter(
      (request) =>
        factories.get(request.kind, request.config.adapter_id) === undefined,
    )
    .map(
      (request) =>
        `${request.kind} adapter factory '${request.config.adapter_id}' is not installed`,
    );
  if (missing.length > 0) {
    throw new Error(`configured adapter factories are unavailable: ${missing.join('; ')}`);
  }
  const registry = new AdapterRegistry();
  for (const request of requested) {
    registry.register(
      await createAdapter(
        factories,
        request.kind,
        request.config,
        context,
      ),
    );
  }
  return registry;
}
