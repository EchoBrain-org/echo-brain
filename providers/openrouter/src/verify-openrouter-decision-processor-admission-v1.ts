import type { Sha256Digest } from "@echo-brain/federation-protocol";
import Database from "better-sqlite3";
import { join } from "node:path";
import { assertOpenRouterDecisionProcessorConfigurationCommitmentV1 } from "./openrouter-decision-processor-config-v1.js";

interface PersistedProcessorCommitmentV1 {
  readonly adapter_id: string;
  readonly version: string;
  readonly configuration_sha256: Sha256Digest;
}

/** Checks an existing admission read-only before a candidate release activates. */
export function verifyPersistedOpenRouterDecisionProcessorAdmissionV1(
  stateDirectory: string,
): void {
  const database = new Database(join(stateDirectory, "authority.sqlite"), {
    readonly: true,
    fileMustExist: true,
  });
  try {
    database.pragma("query_only = ON");
    database.pragma("trusted_schema = OFF");
    const row = database
      .prepare(
        `SELECT processor_adapter_id AS adapter_id,
                processor_adapter_version AS version,
                processor_configuration_sha256 AS configuration_sha256
           FROM authority_live_source_admission_v2
          WHERE singleton = 1`,
      )
      .get() as PersistedProcessorCommitmentV1 | undefined;
    if (row === undefined) return;
    try {
      assertOpenRouterDecisionProcessorConfigurationCommitmentV1(row);
    } catch {
      throw new Error(
        "Candidate OpenRouter processor differs from the immutable admitted processor commitment; if this is a pre-live rehearsal with no live users, run deploy/organization-authority/onboard-clean-v1.sh replace-rehearsal --confirm-no-live-users before re-admitting the source; live state requires an explicit processor-admission migration",
      );
    }
  } finally {
    database.close();
  }
}
