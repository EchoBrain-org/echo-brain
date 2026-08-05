import {
  AdapterRegistry,
  adapterInstanceKey,
  type AdapterConfig,
  type AdapterConfigValidation,
  type AdapterKind,
  type AnyAdapter,
} from '../core/index.js';
import type { ProductRuntimeConfig } from './config.js';
import type { DecisionNodeFederationCapture } from './approval/decision-node-store.js';
import type { ApprovalActionAuthorizer } from '../adapters/approval-surfaces/slack-reactions/slack-reactions-approval-surface.js';
import {
  createProductCredentialResolver,
  type ProductCredentialResolver,
} from './credentials.js';

export interface ProductAdapterFactoryContext {
  stateDirectory: string;
  environment: NodeJS.ProcessEnv;
  credentialResolver: ProductCredentialResolver;
  now: () => string;
  approvalFederationCapture?: DecisionNodeFederationCapture;
  approvalActionAuthorizer?: ApprovalActionAuthorizer;
}

export interface ProductAdapterFactory {
  readonly kind: AdapterKind;
  readonly adapter_id: string;
  /**
   * Static verdict on one configuration entry. Implementations must be
   * synchronous and side-effect free: no `create`, no credential resolver, no
   * environment read, no state store, no `fetch`, no `healthCheck`, and no
   * provider contact. `assertConfiguredAdaptersValid` calls only this, so
   * whatever a factory does here is what update and recovery run on an
   * offline machine. Optional for out-of-tree factories; the proof below
   * refuses a factory that omits it rather than silently skipping the check.
   */
  validateStaticConfig?(config: AdapterConfig): AdapterConfigValidation;
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
  credentialResolver?: ProductCredentialResolver;
  now?: () => string;
  approvalFederationCapture?: DecisionNodeFederationCapture;
  approvalActionAuthorizer?: ApprovalActionAuthorizer;
}

interface ConfiguredAdapterRequest {
  kind: AdapterKind;
  config: AdapterConfig;
}

function configuredAdapterRequests(
  config: ProductRuntimeConfig,
): readonly ConfiguredAdapterRequest[] {
  return [
    ...config.meeting_sources.map((adapterConfig) => ({
      kind: 'meeting-source' as const,
      config: adapterConfig,
    })),
    { kind: 'decision-processor', config: config.decision_processor },
    ...config.delivery_surfaces.map((adapterConfig) => ({
      kind: 'delivery-surface' as const,
      config: adapterConfig,
    })),
    ...(config.approval_mode === 'adapter'
      ? [{ kind: 'approval-surface' as const, config: config.approval_surface }]
      : []),
  ];
}

/**
 * Pure availability preflight. This proves every requested factory exists
 * without constructing an adapter, resolving a credential, or contacting a
 * provider. Product startup uses it before touching state while keeping actual
 * adapter construction behind the Founder identity gate.
 */
export function assertConfiguredAdapterFactoriesAvailable(
  config: ProductRuntimeConfig,
  factories: ProductAdapterFactoryRegistry,
): void {
  const missing = configuredAdapterRequests(config)
    .filter(
      (request) =>
        factories.get(request.kind, request.config.adapter_id) === undefined,
    )
    .map(
      (request) =>
        `${request.kind} adapter factory '${request.config.adapter_id}' is not installed`,
    );
  if (missing.length > 0) {
    throw new Error(
      `configured adapter factories are unavailable: ${missing.join('; ')}`,
    );
  }
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

function createFactoryContext(
  config: ProductRuntimeConfig,
  options: CreateConfiguredAdapterRegistryOptions,
): ProductAdapterFactoryContext {
  const environment = options.environment ?? process.env;
  return {
    stateDirectory: config.state_dir,
    environment,
    credentialResolver:
      options.credentialResolver ??
      createProductCredentialResolver(environment),
    now: options.now ?? (() => new Date().toISOString()),
    ...(options.approvalFederationCapture === undefined
      ? {}
      : { approvalFederationCapture: options.approvalFederationCapture }),
    ...(options.approvalActionAuthorizer === undefined
      ? {}
      : { approvalActionAuthorizer: options.approvalActionAuthorizer }),
  };
}

/**
 * Static offline proof that this package can run the configured adapters.
 * It asks every requested factory for its own static verdict and calls
 * nothing else: no `create`, no credential resolver, no environment, no state
 * store, no `fetch`, no `healthCheck`, no provider. Update and recovery can
 * therefore never depend on provider uptime or on a reachable machine. A
 * missing factory, a factory without a static validator, a validator that
 * throws, and a rejected configuration are all aggregated in configuration
 * order so one pass names every unusable adapter. Reconfigure applies this
 * before it rewrites the installation manifest.
 */
export function assertConfiguredAdaptersValid(
  config: ProductRuntimeConfig,
  factories: ProductAdapterFactoryRegistry,
): void {
  const issues: string[] = [];
  for (const request of configuredAdapterRequests(config)) {
    const reference = `${request.kind} '${request.config.adapter_id}/${request.config.instance_id}'`;
    const factory = factories.get(request.kind, request.config.adapter_id);
    if (factory === undefined) {
      issues.push(
        `${request.kind} adapter factory '${request.config.adapter_id}' is not installed`,
      );
      continue;
    }
    if (typeof factory.validateStaticConfig !== 'function') {
      issues.push(`${reference} exposes no static configuration validator`);
      continue;
    }
    let validation: AdapterConfigValidation;
    try {
      validation = factory.validateStaticConfig(request.config);
    } catch (error) {
      issues.push(`${reference} was rejected: ${(error as Error).message}`);
      continue;
    }
    if (!validation.ok) {
      issues.push(
        `${reference} configuration is invalid: ${
          validation.errors.length === 0
            ? 'adapter configuration is invalid'
            : validation.errors.join('; ')
        }`,
      );
    }
  }
  if (issues.length > 0) {
    throw new Error(`configured adapters are unusable: ${issues.join('; ')}`);
  }
}

export async function createConfiguredAdapterRegistry(
  config: ProductRuntimeConfig,
  factories: ProductAdapterFactoryRegistry,
  options: CreateConfiguredAdapterRegistryOptions = {},
): Promise<AdapterRegistry> {
  const context = createFactoryContext(config, options);
  const requested = configuredAdapterRequests(config);
  assertConfiguredAdapterFactoriesAvailable(config, factories);
  const registry = new AdapterRegistry();
  for (const request of requested) {
    registry.register(
      await createAdapter(factories, request.kind, request.config, context),
    );
  }
  return registry;
}
