import { canonicalJson, canonicalSha256 } from "../canonical/canonical-json.js";
import {
  SLACK_ORGANIZATION_TOOL_REQUIRED_SCOPES,
  type OrganizationSecretReference,
  type OrganizationSecretStore,
  type VerifiedSlackChannel,
  type VerifiedSlackConnection,
} from "../application/slack-integration-contracts.js";
import {
  buildOrganizationToolConnectionContractV2,
  buildOrganizationToolConnectionStateV2,
  validateOrganizationToolConnectionContractV2,
  validateOrganizationToolConnectionStateV2,
  type OrganizationToolConnectionContractV2,
  type OrganizationToolConnectionStateV2,
} from "../application/person-slack-reaction-approval-contracts-v2.js";
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

/**
 * The later CLI supplies public flags separately from the private token read.
 * Keeping this adapter free of process I/O makes it safe to test with a fake
 * provider and prevents a caller from accidentally echoing its stdin bytes.
 */
export interface RunSlackConnectionSetupCommandV1Input extends Omit<
  ConnectSlackConnectionInputV1,
  "slack_bot_token"
> {
  readonly read_slack_bot_token: () => Promise<string> | string;
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

interface StoredActiveConnection {
  readonly connection: OrganizationToolConnectionContractV2;
  readonly state: OrganizationToolConnectionStateV2;
}

function parseCanonical(json: string): unknown {
  const value = JSON.parse(json) as unknown;
  if (canonicalJson(value) !== json) {
    throw new Error("stored Slack connection body is not canonical");
  }
  return value;
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

function activeConnection(
  database: Database.Database,
): StoredActiveConnection | undefined {
  const row = database
    .prepare(
      `SELECT contract.contract_json, contract.contract_sha256,
              current_state.state_json, current_state.state_sha256
       FROM organization_tool_connection_current_state AS current_state
       JOIN organization_tool_connection_contracts AS contract
         ON contract.connection_id = current_state.connection_id
        AND contract.contract_sha256 = current_state.connection_contract_sha256
       WHERE current_state.current_status = 'active'`,
    )
    .get() as
    | {
        contract_json: string;
        contract_sha256: string;
        state_json: string;
        state_sha256: string;
      }
    | undefined;
  if (row === undefined) return undefined;
  const connection = validateOrganizationToolConnectionContractV2(
    parseCanonical(row.contract_json),
  );
  const state = validateOrganizationToolConnectionStateV2(
    parseCanonical(row.state_json),
  );
  if (
    canonicalSha256(connection) !== row.contract_sha256 ||
    canonicalSha256(state) !== row.state_sha256 ||
    state.connection_contract_sha256 !== row.contract_sha256 ||
    state.connection_status !== "active"
  ) {
    throw new Error("stored Slack connection digest chain is invalid");
  }
  return Object.freeze({ connection, state });
}

function samePublicConnection(
  existing: StoredActiveConnection,
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
  const existing = activeConnection(database);
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

function assertMetadata(
  database: Database.Database,
  input: SlackConnectionSetupInputV1,
): void {
  const metadata = database
    .prepare(
      `SELECT authority_id, organization_id
       FROM organization_control_plane_metadata WHERE singleton = 1`,
    )
    .get() as { authority_id: string; organization_id: string } | undefined;
  if (
    metadata === undefined ||
    metadata.authority_id !== input.authority_id ||
    metadata.organization_id !== input.organization_id
  ) {
    throw new Error(
      "Slack connection coordinates do not match control metadata",
    );
  }
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
  assertMetadata(input.database, input);
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
    const stateSha256 = canonicalSha256(state);

    input.database.exec("BEGIN IMMEDIATE");
    try {
      const racedReplay = existingResult(input.database, input);
      if (racedReplay !== undefined) {
        input.database.exec("COMMIT");
        return racedReplay;
      }
      const now = input.now();
      input.database
        .prepare(
          `INSERT INTO organization_tool_connection_contracts
           (connection_id, contract_json, contract_sha256, created_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run(
          connection.connection_id,
          canonicalJson(connection),
          connectionSha256,
          now,
        );
      input.database
        .prepare(
          `INSERT INTO organization_tool_connection_current_state
           (connection_id, connection_contract_sha256, state_json, state_sha256,
            current_status, updated_at)
           VALUES (?, ?, ?, ?, 'active', ?)`,
        )
        .run(
          connection.connection_id,
          connectionSha256,
          canonicalJson(state),
          stateSha256,
          now,
        );
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

/** A stopped-state `slack connect` command seam for a future CLI. */
export async function runSlackConnectionSetupCommandV1(
  input: RunSlackConnectionSetupCommandV1Input,
): Promise<ConnectedSlackConnectionV1> {
  const slackBotToken = await input.read_slack_bot_token();
  return connectSlackConnectionV1({ ...input, slack_bot_token: slackBotToken });
}
