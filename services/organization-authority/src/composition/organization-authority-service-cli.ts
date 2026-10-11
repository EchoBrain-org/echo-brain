import { OPENROUTER_TELEMETRY_VOCABULARY_V1 } from "@echo-brain/provider-openrouter/openrouter-telemetry-vocabulary-v1";
import { AGENTIC_TRIGGER_DEFINITIONS_V1 } from "@echo-brain/organization-authority-kernel/answer-composition/agentic-trigger-definitions-v1";
import { canonicalJson } from "@echo-brain/federation-protocol";
import { readPrivateAuthorityCredential, readPrivateAuthorityOidcClientSecret } from "@echo-brain/organization-authority-kernel/adapters/security/private-file-credentials";
import { readOrganizationAuthoritySetupManifest } from "./organization-authority-setup-cli.js";
import { openOrganizationAuthorityService } from "./organization-authority-composition-root.js";
import { readPersonOidcConfiguration } from "./organization-authority-person-administration-cli.js";
import { openStagingSyntheticPrivateDmCanaryControlV1 } from "@echo-brain/provider-slack-server/composition/staging/slack-private-approval/staging-synthetic-private-dm-canary-control-v1";
import { STAGING_AUTHORITY_ORIGIN_V1 } from "@echo-brain/organization-authority-kernel/composition/staging-authority-environment-v1";
import { requestStagingSyntheticPrivateDmCanaryV1 } from "@echo-brain/provider-slack-server/composition/staging/slack-private-approval/staging-synthetic-private-dm-canary-client-v1";
import { createJourneyTelemetryTransportFromEnvironmentV1 } from "./observability/journey-telemetry-transport-v1.js";
import { createLangSmithRuntimeV1 } from './observability/langsmith-runtime-v1.js';
import { assertStagingSyntheticMeetingSourceSelectionV1 } from "./staging/staging-synthetic-meeting-source-selection-v1.js";
import { JIRA_PERSON_LIVE_RELEASE_APPROVED_V1 } from './jira-person-live-runtime-v1.js';
import { CONFLUENCE_PERSON_LIVE_RELEASE_APPROVED_V1 } from './confluence-person-live-runtime-v1.js';
import { readStagingConnectorRehearsalSelection } from './staging-connector-rehearsal-selection.js';
import { openStagingConnectorRehearsalService } from './staging-connector-rehearsal-runtime.js';

const USAGE =
  "usage: echo-organization-authority-serve serve " +
  "--state-dir <absolute-path> --host <127.0.0.1|::1> --port <1-65535> " +
  "--nango-secret-key-file <absolute-path> --nango-integration <key> [--nango-base-url <https-origin>] " +
  "[--client-secret-file <absolute-path>] [--worker-interval-ms <positive-integer>] " +
  "[--jira-cloud-id <cloud-id> --jira-nango-integration <key>] " +
  "[--confluence-cloud-id <cloud-id> --confluence-nango-integration <key>] " +
  "[--staging-synthetic-meetings-dir <absolute-path>]";
const STAGING_CANARY_USAGE =
  "usage: echo-organization-authority-serve staging-private-dm-canary " +
  "--release-id <canonical-clean-v1-release-id>";
const RELEASE_ID = /^clean-v1-[a-z0-9][a-z0-9-]{2,63}$/;

interface OrganizationAuthorityServiceCliIo {
  readonly stdout: (value: string) => void;
  readonly stderr: (value: string) => void;
}

const PROCESS_IO: OrganizationAuthorityServiceCliIo = {
  stdout: (value) => process.stdout.write(value),
  stderr: (value) => process.stderr.write(value),
};

const LEGACY_CLEAN_LIVE_WORKER_FAILURE_EVENT_V1 = canonicalJson({
  schema_version: 1,
  kind: "echo-clean-live-worker-failed-v1",
} as never);

// Retained solely for the existing CloudWatch metric/alarm compatibility.
// New operational diagnostics query the ordered lifecycle events instead:
// phase failed, then cycle failed, then this legacy marker.

const LEGACY_CLEAN_LIVE_STARTUP_FAILURE_EVENT_V1 = canonicalJson({
  schema_version: 1,
  kind: "echo-clean-live-startup-failed-v1",
} as never);

function flags(
  argv: readonly string[],
): Readonly<Record<string, string | undefined>> {
  const allowed = new Set([
    "--state-dir",
    "--host",
    "--port",
    "--client-secret-file",
    "--nango-secret-key-file",
    "--nango-integration",
    "--nango-base-url",
    "--jira-cloud-id",
    "--jira-nango-integration",
    "--confluence-cloud-id",
    "--confluence-nango-integration",
    "--worker-interval-ms",
    "--staging-synthetic-meetings-dir",
  ]);
  const parsed: Record<string, string | undefined> = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (
      key === undefined ||
      value === undefined ||
      value.length === 0 ||
      !allowed.has(key) ||
      parsed[key] !== undefined
    ) {
      throw new Error(USAGE);
    }
    parsed[key] = value;
  }
  for (const required of [
    "--state-dir",
    "--host",
    "--port",
    "--nango-secret-key-file",
    "--nango-integration",
  ]) {
    if (parsed[required] === undefined) throw new Error(USAGE);
  }
  return Object.freeze(parsed);
}

function required(
  values: Readonly<Record<string, string | undefined>>,
  key: string,
): string {
  const value = values[key];
  if (value === undefined) throw new Error(USAGE);
  return value;
}

function positiveInteger(value: string, label: string): number {
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error(`${label} is invalid`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${label} is invalid`);
  return parsed;
}



function stagingCanaryReleaseId(argv: readonly string[]): string {
  if (
    argv.length !== 2 ||
    argv[0] !== "--release-id" ||
    argv[1] === undefined ||
    !RELEASE_ID.test(argv[1])
  ) {
    throw new Error(STAGING_CANARY_USAGE);
  }
  if (process.env.ECHO_CLEAN_RELEASE_ID !== argv[1]) {
    throw new Error("staging synthetic canary release does not match runtime");
  }
  return argv[1];
}

/**
 * Starts from the private, non-secret onboarding manifest. It deliberately does
 * not repeat the Authority URL, OIDC configuration or PKCE key at the command
 * line. The same command serves Person onboarding, the owner's in-app Slack
 * setup and personal meeting intake; meetings enter only through personal sources.
 */
export async function runOrganizationAuthorityServiceCli(
  argv: readonly string[],
  io: OrganizationAuthorityServiceCliIo = PROCESS_IO,
): Promise<number> {
  let journeyTelemetry: ReturnType<
    typeof createJourneyTelemetryTransportFromEnvironmentV1
  > | undefined;
  let langSmith: ReturnType<typeof createLangSmithRuntimeV1> | undefined;
  try {
    if (argv[0] === "staging-private-dm-canary") {
      const receipt = await requestStagingSyntheticPrivateDmCanaryV1({
        release_id: stagingCanaryReleaseId(argv.slice(1)),
      });
      io.stdout(`${canonicalJson(receipt as never)}\n`);
      return 0;
    }
    if (argv[0] !== "serve") throw new Error(USAGE);
    const parsed = flags(argv.slice(1));
    const stateDirectory = required(parsed, "--state-dir");
    const manifest = readOrganizationAuthoritySetupManifest(stateDirectory);
    const configured = readPersonOidcConfiguration(
      manifest.oidc_config_path,
    );
    const secretFile = parsed["--client-secret-file"];
    if (
      (configured.client_authentication === "none") !==
      (secretFile === undefined)
    ) {
      throw new Error(
        "organization authority service OIDC client-secret flags do not match config",
      );
    }
    const jiraRequested = [parsed['--jira-cloud-id'], parsed['--jira-nango-integration']].some(value => value !== undefined);
    if (jiraRequested && (!JIRA_PERSON_LIVE_RELEASE_APPROVED_V1 || parsed['--jira-cloud-id'] === undefined || parsed['--jira-nango-integration'] === undefined || (parsed['--nango-base-url'] !== undefined && parsed['--nango-base-url'] !== 'https://api.nango.dev'))) {
      throw new Error('Jira live selection requires accepted ADR-0026, one configured cloud site and Nango Cloud');
    }
    const confluenceRequested = [parsed['--confluence-cloud-id'], parsed['--confluence-nango-integration']].some(value => value !== undefined);
    if (confluenceRequested && (!CONFLUENCE_PERSON_LIVE_RELEASE_APPROVED_V1 || parsed['--confluence-cloud-id'] === undefined || parsed['--confluence-nango-integration'] === undefined || (parsed['--nango-base-url'] !== undefined && parsed['--nango-base-url'] !== 'https://api.nango.dev'))) {
      throw new Error('Confluence live selection requires its accepted release gate, one configured cloud site and Nango Cloud');
    }
    // Read once into memory; the startup-failure event below never carries it.
    const slackNango = {
      ...(parsed["--nango-base-url"] === undefined ? {} : { base_url: parsed["--nango-base-url"] }),
      secret_key: readPrivateAuthorityCredential(`file:${required(parsed, "--nango-secret-key-file")}`),
      integration_key: required(parsed, "--nango-integration"),
    };
    const host = required(parsed, "--host");
    if (host !== "127.0.0.1" && host !== "::1") throw new Error(USAGE);
    // Agentic Ask is the only Ask (ADR-0022). ECHO_AGENTIC_ASK_V1 is still
    // written by older release records and profiles; it no longer has an effect.
    const agenticAskSmallScopeShortcut =
      process.env.ECHO_AGENTIC_ASK_SMALL_SCOPE_SHORTCUT === "true";
    const environmentSyntheticMeetingsDirectory =
      process.env.ECHO_STAGING_SYNTHETIC_MEETINGS_DIR;
    const requestedSyntheticMeetingsDirectory =
      parsed["--staging-synthetic-meetings-dir"] ??
      (environmentSyntheticMeetingsDirectory === ""
        ? undefined
        : environmentSyntheticMeetingsDirectory);
    if (
      parsed["--staging-synthetic-meetings-dir"] !== undefined &&
      environmentSyntheticMeetingsDirectory !== undefined &&
      environmentSyntheticMeetingsDirectory !== "" &&
      environmentSyntheticMeetingsDirectory !==
        parsed["--staging-synthetic-meetings-dir"]
    ) {
      throw new Error("staging synthetic meetings directory differs between command and environment");
    }
    const stagingSyntheticMeetingsDirectory =
      requestedSyntheticMeetingsDirectory === undefined
        ? undefined
        : assertStagingSyntheticMeetingSourceSelectionV1({
            authority_url: manifest.authority_url,
            meetings_directory: requestedSyntheticMeetingsDirectory,
          });
    const connectorRehearsal = readStagingConnectorRehearsalSelection({
      state_directory: stateDirectory, authority_url: manifest.authority_url, environment: process.env,
    });
    const stagingJiraAsk = process.env.ECHO_STAGING_JIRA_ASK_V1;
    if (stagingJiraAsk !== undefined && !['', 'false', 'true'].includes(stagingJiraAsk)) {
      throw new Error('Staging Jira Ask selection is invalid');
    }
    if (stagingJiraAsk === 'true' && (connectorRehearsal === undefined || !JIRA_PERSON_LIVE_RELEASE_APPROVED_V1)) {
      throw new Error('Staging Jira Ask requires the fixed staging connector profile');
    }
    const stagingConfluenceAsk = process.env.ECHO_STAGING_CONFLUENCE_ASK_V1;
    if (stagingConfluenceAsk !== undefined && !['', 'false', 'true'].includes(stagingConfluenceAsk)) {
      throw new Error('Staging Confluence Ask selection is invalid');
    }
    if (stagingConfluenceAsk === 'true' && (connectorRehearsal === undefined ||
        !CONFLUENCE_PERSON_LIVE_RELEASE_APPROVED_V1 ||
        (parsed['--nango-base-url'] !== undefined && parsed['--nango-base-url'] !== 'https://api.nango.dev') ||
        (parsed['--confluence-cloud-id'] !== undefined && parsed['--confluence-cloud-id'] !== connectorRehearsal.profile.jira.cloud_id) ||
        (parsed['--confluence-nango-integration'] !== undefined && parsed['--confluence-nango-integration'] !== 'confluence'))) {
      throw new Error('Staging Confluence Ask requires the fixed staging cloud site and the confluence Nango Cloud integration');
    }
    if (connectorRehearsal !== undefined && stagingSyntheticMeetingsDirectory !== undefined) {
      throw new Error('Staging connector rehearsal cannot select another synthetic source profile');
    }
    const stagingResearchEval = process.env.ECHO_STAGING_RESEARCH_EVAL_V1;
    if (stagingResearchEval !== undefined && !['', 'false', 'true'].includes(stagingResearchEval)) {
      throw new Error('Staging research evaluation selection is invalid');
    }
    if (stagingResearchEval === 'true' && manifest.authority_url !== STAGING_AUTHORITY_ORIGIN_V1) {
      throw new Error('Research evaluation is available only on the staging Authority');
    }
    const jiraCloudId = parsed['--jira-cloud-id'] ?? (stagingJiraAsk === 'true' ? connectorRehearsal?.profile.jira.cloud_id : undefined);
    const jiraIntegration = parsed['--jira-nango-integration'] ?? (stagingJiraAsk === 'true' ? connectorRehearsal?.profile.jira.integration_key : undefined);
    // Staging shares only the validated Atlassian site, never Jira's project or grant.
    // Other deployments select Confluence with both explicit profile-owned flags.
    const confluenceCloudId = parsed['--confluence-cloud-id'] ?? (stagingConfluenceAsk === 'true' ? connectorRehearsal?.profile.jira.cloud_id : undefined);
    const confluenceIntegration = parsed['--confluence-nango-integration'] ?? (stagingConfluenceAsk === 'true' ? 'confluence' : undefined);
    const telemetryEnvironment = manifest.authority_url === STAGING_AUTHORITY_ORIGIN_V1 ? "staging" : "production";
    const telemetryVocabulary = { ...OPENROUTER_TELEMETRY_VOCABULARY_V1, triggers: AGENTIC_TRIGGER_DEFINITIONS_V1.map(definition => definition.name) };
    journeyTelemetry = createJourneyTelemetryTransportFromEnvironmentV1(telemetryEnvironment, process.env, {
      write: io.stderr,
    }, telemetryVocabulary);
    langSmith = createLangSmithRuntimeV1({
      path: process.env.ECHO_STAGING_LANGSMITH_TRACING_FILE,
      authority_url: manifest.authority_url, release_sha: process.env.ECHO_SOURCE_SHA ?? 'unknown',
      existing: journeyTelemetry.enabled ? journeyTelemetry.core_runtime : undefined, vocabulary: telemetryVocabulary,
      write: io.stderr,
    });
    const openService: typeof openOrganizationAuthorityService = connectorRehearsal === undefined
      ? openOrganizationAuthorityService
      : (config, dependencies) => openStagingConnectorRehearsalService(config, connectorRehearsal, dependencies);
    const runtime = await openService({
      ...(langSmith.scope === undefined ? {} : { core_runtime_observation: langSmith.scope }),
      state_directory: stateDirectory,
      host,
      port: positiveInteger(
        required(parsed, "--port"),
        "organization authority service port",
      ),
      authority_url: manifest.authority_url,
      oidc: configured.configuration,
      client_authentication:
        configured.client_authentication === "none"
          ? { method: "none" as const }
          : {
              method: configured.client_authentication,
              client_secret: readPrivateAuthorityOidcClientSecret(
                `file:${secretFile!}`,
              ),
            },
      pkce_key_file: manifest.pkce_key_file,
      ...(agenticAskSmallScopeShortcut
        ? { agentic_ask_v1_small_scope_shortcut: true }
        : {}),
      ...(stagingResearchEval === 'true' ? { staging_research_eval_v1: true as const } : {}),
      slack_nango: slackNango,
      ...(jiraCloudId === undefined ? {} : { jira_person_live: {
        enabled: true as const,
        cloud_id: jiraCloudId,
        integration_id: jiraIntegration!,
        nango_authorization: () => slackNango.secret_key,
      } }),
      ...(confluenceCloudId === undefined ? {} : { confluence_person_live: {
        enabled: true as const,
        cloud_id: confluenceCloudId,
        integration_id: confluenceIntegration!,
        nango_authorization: () => slackNango.secret_key,
      } }),
      // The manifest retains its serialized compatibility field.
      openrouter_credential_file: manifest.llm_credential_file,
      ...(stagingSyntheticMeetingsDirectory === undefined
        ? {}
        : {
            staging_synthetic_meetings_directory:
              stagingSyntheticMeetingsDirectory,
          }),
      on_worker_error: () => {
        io.stderr(`${LEGACY_CLEAN_LIVE_WORKER_FAILURE_EVENT_V1}\n`);
      },
      on_worker_telemetry: (event) => {
        // The lifecycle reporter constructs this closed, content-free schema.
        io.stderr(`${canonicalJson(event as never)}\n`);
      },
      ...(parsed["--worker-interval-ms"] === undefined
        ? {}
        : {
            worker_interval_ms: positiveInteger(
              parsed["--worker-interval-ms"]!,
              "organization authority service worker interval",
            ),
          }),
    });
    const stagingCanaryControl =
      manifest.authority_url ===
        STAGING_AUTHORITY_ORIGIN_V1 &&
      runtime.run_staging_synthetic_canary !== undefined
        ? await openStagingSyntheticPrivateDmCanaryControlV1({
            authority_url: manifest.authority_url,
            authority_host: process.env.ECHO_CLEAN_AUTHORITY_HOST ?? "",
            release_id: process.env.ECHO_CLEAN_RELEASE_ID ?? "",
            runtime,
          }).catch(async (error: unknown) => {
            await runtime.close();
            throw error;
          })
        : undefined;
    io.stderr(
      `${canonicalJson({
        schema_version: 1,
        kind: "echo-clean-live-runtime-ready-v1",
        processing: runtime.processing,
      } as never)}\n`,
    );
    // Liveness is deliberately activated only after openOrganizationAuthorityService
    // and the optional staging canary control have both completed successfully.
    // A failed or still-pending runtime open must not make staging look alive.
    journeyTelemetry.start();
    langSmith.start();
    await new Promise<void>((resolve) => {
      let closing: Promise<void> | undefined;
      const close = (): void => {
        closing ??=
          stagingCanaryControl === undefined
            ? runtime.close().finally(async () => { await langSmith?.close(); journeyTelemetry?.close(); })
            : Promise.all([
                stagingCanaryControl.close().catch(() => undefined),
                runtime.close(),
              ])
                .then(() => undefined)
                .finally(async () => { await langSmith?.close(); journeyTelemetry?.close(); });
        void closing.finally(resolve);
      };
      process.once("SIGINT", close);
      process.once("SIGTERM", close);
    });
    return 0;
  } catch {
    await langSmith?.close();
    journeyTelemetry?.close();
    io.stderr(`${LEGACY_CLEAN_LIVE_STARTUP_FAILURE_EVENT_V1}\n`);
    return 1;
  }
}
