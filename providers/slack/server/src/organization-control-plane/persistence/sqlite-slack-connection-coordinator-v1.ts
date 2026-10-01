import { canonicalSha256 } from "@echo-brain/organization-control-plane/canonical/canonical-json";
import { type OrganizationSecretReference, type OrganizationSecretStore } from "../application/slack-integration-contracts.js";
import { SLACK_ORGANIZATION_TOOL_REQUIRED_SCOPES, type VerifiedSlackChannel, type VerifiedSlackConnection } from "../application/slack-integration-contracts.js";
import { buildOrganizationToolConnectionContractV2, buildOrganizationToolConnectionStateV2, type OrganizationToolConnectionContractV2, type OrganizationToolConnectionStateV2 } from "../application/organization-tool-connection-contracts-v2.js";
import { assertSlackConnectionMetadataV1, insertActiveSlackConnectionV1, readActiveSlackConnectionV1, type StoredSlackConnectionV1 } from "./sqlite-slack-active-connection-v1.js";
import type Database from "better-sqlite3";

/** A provider seam deliberately limited to Slack connection setup. */
export interface SlackConnectionVerifierV1 {
  verifyConnection(
    token: string,
    signal?: AbortSignal,
  ): Promise<VerifiedSlackConnection>;
  verifyChannel(
    token: string,
    channelId: string,
    expectedTeamId: string,
    signal?: AbortSignal,
  ): Promise<VerifiedSlackChannel>;
}

export interface SlackConnectionSetupInputV1 {
  readonly authority_id: string;
  readonly organization_id: string;
  readonly state_lineage_id: string;
  readonly connection_id: string;
  readonly approval_channel_id: string;
}

/** The token is injected, never part of the public command shape or result. */
export interface ConnectSlackConnectionInputV1 extends SlackConnectionSetupInputV1 {
  readonly slack_bot_token: string;
  readonly database: Database.Database;
  readonly secrets: Pick<OrganizationSecretStore, "create" | "remove">;
  readonly verifier: SlackConnectionVerifierV1;
  readonly now: () => string;
  readonly signal?: AbortSignal;
}

export interface ConnectedSlackConnectionV1 {
  readonly connection: OrganizationToolConnectionContractV2;
  readonly state: OrganizationToolConnectionStateV2;
  readonly idempotent: boolean;
  /** Present for a new provider verification; replay proves the same stored connection. */
  readonly channel_verification: {
    readonly selected_channel_public: true;
    readonly selected_channel_active: true;
    readonly bot_membership_verified: true;
    readonly bot_access_verified: true;
  };
}

export class SlackConnectionConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SlackConnectionConflictError";
  }
}

function publicConfigurationSha256(
  input: SlackConnectionSetupInputV1,
): `sha256:${string}` {
  return canonicalSha256({
    approval_adapter_id: "slack-reactions",
    approval_channel_id: input.approval_channel_id,
    approve_reaction: "white_check_mark",
    kind: "echo-clean-slack-connection-public-configuration-v1",
    reject_reaction: "x",
  });
}

function samePublicConnection(
  existing: StoredSlackConnectionV1,
  input: SlackConnectionSetupInputV1,
): boolean {
  return (
    existing.connection.connection_id === input.connection_id &&
    existing.connection.authority_id === input.authority_id &&
    existing.connection.organization_id === input.organization_id &&
    existing.connection.state_lineage_id === input.state_lineage_id &&
    existing.connection.public_connection_configuration_sha256 ===
      publicConfigurationSha256(input)
  );
}

function existingResult(
  database: Database.Database,
  input: SlackConnectionSetupInputV1,
): ConnectedSlackConnectionV1 | undefined {
  const existing = readActiveSlackConnectionV1(database);
  if (existing === undefined) return undefined;
  if (!samePublicConnection(existing, input)) {
    throw new SlackConnectionConflictError(
      "a different Slack organization connection is already active",
    );
  }
  return Object.freeze({
    connection: existing.connection,
    state: existing.state,
    idempotent: true,
    channel_verification: Object.freeze({
      selected_channel_public: true,
      selected_channel_active: true,
      bot_membership_verified: true,
      bot_access_verified: true,
    }),
  });
}

function normalizedScopes(
  connection: VerifiedSlackConnection,
): readonly string[] {
  const scopes = [...new Set(connection.granted_scopes)].sort();
  if (
    scopes.length === 0 ||
    scopes.some((scope) => typeof scope !== "string" || scope.length === 0)
  ) {
    throw new Error("Slack verification returned invalid granted scopes");
  }
  for (const required of SLACK_ORGANIZATION_TOOL_REQUIRED_SCOPES) {
    if (!scopes.includes(required)) {
      throw new Error(`Slack bot token is missing required scope ${required}`);
    }
  }
  return Object.freeze(scopes);
}

/**
 * Persists the first Slack connection after provider verification. It is
 * intentionally a stopped-state seam: it neither opens a listener nor reads
 * an installation, enrollment, or lease.
 */
export async function connectSlackConnectionV1(
  input: ConnectSlackConnectionInputV1,
): Promise<ConnectedSlackConnectionV1> {
  assertSlackConnectionMetadataV1(input.database, input);
  const replay = existingResult(input.database, input);
  if (replay !== undefined) return replay;

  const connectionEvidence = await input.verifier.verifyConnection(
    input.slack_bot_token,
    input.signal,
  );
  const scopes = normalizedScopes(connectionEvidence);
  const channelEvidence = await input.verifier.verifyChannel(
    input.slack_bot_token,
    input.approval_channel_id,
    connectionEvidence.team_id,
    input.signal,
  );
  if (
    channelEvidence.team_id !== connectionEvidence.team_id ||
    channelEvidence.channel_id !== input.approval_channel_id ||
    channelEvidence.is_public_organization_channel !== true ||
    channelEvidence.is_active !== true ||
    channelEvidence.bot_membership_verified !== true ||
    channelEvidence.bot_access_verified !== true
  ) {
    throw new Error("Slack verified a different approval channel");
  }

  let createdSecret: OrganizationSecretReference | undefined;
  let retainedSecret = false;
  try {
    createdSecret = input.secrets.create(input.slack_bot_token);
    const connection = buildOrganizationToolConnectionContractV2({
      authority_id: input.authority_id,
      organization_id: input.organization_id,
      state_lineage_id: input.state_lineage_id,
      connection_id: input.connection_id,
      provider_issuer: "https://slack.com",
      provider_tenant_kind: "workspace",
      provider_tenant_id: connectionEvidence.team_id,
      provider_enterprise_id: connectionEvidence.enterprise_id,
      tool_kind: "slack",
      provider_app_id: connectionEvidence.app_id,
      provider_bot_id: connectionEvidence.bot_id,
      provider_bot_user_id: connectionEvidence.bot_user_id,
      required_provider_scopes: SLACK_ORGANIZATION_TOOL_REQUIRED_SCOPES,
      public_connection_configuration_sha256: publicConfigurationSha256(input),
    });
    const connectionSha256 = canonicalSha256(connection);
    const state = buildOrganizationToolConnectionStateV2({
      connection_id: connection.connection_id,
      connection_contract_sha256: connectionSha256,
      connection_status: "active",
      credential_reference_sha256: canonicalSha256(createdSecret),
      observed_granted_scopes: scopes,
      verification_event_id: `verify_${input.connection_id}`,
      verification_evidence_sha256: canonicalSha256({
        channel_verification_evidence_sha256:
          channelEvidence.verification_evidence_sha256,
        connection_verification_evidence_sha256:
          connectionEvidence.verification_evidence_sha256,
        kind: "echo-clean-slack-connection-verification-v1",
      }),
      verification_revision: 1,
      verified_at: input.now(),
    });

    input.database.exec("BEGIN IMMEDIATE");
    try {
      const racedReplay = existingResult(input.database, input);
      if (racedReplay !== undefined) {
        input.database.exec("COMMIT");
        return racedReplay;
      }
      insertActiveSlackConnectionV1(input.database, {
        connection,
        state,
        now: input.now(),
      });
      input.database.exec("COMMIT");
      retainedSecret = true;
      return Object.freeze({
        connection,
        state,
        idempotent: false,
        channel_verification: Object.freeze({
          selected_channel_public: true,
          selected_channel_active: true,
          bot_membership_verified: true,
          bot_access_verified: true,
        }),
      });
    } catch (error) {
      try {
        input.database.exec("ROLLBACK");
      } catch {}
      throw error;
    }
  } finally {
    if (createdSecret !== undefined && !retainedSecret) {
      input.secrets.remove(createdSecret);
    }
  }
}
