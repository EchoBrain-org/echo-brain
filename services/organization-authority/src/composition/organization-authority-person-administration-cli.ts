import { readFileSync } from "node:fs";
import { canonicalJson } from "@echo-brain/federation-protocol";
import { validateOrganizationAuthorityOrigin } from "@echo-brain/organization-api";
import type { PersonSessionOidcConfiguration } from "@echo-brain/organization-authority-kernel/application/ports/person-session-dependencies";
import { readPrivateAuthorityPersonSessionPkceKey } from "@echo-brain/organization-authority-kernel/adapters/security/private-file-credentials";
import {
  initializePersonSessionCredentials,
  issuePersonOnboardingInvitation,
} from "./person-onboarding-service.js";

const USAGE = `usage:
  credentials-init --state-dir <absolute-path>
  invite --state-dir <absolute-path> --oidc-config <absolute-json-path> --pkce-key-file <absolute-path> --membership-id <mem-id> --expected-email <email> --authority-url <https-origin> --out <absolute-path>`;

interface OrganizationAuthorityPersonAdministrationCliIo {
  stdout(value: string): void;
  stderr(value: string): void;
}
const PROCESS_IO: OrganizationAuthorityPersonAdministrationCliIo = {
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

export function readPersonOidcConfiguration(path: string): {
  configuration: PersonSessionOidcConfiguration;
  client_authentication: "none" | "client_secret_basic" | "client_secret_post";
} {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    throw new Error("Person OIDC config must be readable JSON");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("Person OIDC config is invalid");
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
    throw new Error("Person OIDC config has an unexpected shape");
  const method = record.client_authentication;
  if (
    method !== "none" &&
    method !== "client_secret_basic" &&
    method !== "client_secret_post"
  )
    throw new Error("Person OIDC client authentication is invalid");
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

export function assertPersonAuthorityCallback(
  origin: string,
  configuration: PersonSessionOidcConfiguration,
): void {
  validateOrganizationAuthorityOrigin(origin);
  if (configuration.redirect_uri !== `${origin}/v2/session/oidc/callback`) {
    throw new Error(
      "Person OIDC redirect URI must be the Organization Authority callback at --authority-url",
    );
  }
}

export async function runOrganizationAuthorityPersonAdministrationCli(
  argv: readonly string[],
  io: OrganizationAuthorityPersonAdministrationCliIo = PROCESS_IO,
): Promise<number> {
  const command = argv[0];
  if (command === "credentials-init") {
    const parsed = flags(argv.slice(1), ["--state-dir"]);
    if (Object.keys(parsed).length !== 1) throw new Error(USAGE);
    io.stdout(
      `${canonicalJson(initializePersonSessionCredentials({ state_directory: required(parsed, "--state-dir") }) as never)}\n`,
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
    const configured = readPersonOidcConfiguration(
      required(parsed, "--oidc-config"),
    );
    const authorityUrl = required(parsed, "--authority-url");
    assertPersonAuthorityCallback(authorityUrl, configured.configuration);
    const result = issuePersonOnboardingInvitation({
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
  throw new Error(USAGE);
}
