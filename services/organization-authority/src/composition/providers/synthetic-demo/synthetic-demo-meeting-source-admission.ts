import { join } from "node:path";
import {
  canonicalSha256,
  type Sha256Digest,
} from "@echo-brain/federation-protocol";
import { openAuthorityDatabase } from "../../../adapters/persistence/sqlite/open-authority-database.js";
import { personLoginGrantExpectedEmailSha256 } from "../../../domain/person-email-binding.js";
import {
  assertDecisionProcessorAdmissionCommitmentV1,
  type DecisionProcessorAdmissionCommitmentV1,
} from "../../../processing/admitted-meeting-processing/decision-processor-admission-commitment.js";
import {
  loadSyntheticDemoMeetingCorpusV1,
  SYNTHETIC_DEMO_INITIAL_CURSOR_V1,
  syntheticDemoMeetingSourceIdentityV1,
  type SyntheticDemoMeetingCorpusV1,
} from "../../../processing/adapters/meeting-sources/synthetic-demo/synthetic-demo-meeting-source-v1.js";
import { verifyAuthorityStateLineage } from "../../verify-authority-state-lineage.js";

const CUSTODIAN_ASSURANCE = "authority_initial_owner_identity";

export interface AdmitSyntheticDemoMeetingSourceInputV1 {
  readonly state_directory: string;
  readonly meetings_directory: string;
  readonly processor: DecisionProcessorAdmissionCommitmentV1;
  /** An exact retry never evaluates this seam. */
  readonly now?: () => string;
}

export interface SyntheticDemoMeetingSourceAdmissionResultV1 {
  readonly schema_version: 1;
  readonly kind: "echo-synthetic-demo-source-admission-v1";
  readonly outcome: "admitted" | "already_admitted";
  readonly source: {
    readonly adapter_id: "synthetic-demo-source";
    readonly instance_id: "customer-demo";
    readonly version: "1.0.0";
    readonly cursor: string;
    readonly cutoff_at: string;
    readonly corpus_digest: Sha256Digest;
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

interface ExistingAdmissionV1 {
  readonly organization_id: string;
  readonly principal_id: string;
  readonly membership_id: string;
  readonly membership_type: "owner";
  readonly source_adapter_id: "synthetic-demo-source";
  readonly source_adapter_version: "1.0.0";
  readonly source_adapter_instance_id: "customer-demo";
  readonly normalizer_version: "1.0.0";
  readonly source_custodian_sha256: Sha256Digest;
  readonly source_custodian_assurance: typeof CUSTODIAN_ASSURANCE;
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
      "synthetic-demo meeting-source admission time must be UTC milliseconds",
    );
  }
}

function assertCorpusOwnersMatchCustodian(
  corpus: SyntheticDemoMeetingCorpusV1,
  custodianDigest: Sha256Digest,
): void {
  for (const meeting of corpus.meetings) {
    const ownerParticipantId = meeting.context?.owner_participant_id;
    const owner = meeting.participants.find(
      (participant) => participant.id === ownerParticipantId,
    );
    const ownerEmails = (owner?.identities ?? []).filter(
      (identity) => identity.kind === "email",
    );
    if (
      ownerEmails.length !== 1 ||
      personLoginGrantExpectedEmailSha256(ownerEmails[0]!.value) !==
        custodianDigest
    ) {
      throw new Error(
        "synthetic-demo meeting owners must match the admitted owner identity",
      );
    }
  }
}

function result(
  outcome: SyntheticDemoMeetingSourceAdmissionResultV1["outcome"],
  admission: ExistingAdmissionV1,
): SyntheticDemoMeetingSourceAdmissionResultV1 {
  return Object.freeze({
    schema_version: 1,
    kind: "echo-synthetic-demo-source-admission-v1",
    outcome,
    source: Object.freeze({
      adapter_id: syntheticDemoMeetingSourceIdentityV1.adapter_id,
      instance_id: syntheticDemoMeetingSourceIdentityV1.instance_id,
      version: syntheticDemoMeetingSourceIdentityV1.version,
      cursor: admission.initial_cursor,
      cutoff_at: admission.cutoff_at,
      corpus_digest: admission.source_credential_reference_sha256,
    }),
    custody: Object.freeze({
      principal_id: admission.principal_id,
      membership_id: admission.membership_id,
      membership_type: "owner",
      owner_email_sha256: admission.source_custodian_sha256,
    }),
    processor: Object.freeze({
      adapter_id: admission.processor_adapter_id,
      instance_id: admission.processor_instance_id,
      version: admission.processor_adapter_version,
      configuration_sha256: admission.processor_configuration_sha256,
    }),
  });
}

/**
 * Admits the fixed local demo corpus to an otherwise ordinary Authority state.
 * The corpus digest is the source credential-reference commitment; directory
 * paths and admission timestamps are intentionally not semantic inputs.
 */
export async function admitSyntheticDemoMeetingSource(
  input: AdmitSyntheticDemoMeetingSourceInputV1,
): Promise<SyntheticDemoMeetingSourceAdmissionResultV1> {
  assertDecisionProcessorAdmissionCommitmentV1(input.processor);
  await input.processor.preflight();
  const corpus = await loadSyntheticDemoMeetingCorpusV1(input.meetings_directory);
  const lineage = verifyAuthorityStateLineage(input.state_directory);
  const database = openAuthorityDatabase(
    join(input.state_directory, "authority.sqlite"),
    { fileMustExist: true },
  );
  try {
    database.exec("BEGIN IMMEDIATE");
    try {
      const owners = database
        .prepare(
          `SELECT principal_id, membership_id, membership_type
             FROM authority_memberships
            WHERE organization_id = ? AND membership_type = 'owner'
              AND status = 'active'
            ORDER BY membership_id`,
        )
        .all(lineage.root.organization_id) as Array<{
        readonly principal_id: string;
        readonly membership_id: string;
        readonly membership_type: "owner";
      }>;
      if (owners.length !== 1) {
        throw new Error(
          "synthetic-demo source admission requires exactly one active organization owner",
        );
      }
      const owner = owners[0]!;
      const identities = database
        .prepare(
          `SELECT login_grant.expected_email_sha256
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
            ORDER BY identity_binding.identity_binding_id`,
        )
        .all(
          lineage.root.organization_id,
          owner.principal_id,
          owner.membership_id,
        ) as Array<{ readonly expected_email_sha256: Sha256Digest }>;
      if (identities.length !== 1) {
        throw new Error(
          "synthetic-demo source admission requires one completed active initial-owner OIDC binding",
        );
      }
      const custodianDigest = identities[0]!.expected_email_sha256;
      assertCorpusOwnersMatchCustodian(corpus, custodianDigest);
      const semanticInputSha256 = canonicalSha256({
        schema_version: 1,
        kind: "echo-synthetic-demo-source-admission-semantic-input-v1",
        organization_id: lineage.root.organization_id,
        principal_id: owner.principal_id,
        membership_id: owner.membership_id,
        membership_type: owner.membership_type,
        source: {
          adapter_id: syntheticDemoMeetingSourceIdentityV1.adapter_id,
          adapter_version: syntheticDemoMeetingSourceIdentityV1.version,
          instance_id: syntheticDemoMeetingSourceIdentityV1.instance_id,
          normalizer_version: "1.0.0",
          custodian_sha256: custodianDigest,
          custodian_assurance: CUSTODIAN_ASSURANCE,
          corpus_digest: corpus.corpus_digest,
          initial_cursor: SYNTHETIC_DEMO_INITIAL_CURSOR_V1,
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
                  processor_adapter_id, processor_instance_id, processor_adapter_version,
                  processor_configuration_sha256,
                  processor_credential_reference_sha256,
                  semantic_input_sha256, admitted_at
             FROM authority_live_source_admission_v2
            WHERE singleton = 1`,
        )
        .get() as ExistingAdmissionV1 | undefined;
      if (existing !== undefined) {
        if (existing.semantic_input_sha256 !== semanticInputSha256) {
          throw new Error(
            "synthetic-demo meeting-source admission semantic input conflicts with the admitted pipeline",
          );
        }
        database.exec("COMMIT");
        return result("already_admitted", existing);
      }

      const admittedAt = (input.now ?? (() => new Date().toISOString()))();
      assertCanonicalUtcMillis(admittedAt);
      const admission: ExistingAdmissionV1 = {
        organization_id: lineage.root.organization_id,
        principal_id: owner.principal_id,
        membership_id: owner.membership_id,
        membership_type: "owner",
        source_adapter_id: syntheticDemoMeetingSourceIdentityV1.adapter_id,
        source_adapter_version: syntheticDemoMeetingSourceIdentityV1.version,
        source_adapter_instance_id: syntheticDemoMeetingSourceIdentityV1.instance_id,
        normalizer_version: "1.0.0",
        source_custodian_sha256: custodianDigest,
        source_custodian_assurance: CUSTODIAN_ASSURANCE,
        source_custodian_observed_at: admittedAt,
        source_credential_reference_sha256: corpus.corpus_digest,
        initial_cursor: SYNTHETIC_DEMO_INITIAL_CURSOR_V1,
        cutoff_at: admittedAt,
        processor_adapter_id: input.processor.adapter_id,
        processor_instance_id: input.processor.instance_id,
        processor_adapter_version: input.processor.version,
        processor_configuration_sha256: input.processor.configuration_sha256,
        processor_credential_reference_sha256:
          input.processor.credential_reference_sha256,
        semantic_input_sha256: semanticInputSha256,
        admitted_at: admittedAt,
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
