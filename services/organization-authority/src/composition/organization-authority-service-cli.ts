import { canonicalJson } from "@echo-brain/federation-protocol";
import { readPrivateAuthorityOidcClientSecret } from "../adapters/security/private-file-credentials.js";
import { readOrganizationAuthoritySetupManifest } from "./organization-authority-setup-cli.js";
import { openOrganizationAuthorityService } from "./organization-authority-composition-root.js";
import { readPersonOidcConfiguration } from "./organization-authority-person-administration-cli.js";
import {
  openStagingSyntheticPrivateDmCanaryControlV1,
  STAGING_SYNTHETIC_PRIVATE_DM_CANARY_AUTHORITY_ORIGIN_V1,
} from "./staging/slack-private-approval/staging-synthetic-private-dm-canary-control-v1.js";
import { requestStagingSyntheticPrivateDmCanaryV1 } from "./staging/slack-private-approval/staging-synthetic-private-dm-canary-client-v1.js";
import { createStagingJourneyTelemetryTransportFromEnvironmentV1 } from "./staging/observability/staging-journey-telemetry-transport-v1.js";

const USAGE =
  "usage: echo-organization-authority-serve serve " +
  "--state-dir <absolute-path> --host <127.0.0.1|::1> --port <1-65535> " +
  "--slack-signing-secret-file <absolute-path> " +
  "[--client-secret-file <absolute-path>] [--worker-interval-ms <positive-integer>]";
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
    "--slack-signing-secret-file",
    "--worker-interval-ms",
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
    "--slack-signing-secret-file",
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
 * Starts from the private, non-secret V1 onboarding manifest. It deliberately does
 * not repeat the Authority URL, OIDC configuration, PKCE key, or Slack
 * channel at the command line. Before the legacy compatibility command
 * legacy `clean-founder finalize` command, the same
 * command serves Person onboarding with an inert worker; after a restart it
 * opens the admitted source-processing chain.
 */
export async function runOrganizationAuthorityServiceCli(
  argv: readonly string[],
  io: OrganizationAuthorityServiceCliIo = PROCESS_IO,
): Promise<number> {
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
    const host = required(parsed, "--host");
    if (host !== "127.0.0.1" && host !== "::1") throw new Error(USAGE);
    const runtime = await openOrganizationAuthorityService({
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
      slack_signing_secret_file: required(
        parsed,
        "--slack-signing-secret-file",
      ),
      slack_connection_id: manifest.slack_connection_id,
      // The V1 manifest keeps its compatibility-bound legacy field name.
      slack_identity_link_channel_id: manifest.slack_approval_channel_id,
      granola_credential_file: manifest.granola_credential_file,
      granola_owner_email_file: manifest.granola_owner_email_file,
      // The V1 manifest retains its serialized compatibility field.
      openrouter_credential_file: manifest.llm_credential_file,
      on_worker_error: () => {
        io.stderr(`${LEGACY_CLEAN_LIVE_WORKER_FAILURE_EVENT_V1}\n`);
      },
      on_worker_telemetry: (event) => {
        // The lifecycle reporter constructs this closed, content-free schema.
        io.stderr(`${canonicalJson(event as never)}\n`);
      },
      on_answer_composition_failure: (event) => {
        io.stderr(
          `${canonicalJson({
            schema_version: event.schema_version,
            kind: event.kind,
            stage: event.stage,
            failure_class: event.failure_class,
            elapsed_ms: event.elapsed_ms,
            http_status: event.http_status,
            finish_reason: event.finish_reason,
          } as never)}\n`,
        );
      },
      on_private_approval_slack_rejection: (event) => {
        io.stderr(
          `${canonicalJson({
            schema_version: 1,
            kind: "echo-private-approval-slack-interaction-rejection-v1",
            stage: event.stage,
          } as never)}\n`,
        );
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
        STAGING_SYNTHETIC_PRIVATE_DM_CANARY_AUTHORITY_ORIGIN_V1 &&
      runtime.run_staging_synthetic_private_dm_canary !== undefined
        ? await openStagingSyntheticPrivateDmCanaryControlV1({
            authority_url: manifest.authority_url,
            authority_host: process.env.ECHO_CLEAN_AUTHORITY_HOST ?? "",
            release_id: process.env.ECHO_CLEAN_RELEASE_ID ?? "",
            owner_email: manifest.owner_email,
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
    const stagingJourneyTelemetry =
      manifest.authority_url ===
      STAGING_SYNTHETIC_PRIVATE_DM_CANARY_AUTHORITY_ORIGIN_V1
        ? createStagingJourneyTelemetryTransportFromEnvironmentV1(process.env, {
            write: io.stderr,
          })
        : undefined;
    await new Promise<void>((resolve) => {
      let closing: Promise<void> | undefined;
      const close = (): void => {
        stagingJourneyTelemetry?.close();
        closing ??=
          stagingCanaryControl === undefined
            ? runtime.close()
            : Promise.all([
                stagingCanaryControl.close().catch(() => undefined),
                runtime.close(),
              ]).then(() => undefined);
        void closing.finally(resolve);
      };
      process.once("SIGINT", close);
      process.once("SIGTERM", close);
    });
    return 0;
  } catch {
    io.stderr(`${LEGACY_CLEAN_LIVE_STARTUP_FAILURE_EVENT_V1}\n`);
    return 1;
  }
}
