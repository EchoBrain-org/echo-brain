import { createRecordInputCodecRegistryV4, HUMAN_ACT_RECORD_INPUT_CODEC_V1, PRIVATE_SLACK_BLOCK_APPROVAL_RECORD_INPUT_CODEC_V1 } from "@echo-brain/organization-protocol";
const RECORD_INPUT_CODECS = createRecordInputCodecRegistryV4([HUMAN_ACT_RECORD_INPUT_CODEC_V1, PRIVATE_SLACK_BLOCK_APPROVAL_RECORD_INPUT_CODEC_V1]);
import {
  createRecordPolicyFactProjectorRegistryV1,
  createPersonPolicyFactProjectorV2,
  createPrivateSlackBlockApprovalPolicyProjectorV1,
  projectPrivateSlackBlockApprovalApproverV1,
} from "@echo-brain/organization-record/organization-record-api-v1";
import {
  openOrganizationAuthorityRuntime,
  type OrganizationAuthorityRuntimeConfig,
  type OrganizationAuthorityRuntimeDependencies,
  type OpenedOrganizationAuthorityRuntime,
} from "./organization-authority-runtime.js";
import { createGranolaMeetingSourceBundleV1 } from "./providers/granola/granola-meeting-source-bundle-v1.js";
import { createSyntheticDemoMeetingSourceBundleV1 } from "./providers/synthetic-demo/synthetic-demo-meeting-source-bundle-v1.js";
import { createOpenRouterDecisionProcessorBundleV1 } from "./providers/openrouter/openrouter-decision-processor-bundle-v1.js";
import { createOpenRouterAnswerCompositionGenerationBundleV1 } from "./providers/openrouter/openrouter-answer-composition-generation-bundle-v1.js";
import { createPrivateSlackApprovalWorkflowBundleV1 } from "./providers/slack/private-approval/private-slack-approval-workflow-bundle-v1.js";
import { createSlackPersonExternalIdentityRuntimeBundleV1 } from "./providers/slack/person-identity/slack-person-external-identity-runtime-bundle-v1.js";
import { createSlackBrowserIdentityProvider } from "../adapters/oidc/slack-browser-identity-provider.js";
import type { PrivateSlackApprovalInteractionRejectionStageV1 } from "./providers/slack/private-approval/private-slack-approval-interaction-protocol-v1.js";
import { runStagingSyntheticPrivateDmCanaryV1 } from "./staging/slack-private-approval/staging-synthetic-private-dm-canary-v1.js";
import type { PrivateSlackApprovalCardPosterV1 } from "../processing/adapters/approval-delivery/slack/private-slack-approval-card-poster-v1.js";
import { assertStagingSyntheticMeetingSourceSelectionV1 } from "./staging/staging-synthetic-meeting-source-selection-v1.js";

export interface OrganizationAuthorityServiceConfig
  extends Omit<
    OrganizationAuthorityRuntimeConfig,
    | "meeting_source_bundle"
    | "decision_processor_bundle"
    | "approval_workflow_bundle"
    | "answer_composition_generation_bundle"
    | "record_policy_fact_projectors"
    | "record_input_codecs"
  > {
  readonly granola_credential_file?: string;
  readonly granola_owner_email_file?: string;
  /** Both fixture fields are required together and staging-origin guarded. */
  readonly staging_synthetic_meetings_directory?: string;
  readonly staging_synthetic_owner_email?: string;
  readonly openrouter_credential_file: string;
  readonly slack_signing_secret_file: string;
  readonly slack_connection_id: string;
  readonly slack_identity_link_channel_id: string;
  /** Optional browser OAuth configuration. It stays in process memory only. */
  readonly slack_browser_oauth?: {
    readonly client_id: string;
    readonly client_secret: string;
    readonly redirect_uri: string;
  };
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
export async function openOrganizationAuthorityService(
  config: OrganizationAuthorityServiceConfig,
  dependencies: OrganizationAuthorityServiceDependencies = {},
): Promise<OpenedOrganizationAuthorityRuntime> {
  const {
    granola_credential_file,
    granola_owner_email_file,
    staging_synthetic_meetings_directory,
    staging_synthetic_owner_email,
    openrouter_credential_file,
    slack_signing_secret_file,
    slack_connection_id,
    slack_identity_link_channel_id,
    slack_browser_oauth,
    on_private_approval_slack_rejection,
    ...sharedConfig
  } = config;
  let meetingSourceBundle;
  if (staging_synthetic_meetings_directory === undefined) {
    if (
      granola_credential_file === undefined ||
      granola_owner_email_file === undefined ||
      staging_synthetic_owner_email !== undefined
    ) {
      throw new Error("organization Authority service requires the committed Granola source");
    }
    meetingSourceBundle = createGranolaMeetingSourceBundleV1({
      granola_credential_file,
      granola_owner_email_file,
    });
  } else {
    if (staging_synthetic_owner_email === undefined) {
      throw new Error("staging synthetic meeting source requires the admitted owner email");
    }
    meetingSourceBundle = await createSyntheticDemoMeetingSourceBundleV1({
      meetings_directory: assertStagingSyntheticMeetingSourceSelectionV1({
        authority_url: sharedConfig.authority_url,
        meetings_directory: staging_synthetic_meetings_directory,
      }),
      owner_email: staging_synthetic_owner_email,
    });
  }
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
    record_approver:
      dependencies.api?.record_approver ?? projectPrivateSlackBlockApprovalApproverV1,
    external_identity_runtime_bundle:
      dependencies.api?.external_identity_runtime_bundle ??
      createSlackPersonExternalIdentityRuntimeBundleV1({
        identity_link_channel_id: slack_identity_link_channel_id,
        ...(slack_browser_oauth === undefined
          ? {}
          : {
              browser_provider:
                createSlackBrowserIdentityProvider(slack_browser_oauth),
            }),
      }),
  };
  return openOrganizationAuthorityRuntime(
    {
      ...sharedConfig,
      meeting_source_bundle: meetingSourceBundle,
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
      record_input_codecs: RECORD_INPUT_CODECS,
      record_policy_fact_projectors:
        createRecordPolicyFactProjectorRegistryV1([
          createPersonPolicyFactProjectorV2(),
          createPrivateSlackBlockApprovalPolicyProjectorV1(),
        ]),
      run_staging_synthetic_private_dm_canary: (input) =>
        runStagingSyntheticPrivateDmCanaryV1(input),
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
