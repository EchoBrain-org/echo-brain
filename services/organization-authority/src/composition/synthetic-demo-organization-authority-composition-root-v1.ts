import { openOrganizationAuthorityService } from "./organization-authority-composition-root.js";
import {
  type OpenedOrganizationAuthorityRuntime,
  type OrganizationAuthorityRuntimeConfig,
  type OrganizationAuthorityRuntimeDependencies,
} from "./organization-authority-runtime.js";

export interface SyntheticDemoOrganizationAuthorityServiceConfigV1
  extends Omit<
    OrganizationAuthorityRuntimeConfig,
    | "meeting_source_bundle"
    | "decision_processor_bundle"
    | "approval_workflow_bundle"
    | "answer_composition_generation_bundle"
    | "record_policy_fact_projectors"
    | "record_input_codecs"
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
 * Compatibility entrypoint for the old customer-demo lane. It delegates to
 * the deployable Authority composition, including its staging-only fixture
 * guard and normal telemetry-capable runtime.
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
  return openOrganizationAuthorityService(
    {
      ...runtimeConfig,
      staging_synthetic_meetings_directory: meetings_directory,
      staging_synthetic_owner_email: owner_email,
      openrouter_credential_file,
      slack_signing_secret_file,
      slack_connection_id,
      slack_identity_link_channel_id,
    },
    dependencies,
  );
}
