import { composePersonExternalIdentityRuntimeBundlesV1 } from "@echo-brain/organization-authority-kernel/composition/person-external-identity-runtime";
import { createRecordInputCodecRegistryV4, HUMAN_ACT_RECORD_INPUT_CODEC_V1 } from "@echo-brain/organization-protocol";
import { PRIVATE_SLACK_BLOCK_APPROVAL_RECORD_INPUT_CODEC_V1 } from "@echo-brain/provider-slack-server/organization-protocol/private-slack-block-approval-record-input-v1";
import { PRIVATE_SLACK_BLOCK_APPROVAL_RECORD_INPUT_CODEC_V2, PRIVATE_SLACK_BLOCK_APPROVAL_RECORD_INPUT_CODEC_V3 } from "@echo-brain/provider-slack-server/organization-protocol/private-slack-block-approval-record-input-v2";
const RECORD_INPUT_CODECS = createRecordInputCodecRegistryV4([HUMAN_ACT_RECORD_INPUT_CODEC_V1, PRIVATE_SLACK_BLOCK_APPROVAL_RECORD_INPUT_CODEC_V1, PRIVATE_SLACK_BLOCK_APPROVAL_RECORD_INPUT_CODEC_V2, PRIVATE_SLACK_BLOCK_APPROVAL_RECORD_INPUT_CODEC_V3]);
import { composeRecordApproverProjectorsV1, createRecordPolicyFactProjectorRegistryV1, createPersonPolicyFactProjectorV2 } from "@echo-brain/organization-record/organization-record-api-v1";
import { createPrivateSlackBlockApprovalPolicyProjectorV1, projectPrivateSlackBlockApprovalApproverV1 } from "@echo-brain/provider-slack-server/organization-record/adapters/record-policy-projection/slack/private-slack-block-approval-policy-projector-v1";
import { createPrivateSlackBlockApprovalPolicyProjectorV2, createPrivateSlackBlockApprovalPolicyProjectorV3, projectPrivateSlackBlockApprovalApproverV2 } from "@echo-brain/provider-slack-server/organization-record/adapters/record-policy-projection/slack/private-slack-block-approval-policy-projector-v2";
import {
  openOrganizationAuthorityRuntime,
  type OrganizationAuthorityRuntimeConfig,
  type OrganizationAuthorityRuntimeDependencies,
  type OpenedOrganizationAuthorityRuntime,
} from "./organization-authority-runtime.js";
import { createGranolaMeetingSourceBundleV1 } from "@echo-brain/provider-granola/granola-meeting-source-bundle-v1";
import { createSyntheticDemoMeetingSourceBundleV1 } from "@echo-brain/provider-synthetic-demo/synthetic-demo-meeting-source-bundle-v1";
import { createOpenRouterDecisionProcessorBundleV1 } from "@echo-brain/provider-openrouter/openrouter-decision-processor-bundle-v1";
import { createOpenRouterAnswerCompositionGenerationBundleV1 } from "@echo-brain/provider-openrouter/openrouter-answer-composition-generation-bundle-v1";
import { createPrivateSlackApprovalWorkflowBundleV1 } from "@echo-brain/provider-slack-server/private-approval/private-slack-approval-workflow-bundle-v1";
import { createSlackPersonExternalIdentityRuntimeBundleV1 } from "@echo-brain/provider-slack-server/person-identity/slack-person-external-identity-runtime-bundle-v1";
import { HttpNangoConnectionClientV1, type NangoConnectionClientV1 } from "@echo-brain/provider-slack-server/organization-control-plane/adapters/nango/nango-connection-client-v1";
import { SlackWebAppManifestProviderV1, type SlackAppManifestProviderV1 } from "@echo-brain/provider-slack-server/organization-control-plane/adapters/slack/slack-app-manifest-provider-v1";
import type { SlackIdentityProviderV1 } from "@echo-brain/provider-slack-server/organization-control-plane/adapters/slack/slack-web-identity-provider-v1";
import { createSlackBotTokenSourceV1, type SlackBotTokenSourceV1 } from "@echo-brain/provider-slack-server/organization-control-plane/application/slack-bot-token-source-v1";
import { SlackConnectionHealthV1 } from "@echo-brain/provider-slack-server/organization-control-plane/application/slack-connection-health-v1";
import { FileOrganizationSecretStore } from "@echo-brain/organization-control-plane/security/file-secret-store";
import { join } from "node:path";
import type { PrivateSlackApprovalInteractionRejectionStageV1 } from "@echo-brain/provider-slack-server/private-approval/private-slack-approval-interaction-protocol-v1";
import { runStagingSyntheticPrivateDmCanaryV1 } from "@echo-brain/provider-slack-server/composition/staging/slack-private-approval/staging-synthetic-private-dm-canary-v1";
import type { PrivateSlackApprovalCardPosterV1 } from "@echo-brain/provider-slack-server/processing/adapters/approval-delivery/slack/private-slack-approval-card-poster-v1";
import { assertStagingSyntheticMeetingSourceSelectionV1 } from "./staging/staging-synthetic-meeting-source-selection-v1.js";
import { openJiraPersonLiveRuntimeV1, type JiraPersonLiveConfigurationV1, type JiraPersonLiveRuntimeSeamsV1 } from './jira-person-live-runtime-v1.js';
import type { PersonTicketLiveRuntimeFactoryV1 } from '../application/ports/person-ticket-live-runtime-v1.js';

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
  /** Jira remains absent unless this explicit selection is supplied after release approval. */
  readonly jira_person_live?: JiraPersonLiveConfigurationV1;
  /** Nango holds the organization's Slack connection. The key stays in process memory only. */
  readonly slack_nango: {
    /** An https origin; defaults to Nango Cloud. */
    readonly base_url?: string;
    readonly secret_key: string;
    readonly integration_key: string;
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
  readonly jira_person_live_seams?: JiraPersonLiveRuntimeSeamsV1;
  /** Test seams for Nango's and Slack's HTTP APIs. */
  readonly slack?: {
    readonly nango?: NangoConnectionClientV1;
    readonly manifest_provider?: SlackAppManifestProviderV1;
    readonly provider?: SlackIdentityProviderV1;
  };
}

/**
 * One Nango client, connection health and bot-token source serve both the
 * owner's in-app setup with the Person identity flows and the approval lane:
 * a token Slack rejects in one is marked for the other, and an install clears it.
 */
function composeSlackV1(
  config: Pick<OrganizationAuthorityServiceConfig, "state_directory" | "authority_url" | "slack_nango">,
  seams: OrganizationAuthorityServiceDependencies["slack"] = {},
) {
  const base_url = config.slack_nango.base_url ?? "https://api.nango.dev";
  const callback_url = new URL("/oauth/callback", base_url).href;
  const nango = seams.nango ?? new HttpNangoConnectionClientV1({ ...config.slack_nango, base_url, callback_url });
  const connection_health = new SlackConnectionHealthV1();
  // The secret store is opened on first use, after the runtime has verified its state directory.
  let tokens: SlackBotTokenSourceV1 | undefined;
  const bot_token_source: SlackBotTokenSourceV1 = {
    botToken: (connection, options) => (tokens ??= createSlackBotTokenSourceV1({
      secrets: new FileOrganizationSecretStore(join(config.state_directory, "secrets")), nango,
    })).botToken(connection, options),
  };
  const external_identity = createSlackPersonExternalIdentityRuntimeBundleV1({
    ...(seams.provider === undefined ? {} : { provider: seams.provider }),
    bot_token_source,
    connection_health,
    organization_setup: {
      authority_url: config.authority_url,
      nango: { client: nango, callback_url },
      manifest_provider: seams.manifest_provider ?? new SlackWebAppManifestProviderV1(),
    },
  });
  return { bot_token_source, connection_health, external_identity };
}

/**
 * The deployable service selects the fixed Granola/OpenRouter/Slack profile.
 * The stopped-state setup CLI selects the same profile; the shared runtime
 * remains provider-neutral. Changing a profile requires both bootstrap selections.
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
    slack_nango,
    jira_person_live,
    on_private_approval_slack_rejection,
    ...sharedConfig
  } = config;
  const slack = composeSlackV1({ ...sharedConfig, slack_nango }, dependencies.slack);
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
    ...(jira_person_live === undefined ? {} : { ticket_live_runtime_factory: ((sessions) => openJiraPersonLiveRuntimeV1({ state_directory: sharedConfig.state_directory, sessions, configuration: jira_person_live, ...(dependencies.jira_person_live_seams === undefined ? {} : { seams: dependencies.jira_person_live_seams }) })) satisfies PersonTicketLiveRuntimeFactoryV1 }),
    record_approver: composeRecordApproverProjectorsV1([
      projectPrivateSlackBlockApprovalApproverV1,
      projectPrivateSlackBlockApprovalApproverV2,
      ...(dependencies.api?.record_approver === undefined ? [] : [dependencies.api.record_approver]),
    ]),
    external_identity_runtime_bundle:
      dependencies.api?.external_identity_runtime_bundle ??
      composePersonExternalIdentityRuntimeBundlesV1([slack.external_identity]),
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
        bot_token_source: slack.bot_token_source,
        connection_health: slack.connection_health,
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
          createPrivateSlackBlockApprovalPolicyProjectorV2(),
          createPrivateSlackBlockApprovalPolicyProjectorV3(),
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
