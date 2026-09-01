import {
  createPersonPolicyFactProjectorV2,
  createPrivateSlackBlockApprovalPolicyProjectorV1,
  createRecordPolicyFactProjectorRegistryV1,
} from "@echo-brain/organization-record/organization-record-api-v1";
import {
  openOrganizationAuthorityRuntime,
  type OpenedOrganizationAuthorityRuntime,
  type OrganizationAuthorityRuntimeConfig,
  type OrganizationAuthorityRuntimeDependencies,
} from "./organization-authority-runtime.js";
import { createOpenRouterAnswerCompositionGenerationBundleV1 } from "./providers/openrouter/openrouter-answer-composition-generation-bundle-v1.js";
import { createOpenRouterDecisionProcessorBundleV1 } from "./providers/openrouter/openrouter-decision-processor-bundle-v1.js";
import { createPrivateSlackApprovalWorkflowBundleV1 } from "./providers/slack/private-approval/private-slack-approval-workflow-bundle-v1.js";
import { createSlackPersonExternalIdentityRuntimeBundleV1 } from "./providers/slack/person-identity/slack-person-external-identity-runtime-bundle-v1.js";
import { createSyntheticDemoMeetingSourceBundleV1 } from "./providers/synthetic-demo/synthetic-demo-meeting-source-bundle-v1.js";

export interface SyntheticDemoOrganizationAuthorityServiceConfigV1
  extends Omit<
    OrganizationAuthorityRuntimeConfig,
    | "meeting_source_bundle"
    | "decision_processor_bundle"
    | "approval_workflow_bundle"
    | "answer_composition_generation_bundle"
    | "record_policy_fact_projectors"
    | "run_staging_synthetic_private_dm_canary"
  > {
  /** A demo-only state directory. It is never a Granola service state directory. */
  readonly meetings_directory: string;
  readonly owner_email: string;
  readonly openrouter_credential_file: string;
  readonly slack_signing_secret_file: string;
  readonly slack_connection_id: string;
  readonly slack_identity_link_channel_id: string;
}

/**
 * The one static customer-demo composition. It changes only the admitted
 * source. Extraction, approval, identity, publication, and retrieval remain
 * the selected production bundles.
 */
export async function openSyntheticDemoOrganizationAuthorityServiceV1(
  config: SyntheticDemoOrganizationAuthorityServiceConfigV1,
  dependencies: OrganizationAuthorityRuntimeDependencies = {},
): Promise<OpenedOrganizationAuthorityRuntime> {
  const {
    meetings_directory,
    owner_email,
    openrouter_credential_file,
    slack_signing_secret_file,
    slack_connection_id,
    slack_identity_link_channel_id,
    ...runtimeConfig
  } = config;
  const meetingSourceBundle = await createSyntheticDemoMeetingSourceBundleV1({
    meetings_directory,
    owner_email,
  });

  return openOrganizationAuthorityRuntime(
    {
      ...runtimeConfig,
      meeting_source_bundle: meetingSourceBundle,
      decision_processor_bundle: createOpenRouterDecisionProcessorBundleV1({
        credential_file: openrouter_credential_file,
      }),
      approval_workflow_bundle: createPrivateSlackApprovalWorkflowBundleV1({
        state_directory: runtimeConfig.state_directory,
        signing_secret_file: slack_signing_secret_file,
        connection_id: slack_connection_id,
      }),
      answer_composition_generation_bundle:
        createOpenRouterAnswerCompositionGenerationBundleV1({
          credential_file: openrouter_credential_file,
        }),
      record_policy_fact_projectors: createRecordPolicyFactProjectorRegistryV1([
        createPersonPolicyFactProjectorV2(),
        createPrivateSlackBlockApprovalPolicyProjectorV1(),
      ]),
    },
    {
      ...dependencies,
      api: {
        ...dependencies.api,
        external_identity_runtime_bundle:
          dependencies.api?.external_identity_runtime_bundle ??
          createSlackPersonExternalIdentityRuntimeBundleV1({
            identity_link_channel_id: slack_identity_link_channel_id,
          }),
      },
    },
  );
}
