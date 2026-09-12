import { canonicalSha256 } from "@echo-brain/federation-protocol";
import { readPrivateAuthorityGranolaOrganizationCredential, readPrivateAuthorityGranolaOwnerEmail } from "./granola-private-credentials-v1.js";
import { personLoginGrantExpectedEmailSha256 } from "@echo-brain/organization-authority-kernel/domain/person-email-binding";
import { createGranolaMeetingSourceAdapter } from "./source/meeting-source-adapter.js";
import type { AdapterConfig } from "@echo-brain/organization-processing/core/contracts/adapter";
import type { AdmittedMeetingProcessingAdmissionV1 } from "@echo-brain/organization-processing/admitted-meeting-processing/meeting-processing-cycle-v1";
import type { AdmittedMeetingProcessingCommitmentsV1 } from "@echo-brain/organization-processing/admitted-meeting-processing/admitted-meeting-processing-commitments";
import { granolaAdmittedMeetingSourceCursorPolicyV1 } from "./granola-admitted-meeting-source-cursor-policy-v1.js";
import type { MeetingSourceBundleV1 } from "@echo-brain/organization-processing/ports/meeting-source-bundle-v1";

function fixedGranolaConfig(
  instanceId: string,
  ownerEmail: string,
  credentialReference: string,
): AdapterConfig {
  return {
    adapter_id: "granola",
    instance_id: instanceId,
    credential_ref: credentialReference,
    settings: { page_size: 1, owner_email: ownerEmail },
  };
}

function assertAdapter(
  adapter: {
    validateConfig(config: AdapterConfig): {
      ok: boolean;
      errors: readonly string[];
    };
  },
  config: AdapterConfig,
): void {
  const validation = adapter.validateConfig(config);
  if (!validation.ok) {
    throw new Error(
      `Granola meeting source configuration is invalid: ${validation.errors.join("; ")}`,
    );
  }
}

function granolaCredentialReferenceSha256(reference: string): string {
  return canonicalSha256({
    schema_version: 1,
    kind: "echo-clean-granola-source-credential-reference-v1",
    reference,
  });
}

/** Owns all Granola-specific construction and admission commitments. */
export function createGranolaMeetingSourceBundleV1(input: {
  readonly granola_credential_file: string;
  readonly granola_owner_email_file: string;
}): MeetingSourceBundleV1 {
  const credentialReference = `file:${input.granola_credential_file}`;
  let committedOwnerEmail: string | undefined;
  return Object.freeze({
    create_source(admission: AdmittedMeetingProcessingAdmissionV1) {
      const ownerEmail = committedOwnerEmail;
      if (ownerEmail === undefined) {
        throw new Error(
          "Granola meeting source commitments were not checked",
        );
      }
      const credential = readPrivateAuthorityGranolaOrganizationCredential(
        credentialReference,
      );
      const adapterConfig = fixedGranolaConfig(
        admission.source.instance_id,
        ownerEmail,
        credentialReference,
      );
      const created = createGranolaMeetingSourceAdapter(adapterConfig, {
        credentialResolver: (reference) =>
          reference === credentialReference ? credential : undefined,
      });
      assertAdapter(created, adapterConfig);
      return created;
    },
    assert_admission_commitments(
      commitments: AdmittedMeetingProcessingCommitmentsV1,
    ) {
      if (
        commitments.source.adapter_id !== "granola" ||
        commitments.source.credential_reference_sha256 !==
          granolaCredentialReferenceSha256(credentialReference)
      ) {
        throw new Error(
          "Granola meeting source credential reference differs from the admitted commitment",
        );
      }
      const ownerEmail = readPrivateAuthorityGranolaOwnerEmail(
        `file:${input.granola_owner_email_file}`,
      );
      if (
        commitments.source.custodian_sha256 !==
        personLoginGrantExpectedEmailSha256(ownerEmail)
      ) {
        throw new Error(
          "Granola meeting source owner differs from the admitted custodian commitment",
        );
      }
      committedOwnerEmail = ownerEmail;
    },
    source_cursor_policy: granolaAdmittedMeetingSourceCursorPolicyV1,
  });
}
