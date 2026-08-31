import type Database from "better-sqlite3";
import type { Sha256Digest } from "@echo-brain/federation-protocol";

/**
 * Immutable admission facts used only while constructing an admitted runtime.
 * They deliberately sit outside the polling-cycle contract: a source adapter
 * must prove that its current local configuration still names this admitted
 * source before any provider credential is read.
 */
export interface AdmittedMeetingProcessingCommitmentsV1 {
  readonly source: {
    readonly adapter_id: string;
    readonly instance_id: string;
    readonly version: string;
    readonly custodian_sha256: Sha256Digest;
    readonly credential_reference_sha256: Sha256Digest;
  };
  readonly processor: {
    readonly adapter_id: string;
    readonly instance_id: string;
    readonly version: string;
    readonly configuration_sha256: Sha256Digest;
    readonly credential_reference_sha256: Sha256Digest;
  };
}

interface CommitmentRow {
  readonly source_adapter_id: string;
  readonly source_adapter_instance_id: string;
  readonly source_adapter_version: string;
  readonly source_custodian_sha256: Sha256Digest;
  readonly source_credential_reference_sha256: Sha256Digest;
  readonly processor_adapter_id: string;
  readonly processor_instance_id: string;
  readonly processor_adapter_version: string;
  readonly processor_configuration_sha256: Sha256Digest;
  readonly processor_credential_reference_sha256: Sha256Digest;
}

/** Reads no private file and exposes no private value. */
export function readAdmittedMeetingProcessingCommitmentsV1(
  database: Database.Database,
): AdmittedMeetingProcessingCommitmentsV1 {
  const row = database
    .prepare(
      `SELECT source_adapter_id, source_adapter_instance_id,
              source_adapter_version, source_custodian_sha256,
              source_credential_reference_sha256, processor_adapter_id,
              processor_instance_id, processor_adapter_version,
              processor_configuration_sha256,
              processor_credential_reference_sha256
         FROM authority_live_source_admission_v2
        WHERE singleton = 1`,
    )
    .get() as CommitmentRow | undefined;
  if (row === undefined) {
    throw new Error("admitted-source processing has no source admission");
  }
  return Object.freeze({
    source: Object.freeze({
      adapter_id: row.source_adapter_id,
      instance_id: row.source_adapter_instance_id,
      version: row.source_adapter_version,
      custodian_sha256: row.source_custodian_sha256,
      credential_reference_sha256: row.source_credential_reference_sha256,
    }),
    processor: Object.freeze({
      adapter_id: row.processor_adapter_id,
      instance_id: row.processor_instance_id,
      version: row.processor_adapter_version,
      configuration_sha256: row.processor_configuration_sha256,
      credential_reference_sha256: row.processor_credential_reference_sha256,
    }),
  });
}
