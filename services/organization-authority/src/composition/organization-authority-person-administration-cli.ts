/**
 * In-process Person setup helpers for the setup and service commands. No
 * command-line program is built from this module.
 */
import { readFileSync } from "node:fs";
import { validateOrganizationAuthorityOrigin } from "@echo-brain/organization-api";
import type { PersonSessionOidcConfiguration } from "@echo-brain/organization-authority-kernel/application/ports/person-session-dependencies";
import { readPrivateAuthorityPersonSessionPkceKey } from "@echo-brain/organization-authority-kernel/adapters/security/private-file-credentials";
import { issuePersonOnboardingInvitation } from "./person-onboarding-service.js";

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

export interface SetupOwnerInvitationInput {
  readonly state_directory: string;
  readonly oidc_config_path: string;
  readonly pkce_key_file: string;
  readonly membership_id: string;
  readonly expected_email: string;
  readonly authority_url: string;
  readonly output_path: string;
}

/** Issues the owner's one-time invitation from setup's private file paths. */
export function issueSetupOwnerInvitation(input: SetupOwnerInvitationInput): void {
  const configured = readPersonOidcConfiguration(input.oidc_config_path);
  assertPersonAuthorityCallback(input.authority_url, configured.configuration);
  issuePersonOnboardingInvitation({
    state_directory: input.state_directory,
    oidc: configured.configuration,
    pkce_sealing_key: readPrivateAuthorityPersonSessionPkceKey(
      `file:${input.pkce_key_file}`,
    ),
    membership_id: input.membership_id,
    expected_email: input.expected_email,
    authority_url: input.authority_url,
    output_path: input.output_path,
  });
}
