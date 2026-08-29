import {
  readPrivateAuthorityGranolaOrganizationCredential,
  readPrivateAuthorityGranolaOwnerEmail,
} from "../adapters/security/private-file-credentials.js";
import { createGranolaMeetingSourceAdapter } from "../processing/adapters/meeting-sources/granola/index.js";
import type { AdapterConfig } from "../processing/core/contracts/adapter.js";
import type { CleanLiveSourceAdmissionV1 } from "../processing/clean-v1/live-only-source-cycle.js";
import type { CleanLiveSourceRuntimeCommitmentsV1 } from "../processing/clean-v1/live-source-runtime-commitments.js";
import { canonicalSha256 } from "@echo-brain/federation-protocol";
import { personLoginGrantExpectedEmailSha256 } from "../domain/person-email-binding.js";
import {
  openCleanLiveRuntime,
  type CleanLiveSourceRuntimeBundleV1,
  type OpenCleanLiveRuntimeConfig,
  type OpenCleanLiveRuntimeDependencies,
  type OpenedCleanLiveRuntime,
} from "./open-clean-live-runtime.js";
import { granolaLiveSourceBoundaryV1 } from "./granola-live-source-boundary-v1.js";

export interface OpenCleanGranolaLiveRuntimeConfig
  extends Omit<OpenCleanLiveRuntimeConfig, "source_runtime"> {
  readonly granola_credential_file: string;
  readonly granola_owner_email_file: string;
}

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
      `Granola clean runtime configuration is invalid: ${validation.errors.join("; ")}`,
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

/**
 * Contains all V1 Granola construction and admission selection. The shared
 * runtime sees only the provider-neutral bundle below.
 */
export function createGranolaLiveSourceRuntimeBundleV1(input: {
  readonly granola_credential_file: string;
  readonly granola_owner_email_file: string;
}): CleanLiveSourceRuntimeBundleV1 {
  const credentialReference = `file:${input.granola_credential_file}`;
  let committedOwnerEmail: string | undefined;
  return Object.freeze({
    create_source(admission: CleanLiveSourceAdmissionV1) {
      const ownerEmail = committedOwnerEmail;
      if (ownerEmail === undefined) {
        throw new Error(
          "Granola clean runtime source commitments were not checked",
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
    assert_runtime_commitments(
      commitments: CleanLiveSourceRuntimeCommitmentsV1,
    ) {
      if (
        commitments.source.adapter_id !== "granola" ||
        commitments.source.credential_reference_sha256 !==
          granolaCredentialReferenceSha256(credentialReference)
      ) {
        throw new Error(
          "Granola clean runtime source credential reference differs from the admitted commitment",
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
          "Granola clean runtime owner differs from the admitted custodian commitment",
        );
      }
      committedOwnerEmail = ownerEmail;
    },
    source_boundary: granolaLiveSourceBoundaryV1,
  });
}

/** Maintains the current CLI's Granola-backed public runtime behavior. */
export function openCleanGranolaLiveRuntime(
  config: OpenCleanGranolaLiveRuntimeConfig,
  dependencies: OpenCleanLiveRuntimeDependencies = {},
): Promise<OpenedCleanLiveRuntime> {
  return openCleanLiveRuntime(
    {
      ...config,
      source_runtime: createGranolaLiveSourceRuntimeBundleV1(config),
    },
    dependencies,
  );
}
