import type { JsonObject } from '@echo-brain/federation-protocol';
import type { PinnedOrganizationAuthority } from './authority-descriptor.js';
import { createOrganizationRecordEnvelopeV4, verifyOrganizationRecordEnvelopeV4 } from './record-envelope-v4.js';
import { createOrganizationRecordReceiptV2, verifyOrganizationRecordReceiptV2, validateOrganizationRecordReceiptBodyV2 } from './organization-record-receipt-v2.js';
import type { RecordInputCodecRegistryV4 } from './record-input-codec-v4.js';

export interface RecordAppendFactoryOptionsV4 {
  readonly pinned_authority: PinnedOrganizationAuthority; readonly state_lineage_id: string;
  readonly sign: Parameters<typeof createOrganizationRecordEnvelopeV4>[3]; readonly codecs: RecordInputCodecRegistryV4;
}
/** Shared signed envelope construction for every approval surface. */
export function createRecordEnvelopeFactoryV4(options: RecordAppendFactoryOptionsV4, input: Pick<Parameters<typeof createOrganizationRecordEnvelopeV4>[0], 'issued_at' | 'human_act_record_input' | 'source_provenance' | 'processor_provenance'>, nextEnvelopeId: () => string) {
  const { pinned_authority: pinned, state_lineage_id: lineage, codecs, sign } = options;
  return {
    create: async (allocation: { readonly predecessor_position: number | null; readonly predecessor_record_sha256: `sha256:${string}` | null }) =>
      await createOrganizationRecordEnvelopeV4({ ...input, predecessor_position: allocation.predecessor_position,
        predecessor_record_sha256: allocation.predecessor_record_sha256, envelope_id: nextEnvelopeId() }, pinned, lineage, sign, codecs) as unknown as JsonObject,
    verify: (value: unknown) => verifyOrganizationRecordEnvelopeV4(value, pinned, lineage, codecs) as ReturnType<typeof verifyOrganizationRecordEnvelopeV4> & JsonObject,
  };
}
/** The exact committed seed remains the receipt's authority during recovery. */
export function createRecordReceiptFactoryV2(options: RecordAppendFactoryOptionsV4) {
  const { pinned_authority: pinned, state_lineage_id: lineage, codecs, sign } = options;
  return {
    createSeed: ({ envelope: raw, position, issued_at, policy_fact_outcome }: {
      readonly envelope: unknown; readonly position: number; readonly issued_at: string; readonly policy_fact_outcome: unknown;
    }): JsonObject => {
      const envelope = verifyOrganizationRecordEnvelopeV4(raw, pinned, lineage, codecs);
      return validateOrganizationRecordReceiptBodyV2({
        schema_version: 2, kind: 'echo-organization-record-receipt-v2', authority_id: envelope.body.authority_id,
        organization_id: envelope.body.organization_id, state_lineage_id: envelope.body.state_lineage_id, envelope_id: envelope.body.envelope_id,
        semantic_idempotency_key: envelope.body.semantic_idempotency_key, event_kind: envelope.body.event.kind,
        record_position: position, record_sha256: envelope.record_sha256, predecessor_record_sha256: envelope.body.predecessor_record_sha256,
        record_head_position: position, record_head_sha256: envelope.record_sha256, issued_at, policy_fact_outcome,
      }) as unknown as JsonObject;
    },
    sign: async ({ envelope: raw, receipt_seed }: { readonly envelope: unknown; readonly receipt_seed: JsonObject }) => {
      const envelope = verifyOrganizationRecordEnvelopeV4(raw, pinned, lineage, codecs);
      return await createOrganizationRecordReceiptV2({ envelope, record_position: envelope.body.predecessor_position === null ? 1 : envelope.body.predecessor_position + 1,
        issued_at: receipt_seed.issued_at as string }, pinned, lineage, sign, codecs) as unknown as JsonObject;
    },
    verify: ({ receipt, envelope }: { readonly receipt: unknown; readonly envelope: unknown }) =>
      verifyOrganizationRecordReceiptV2(receipt, envelope, pinned, lineage, codecs) as unknown as JsonObject,
  };
}
