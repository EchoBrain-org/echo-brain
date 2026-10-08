import { openGranolaPersonLiveRuntimeV1 } from './granola-person-live-runtime-v1.js';
import { AUTHORITY_RECORD_APPROVER_PROJECTORS_V1, AUTHORITY_RECORD_INPUT_CODECS_V1, authorityRecordPolicyProjectorsV1 } from './authority-record-protocols-v1.js';
import { STAGING_AUTHORITY_ORIGIN_V1 } from "@echo-brain/organization-authority-kernel/composition/staging-authority-environment-v1";
import { composePersonExternalIdentityRuntimeBundlesV1 } from "@echo-brain/organization-authority-kernel/composition/person-external-identity-runtime";
import { composeRecordApproverProjectorsV1 } from "@echo-brain/organization-record/organization-record-api-v1";
import {
  openOrganizationAuthorityRuntime,
  type OrganizationAuthorityRuntimeConfig,
  type OpenedOrganizationAuthorityRuntime,
} from "./organization-authority-runtime.js";
import { createOpenRouterDecisionProcessorBundleV1 } from "@echo-brain/provider-openrouter/openrouter-decision-processor-bundle-v1";
import { createOpenRouterAnswerCompositionGenerationBundleV1 } from "@echo-brain/provider-openrouter/openrouter-answer-composition-generation-bundle-v1";
import { createSlackPersonExternalIdentityRuntimeBundleV1 } from "@echo-brain/provider-slack-server/person-identity/slack-person-external-identity-runtime-bundle-v1";
import { HttpNangoConnectionClientV1, type NangoConnectionClientV1 } from "@echo-brain/provider-slack-server/organization-control-plane/adapters/nango/nango-connection-client-v1";
import { SlackWebAppManifestProviderV1, type SlackAppManifestProviderV1 } from "@echo-brain/provider-slack-server/organization-control-plane/adapters/slack/slack-app-manifest-provider-v1";
import { SlackWebIdentityProviderV1, type SlackIdentityProviderV1 } from "@echo-brain/provider-slack-server/organization-control-plane/adapters/slack/slack-web-identity-provider-v1";
import { createSlackBotTokenSourceV1, type SlackBotTokenSourceV1 } from "@echo-brain/provider-slack-server/organization-control-plane/application/slack-bot-token-source-v1";
import { SlackConnectionHealthV1 } from "@echo-brain/provider-slack-server/organization-control-plane/application/slack-connection-health-v1";
import { PrivateSlackApprovalCardPosterV1 } from '@echo-brain/provider-slack-server/processing/adapters/approval-delivery/slack/private-slack-approval-card-poster-v1';
import { createSlackApprovalPresenterV1 } from '@echo-brain/provider-slack-server/private-approval/slack-approval-presenter-v1';
import { openOrganizationControlDatabase, readActiveSlackConnectionV1, resolveCurrentSlackDmApprovalReviewerTargetV1 } from '@echo-brain/provider-slack-server/organization-control-plane/slack-approval-integration-v1';
import { FileOrganizationSecretStore } from "@echo-brain/organization-control-plane/security/file-secret-store";
import { join } from "node:path";
import { createStagingSyntheticPersonalMeetingProviderV1 } from "@echo-brain/provider-synthetic-demo/staging-synthetic-personal-meeting-provider-v1";
import { runStagingSyntheticPersonalCanaryV1 } from "./staging/staging-synthetic-personal-canary-v1.js";
import { assertStagingSyntheticMeetingSourceSelectionV1 } from "./staging/staging-synthetic-meeting-source-selection-v1.js";
import { openJiraPersonLiveRuntimeV1, type JiraPersonLiveConfigurationV1, type JiraPersonLiveRuntimeSeamsV1 } from './jira-person-live-runtime-v1.js';
import { openConfluencePersonLiveRuntimeV1, type ConfluencePersonLiveConfigurationV1, type ConfluencePersonLiveRuntimeSeamsV1 } from './confluence-person-live-runtime-v1.js';
import type { PersonLiveConnectorDefinitionV1 } from '../application/ports/person-context-live-runtime-v1.js';
import { JIRA_LIVE_CONNECTOR_V1, CONFLUENCE_LIVE_CONNECTOR_V1 } from './person-live-connector-registry-v1.js';
import type { OrganizationAuthorityApiRuntimeDependencies } from './organization-authority-api-runtime.js';
import type { DecisionProcessorBundleV1 } from '@echo-brain/organization-processing/ports/decision-processor-bundle-v1';

export interface OrganizationAuthorityServiceConfig
  extends Omit<
    OrganizationAuthorityRuntimeConfig,
    | "answer_composition_generation_bundle"
    | "record_policy_fact_projectors"
    | "record_input_codecs"
    | "run_staging_synthetic_canary"
  > {
  /** Staging-origin guarded: fixture meetings the owner's synthetic personal source may queue. */
  readonly staging_synthetic_meetings_directory?: string;
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
}

export interface OrganizationAuthorityServiceDependencies {
  /** Passed straight to the Authority API runtime, for example a local OIDC fake. */
  readonly api?: OrganizationAuthorityApiRuntimeDependencies;
  readonly jira_person_live_seams?: JiraPersonLiveRuntimeSeamsV1;
  /** Provider-only test seams; production reads every page through the asker's Nango grant. */
  readonly confluence_person_live_seams?: ConfluencePersonLiveRuntimeSeamsV1;
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
 * One Nango client, connection health and bot-token source serve the owner's
 * in-app setup and the Person identity flows: a token Slack rejects is marked
 * for every flow, and an install clears it.
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
 * The deployable service selects OpenRouter and Slack identity. Meetings enter
 * only through personal sources; on staging the owner's synthetic personal source
 * also serves the release canary. The shared runtime and personal live connector
 * registry remain provider-neutral.
 */
export async function openOrganizationAuthorityService(
  config: OrganizationAuthorityServiceConfig,
  dependencies: OrganizationAuthorityServiceDependencies = {},
): Promise<OpenedOrganizationAuthorityRuntime> {
  const {
    staging_synthetic_meetings_directory,
    openrouter_credential_file,
    slack_nango,
    jira_person_live,
    confluence_person_live,
    ...sharedConfig
  } = config;
  const slack = composeSlackV1({ ...sharedConfig, slack_nango }, dependencies.slack);
  const decisionProcessor = createOpenRouterDecisionProcessorBundleV1({ credential_file: openrouter_credential_file });
  // One instance for the personal appender and the Authority's readers.
  const policyProjectors = authorityRecordPolicyProjectorsV1();
  // Staging only: the owner's synthetic personal source carries the release canary and the fixture meetings.
  const stagingSynthetic = config.authority_url === STAGING_AUTHORITY_ORIGIN_V1
    ? createStagingSyntheticPersonalMeetingProviderV1(staging_synthetic_meetings_directory === undefined ? {} : {
        fixtures_directory: assertStagingSyntheticMeetingSourceSelectionV1({ authority_url: sharedConfig.authority_url, meetings_directory: staging_synthetic_meetings_directory }),
      })
    : undefined;
  let stagingCanary: ((release_id: string, signal: AbortSignal) => ReturnType<typeof runStagingSyntheticPersonalCanaryV1>) | undefined;
  const apiDependencies: OrganizationAuthorityApiRuntimeDependencies = {
    ...dependencies.api,
    person_http_runtime_factory: (sessions, resources) => {
      const existing = dependencies.api?.person_http_runtime_factory?.(sessions, resources);
      let control: ReturnType<typeof openOrganizationControlDatabase> | undefined;
      // This root selects one personal intake runtime; a caller cannot silently replace its worker.
      try {
        if (existing?.processing !== undefined) throw new Error('Personal meeting processing is already selected');
        const openedControl = openOrganizationControlDatabase(join(sharedConfig.state_directory, 'integrations.sqlite'), { fileMustExist: true }); control = openedControl;
        const poster = new PrivateSlackApprovalCardPosterV1(async options => {
          const active = readActiveSlackConnectionV1(openedControl, resources.coordinates);
          if (active === undefined) throw new Error('Slack is not connected');
          return slack.bot_token_source.botToken(active, options);
        }, { needs_reinstall: () => slack.connection_health.needsReinstall(readActiveSlackConnectionV1(openedControl, resources.coordinates)?.state_sha256),
          on_auth_failure: () => { const active = readActiveSlackConnectionV1(openedControl, resources.coordinates); if (active !== undefined) slack.connection_health.markNeedsReinstall(active.state_sha256); } });
        const granola = openGranolaPersonLiveRuntimeV1({ state_directory: sharedConfig.state_directory, sessions, resources,
          processor: dependencies.person_meeting_processor ?? decisionProcessor, projectors: policyProjectors, nango_authorization: () => slack_nango.secret_key,
          approval_core: { presenters: [core => createSlackApprovalPresenterV1({ database: resources.database, core,
            target: reviewer => {
              const active = readActiveSlackConnectionV1(openedControl, resources.coordinates); if (active === undefined) return null;
              const membership_type = resources.database.prepare('SELECT membership_type FROM authority_memberships WHERE organization_id=? AND principal_id=? AND membership_id=? AND status=\'active\'')
                .pluck().get(reviewer.organization_id, reviewer.principal_id, reviewer.membership_id);
              if (membership_type !== 'owner' && membership_type !== 'employee') return null;
              const resolved = resolveCurrentSlackDmApprovalReviewerTargetV1(openedControl, resources.coordinates, active.connection.connection_id, { ...reviewer, membership_type });
              if (resolved === undefined) return null;
              return { connection_id: active.connection.connection_id, external_identity_link_id: resolved.current_slack_identity_link.external_identity_link_id,
                external_identity_link_contract_sha256: resolved.current_slack_identity_link.external_identity_link_contract_sha256,
                slack_workspace_id: active.connection.provider_tenant_id, slack_subject_id: resolved.current_slack_identity_link.provider_subject_id, api_app_id: active.connection.provider_app_id,
                };
            }, targetCurrent: target => {
              const active = readActiveSlackConnectionV1(openedControl, resources.coordinates);
              if (active === undefined || active.connection.connection_id !== target.connection_id || active.connection.provider_tenant_id !== target.slack_workspace_id || active.connection.provider_app_id !== target.api_app_id) return false;
              return openedControl.prepare(`SELECT 1 FROM organization_external_human_link_current WHERE external_identity_link_id=? AND contract_sha256=? AND current_status='active' AND provider_subject_id=?`).get(target.external_identity_link_id, target.external_identity_link_contract_sha256, target.slack_subject_id) !== undefined;
            }, poster, projects: reviewer => resources.database.prepare(`SELECT p.project_id,p.name FROM authority_projects_v1 p JOIN authority_project_memberships_v1 m ON m.project_id=p.project_id WHERE p.organization_id=? AND p.status='active' AND m.principal_id=? AND m.membership_id=? AND m.status='active' ORDER BY p.project_id LIMIT 100`).all(reviewer.organization_id, reviewer.principal_id, reviewer.membership_id) as readonly { readonly project_id: string; readonly name: string }[] })] },
          ...(stagingSynthetic === undefined ? {} : { providers: [stagingSynthetic] }) });
        if (stagingSynthetic !== undefined) stagingCanary = (release_id, signal) => runStagingSyntheticPersonalCanaryV1({ database: resources.database, runtime: granola, release_id, signal });
        return { applications: [...(existing?.applications ?? []), ...granola.applications], processing: granola.processing,
          tools: async token => [...await (existing?.tools?.(token) ?? []), ...await granola.tools(token)],
          close() { try { granola.close(); } finally { try { openedControl.close(); } finally { existing?.close(); } } } };
      } catch (error) { control?.close(); existing?.close(); throw error; }
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
      ...AUTHORITY_RECORD_APPROVER_PROJECTORS_V1,
      ...(dependencies.api?.record_approver === undefined ? [] : [dependencies.api.record_approver]),
    ]),
    external_identity_runtime_bundle:
      dependencies.api?.external_identity_runtime_bundle ??
      composePersonExternalIdentityRuntimeBundlesV1([slack.external_identity]),
  };
  return openOrganizationAuthorityRuntime(
    {
      ...sharedConfig,
      answer_composition_generation_bundle:
        createOpenRouterAnswerCompositionGenerationBundleV1({
          credential_file: openrouter_credential_file,
        }),
      record_input_codecs: AUTHORITY_RECORD_INPUT_CODECS_V1,
      record_policy_fact_projectors: policyProjectors,
      ...(stagingSynthetic === undefined ? {} : {
        run_staging_synthetic_canary: (release_id: string, signal: AbortSignal) => {
          if (stagingCanary === undefined) throw new Error("staging synthetic canary requires the personal meeting runtime");
          return stagingCanary(release_id, signal);
        },
      }),
    },
    { api: apiDependencies },
  );
}
