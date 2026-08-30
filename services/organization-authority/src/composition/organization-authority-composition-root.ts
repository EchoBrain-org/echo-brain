import {
  createRecordPolicyFactProjectorRegistryV1,
  createPersonPolicyFactProjectorV2,
  createPrivateSlackBlockApprovalPolicyProjectorV1,
} from "@echo-brain/organization-record/new-lineage-v1";
import {
  openOrganizationAuthorityRuntime,
  type OrganizationAuthorityRuntimeConfig,
  type OrganizationAuthorityRuntimeDependencies,
  type OpenedOrganizationAuthorityRuntime,
} from "./organization-authority-runtime.js";
import { createGranolaMeetingSourceRuntimeBundleV1 } from "./granola-meeting-source-runtime-v1.js";
import { createOpenRouterDecisionProcessorRuntimeBundleV1 } from "./openrouter-decision-processor-runtime-bundle-v1.js";
import { createOpenRouterAnswerCompositionRuntimeBundleV1 } from "./openrouter-answer-composition-runtime-v1.js";
import { createPrivateSlackApprovalRuntimeBundleV1 } from "./private-slack-approval-runtime-v1.js";
import { createSlackPersonExternalIdentityRuntimeBundleV1 } from "./slack-person-external-identity-runtime.js";
import type { PrivateSlackApprovalInteractionRejectionStageV1 } from "./private-slack-approval-interaction-v1.js";
import type { PrivateSlackApprovalCardPosterV1 } from "../processing/adapters/approval-delivery/slack/private-slack-approval-card-poster-v1.js";

export interface OrganizationAuthorityServiceConfig
  extends Omit<
    OrganizationAuthorityRuntimeConfig,
    | "source_runtime"
    | "processor_runtime"
    | "approval_runtime"
    | "answer_composition_runtime"
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
  OrganizationAuthorityRuntimeDependencies["live_adapters"]
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
  extends Omit<OrganizationAuthorityRuntimeDependencies, "live_adapters"> {
  readonly live_adapters?: OrganizationAuthorityServiceAdapterOverrides;
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
      source_runtime: createGranolaMeetingSourceRuntimeBundleV1({
        granola_credential_file,
        granola_owner_email_file,
      }),
      processor_runtime: createOpenRouterDecisionProcessorRuntimeBundleV1({
        credential_file: openrouter_credential_file,
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
      ...(sharedLiveAdapters === undefined
        ? {}
        : { live_adapters: sharedLiveAdapters }),
    },
  );
}
