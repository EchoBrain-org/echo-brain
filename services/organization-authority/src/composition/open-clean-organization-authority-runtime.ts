import {
  readPrivateAuthorityGranolaOrganizationCredential,
  readPrivateAuthorityGranolaOwnerEmail,
} from "../adapters/security/private-file-credentials.js";
import { createGranolaMeetingSourceAdapter } from "../processing/adapters/meeting-sources/granola/index.js";
import type { AdapterConfig } from "../processing/core/contracts/adapter.js";
import type { CleanLiveSourceAdmissionV1 } from "../processing/clean-v1/live-only-source-cycle.js";
import type { CleanLiveSourceRuntimeCommitmentsV1 } from "../processing/clean-v1/live-source-runtime-commitments.js";
import { canonicalSha256 } from "@echo-brain/federation-protocol";
import {
  createRecordPolicyFactProjectorRegistryV1,
  createPersonPolicyFactProjectorV2,
  createPrivateSlackBlockApprovalPolicyProjectorV1,
} from "@echo-brain/organization-record/new-lineage-v1";
import { personLoginGrantExpectedEmailSha256 } from "../domain/person-email-binding.js";
import {
  openCleanLiveRuntime,
  type CleanLiveSourceRuntimeBundleV1,
  type OpenCleanLiveRuntimeConfig,
  type OpenCleanLiveRuntimeDependencies,
  type OpenedCleanLiveRuntime,
} from "./open-clean-live-runtime.js";
import { granolaLiveSourceBoundaryV1 } from "./granola-live-source-boundary-v1.js";
import { createOpenRouterCleanLiveProcessorRuntimeBundleV1 } from "./openrouter-clean-live-processor-runtime.js";
import { createOpenRouterAnswerCompositionRuntimeBundleV1 } from "./openrouter-answer-composition-runtime-v1.js";
import { createPrivateSlackApprovalRuntimeBundleV1 } from "./private-slack-approval-runtime-v1.js";
import { createCleanSlackPersonExternalIdentityRuntimeBundleV1 } from "./clean-slack-person-external-identity-runtime.js";
import type { PrivateSlackApprovalInteractionRejectionStageV1 } from "./private-slack-approval-interaction-v1.js";
import type { PrivateSlackApprovalCardPosterV1 } from "../processing/clean-v1/private-slack-approval-card-poster-v1.js";

export interface OpenCleanOrganizationAuthorityRuntimeConfig
  extends Omit<
    OpenCleanLiveRuntimeConfig,
    | "source_runtime"
    | "processor_runtime"
    | "approval_runtime"
    | "answer_composition_runtime"
    | "record_policy_fact_projectors"
  > {
  readonly granola_credential_file: string;
  readonly granola_owner_email_file: string;
  readonly llm_credential_file: string;
  readonly slack_signing_secret_file: string;
  readonly slack_connection_id: string;
  readonly slack_identity_link_channel_id: string;
  readonly on_private_approval_slack_rejection?: (event: {
    readonly stage: PrivateSlackApprovalInteractionRejectionStageV1;
  }) => void;
}

type CleanOrganizationAuthorityRuntimeAdapterOverrides = NonNullable<
  OpenCleanLiveRuntimeDependencies["live_adapters"]
> & {
  readonly private_approval_card_poster?: Pick<
    PrivateSlackApprovalCardPosterV1,
    | "openDirectMessage"
    | "postMarker"
    | "reconcileMarker"
    | "publish"
    | "tombstone"
    | "renderTerminal"
  >;
};

export interface OpenCleanOrganizationAuthorityRuntimeDependencies
  extends Omit<OpenCleanLiveRuntimeDependencies, "live_adapters"> {
  readonly live_adapters?: CleanOrganizationAuthorityRuntimeAdapterOverrides;
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

/**
 * Opens the deployable Authority runtime with the currently selected Granola,
 * OpenRouter, and Slack adapters. Provider-neutral orchestration remains in
 * `openCleanLiveRuntime`.
 */
export function openCleanOrganizationAuthorityRuntime(
  config: OpenCleanOrganizationAuthorityRuntimeConfig,
  dependencies: OpenCleanOrganizationAuthorityRuntimeDependencies = {},
): Promise<OpenedCleanLiveRuntime> {
  const {
    granola_credential_file,
    granola_owner_email_file,
    llm_credential_file,
    slack_signing_secret_file,
    slack_connection_id,
    slack_identity_link_channel_id,
    on_private_approval_slack_rejection,
    ...sharedConfig
  } = config;
  const sharedLiveAdapters =
    dependencies.live_adapters === undefined
      ? undefined
      : {
          ...(dependencies.live_adapters.source === undefined
            ? {}
            : { source: dependencies.live_adapters.source }),
          ...(dependencies.live_adapters.processor === undefined
            ? {}
            : { processor: dependencies.live_adapters.processor }),
        };
  const personDependencies = {
    ...dependencies.person,
    external_identity_runtime:
      dependencies.person?.external_identity_runtime ??
      createCleanSlackPersonExternalIdentityRuntimeBundleV1({
        identity_link_channel_id: slack_identity_link_channel_id,
      }),
  };
  return openCleanLiveRuntime(
    {
      ...sharedConfig,
      source_runtime: createGranolaLiveSourceRuntimeBundleV1({
        granola_credential_file,
        granola_owner_email_file,
      }),
      processor_runtime: createOpenRouterCleanLiveProcessorRuntimeBundleV1({
        credential_file: llm_credential_file,
      }),
      approval_runtime: createPrivateSlackApprovalRuntimeBundleV1({
        state_directory: sharedConfig.state_directory,
        signing_secret_file: slack_signing_secret_file,
        connection_id: slack_connection_id,
        ...(dependencies.live_adapters?.private_approval_card_poster ===
        undefined
          ? {}
          : {
              poster:
                dependencies.live_adapters.private_approval_card_poster,
            }),
        ...(on_private_approval_slack_rejection === undefined
          ? {}
          : { on_rejection: on_private_approval_slack_rejection }),
      }),
      answer_composition_runtime:
        createOpenRouterAnswerCompositionRuntimeBundleV1({
        credential_file: llm_credential_file,
        }),
      record_policy_fact_projectors:
        createRecordPolicyFactProjectorRegistryV1([
          createPersonPolicyFactProjectorV2(),
          createPrivateSlackBlockApprovalPolicyProjectorV1(),
        ]),
    },
    {
      ...dependencies,
      person: personDependencies,
      ...(sharedLiveAdapters === undefined
        ? {}
        : { live_adapters: sharedLiveAdapters }),
    },
  );
}
