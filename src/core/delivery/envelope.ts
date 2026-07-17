import { createHash } from 'node:crypto';
import type {
  DecisionBrief,
  DeliveryEnvelope,
  DeliveryReceipt,
} from '../contracts/delivery.js';
import type { CommunicationChannelAdapter } from '../ports/adapters.js';

function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value) as string;
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalJson(record[key])}`,
    )
    .join(',')}}`;
}

export function approvedBriefDigest(brief: DecisionBrief): string {
  return createHash('sha256').update(canonicalJson(brief)).digest('hex');
}

export function deliveryIdempotencyKey(
  processingKey: string,
  channel: CommunicationChannelAdapter,
  brief: DecisionBrief,
): string {
  return `delivery:v1:${JSON.stringify([
    processingKey,
    approvedBriefDigest(brief),
    channel.identity.adapter_id,
    channel.identity.instance_id,
    channel.destination.external_id,
  ])}`;
}

export function createDeliveryEnvelope(
  id: string,
  processingKey: string,
  channel: CommunicationChannelAdapter,
  brief: DecisionBrief,
  approvedAt: string,
): DeliveryEnvelope {
  if (
    channel.destination.adapter_id !== channel.identity.adapter_id ||
    channel.destination.instance_id !== channel.identity.instance_id
  ) {
    throw new Error('channel destination does not match the configured adapter instance');
  }
  return {
    schema_version: 1,
    id,
    idempotency_key: deliveryIdempotencyKey(processingKey, channel, brief),
    destination: channel.destination,
    brief,
    approved_at: approvedAt,
  };
}

export function assertDeliveryReceipt(
  envelope: DeliveryEnvelope,
  receipt: DeliveryReceipt,
): void {
  if (receipt.envelope_id !== envelope.id) {
    throw new Error('delivery receipt does not match its envelope');
  }
  const recordedAt = new Date(receipt.recorded_at).getTime();
  if (
    receipt.schema_version !== 1 ||
    !['delivered', 'rejected', 'failed', 'unknown'].includes(receipt.status) ||
    !(receipt.external_id === null || typeof receipt.external_id === 'string') ||
    typeof receipt.retryable !== 'boolean' ||
    Number.isNaN(recordedAt) ||
    new Date(recordedAt).toISOString() !== receipt.recorded_at ||
    (receipt.message !== undefined && typeof receipt.message !== 'string') ||
    (receipt.status === 'delivered' &&
      (receipt.external_id === null ||
        receipt.external_id.trim() === '' ||
        receipt.retryable))
  ) {
    throw new Error('communication-channel adapter returned an invalid delivery receipt');
  }
}
