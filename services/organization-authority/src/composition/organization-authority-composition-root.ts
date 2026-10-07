import { openGranolaPersonLiveRuntimeV1 } from './granola-person-live-runtime-v1.js';
import { createPersonMeetingApprovalPolicyProjectorV1, projectPersonMeetingApproverV1 } from './person-meeting-approval-projection-v1.js';
import { createStagingCanaryMeetingSourceBundleV1 } from "@echo-brain/provider-synthetic-demo/staging-canary-meeting-source-v1";
import { STAGING_AUTHORITY_ORIGIN_V1 } from "@echo-brain/organization-authority-kernel/composition/staging-authority-environment-v1";
import { composePersonExternalIdentityRuntimeBundlesV1 } from "@echo-brain/organization-authority-kernel/composition/person-external-identity-runtime";
import { createRecordInputCodecRegistryV4, HUMAN_ACT_RECORD_INPUT_CODEC_V1, PERSON_MEETING_APPROVAL_RECORD_INPUT_CODEC_V1 } from "@echo-brain/organization-protocol";
import { PRIVATE_SLACK_BLOCK_APPROVAL_RECORD_INPUT_CODEC_V1 } from "@echo-brain/provider-slack-server/organization-protocol/private-slack-block-approval-record-input-v1";
import { PRIVATE_SLACK_BLOCK_APPROVAL_RECORD_INPUT_CODEC_V2, PRIVATE_SLACK_BLOCK_APPROVAL_RECORD_INPUT_CODEC_V3 } from "@echo-brain/provider-slack-server/organization-protocol/private-slack-block-approval-record-input-v2";
const RECORD_INPUT_CODECS = createRecordInputCodecRegistryV4([PERSON_MEETING_APPROVAL_RECORD_INPUT_CODEC_V1, HUMAN_ACT_RECORD_INPUT_CODEC_V1, PRIVATE_SLACK_BLOCK_APPROVAL_RECORD_INPUT_CODEC_V1, PRIVATE_SLACK_BLOCK_APPROVAL_RECORD_INPUT_CODEC_V2, PRIVATE_SLACK_BLOCK_APPROVAL_RECORD_INPUT_CODEC_V3]);
import { composeRecordApproverProjectorsV1, createRecordPolicyFactProjectorRegistryV1, createPersonPolicyFactProjectorV2 } from "@echo-brain/organization-record/organization-record-api-v1";
import { createPrivateSlackBlockApprovalPolicyProjectorV1, projectPrivateSlackBlockApprovalApproverV1 } from "@echo-brain/provider-slack-server/organization-record/adapters/record-policy-projection/slack/private-slack-block-approval-policy-projector-v1";
import { createPrivateSlackBlockApprovalPolicyProjectorV2, createPrivateSlackBlockApprovalPolicyProjectorV3, projectPrivateSlackBlockApprovalApproverV2 } from "@echo-brain/provider-slack-server/organization-record/adapters/record-policy-projection/slack/private-slack-block-approval-policy-projector-v2";
import {
  openOrganizationAuthorityRuntime,
  type OrganizationAuthorityRuntimeConfig,
  type OrganizationAuthorityRuntimeDependencies,
  type OpenedOrganizationAuthorityRuntime,
} from "./organization-authority-runtime.js";
import { createSyntheticDemoMeetingSourceBundleV1 } from "@echo-brain/provider-synthetic-demo/synthetic-demo-meeting-source-bundle-v1";
import { createOpenRouterDecisionProcessorBundleV1 } from "@echo-brain/provider-openrouter/openrouter-decision-processor-bundle-v1";
import { createOpenRouterAnswerCompositionGenerationBundleV1 } from "@echo-brain/provider-openrouter/openrouter-answer-composition-generation-bundle-v1";
import { createPrivateSlackApprovalWorkflowBundleV1 } from "@echo-brain/provider-slack-server/private-approval/private-slack-approval-workflow-bundle-v1";
import { createSlackPersonExternalIdentityRuntimeBundleV1 } from "@echo-brain/provider-slack-server/person-identity/slack-person-external-identity-runtime-bundle-v1";
import { HttpNangoConnectionClientV1, type NangoConnectionClientV1 } from "@echo-brain/provider-slack-server/organization-control-plane/adapters/nango/nango-connection-client-v1";
import { SlackWebAppManifestProviderV1, type SlackAppManifestProviderV1 } from "@echo-brain/provider-slack-server/organization-control-plane/adapters/slack/slack-app-manifest-provider-v1";
import { SlackWebIdentityProviderV1, type SlackIdentityProviderV1 } from "@echo-brain/provider-slack-server/organization-control-plane/adapters/slack/slack-web-identity-provider-v1";
import { createSlackBotTokenSourceV1, type SlackBotTokenSourceV1 } from "@echo-brain/provider-slack-server/organization-control-plane/application/slack-bot-token-source-v1";
import { SlackConnectionHealthV1 } from "@echo-brain/provider-slack-server/organization-control-plane/application/slack-connection-health-v1";
import { FileOrganizationSecretStore } from "@echo-brain/organization-control-plane/security/file-secret-store";
import { join } from "node:path";
import type { PrivateSlackApprovalInteractionRejectionStageV1 } from "@echo-brain/provider-slack-server/private-approval/private-slack-approval-interaction-protocol-v1";
import { createStagingSyntheticPersonalMeetingProviderV1 } from "@echo-brain/provider-synthetic-demo/staging-synthetic-personal-meeting-provider-v1";
import { runStagingSyntheticPersonalCanaryV1 } from "./staging/staging-synthetic-personal-canary-v1.js";
import type { PrivateSlackApprovalCardPosterV1 } from "@echo-brain/provider-slack-server/processing/adapters/approval-delivery/slack/private-slack-approval-card-poster-v1";
import { assertStagingSyntheticMeetingSourceSelectionV1 } from "./staging/staging-synthetic-meeting-source-selection-v1.js";
import { openJiraPersonLiveRuntimeV1, type JiraPersonLiveConfigurationV1, type JiraPersonLiveRuntimeSeamsV1 } from './jira-person-live-runtime-v1.js';
import { openConfluencePersonLiveRuntimeV1, type ConfluencePersonLiveConfigurationV1, type ConfluencePersonLiveRuntimeSeamsV1 } from './confluence-person-live-runtime-v1.js';
import type { PersonLiveConnectorDefinitionV1 } from '../application/ports/person-context-live-runtime-v1.js';
import { JIRA_LIVE_CONNECTOR_V1, CONFLUENCE_LIVE_CONNECTOR_V1 } from './person-live-connector-registry-v1.js';
import type { OrganizationAuthorityApiRuntimeDependencies } from './organization-authority-api-runtime.js';
import type { MeetingSourceBundleV1 } from '@echo-brain/organization-processing/ports/meeting-source-bundle-v1';
import type { DecisionProcessorBundleV1 } from '@echo-brain/organization-processing/ports/decision-processor-bundle-v1';

export interface OrganizationAuthorityServiceConfig
  extends Omit<
    OrganizationAuthorityRuntimeConfig,
    | "meeting_source_bundle"
    | "decision_processor_bundle"
    | "approval_workflow_bundle"
    | "answer_composition_generation_bundle"
    | "record_policy_fact_projectors"
    | "record_input_codecs"
    | "run_staging_synthetic_canary"
  > {
  /** Both fixture fields are required together and staging-origin guarded. */
  readonly staging_synthetic_meetings_directory?: string;
  readonly staging_synthetic_owner_email?: string;
  /** Explicit generic test fixture; deployable CLI never supplies this seam. */
  readonly synthetic_meeting_source_bundle?: MeetingSourceBundleV1;
  readonly openrouter_credential_file: string;
  /** Jira remains absent unless this explicit selection is supplied after release approval. */
  readonly jira_person_live?: JiraPersonLiveConfigurationV1;
  /** Explicit Confluence Cloud selection. It is absent unless an operator enables live page reads. */
  readonly confluence_person_live?: ConfluencePersonLiveConfigurationV1;
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
  extends Omit<OrganizationAuthorityRuntimeDependencies, "processing_adapter_overrides" | "api"> {
  readonly api?: OrganizationAuthorityApiRuntimeDependencies;
  readonly processing_adapter_overrides?: OrganizationAuthorityServiceAdapterOverrides;
  readonly jira_person_live_seams?: JiraPersonLiveRuntimeSeamsV1;
  /** Provider-only test seams; production reads every page through the asker's Nango grant. */
  readonly confluence_person_live_seams?: ConfluencePersonLiveRuntimeSeamsV1;
  /** Synthetic-test seam. Deployable selection remains staging-origin guarded. */
  readonly meeting_source_bundle?: MeetingSourceBundleV1;
  /** Provider-free test seam for the personal meeting runtime; the deployable service keeps OpenRouter. */
  readonly person_meeting_processor?: DecisionProcessorBundleV1;
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
  const nango = seams.nango ?? new HttpNangoConnectionClientV1({ ...config.slack_nango, base_url });
  const connection_health = new SlackConnectionHealthV1();
  const provider = seams.provider ?? new SlackWebIdentityProviderV1();
  // The secret store is opened on first use, after the runtime has verified its state directory.
  let tokens: SlackBotTokenSourceV1 | undefined;
  const bot_token_source: SlackBotTokenSourceV1 = {
    botToken: (connection, options) => (tokens ??= createSlackBotTokenSourceV1({
      secrets: new FileOrganizationSecretStore(join(config.state_directory, "secrets")), nango, health: connection_health,
    })).botToken(connection, options),
  };
  const external_identity = createSlackPersonExternalIdentityRuntimeBundleV1({
    provider,
    bot_token_source,
    connection_health,
    organization_setup: {
      authority_url: config.authority_url,
      nango: { client: nango, callback_url },
      manifest_provider: seams.manifest_provider ?? new SlackWebAppManifestProviderV1(),
    },
  });
  return { bot_token_source, connection_health, provider, external_identity };
}

/**
 * The deployable service selects OpenRouter and Slack while meeting intake is optional.
 * Only staging synthetic infrastructure may select an organization-level meeting source;
 * the shared runtime and personal live connector registry remain provider-neutral.
 */
export async function openOrganizationAuthorityService(
  config: OrganizationAuthorityServiceConfig,
  dependencies: OrganizationAuthorityServiceDependencies = {},
): Promise<OpenedOrganizationAuthorityRuntime> {
  const {
    staging_synthetic_meetings_directory,
    staging_synthetic_owner_email,
    synthetic_meeting_source_bundle,
    openrouter_credential_file,
    slack_nango,
    jira_person_live,
    confluence_person_live,
    on_private_approval_slack_rejection,
    ...sharedConfig
  } = config;
  const slack = composeSlackV1({ ...sharedConfig, slack_nango }, dependencies.slack);
  if (staging_synthetic_meetings_directory === undefined && staging_synthetic_owner_email !== undefined) {
    throw new Error("staging synthetic meeting source owner requires a fixture selector");
  }
  const meetingSourceBundle = dependencies.meeting_source_bundle ?? synthetic_meeting_source_bundle ?? (staging_synthetic_meetings_directory === undefined
    ? (config.authority_url === STAGING_AUTHORITY_ORIGIN_V1 ? createStagingCanaryMeetingSourceBundleV1(config.authority_url) : undefined)
    : await createSyntheticDemoMeetingSourceBundleV1({
        meetings_directory: assertStagingSyntheticMeetingSourceSelectionV1({
          authority_url: sharedConfig.authority_url,
          meetings_directory: staging_synthetic_meetings_directory,
        }),
        owner_email: staging_synthetic_owner_email ?? (() => {
          throw new Error("staging synthetic meeting source requires the admitted owner email");
        })(),
      }));
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
  const decisionProcessor = createOpenRouterDecisionProcessorBundleV1({ credential_file: openrouter_credential_file });
  const policyProjectors = createRecordPolicyFactProjectorRegistryV1([
    createPersonPolicyFactProjectorV2(), createPrivateSlackBlockApprovalPolicyProjectorV1(),
    createPrivateSlackBlockApprovalPolicyProjectorV2(), createPrivateSlackBlockApprovalPolicyProjectorV3(), createPersonMeetingApprovalPolicyProjectorV1(),
  ]);
  // Staging only: the owner's synthetic personal source carries the release canary and the fixture meetings.
  const stagingSynthetic = config.authority_url === STAGING_AUTHORITY_ORIGIN_V1
    ? createStagingSyntheticPersonalMeetingProviderV1(staging_synthetic_meetings_directory === undefined ? {} : {
        fixtures_directory: assertStagingSyntheticMeetingSourceSelectionV1({ authority_url: sharedConfig.authority_url, meetings_directory: staging_synthetic_meetings_directory }),
      })
    : undefined;
  let stagingCanary: ((signal: AbortSignal) => ReturnType<typeof runStagingSyntheticPersonalCanaryV1>) | undefined;
  const apiDependencies: OrganizationAuthorityApiRuntimeDependencies = {
    ...dependencies.api,
    person_http_runtime_factory: (sessions, resources) => {
      const existing = dependencies.api?.person_http_runtime_factory?.(sessions, resources);
      // This root selects one personal intake runtime; a caller cannot silently replace its worker.
      try {
        if (existing?.processing !== undefined) throw new Error('Personal meeting processing is already selected');
        const granola = openGranolaPersonLiveRuntimeV1({ state_directory: sharedConfig.state_directory, sessions, resources,
          processor: dependencies.person_meeting_processor ?? decisionProcessor, projectors: policyProjectors, nango_authorization: () => slack_nango.secret_key,
          ...(stagingSynthetic === undefined ? {} : { providers: [stagingSynthetic] }) });
        if (stagingSynthetic !== undefined) stagingCanary = signal => runStagingSyntheticPersonalCanaryV1({ database: resources.database, runtime: granola, signal });
        return { applications: [...(existing?.applications ?? []), ...granola.applications], processing: granola.processing,
          tools: async token => [...await (existing?.tools?.(token) ?? []), ...await granola.tools(token)],
          close() { granola.close(); existing?.close(); } };
      } catch (error) { existing?.close(); throw error; }
    },
    live_connectors: [
      ...(dependencies.api?.live_connectors ?? []),
      ...(jira_person_live === undefined ? [] : [{ ...JIRA_LIVE_CONNECTOR_V1,
        open: ((sessions, authorize_project) => openJiraPersonLiveRuntimeV1({ authorize_project, state_directory: sharedConfig.state_directory, sessions,
          configuration: jira_person_live, ...(dependencies.jira_person_live_seams === undefined ? {} : { seams: dependencies.jira_person_live_seams }),
        })) satisfies PersonLiveConnectorDefinitionV1['open'],
      }]),
      ...(confluence_person_live === undefined ? [] : [{ ...CONFLUENCE_LIVE_CONNECTOR_V1,
        open: ((sessions, authorize_project) => openConfluencePersonLiveRuntimeV1({ authorize_project, state_directory: sharedConfig.state_directory, sessions,
          configuration: confluence_person_live, ...(dependencies.confluence_person_live_seams === undefined ? {} : { seams: dependencies.confluence_person_live_seams }),
        })) satisfies PersonLiveConnectorDefinitionV1['open'],
      }]),
    ],
    record_approver: composeRecordApproverProjectorsV1([
      projectPersonMeetingApproverV1,
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
      ...(meetingSourceBundle === undefined ? {} : { meeting_source_bundle: meetingSourceBundle }),
      decision_processor_bundle: decisionProcessor,
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
      record_policy_fact_projectors: policyProjectors,
      ...(stagingSynthetic === undefined ? {} : {
        run_staging_synthetic_canary: (signal: AbortSignal) => {
          if (stagingCanary === undefined) throw new Error("staging synthetic canary requires the personal meeting runtime");
          return stagingCanary(signal);
        },
      }),
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
