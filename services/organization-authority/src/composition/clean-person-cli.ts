import { readFileSync } from "node:fs";
import { canonicalJson } from "@echo-brain/federation-protocol";
import { validateOrganizationAuthorityOrigin } from "@echo-brain/organization-api";
import type { PersonSessionOidcConfiguration } from "../application/ports/person-session-runtime.js";
import {
  readPrivateAuthorityOidcClientSecret,
  readPrivateAuthorityPersonSessionPkceKey,
} from "../adapters/security/private-file-credentials.js";
import {
  initializeCleanPersonCredentials,
  issueCleanPersonInvitation,
} from "./clean-person-onboarding.js";
import { startOrganizationAuthorityApiRuntime } from "./organization-authority-api-runtime.js";
import { createSlackPersonExternalIdentityRuntimeBundleV1 } from "./slack-person-external-identity-runtime.js";

const USAGE = `usage:
  echo-organization-authority-clean-person credentials-init --state-dir <absolute-path>
  echo-organization-authority-clean-person invite --state-dir <absolute-path> --oidc-config <absolute-json-path> --pkce-key-file <absolute-path> --membership-id <mem-id> --expected-email <email> --authority-url <https-origin> --out <absolute-path>
  echo-organization-authority-clean-person serve --state-dir <absolute-path> --host <127.0.0.1|::1> --port <1-65535> --authority-url <https-origin> --oidc-config <absolute-json-path> --pkce-key-file <absolute-path> [--client-secret-file <absolute-path>] [--slack-approval-channel-id <channel-id>]`;

interface CliIo {
  stdout(value: string): void;
  stderr(value: string): void;
}
const PROCESS_IO: CliIo = {
  stdout: (value) => process.stdout.write(value),
  stderr: (value) => process.stderr.write(value),
};

function flags(
  values: readonly string[],
  accepted: readonly string[],
): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (
      key === undefined ||
      value === undefined ||
      !accepted.includes(key) ||
      result[key] !== undefined ||
      value.length === 0
    )
      throw new Error(USAGE);
    result[key] = value;
  }
  return result;
}

function required(
  values: Readonly<Record<string, string>>,
  key: string,
): string {
  const value = values[key];
  if (value === undefined) throw new Error(USAGE);
  return value;
}

export function readCleanPersonOidcConfiguration(path: string): {
  configuration: PersonSessionOidcConfiguration;
  client_authentication: "none" | "client_secret_basic" | "client_secret_post";
} {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    throw new Error("clean Person OIDC config must be readable JSON");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("clean Person OIDC config is invalid");
  const record = value as Record<string, unknown>;
  const keys = [
    "issuer",
    "client_id",
    "redirect_uri",
    "tenant",
    "id_token_algorithms",
    "client_authentication",
  ];
  if (Object.keys(record).sort().join(",") !== keys.sort().join(","))
    throw new Error("clean Person OIDC config has an unexpected shape");
  const method = record.client_authentication;
  if (
    method !== "none" &&
    method !== "client_secret_basic" &&
    method !== "client_secret_post"
  )
    throw new Error("clean Person OIDC client authentication is invalid");
  return {
    configuration: {
      issuer: record.issuer as string,
      client_id: record.client_id as string,
      redirect_uri: record.redirect_uri as string,
      tenant: record.tenant as PersonSessionOidcConfiguration["tenant"],
      id_token_algorithms: record.id_token_algorithms as readonly string[],
    },
    client_authentication: method,
  };
}

function privateReference(path: string): string {
  return `file:${path}`;
}

export function assertCleanPersonAuthorityCallback(
  origin: string,
  configuration: PersonSessionOidcConfiguration,
): void {
  validateOrganizationAuthorityOrigin(origin);
  if (configuration.redirect_uri !== `${origin}/v2/session/oidc/callback`) {
    throw new Error(
      "clean Person OIDC redirect URI must be the Authority callback at --authority-url",
    );
  }
}

export async function runCleanPersonCli(
  argv: readonly string[],
  io: CliIo = PROCESS_IO,
): Promise<number> {
  const command = argv[0];
  if (command === "credentials-init") {
    const parsed = flags(argv.slice(1), ["--state-dir"]);
    if (Object.keys(parsed).length !== 1) throw new Error(USAGE);
    io.stdout(
      `${canonicalJson(initializeCleanPersonCredentials({ state_directory: required(parsed, "--state-dir") }) as never)}\n`,
    );
    return 0;
  }
  if (command === "invite") {
    const parsed = flags(argv.slice(1), [
      "--state-dir",
      "--oidc-config",
      "--pkce-key-file",
      "--membership-id",
      "--expected-email",
      "--authority-url",
      "--out",
    ]);
    if (Object.keys(parsed).length !== 7) throw new Error(USAGE);
    const configured = readCleanPersonOidcConfiguration(
      required(parsed, "--oidc-config"),
    );
    const authorityUrl = required(parsed, "--authority-url");
    assertCleanPersonAuthorityCallback(authorityUrl, configured.configuration);
    const result = issueCleanPersonInvitation({
      state_directory: required(parsed, "--state-dir"),
      oidc: configured.configuration,
      pkce_sealing_key: readPrivateAuthorityPersonSessionPkceKey(
        privateReference(required(parsed, "--pkce-key-file")),
      ),
      membership_id: required(parsed, "--membership-id"),
      expected_email: required(parsed, "--expected-email"),
      authority_url: authorityUrl,
      output_path: required(parsed, "--out"),
    });
    io.stdout(
      `${canonicalJson({ schema_version: 1, kind: "echo-clean-person-invitation-issued-v1", ...result } as never)}\n`,
    );
    return 0;
  }
  if (command === "serve") {
    const parsed = flags(argv.slice(1), [
      "--state-dir",
      "--host",
      "--port",
      "--authority-url",
      "--oidc-config",
      "--pkce-key-file",
      "--client-secret-file",
      "--slack-approval-channel-id",
    ]);
    const configured = readCleanPersonOidcConfiguration(
      required(parsed, "--oidc-config"),
    );
    const authorityUrl = required(parsed, "--authority-url");
    assertCleanPersonAuthorityCallback(authorityUrl, configured.configuration);
    const secretFile = parsed["--client-secret-file"];
    if (
      (configured.client_authentication === "none") !==
      (secretFile === undefined)
    )
      throw new Error(
        "clean Person OIDC client-secret flags do not match config",
      );
    const port = Number(required(parsed, "--port"));
    const host = required(parsed, "--host");
    const stateDirectory = required(parsed, "--state-dir");
    const runtime = await startOrganizationAuthorityApiRuntime({
      state_directory: stateDirectory,
      host:
        host === "127.0.0.1" || host === "::1"
          ? host
          : (() => {
              throw new Error(USAGE);
            })(),
      port,
      authority_url: authorityUrl,
      oidc: configured.configuration,
      client_authentication:
        configured.client_authentication === "none"
          ? { method: "none" }
          : {
              method: configured.client_authentication,
              client_secret: readPrivateAuthorityOidcClientSecret(
                privateReference(secretFile!),
              ),
            },
      pkce_sealing_key: readPrivateAuthorityPersonSessionPkceKey(
        privateReference(required(parsed, "--pkce-key-file")),
      ),
    }, {
      external_identity_runtime:
        createSlackPersonExternalIdentityRuntimeBundleV1({
          // The public V1 flag keeps its compatibility-bound legacy name.
          identity_link_channel_id: parsed["--slack-approval-channel-id"],
        }),
    });
    io.stderr(
      `${canonicalJson({ schema_version: 1, kind: "echo-clean-person-runtime-ready-v1", host: runtime.address.address, port: runtime.address.port } as never)}\n`,
    );
    await new Promise<void>((resolve) => {
      const close = () => {
        void runtime.close().finally(resolve);
      };
      process.once("SIGINT", close);
      process.once("SIGTERM", close);
    });
    return 0;
  }
  throw new Error(USAGE);
}
