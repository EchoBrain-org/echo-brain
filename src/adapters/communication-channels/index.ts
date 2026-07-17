/**
 * Communication-channel adapter implementations belong under this namespace.
 *
 * The bundled JSONL outbox is a durable local delivery target and reference
 * implementation for external channel adapters.
 */
export type {
  Adapter,
  AdapterConfig,
  AdapterConfigValidation,
  AdapterHealth,
  AdapterIdentity,
  ChannelDestination,
  CommunicationChannelAdapter,
  DecisionBrief,
  DeliveryEnvelope,
  DeliveryReceipt,
} from '../../core/index.js';

export * from './jsonl-outbox/index.js';
