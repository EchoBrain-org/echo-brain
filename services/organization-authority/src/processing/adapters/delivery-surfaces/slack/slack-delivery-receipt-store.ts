export type SlackStoredDelivery =
  | {
      schema_version: 1;
      record_type: 'echo-brain.slack-delivery';
      idempotency_key: string;
      status: 'delivered';
      channel_id: string;
      message_ts: string;
      recorded_at: string;
    }
  | {
      schema_version: 1;
      record_type: 'echo-brain.slack-delivery';
      idempotency_key: string;
      status: 'unknown';
      channel_id: null;
      message_ts: null;
      recorded_at: string;
      message: string;
    };

export type SlackDeliveryClaim =
  | { readonly kind: 'claimed' }
  | {
      readonly kind: 'existing';
      readonly record: SlackStoredDelivery;
    };

/** Authority-owned persistence around the one non-idempotent Slack write. */
export interface SlackDeliveryReceiptStore {
  healthCheck(): Promise<void>;
  claim(
    attempt: SlackStoredDelivery & { readonly status: 'unknown' },
  ): Promise<SlackDeliveryClaim>;
  recordOutcome(record: SlackStoredDelivery): Promise<void>;
  clearAttempt(idempotencyKey: string): Promise<void>;
}
