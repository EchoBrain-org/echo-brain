import { canonicalJson } from "@echo-brain/federation-protocol";
import { readPrivateAuthorityOidcClientSecret } from "../adapters/security/private-file-credentials.js";
import { readCleanFounderOnboardingManifest } from "./clean-founder-cli.js";
import { openCleanLiveRuntime } from "./open-clean-live-runtime.js";
import { readCleanPersonOidcConfiguration } from "./clean-person-cli.js";

const USAGE =
  "usage: echo-organization-authority-clean-live serve " +
  "--state-dir <absolute-path> --host <127.0.0.1|::1> --port <1-65535> " +
  "[--client-secret-file <absolute-path>] [--worker-interval-ms <positive-integer>]";

interface CliIo {
  readonly stdout: (value: string) => void;
  readonly stderr: (value: string) => void;
}

const PROCESS_IO: CliIo = {
  stdout: (value) => process.stdout.write(value),
  stderr: (value) => process.stderr.write(value),
};

const CLEAN_LIVE_WORKER_FAILURE_EVENT_V1 = canonicalJson({
  schema_version: 1,
  kind: "echo-clean-live-worker-failed-v1",
} as never);

const CLEAN_LIVE_STARTUP_FAILURE_EVENT_V1 = canonicalJson({
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
  for (const required of ["--state-dir", "--host", "--port"]) {
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

/**
 * Starts from the private, non-secret founder manifest. It deliberately does
 * not repeat the Authority URL, OIDC configuration, PKCE key, or Slack
 * channel at the command line. Before `clean-founder finalize`, the same
 * command serves Person onboarding with an inert worker; after a restart it
 * opens the admitted live-only processing chain.
 */
export async function runCleanLiveCli(
  argv: readonly string[],
  io: CliIo = PROCESS_IO,
): Promise<number> {
  try {
    if (argv[0] !== "serve") throw new Error(USAGE);
    const parsed = flags(argv.slice(1));
    const stateDirectory = required(parsed, "--state-dir");
    const manifest = readCleanFounderOnboardingManifest(stateDirectory);
    const configured = readCleanPersonOidcConfiguration(
      manifest.oidc_config_path,
    );
    const secretFile = parsed["--client-secret-file"];
    if (
      (configured.client_authentication === "none") !==
      (secretFile === undefined)
    ) {
      throw new Error(
        "clean live OIDC client-secret flags do not match config",
      );
    }
    const host = required(parsed, "--host");
    if (host !== "127.0.0.1" && host !== "::1") throw new Error(USAGE);
    const runtime = await openCleanLiveRuntime({
      state_directory: stateDirectory,
      host,
      port: positiveInteger(required(parsed, "--port"), "clean live port"),
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
      slack_approval_channel_id: manifest.slack_approval_channel_id,
      granola_credential_file: manifest.granola_credential_file,
      granola_owner_email_file: manifest.granola_owner_email_file,
      llm_credential_file: manifest.llm_credential_file,
      on_worker_error: () => {
        io.stderr(`${CLEAN_LIVE_WORKER_FAILURE_EVENT_V1}\n`);
      },
      on_worker_telemetry: (event) => {
        // The lifecycle reporter constructs this closed, content-free schema.
        io.stderr(`${canonicalJson(event as never)}\n`);
      },
      on_layer4_failure: (event) => {
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
      ...(parsed["--worker-interval-ms"] === undefined
        ? {}
        : {
            worker_interval_ms: positiveInteger(
              parsed["--worker-interval-ms"]!,
              "clean live worker interval",
            ),
          }),
    });
    io.stderr(
      `${canonicalJson({
        schema_version: 1,
        kind: "echo-clean-live-runtime-ready-v1",
        processing: runtime.processing,
      } as never)}\n`,
    );
    await new Promise<void>((resolve) => {
      const close = () => void runtime.close().finally(resolve);
      process.once("SIGINT", close);
      process.once("SIGTERM", close);
    });
    return 0;
  } catch {
    io.stderr(`${CLEAN_LIVE_STARTUP_FAILURE_EVENT_V1}\n`);
    return 1;
  }
}
