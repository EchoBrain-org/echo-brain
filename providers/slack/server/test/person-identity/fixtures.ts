/** Slack identity-link workflow fixtures shared by the provider's tests and the Authority HTTP-server test. */
import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { afterEach, vi } from "vitest";
import { canonicalSha256 } from "@echo-brain/federation-protocol";
import { organizationPersonSlackIdentityLinkChallengeCodeSha256 } from "@echo-brain/provider-slack-client/organization-api/person-slack-identity-link";
import type { PersonAccessAuthorization } from "@echo-brain/organization-authority-kernel/application/ports/person-access-authorization";
import { applyOrganizationControlBaselineV4 } from "../../../../../packages/organization-control-plane/src/persistence/baseline.js";
import type { SlackIdentityProviderV1 } from "../../src/organization-control-plane/adapters/slack/slack-web-identity-provider-v1.js";
import { activateNangoSlackConnectionV1 } from "../../src/organization-control-plane/persistence/sqlite-slack-nango-connection-coordinator-v1.js";
import { SLACK_PRIVATE_APP_BOT_SCOPES_V1, type OrganizationSecretStore } from "../../src/organization-control-plane/application/slack-integration-contracts.js";
import { serializeSlackAppCredentialsV1 } from "../../src/organization-control-plane/application/slack-app-credentials-v1.js";
import { createSqliteSlackPersonIdentityLinkWorkflowV1, type CreateSqliteSlackPersonIdentityLinkWorkflowV1Input, type SlackBotTokenAccessV1 } from "../../src/person-identity/sqlite-slack-person-identity-link-repository-v1.js";

export const NOW = "2026-08-22T00:00:00.000Z";
export const AUTHORITY_ID = "oau_00000000-0000-4000-8000-000000000001";
export const ORGANIZATION_ID = "org_00000000-0000-4000-8000-000000000001";
const LINEAGE_ID = "lineage-00000000-0000-4000-8000-000000000001";
const CONNECTION_ID = "con_00000000-0000-4000-8000-000000000001";
export const PRINCIPAL_ID = "prn_00000000-0000-4000-8000-000000000001";
export const MEMBERSHIP_ID = "mem_00000000-0000-4000-8000-000000000001";
export const CODE = Buffer.alloc(32).toString("base64url");
export const OTHER_CODE = Buffer.alloc(32, 1).toString("base64url");
export const TOKEN = "test-slack-token";
/** The bot token source, with a connection never marked "needs reinstall". */
export const tokenAccess = (
  readActiveSlackBotToken: SlackBotTokenAccessV1["readActiveSlackBotToken"] = () => TOKEN,
  onActiveSlackBotTokenRejected: SlackBotTokenAccessV1["onActiveSlackBotTokenRejected"] = () => undefined,
): SlackBotTokenAccessV1 => ({ readActiveSlackBotToken, onActiveSlackBotTokenRejected, isActiveSlackBotTokenRejected: () => false });

export const authorization: PersonAccessAuthorization = {
  organization_id: ORGANIZATION_ID,
  principal_id: PRINCIPAL_ID,
  membership_id: MEMBERSHIP_ID,
  membership_type: "employee",
  identity_binding_id: "oib_00000000-0000-4000-8000-000000000001",
  session_family_id: "psf_00000000-0000-4000-8000-000000000001",
  access_credential_sha256: canonicalSha256("access"),
  access_expires_at: "2026-08-23T00:00:00.000Z",
  hard_reauthentication_at: "2026-08-29T00:00:00.000Z",
  person_state_sha256: canonicalSha256("person"),
  session_state_sha256: canonicalSha256("session"),
  checked_at: NOW,
};

const databases: Database.Database[] = [];

export function beginRequest(requestId = "psb_00000000-0000-4000-8000-000000000001", code = CODE) {
  return {
    request_id: requestId,
    challenge_code_sha256: organizationPersonSlackIdentityLinkChallengeCodeSha256(code),
    recipient_user_id: "U12345679",
  };
}

/** Every workflow here shares these; each caller states its own authentication, membership and token access. */
export function workflowOptions(
  context: { readonly database: Database.Database; readonly slack: SlackIdentityProviderV1 },
  overrides: Pick<CreateSqliteSlackPersonIdentityLinkWorkflowV1Input, "authentication" | "membership_type" | "slack_token_access">,
): CreateSqliteSlackPersonIdentityLinkWorkflowV1Input {
  return {
    database: context.database,
    authority_id: AUTHORITY_ID,
    organization_id: ORGANIZATION_ID,
    state_lineage_id: LINEAGE_ID,
    slack: context.slack,
    now: () => NOW,
    ...overrides,
  };
}

export async function setup(
  currentAuthorization: () => PersonAccessAuthorization = () => authorization,
): Promise<{
  database: Database.Database;
  slack: SlackIdentityProviderV1;
  application: ReturnType<typeof createSqliteSlackPersonIdentityLinkWorkflowV1>;
}> {
  const database = new Database(":memory:");
  databases.push(database);
  applyOrganizationControlBaselineV4(database);
  database
    .prepare(
      `INSERT INTO organization_control_plane_metadata
       (singleton, control_plane_id, organization_id, authority_id,
        authority_descriptor_sha256, created_at)
       VALUES (1, ?, ?, ?, ?, ?)`,
    )
    .run(
      "ocp_00000000-0000-4000-8000-000000000001",
      ORGANIZATION_ID,
      AUTHORITY_ID,
      canonicalSha256("authority"),
      NOW,
    );

  const slack: SlackIdentityProviderV1 = {
    openIdentityLinkDirectMessage: vi.fn(async () => ({ team_id: "T12345678", channel_id: "D12345678", recipient_user_id: "U12345679" })),
    verifyConnection: vi.fn(async () => ({
      team_id: "T12345678",
      enterprise_id: null,
      bot_user_id: "U12345678",
      bot_id: "B12345678",
      app_id: "A12345678",
      granted_scopes: SLACK_PRIVATE_APP_BOT_SCOPES_V1,
      verification_evidence_sha256: canonicalSha256("connection"),
    })),
    postIdentityLinkChallenge: vi.fn(async (_token, input) => ({
      team_id: "T12345678",
      channel_id: input.channel_id,
      challenge_message_ts: "100.000001",
    })),
    observeIdentityLinkChallenge: vi.fn(async (_token, input) => ({
      team_id: "T12345678",
      user_id: "U12345679",
      channel_id: input.channel_id,
      challenge_message_ts: input.challenge_message_ts,
      reply_message_ts: "100.000002",
      verification_evidence_sha256: canonicalSha256("observed"),
    })),
  };
  await activateNango(database, slack);

  return {
    database,
    slack,
    application: createSqliteSlackPersonIdentityLinkWorkflowV1(workflowOptions({ database, slack }, {
      authentication: {
        authenticateAccess: vi.fn(currentAuthorization),
      },
      membership_type: () => currentAuthorization().membership_type,
      slack_token_access: tokenAccess(vi.fn(() => TOKEN)),
    })),
  };
}

/** Nothing here reads the bundle back (the workflow gets slack_token_access), so memory spares the file store's fsyncs. */
function memorySecrets(): OrganizationSecretStore {
  const values = new Map<string, string>();
  const stored = (handle: string) => {
    const value = values.get(handle);
    if (value === undefined) throw new Error("test secret is missing");
    return value;
  };
  return {
    create: (secret) => {
      const reference = { secret_backend_id: "authority-file-v1" as const, secret_handle_id: randomUUID() };
      values.set(reference.secret_handle_id, secret);
      return reference;
    },
    read: (reference) => stored(reference.secret_handle_id),
    replace: (reference, secret) => { stored(reference.secret_handle_id); values.set(reference.secret_handle_id, secret); },
    listReferences: () => [...values.keys()].map((secret_handle_id) => ({ secret_backend_id: "authority-file-v1" as const, secret_handle_id })),
    remove: (reference) => { values.delete(reference.secret_handle_id); },
  };
}

/** The organization's own app installed through Nango: the recipe's four scopes, private DMs only. */
async function activateNango(database: Database.Database, slack: SlackIdentityProviderV1): Promise<void> {
  const secrets = memorySecrets();
  const credentials = { kind: "echo-slack-app-credentials-v1" as const, app_id: "A12345678", client_id: "1234.5678",
    client_secret: "client-secret-value", signing_secret: "signing-secret-value", nango_connection_id: null };
  await activateNangoSlackConnectionV1({
    database, secrets, verifier: slack, authority_id: AUTHORITY_ID, organization_id: ORGANIZATION_ID, state_lineage_id: LINEAGE_ID,
    credential: { reference: secrets.create(serializeSlackAppCredentialsV1(credentials)), credentials },
    nango: { connection_id: "nango-conn-1", tags: {}, team_id: "T12345678",
      app_id: "A12345678", bot_user_id: "U12345678", granted_scopes: SLACK_PRIVATE_APP_BOT_SCOPES_V1, bot_token: TOKEN },
    now: () => NOW, new_connection_id: () => CONNECTION_ID,
  });
}

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});
