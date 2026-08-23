import { join } from "node:path";
import { canonicalSha256 } from "@echo-brain/federation-protocol";
import type { Sha256Digest } from "@echo-brain/federation-protocol";
import {
  readPrivateAuthorityCredential,
  readPrivateAuthorityGranolaOrganizationCredential,
  readPrivateAuthorityGranolaOwnerEmail,
} from "../adapters/security/private-file-credentials.js";
import { personLoginGrantExpectedEmailSha256 } from "../domain/person-email-binding.js";
import { openAuthorityDatabase } from "../adapters/persistence/sqlite/open-unmigrated-database.js";
import {
  createGranolaLiveOnlyCursor,
  granolaLiveOnlyCutoff,
  observeGranolaRecordOwner,
  type GranolaRecordOwnerObservationClient,
} from "../processing/adapters/meeting-sources/granola/index.js";
import { llmProcessingVersion } from "../processing/adapters/decision-processors/llm/llm-decision-processor.js";
import type { AdapterConfig } from "../processing/core/contracts/adapter.js";
import { verifyCleanStateLineage } from "./verify-clean-state-lineage.js";

export const CLEAN_GRANOLA_SOURCE_ADAPTER_VERSION_V1 = "2.2.0";
export const CLEAN_LLM_PROCESSOR_ADAPTER_VERSION_V1 = "1.3.0";
export const CLEAN_LLM_PROCESSOR_PROMPT_VERSION_V1 = "decision-extraction-v3";
export const CLEAN_LLM_PROCESSOR_SCHEMA_VERSION_V1 =
  "decision-extraction-schema-v4";
export const CLEAN_LLM_PROCESSOR_PROVIDER_V1 = "openrouter";
export const CLEAN_LLM_PROCESSOR_MODEL_V1 = "deepseek/deepseek-r1";
export const CLEAN_LLM_PROCESSOR_MAX_OUTPUT_TOKENS_V1 = 8192;
export const CLEAN_LLM_PROCESSOR_TIMEOUT_MS_V1 = 600_000;

function fixedLlmProcessorConfig(instanceId: string): AdapterConfig {
  return {
    adapter_id: "llm",
    instance_id: instanceId,
    settings: {
      provider: CLEAN_LLM_PROCESSOR_PROVIDER_V1,
      model: CLEAN_LLM_PROCESSOR_MODEL_V1,
      max_output_tokens: CLEAN_LLM_PROCESSOR_MAX_OUTPUT_TOKENS_V1,
      request_timeout_ms: CLEAN_LLM_PROCESSOR_TIMEOUT_MS_V1,
    },
  };
}

/** Exact runtime identity emitted by the fixed clean LLM adapter configuration. */
export const CLEAN_LLM_PROCESSOR_RUNTIME_VERSION_V1 = llmProcessingVersion(
  fixedLlmProcessorConfig("clean-fixed-llm"),
);

const INSTANCE_ID = /^[a-z][a-z0-9-]{0,127}$/;

export interface AdmitCleanGranolaSourceInput {
  readonly state_directory: string;
  readonly source_instance_id: string;
  readonly processor_instance_id: string;
  /** A canonical `file:` reference to a current-user 0600 Granola key. */
  readonly granola_credential_reference: string;
  /** A canonical `file:` reference to a current-user 0600 owner email. */
  readonly granola_owner_email_reference: string;
  /** A canonical `file:` reference to a current-user 0600 LLM credential. */
  readonly llm_credential_reference: string;
  /**
   * Metadata-only provider seam. It exposes listNotes only, so admission
   * cannot fetch provider content while proving the configured owner exists.
   */
  readonly create_granola_record_owner_client: (
    credential: string,
  ) => GranolaRecordOwnerObservationClient;
  /** Test seam. An exact retry never evaluates it. */
  readonly now?: () => string;
}

export interface CleanGranolaSourceAdmissionResult {
  readonly schema_version: 1;
  readonly kind: "echo-clean-granola-source-admission-v1";
  readonly outcome: "admitted" | "already_admitted";
  readonly source: {
    readonly adapter_id: "granola";
    readonly instance_id: string;
    readonly version: typeof CLEAN_GRANOLA_SOURCE_ADAPTER_VERSION_V1;
    readonly cursor: string;
    readonly cutoff_at: string;
  };
  readonly custody: {
    readonly principal_id: string;
    readonly membership_id: string;
    readonly membership_type: "owner";
    readonly owner_email_sha256: Sha256Digest;
  };
  readonly processor: {
    readonly adapter_id: "llm";
    readonly instance_id: string;
    readonly version: string;
    readonly configuration_sha256: Sha256Digest;
  };
}

interface ExistingAdmission {
  readonly organization_id: string;
  readonly principal_id: string;
  readonly membership_id: string;
  readonly membership_type: "owner";
  readonly source_instance_id: string;
  readonly cursor: string;
  readonly cutoff_at: string;
  readonly owner_email_sha256: Sha256Digest;
  readonly owner_observation_assurance: "provider_record_owner_observed";
  readonly owner_observed_at: string;
  readonly processor_instance_id: string;
  readonly processor_adapter_version: string;
  readonly processor_configuration_sha256: Sha256Digest;
  readonly semantic_input_sha256: Sha256Digest;
}

function assertCanonicalUtcMillis(value: string): void {
  if (new Date(value).toISOString() !== value) {
    throw new Error(
      "clean Granola source admission time must be UTC milliseconds",
    );
  }
}

function privateReferenceSha256(kind: string, reference: string): Sha256Digest {
  return canonicalSha256({
    schema_version: 1,
    kind,
    reference,
  });
}

function processorConfigurationSha256(): Sha256Digest {
  return canonicalSha256({
    schema_version: 1,
    kind: "echo-clean-llm-processor-configuration-v1",
    adapter_id: "llm",
    adapter_version: CLEAN_LLM_PROCESSOR_RUNTIME_VERSION_V1,
    prompt_version: CLEAN_LLM_PROCESSOR_PROMPT_VERSION_V1,
    extraction_schema_version: CLEAN_LLM_PROCESSOR_SCHEMA_VERSION_V1,
    provider: CLEAN_LLM_PROCESSOR_PROVIDER_V1,
    model: CLEAN_LLM_PROCESSOR_MODEL_V1,
    max_output_tokens: CLEAN_LLM_PROCESSOR_MAX_OUTPUT_TOKENS_V1,
    request_timeout_ms: CLEAN_LLM_PROCESSOR_TIMEOUT_MS_V1,
  });
}

function result(
  outcome: CleanGranolaSourceAdmissionResult["outcome"],
  admission: ExistingAdmission,
): CleanGranolaSourceAdmissionResult {
  return Object.freeze({
    schema_version: 1,
    kind: "echo-clean-granola-source-admission-v1",
    outcome,
    source: {
      adapter_id: "granola" as const,
      instance_id: admission.source_instance_id,
      version:
        CLEAN_GRANOLA_SOURCE_ADAPTER_VERSION_V1 as typeof CLEAN_GRANOLA_SOURCE_ADAPTER_VERSION_V1,
      cursor: admission.cursor,
      cutoff_at: admission.cutoff_at,
    },
    custody: {
      principal_id: admission.principal_id,
      membership_id: admission.membership_id,
      membership_type: "owner" as const,
      owner_email_sha256: admission.owner_email_sha256,
    },
    processor: {
      adapter_id: "llm" as const,
      instance_id: admission.processor_instance_id,
      version: admission.processor_adapter_version,
      configuration_sha256: admission.processor_configuration_sha256,
    },
  });
}

/**
 * Creates the one fresh, live-only source pipeline while Authority is stopped.
 * It makes one bounded, metadata-only Granola list request before its first
 * admission. Credential bytes are read only to prove their private-file
 * contracts and are never persisted, logged, or returned.
 */
export async function admitCleanGranolaSource(
  input: AdmitCleanGranolaSourceInput,
): Promise<CleanGranolaSourceAdmissionResult> {
  const granolaCredential = readPrivateAuthorityGranolaOrganizationCredential(
    input.granola_credential_reference,
  );
  const ownerEmail = readPrivateAuthorityGranolaOwnerEmail(
    input.granola_owner_email_reference,
  );
  return admitCleanGranolaSourceAfterOwnerPreflight(
    input,
    granolaCredential,
    ownerEmail,
    false,
  );
}

/**
 * The second entry is private so a caller cannot claim that provider ownership
 * was observed. It rechecks every database admission fact after the bounded
 * network observation, without holding SQLite's write transaction open while
 * waiting on the provider.
 */
async function admitCleanGranolaSourceAfterOwnerPreflight(
  input: AdmitCleanGranolaSourceInput,
  granolaCredential: string,
  ownerEmail: string,
  ownerPreflightComplete: boolean,
): Promise<CleanGranolaSourceAdmissionResult> {
  if (
    !INSTANCE_ID.test(input.source_instance_id) ||
    !INSTANCE_ID.test(input.processor_instance_id)
  ) {
    throw new Error(
      "clean Granola source and processor instance IDs are invalid",
    );
  }

  const lineage = verifyCleanStateLineage(input.state_directory);
  // Private values are never persisted, logged, or returned.
  const ownerEmailSha256 = personLoginGrantExpectedEmailSha256(
    ownerEmail,
  );
  void readPrivateAuthorityCredential(input.llm_credential_reference);
  const sourceCredentialReferenceSha256 = privateReferenceSha256(
    "echo-clean-granola-source-credential-reference-v1",
    input.granola_credential_reference,
  );
  const processorCredentialReferenceSha256 = privateReferenceSha256(
    "echo-clean-llm-processor-credential-reference-v1",
    input.llm_credential_reference,
  );
  const configurationSha256 = processorConfigurationSha256();

  const database = openAuthorityDatabase(
    join(input.state_directory, "authority.sqlite"),
    { fileMustExist: true },
  );
  try {
    database.exec("BEGIN IMMEDIATE");
    try {
      const custody = database
        .prepare(
          `SELECT principal_id, membership_id, membership_type
             FROM authority_memberships
            WHERE organization_id = ? AND membership_type = 'owner'
              AND status = 'active'
            ORDER BY membership_id`,
        )
        .all(lineage.root.organization_id) as Array<{
        principal_id: string;
        membership_id: string;
        membership_type: "owner";
      }>;
      if (custody.length !== 1) {
        throw new Error(
          "clean Granola source admission requires exactly one active founder owner",
        );
      }
      const owner = custody[0]!;
      const completedFounderIdentity = database
        .prepare(
          `SELECT 1
             FROM authority_oidc_identity_bindings AS identity_binding
             JOIN authority_person_login_grants AS login_grant
               ON login_grant.login_grant_sha256 =
                    identity_binding.initial_login_grant_sha256
              AND login_grant.organization_id = identity_binding.organization_id
              AND login_grant.principal_id = identity_binding.principal_id
              AND login_grant.membership_id = identity_binding.membership_id
              AND login_grant.membership_type = identity_binding.membership_type
            WHERE identity_binding.organization_id = ?
              AND identity_binding.principal_id = ?
              AND identity_binding.membership_id = ?
              AND identity_binding.membership_type = 'owner'
              AND identity_binding.status = 'active'
              AND login_grant.consumed_at = identity_binding.bound_at
              AND login_grant.expected_email_sha256 = ?
            LIMIT 1`,
        )
        .get(
          lineage.root.organization_id,
          owner.principal_id,
          owner.membership_id,
          ownerEmailSha256,
        );
      if (completedFounderIdentity === undefined) {
        throw new Error(
          "clean Granola source admission requires completed founder OIDC re-onboarding bound to the supplied owner email",
        );
      }
      const semanticInputSha256 = canonicalSha256({
        schema_version: 1,
        kind: "echo-clean-granola-source-admission-semantic-input-v1",
        organization_id: lineage.root.organization_id,
        principal_id: owner.principal_id,
        membership_id: owner.membership_id,
        membership_type: owner.membership_type,
        source: {
          adapter_id: "granola",
          adapter_version: CLEAN_GRANOLA_SOURCE_ADAPTER_VERSION_V1,
          instance_id: input.source_instance_id,
          normalizer_version: CLEAN_GRANOLA_SOURCE_ADAPTER_VERSION_V1,
          owner_email_sha256: ownerEmailSha256,
          owner_observation_assurance: "provider_record_owner_observed",
          credential_reference_sha256: sourceCredentialReferenceSha256,
        },
        processor: {
          adapter_id: "llm",
          adapter_version: CLEAN_LLM_PROCESSOR_RUNTIME_VERSION_V1,
          instance_id: input.processor_instance_id,
          configuration_sha256: configurationSha256,
          credential_reference_sha256: processorCredentialReferenceSha256,
        },
      });
      const existing = database
        .prepare(
          `SELECT organization_id, principal_id, membership_id, membership_type,
                  source_instance_id, cursor, cutoff_at, owner_email_sha256,
                  owner_observation_assurance, owner_observed_at,
                  processor_instance_id, processor_adapter_version,
                  processor_configuration_sha256,
                  semantic_input_sha256
             FROM authority_clean_granola_source_admission_v1
            WHERE singleton = 1`,
        )
        .get() as ExistingAdmission | undefined;
      if (existing !== undefined) {
        if (existing.semantic_input_sha256 !== semanticInputSha256) {
          throw new Error(
            "clean Granola source admission semantic input conflicts with the admitted pipeline",
          );
        }
        database.exec("COMMIT");
        return result("already_admitted", existing);
      }

      if (!ownerPreflightComplete) {
        database.exec("COMMIT");
        await observeGranolaRecordOwner(
          input.create_granola_record_owner_client(granolaCredential),
          ownerEmail,
        );
        return admitCleanGranolaSourceAfterOwnerPreflight(
          input,
          granolaCredential,
          ownerEmail,
          true,
        );
      }
      const ownerObservedAt = (input.now ?? (() => new Date().toISOString()))();
      assertCanonicalUtcMillis(ownerObservedAt);
      const cursor = createGranolaLiveOnlyCursor(ownerObservedAt);
      if (granolaLiveOnlyCutoff(cursor) !== ownerObservedAt) {
        throw new Error(
          "clean Granola source admission could not establish its live-only cutoff",
        );
      }
      const admission: ExistingAdmission = {
        organization_id: lineage.root.organization_id,
        principal_id: owner.principal_id,
        membership_id: owner.membership_id,
        membership_type: "owner",
        source_instance_id: input.source_instance_id,
        cursor,
        cutoff_at: ownerObservedAt,
        owner_email_sha256: ownerEmailSha256,
        owner_observation_assurance: "provider_record_owner_observed",
        owner_observed_at: ownerObservedAt,
        processor_instance_id: input.processor_instance_id,
        processor_adapter_version: CLEAN_LLM_PROCESSOR_RUNTIME_VERSION_V1,
        processor_configuration_sha256: configurationSha256,
        semantic_input_sha256: semanticInputSha256,
      };
      database
        .prepare(
          `INSERT INTO authority_clean_granola_source_admission_v1 (
             singleton, organization_id, principal_id, membership_id,
             membership_type, source_instance_id, source_adapter_version,
             normalizer_version, owner_email_sha256,
             owner_observation_assurance, owner_observed_at,
             source_credential_reference_sha256, cursor, cutoff_at,
             processor_instance_id, processor_adapter_version,
             processor_configuration_sha256,
             processor_credential_reference_sha256, semantic_input_sha256,
             admitted_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          1,
          admission.organization_id,
          admission.principal_id,
          admission.membership_id,
          admission.membership_type,
          admission.source_instance_id,
          CLEAN_GRANOLA_SOURCE_ADAPTER_VERSION_V1,
          CLEAN_GRANOLA_SOURCE_ADAPTER_VERSION_V1,
          admission.owner_email_sha256,
          admission.owner_observation_assurance,
          admission.owner_observed_at,
          sourceCredentialReferenceSha256,
          admission.cursor,
          admission.cutoff_at,
          admission.processor_instance_id,
          admission.processor_adapter_version,
          admission.processor_configuration_sha256,
          processorCredentialReferenceSha256,
          admission.semantic_input_sha256,
          ownerObservedAt,
        );
      database.exec("COMMIT");
      return result("admitted", admission);
    } catch (error) {
      try {
        database.exec("ROLLBACK");
      } catch {}
      throw error;
    }
  } finally {
    database.close();
  }
}
