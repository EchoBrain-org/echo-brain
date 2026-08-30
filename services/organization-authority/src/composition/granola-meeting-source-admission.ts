import { join } from "node:path";
import { canonicalSha256 } from "@echo-brain/federation-protocol";
import type { Sha256Digest } from "@echo-brain/federation-protocol";
import {
  readPrivateAuthorityGranolaOrganizationCredential,
  readPrivateAuthorityGranolaOwnerEmail,
} from "../adapters/security/private-file-credentials.js";
import { personLoginGrantExpectedEmailSha256 } from "../domain/person-email-binding.js";
import { openAuthorityDatabase } from "../adapters/persistence/sqlite/open-authority-database.js";
import {
  createGranolaLiveOnlyCursor,
  granolaLiveOnlyCutoff,
  observeGranolaRecordOwner,
  type GranolaRecordOwnerObservationClient,
} from "../processing/adapters/meeting-sources/granola/index.js";
import {
  assertDecisionProcessorAdmissionCommitmentV1,
  type DecisionProcessorAdmissionCommitmentV1,
} from "../processing/admitted-meeting-processing/decision-processor-admission-commitment.js";
import { verifyAuthorityStateLineage } from "./verify-authority-state-lineage.js";

export const CLEAN_GRANOLA_SOURCE_ADAPTER_VERSION_V1 = "2.2.0";
const INSTANCE_ID = /^[a-z][a-z0-9-]{0,127}$/;

export interface AdmitGranolaMeetingSourceInput {
  readonly state_directory: string;
  readonly source_instance_id: string;
  /** A canonical `file:` reference to a current-user 0600 Granola key. */
  readonly granola_credential_reference: string;
  /** A canonical `file:` reference to a current-user 0600 owner email. */
  readonly granola_owner_email_reference: string;
  /** Processor facts and local proof are owned by its provider composition. */
  readonly processor: DecisionProcessorAdmissionCommitmentV1;
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

export interface GranolaMeetingSourceAdmissionResult {
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
    readonly adapter_id: string;
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
  readonly source_adapter_id: "granola";
  readonly source_adapter_version: string;
  readonly source_adapter_instance_id: string;
  readonly normalizer_version: string;
  readonly source_custodian_sha256: Sha256Digest;
  readonly source_custodian_assurance: "provider_record_owner_observed";
  readonly source_custodian_observed_at: string;
  readonly source_credential_reference_sha256: Sha256Digest;
  readonly initial_cursor: string;
  readonly cutoff_at: string;
  readonly processor_adapter_id: string;
  readonly processor_instance_id: string;
  readonly processor_adapter_version: string;
  readonly processor_configuration_sha256: Sha256Digest;
  readonly processor_credential_reference_sha256: Sha256Digest;
  readonly semantic_input_sha256: Sha256Digest;
  readonly admitted_at: string;
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

function result(
  outcome: GranolaMeetingSourceAdmissionResult["outcome"],
  admission: ExistingAdmission,
): GranolaMeetingSourceAdmissionResult {
  return Object.freeze({
    schema_version: 1,
    kind: "echo-clean-granola-source-admission-v1",
    outcome,
    source: {
      adapter_id: "granola" as const,
      instance_id: admission.source_adapter_instance_id,
      version:
        CLEAN_GRANOLA_SOURCE_ADAPTER_VERSION_V1 as typeof CLEAN_GRANOLA_SOURCE_ADAPTER_VERSION_V1,
      cursor: admission.initial_cursor,
      cutoff_at: admission.cutoff_at,
    },
    custody: {
      principal_id: admission.principal_id,
      membership_id: admission.membership_id,
      membership_type: "owner" as const,
      owner_email_sha256: admission.source_custodian_sha256,
    },
    processor: {
      adapter_id: admission.processor_adapter_id,
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
export async function admitGranolaMeetingSource(
  input: AdmitGranolaMeetingSourceInput,
): Promise<GranolaMeetingSourceAdmissionResult> {
  assertDecisionProcessorAdmissionCommitmentV1(input.processor);
  await input.processor.preflight();
  const granolaCredential = readPrivateAuthorityGranolaOrganizationCredential(
    input.granola_credential_reference,
  );
  const ownerEmail = readPrivateAuthorityGranolaOwnerEmail(
    input.granola_owner_email_reference,
  );
  return admitGranolaMeetingSourceAfterOwnerPreflight(
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
async function admitGranolaMeetingSourceAfterOwnerPreflight(
  input: AdmitGranolaMeetingSourceInput,
  granolaCredential: string,
  ownerEmail: string,
  ownerPreflightComplete: boolean,
): Promise<GranolaMeetingSourceAdmissionResult> {
  if (
    !INSTANCE_ID.test(input.source_instance_id)
  ) {
    throw new Error(
      "clean Granola source instance ID is invalid",
    );
  }

  const lineage = verifyAuthorityStateLineage(input.state_directory);
  // Private values are never persisted, logged, or returned.
  const ownerEmailSha256 = personLoginGrantExpectedEmailSha256(
    ownerEmail,
  );
  const sourceCredentialReferenceSha256 = privateReferenceSha256(
    "echo-clean-granola-source-credential-reference-v1",
    input.granola_credential_reference,
  );
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
          "Granola source admission requires exactly one active organization owner",
        );
      }
      const owner = custody[0]!;
      const completedInitialOwnerIdentity = database
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
      if (completedInitialOwnerIdentity === undefined) {
        throw new Error(
          "Granola source admission requires completed initial-owner OIDC re-onboarding bound to the supplied owner email (legacy check: completed founder OIDC re-onboarding)",
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
          adapter_id: input.processor.adapter_id,
          adapter_version: input.processor.version,
          instance_id: input.processor.instance_id,
          configuration_sha256: input.processor.configuration_sha256,
          credential_reference_sha256:
            input.processor.credential_reference_sha256,
        },
      });
      const existing = database
        .prepare(
          `SELECT organization_id, principal_id, membership_id, membership_type,
                  source_adapter_id, source_adapter_version,
                  source_adapter_instance_id, normalizer_version,
                  source_custodian_sha256, source_custodian_assurance,
                  source_custodian_observed_at,
                  source_credential_reference_sha256, initial_cursor, cutoff_at,
                  processor_adapter_id,
                  processor_instance_id, processor_adapter_version,
                  processor_configuration_sha256,
                  processor_credential_reference_sha256,
                  semantic_input_sha256, admitted_at
             FROM authority_live_source_admission_v2
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
        return admitGranolaMeetingSourceAfterOwnerPreflight(
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
        source_adapter_id: "granola",
        source_adapter_version: CLEAN_GRANOLA_SOURCE_ADAPTER_VERSION_V1,
        source_adapter_instance_id: input.source_instance_id,
        normalizer_version: CLEAN_GRANOLA_SOURCE_ADAPTER_VERSION_V1,
        source_custodian_sha256: ownerEmailSha256,
        source_custodian_assurance: "provider_record_owner_observed",
        source_custodian_observed_at: ownerObservedAt,
        source_credential_reference_sha256: sourceCredentialReferenceSha256,
        initial_cursor: cursor,
        cutoff_at: ownerObservedAt,
        processor_adapter_id: input.processor.adapter_id,
        processor_instance_id: input.processor.instance_id,
        processor_adapter_version: input.processor.version,
        processor_configuration_sha256: input.processor.configuration_sha256,
        processor_credential_reference_sha256:
          input.processor.credential_reference_sha256,
        semantic_input_sha256: semanticInputSha256,
        admitted_at: ownerObservedAt,
      };
      database
        .prepare(
          `INSERT INTO authority_live_source_admission_v2 (
             singleton, organization_id, principal_id, membership_id,
             membership_type, source_adapter_id, source_adapter_version,
             source_adapter_instance_id, normalizer_version,
             source_custodian_sha256, source_custodian_assurance,
             source_custodian_observed_at,
             source_credential_reference_sha256, initial_cursor, cutoff_at,
             processor_adapter_id, processor_instance_id, processor_adapter_version,
             processor_configuration_sha256,
             processor_credential_reference_sha256, semantic_input_sha256,
             admitted_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          1,
          admission.organization_id,
          admission.principal_id,
          admission.membership_id,
          admission.membership_type,
          admission.source_adapter_id,
          admission.source_adapter_version,
          admission.source_adapter_instance_id,
          admission.normalizer_version,
          admission.source_custodian_sha256,
          admission.source_custodian_assurance,
          admission.source_custodian_observed_at,
          admission.source_credential_reference_sha256,
          admission.initial_cursor,
          admission.cutoff_at,
          admission.processor_adapter_id,
          admission.processor_instance_id,
          admission.processor_adapter_version,
          admission.processor_configuration_sha256,
          admission.processor_credential_reference_sha256,
          admission.semantic_input_sha256,
          admission.admitted_at,
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
