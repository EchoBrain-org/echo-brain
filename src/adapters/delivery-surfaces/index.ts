/**
 * Delivery-surface adapter implementations belong under this namespace.
 *
 * The bundled JSONL outbox is a durable local delivery target and reference
 * implementation for external delivery adapters.
 */
export type {
  Adapter,
  AdapterConfig,
  AdapterConfigValidation,
  AdapterHealth,
  AdapterIdentity,
  DeliveryDestination,
  DeliverySurfaceAdapter,
  DecisionBrief,
  DeliveryEnvelope,
  DeliveryReceipt,
} from '@echo-brain/organization-authority/processing/core/index.js';

export * from './jsonl-outbox/index.js';
export * from './slack/index.js';
