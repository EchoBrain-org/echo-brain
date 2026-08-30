import {
  createRecordPolicyFactProjectorRegistryV1,
  createPersonPolicyFactProjectorV2,
  createPrivateSlackBlockApprovalPolicyProjectorV1,
} from "@echo-brain/organization-record/organization-record-api-v1";
import {
  openOrganizationAuthorityRuntime,
  type OrganizationAuthorityRuntimeConfig,
  type OrganizationAuthorityRuntimeDependencies,
  type OpenedOrganizationAuthorityRuntime,
} from "./organization-authority-runtime.js";
import { createGranolaMeetingSourceBundleV1 } from "./granola-meeting-source-bundle-v1.js";
import { createOpenRouterDecisionProcessorBundleV1 } from "./openrouter-decision-processor-bundle-v1.js";
import { createOpenRouterAnswerCompositionGenerationBundleV1 } from "./openrouter-answer-composition-generation-bundle-v1.js";
import { createPrivateSlackApprovalWorkflowBundleV1 } from "./private-slack-approval-workflow-bundle-v1.js";
import { createSlackPersonExternalIdentityRuntimeBundleV1 } from "./slack-person-external-identity-runtime-bundle-v1.js";
import type { PrivateSlackApprovalInteractionRejectionStageV1 } from "./private-slack-approval-interaction-protocol-v1.js";
import type { PrivateSlackApprovalCardPosterV1 } from "../processing/adapters/approval-delivery/slack/private-slack-approval-card-poster-v1.js";

export interface OrganizationAuthorityServiceConfig
  extends Omit<
    OrganizationAuthorityRuntimeConfig,
    | "meeting_source_bundle"
    | "decision_processor_bundle"
    | "approval_workflow_bundle"
    | "answer_composition_generation_bundle"
    | "record_policy_fact_projectors"
  > {
  readonly granola_credential_file: string;
  readonly granola_owner_email_file: string;
  readonly openrouter_credential_file: string;
  readonly slack_signing_secret_file: string;
  readonly slack_connection_id: string;
  readonly slack_identity_link_channel_id: string;
  readonly on_private_approval_slack_rejection?: (event: {
    readonly stage: PrivateSlackApprovalInteractionRejectionStageV1;
  }) => void;
}

type OrganizationAuthorityServiceAdapterOverrides = NonNullable<
  OrganizationAuthorityRuntimeDependencies["processing_adapter_overrides"]
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

export interface OrganizationAuthorityServiceDependencies
  extends Omit<OrganizationAuthorityRuntimeDependencies, "processing_adapter_overrides"> {
  readonly processing_adapter_overrides?: OrganizationAuthorityServiceAdapterOverrides;
}

/**
 * The deployable service composition root. This is the only component that
 * selects the current Granola, OpenRouter, and Slack provider bundles.
 */
export function openOrganizationAuthorityService(
  config: OrganizationAuthorityServiceConfig,
  dependencies: OrganizationAuthorityServiceDependencies = {},
): Promise<OpenedOrganizationAuthorityRuntime> {
  const {
    granola_credential_file,
    granola_owner_email_file,
    openrouter_credential_file,
    slack_signing_secret_file,
    slack_connection_id,
    slack_identity_link_channel_id,
    on_private_approval_slack_rejection,
    ...sharedConfig
  } = config;
  const sharedProcessingAdapterOverrides =
    dependencies.processing_adapter_overrides === undefined
      ? undefined
      : {
          ...(dependencies.processing_adapter_overrides.source === undefined
            ? {}
            : { source: dependencies.processing_adapter_overrides.source }),
          ...(dependencies.processing_adapter_overrides.processor === undefined
            ? {}
            : { processor: dependencies.processing_adapter_overrides.processor }),
        };
  const apiDependencies = {
    ...dependencies.api,
    external_identity_runtime:
      dependencies.api?.external_identity_runtime ??
      createSlackPersonExternalIdentityRuntimeBundleV1({
        identity_link_channel_id: slack_identity_link_channel_id,
      }),
  };
  return openOrganizationAuthorityRuntime(
    {
      ...sharedConfig,
      meeting_source_bundle: createGranolaMeetingSourceBundleV1({
        granola_credential_file,
        granola_owner_email_file,
      }),
      decision_processor_bundle: createOpenRouterDecisionProcessorBundleV1({
        credential_file: openrouter_credential_file,
      }),
      approval_workflow_bundle: createPrivateSlackApprovalWorkflowBundleV1({
        state_directory: sharedConfig.state_directory,
        signing_secret_file: slack_signing_secret_file,
        connection_id: slack_connection_id,
        ...(dependencies.processing_adapter_overrides?.private_approval_card_poster ===
        undefined
          ? {}
          : {
              poster:
                dependencies.processing_adapter_overrides.private_approval_card_poster,
            }),
        ...(on_private_approval_slack_rejection === undefined
          ? {}
          : { on_rejection: on_private_approval_slack_rejection }),
      }),
      answer_composition_generation_bundle:
        createOpenRouterAnswerCompositionGenerationBundleV1({
          credential_file: openrouter_credential_file,
        }),
      record_policy_fact_projectors:
        createRecordPolicyFactProjectorRegistryV1([
          createPersonPolicyFactProjectorV2(),
          createPrivateSlackBlockApprovalPolicyProjectorV1(),
        ]),
    },
    {
      ...dependencies,
      api: apiDependencies,
      ...(sharedProcessingAdapterOverrides === undefined
        ? {}
        : { processing_adapter_overrides: sharedProcessingAdapterOverrides }),
    },
  );
}
