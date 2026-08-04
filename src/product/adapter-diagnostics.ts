import type {
  Adapter,
  AdapterConfig,
  AdapterHealth,
  AdapterKind,
  AdapterRegistry,
} from '../core/index.js';
import type { ProductRuntimeConfig } from './config.js';

export interface AdapterDiagnostic {
  kind: AdapterKind;
  adapter_id: string;
  instance_id: string;
  status: AdapterHealth['status'];
  message?: string;
}

interface ConfiguredAdapter {
  kind: AdapterKind;
  config: AdapterConfig;
  adapter: Adapter | undefined;
}

function configuredAdapters(
  config: ProductRuntimeConfig,
  registry: AdapterRegistry,
): ConfiguredAdapter[] {
  return [
    ...config.meeting_sources.map((adapterConfig) => ({
      kind: 'meeting-source' as const,
      config: adapterConfig,
      adapter: registry.getMeetingSource(adapterConfig),
    })),
    {
      kind: 'decision-processor' as const,
      config: config.decision_processor,
      adapter: registry.getDecisionProcessor(config.decision_processor),
    },
    ...config.delivery_surfaces.map((adapterConfig) => ({
      kind: 'delivery-surface' as const,
      config: adapterConfig,
      adapter: registry.getDeliverySurface(adapterConfig),
    })),
    ...(config.approval_mode === 'adapter'
      ? [
          {
            kind: 'approval-surface' as const,
            config: config.approval_surface,
            adapter: registry.getApprovalSurface(config.approval_surface),
          },
        ]
      : []),
  ];
}

async function healthWithDeadline(
  adapter: Adapter,
  timeoutMs: number,
): Promise<AdapterHealth> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`health check timed out after ${timeoutMs}ms`);
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      Promise.resolve().then(() =>
        adapter.healthCheck({ signal: controller.signal }),
      ),
      timeout,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Diagnose one configured adapter instance: static `validateConfig` first,
 * then a deadline-bounded live `healthCheck`. This is the same primitive the
 * full `diagnoseConfiguredAdapters` sweep applies to every configured
 * adapter; reconfigure's changed-configuration decision-processor activation
 * proof reuses it for a single instance.
 */
export async function diagnoseAdapterInstance(
  kind: AdapterKind,
  config: AdapterConfig,
  adapter: Adapter | undefined,
  timeoutMs = 10_000,
): Promise<AdapterDiagnostic> {
  return await diagnoseOne({ kind, config, adapter }, timeoutMs);
}

async function diagnoseOne(
  configured: ConfiguredAdapter,
  timeoutMs: number,
): Promise<AdapterDiagnostic> {
  const reference = {
    kind: configured.kind,
    adapter_id: configured.config.adapter_id,
    instance_id: configured.config.instance_id,
  };
  if (configured.adapter === undefined) {
    return {
      ...reference,
      status: 'unavailable',
      message: 'configured adapter is not installed',
    };
  }
  try {
    const validation = configured.adapter.validateConfig(configured.config);
    if (!validation.ok) {
      return {
        ...reference,
        status: 'unavailable',
        message:
          validation.errors.length === 0
            ? 'adapter configuration is invalid'
            : validation.errors.join('; '),
      };
    }
  } catch {
    return {
      ...reference,
      status: 'unavailable',
      message: 'adapter configuration validation failed unexpectedly',
    };
  }
  try {
    const health = await healthWithDeadline(configured.adapter, timeoutMs);
    return {
      ...reference,
      status: health.status,
      ...(health.message === undefined ? {} : { message: health.message }),
    };
  } catch (error) {
    return {
      ...reference,
      status: 'unavailable',
      message: (error as Error).message,
    };
  }
}

export async function diagnoseConfiguredAdapters(
  config: ProductRuntimeConfig,
  registry: AdapterRegistry,
  timeoutMs = 10_000,
): Promise<readonly AdapterDiagnostic[]> {
  return await Promise.all(
    configuredAdapters(config, registry).map(
      async (configured) => await diagnoseOne(configured, timeoutMs),
    ),
  );
}
