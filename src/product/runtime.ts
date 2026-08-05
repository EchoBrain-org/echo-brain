import type {
  Adapter,
  AdapterInstanceConfig,
  AdapterRegistry,
  ApprovalSurfaceAdapter,
  DeliverySurfaceAdapter,
  DecisionProcessorAdapter,
  MeetingSourceAdapter,
} from '../core/index.js';
import type { ProductRuntimeConfig } from './config.js';

export interface ProductRuntimeAdapters {
  meetingSources: readonly MeetingSourceAdapter[];
  decisionProcessor: DecisionProcessorAdapter;
  deliverySurfaces: readonly DeliverySurfaceAdapter[];
  approvalSurface?: ApprovalSurfaceAdapter;
}

export class ProductRuntimeFailure extends Error {
  constructor(
    public readonly code:
      | 'adapter_unavailable'
      | 'adapter_invalid_config'
      | 'state_not_local'
      | 'retired_founder_provenance'
      | 'organization_access_denied'
      | 'startup_failed',
    message: string,
    public readonly details: readonly string[] = [],
  ) {
    super(message);
    this.name = 'ProductRuntimeFailure';
  }
}

function unavailableAdapterDetail(
  kind: string,
  config: AdapterInstanceConfig,
): string {
  return `${kind} adapter '${config.adapter_id}' instance '${config.instance_id}' is unavailable`;
}

function invalidAdapterPrefix(
  kind: string,
  config: AdapterInstanceConfig,
): string {
  return `${kind} adapter '${config.adapter_id}' instance '${config.instance_id}'`;
}

function validateConfiguredAdapter(
  kind: string,
  config: AdapterInstanceConfig,
  adapter: Adapter,
): string[] {
  const prefix = invalidAdapterPrefix(kind, config);
  try {
    const result = adapter.validateConfig(config);
    if (result.ok) return [];
    if (result.errors.length === 0)
      return [`${prefix}: configuration is invalid`];
    return result.errors.map((error) => `${prefix}: ${error}`);
  } catch {
    return [`${prefix}: configuration validation failed unexpectedly`];
  }
}

export function resolveConfiguredAdapters(
  config: ProductRuntimeConfig,
  registry: AdapterRegistry,
): ProductRuntimeAdapters | ProductRuntimeFailure {
  const missing: string[] = [];
  const meetingSources = config.meeting_sources.map((adapterConfig) => {
    const adapter = registry.getMeetingSource(adapterConfig);
    if (adapter === undefined)
      missing.push(unavailableAdapterDetail('meeting-source', adapterConfig));
    return adapter;
  });
  const decisionProcessor = registry.getDecisionProcessor(
    config.decision_processor,
  );
  if (decisionProcessor === undefined) {
    missing.push(
      unavailableAdapterDetail('decision-processor', config.decision_processor),
    );
  }
  const deliverySurfaces = config.delivery_surfaces.map((adapterConfig) => {
    const adapter = registry.getDeliverySurface(adapterConfig);
    if (adapter === undefined) {
      missing.push(unavailableAdapterDetail('delivery-surface', adapterConfig));
    }
    return adapter;
  });
  let approvalSurface: ApprovalSurfaceAdapter | undefined;
  if (config.approval_mode === 'adapter') {
    approvalSurface = registry.getApprovalSurface(config.approval_surface);
    if (approvalSurface === undefined) {
      missing.push(
        unavailableAdapterDetail('approval-surface', config.approval_surface),
      );
    }
  }
  if (missing.length > 0) {
    return new ProductRuntimeFailure(
      'adapter_unavailable',
      `configured adapters are unavailable: ${missing.join('; ')}`,
      missing,
    );
  }
  const invalid = [
    ...config.meeting_sources.flatMap((adapterConfig, index) =>
      validateConfiguredAdapter(
        'meeting-source',
        adapterConfig,
        meetingSources[index] as MeetingSourceAdapter,
      ),
    ),
    ...validateConfiguredAdapter(
      'decision-processor',
      config.decision_processor,
      decisionProcessor as DecisionProcessorAdapter,
    ),
    ...config.delivery_surfaces.flatMap((adapterConfig, index) =>
      validateConfiguredAdapter(
        'delivery-surface',
        adapterConfig,
        deliverySurfaces[index] as DeliverySurfaceAdapter,
      ),
    ),
    ...(config.approval_mode === 'adapter'
      ? validateConfiguredAdapter(
          'approval-surface',
          config.approval_surface,
          approvalSurface as ApprovalSurfaceAdapter,
        )
      : []),
  ];
  if (invalid.length > 0) {
    return new ProductRuntimeFailure(
      'adapter_invalid_config',
      `configured adapters rejected their configuration: ${invalid.join('; ')}`,
      invalid,
    );
  }
  return {
    meetingSources: meetingSources as MeetingSourceAdapter[],
    decisionProcessor: decisionProcessor as DecisionProcessorAdapter,
    deliverySurfaces: deliverySurfaces as DeliverySurfaceAdapter[],
    ...(approvalSurface === undefined ? {} : { approvalSurface }),
  };
}
