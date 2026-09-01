import { isAbsolute, resolve } from "node:path";
import { canonicalJson } from "@echo-brain/federation-protocol";
import { readPrivateAuthorityOidcClientSecret } from "../adapters/security/private-file-credentials.js";
import { admitSyntheticDemoMeetingSource } from "./providers/synthetic-demo/synthetic-demo-meeting-source-admission.js";
import { createOpenRouterDecisionProcessorAdmissionCommitmentV1 } from "./providers/openrouter/openrouter-decision-processor-admission-commitment.js";
import { readPersonOidcConfiguration } from "./organization-authority-person-administration-cli.js";
import { openSyntheticDemoOrganizationAuthorityServiceV1 } from "./synthetic-demo-organization-authority-composition-root-v1.js";
import { readOrganizationAuthoritySetupManifest } from "./organization-authority-setup-cli.js";

const USAGE = `usage:
  echo-synthetic-demo admit --state-dir <absolute-path> --meetings-dir <absolute-path>
  echo-synthetic-demo serve --state-dir <absolute-path> --meetings-dir <absolute-path> --host <127.0.0.1|::1> --port <1-65535> --slack-signing-secret-file <absolute-path> [--client-secret-file <absolute-path>] [--worker-interval-ms <positive-integer>]`;
// The demo source is admitted against the shared production processor identity.
const ESTABLISHED_OPENROUTER_PROCESSOR_INSTANCE_ID_V1 = "founder-llm-v1";

export interface SyntheticDemoOrganizationAuthorityCliIoV1 {
  readonly stdout: (value: string) => void;
  readonly stderr: (value: string) => void;
}

const PROCESS_IO: SyntheticDemoOrganizationAuthorityCliIoV1 = {
  stdout: (value) => process.stdout.write(value),
  stderr: (value) => process.stderr.write(value),
};

function absolutePath(value: string | undefined): string {
  if (
    value === undefined ||
    value.length === 0 ||
    value.includes("\0") ||
    !isAbsolute(value) ||
    resolve(value) !== value
  ) {
    throw new Error(USAGE);
  }
  return value;
}

function parseFlags(
  argv: readonly string[],
  allowed: readonly string[],
  required: readonly string[],
): Readonly<Record<string, string | undefined>> {
  const parsed: Record<string, string | undefined> = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (
      key === undefined ||
      value === undefined ||
      value.length === 0 ||
      !allowed.includes(key) ||
      parsed[key] !== undefined
    ) {
      throw new Error(USAGE);
    }
    parsed[key] = value;
  }
  if (required.some((key) => parsed[key] === undefined)) throw new Error(USAGE);
  return Object.freeze(parsed);
}

function required(
  flags: Readonly<Record<string, string | undefined>>,
  key: string,
): string {
  const value = flags[key];
  if (value === undefined) throw new Error(USAGE);
  return value;
}

function positiveInteger(value: string): number {
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error(USAGE);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(USAGE);
  return parsed;
}

async function runAdmission(
  argv: readonly string[],
  io: SyntheticDemoOrganizationAuthorityCliIoV1,
): Promise<number> {
  const flags = parseFlags(
    argv,
    ["--state-dir", "--meetings-dir"],
    ["--state-dir", "--meetings-dir"],
  );
  const stateDirectory = absolutePath(required(flags, "--state-dir"));
  const manifest = readOrganizationAuthoritySetupManifest(stateDirectory);
  const result = await admitSyntheticDemoMeetingSource({
    state_directory: stateDirectory,
    meetings_directory: absolutePath(required(flags, "--meetings-dir")),
    processor: createOpenRouterDecisionProcessorAdmissionCommitmentV1({
      instance_id: ESTABLISHED_OPENROUTER_PROCESSOR_INSTANCE_ID_V1,
      credential_reference: `file:${manifest.llm_credential_file}`,
    }),
  });
  io.stdout(`${canonicalJson(result as never)}\n`);
  return 0;
}

async function runService(
  argv: readonly string[],
  io: SyntheticDemoOrganizationAuthorityCliIoV1,
): Promise<number> {
  const flags = parseFlags(
    argv,
    [
      "--state-dir",
      "--meetings-dir",
      "--host",
      "--port",
      "--slack-signing-secret-file",
      "--client-secret-file",
      "--worker-interval-ms",
    ],
    [
      "--state-dir",
      "--meetings-dir",
      "--host",
      "--port",
      "--slack-signing-secret-file",
    ],
  );
  const stateDirectory = absolutePath(required(flags, "--state-dir"));
  const manifest = readOrganizationAuthoritySetupManifest(stateDirectory);
  const oidc = readPersonOidcConfiguration(manifest.oidc_config_path);
  const secretFile = flags["--client-secret-file"];
  if ((oidc.client_authentication === "none") !== (secretFile === undefined)) {
    throw new Error("synthetic-demo OIDC client-secret flags do not match config");
  }
  const host = required(flags, "--host");
  if (host !== "127.0.0.1" && host !== "::1") throw new Error(USAGE);
  const runtime = await openSyntheticDemoOrganizationAuthorityServiceV1({
    state_directory: stateDirectory,
    meetings_directory: absolutePath(required(flags, "--meetings-dir")),
    host,
    port: positiveInteger(required(flags, "--port")),
    authority_url: manifest.authority_url,
    oidc: oidc.configuration,
    client_authentication:
      oidc.client_authentication === "none"
        ? { method: "none" as const }
        : {
            method: oidc.client_authentication,
            client_secret: readPrivateAuthorityOidcClientSecret(
              `file:${absolutePath(secretFile)}`,
            ),
          },
    pkce_key_file: manifest.pkce_key_file,
    openrouter_credential_file: manifest.llm_credential_file,
    owner_email: manifest.owner_email,
    slack_signing_secret_file: absolutePath(
      required(flags, "--slack-signing-secret-file"),
    ),
    slack_connection_id: manifest.slack_connection_id,
    slack_identity_link_channel_id: manifest.slack_approval_channel_id,
    ...(flags["--worker-interval-ms"] === undefined
      ? {}
      : { worker_interval_ms: positiveInteger(flags["--worker-interval-ms"]!) }),
  });
  io.stderr(
    `${canonicalJson({
      schema_version: 1,
      kind: "echo-synthetic-demo-runtime-ready-v1",
      processing: runtime.processing,
    } as never)}\n`,
  );
  await new Promise<void>((resolve) => {
    let closing: Promise<void> | undefined;
    const close = (): void => {
      closing ??= runtime.close();
      void closing.finally(resolve);
    };
    process.once("SIGINT", close);
    process.once("SIGTERM", close);
  });
  return 0;
}

/** The synthetic demo has a single admitted source and a single service shape. */
export async function runSyntheticDemoOrganizationAuthorityCliV1(
  argv: readonly string[],
  io: SyntheticDemoOrganizationAuthorityCliIoV1 = PROCESS_IO,
): Promise<number> {
  try {
    if (argv[0] === "admit") return await runAdmission(argv.slice(1), io);
    if (argv[0] === "serve") return await runService(argv.slice(1), io);
    throw new Error(USAGE);
  } catch {
    io.stderr(`${USAGE}\n`);
    return 1;
  }
}
