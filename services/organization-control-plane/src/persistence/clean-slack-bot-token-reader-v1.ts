import {
  validateOrganizationToolConnectionStateV2,
  type ApprovalContractSha256,
} from "../application/person-slack-reaction-approval-contracts-v2.js";
import { canonicalJson, canonicalSha256 } from "../canonical/canonical-json.js";
import type Database from "better-sqlite3";

export interface CleanSlackSecretReferenceV1 {
  readonly secret_backend_id: string;
  readonly secret_handle_id: string;
}

export interface CleanSlackSecretReaderV1 {
  listReferences(): readonly CleanSlackSecretReferenceV1[];
  read(reference: CleanSlackSecretReferenceV1): string;
}

export interface CleanSlackBotTokenReaderV1 {
  readBotToken(input: {
    readonly connection_id: string;
    readonly connection_state_sha256: ApprovalContractSha256;
  }): string;
}

function parseCanonical(json: string): unknown {
  const value = JSON.parse(json) as unknown;
  if (canonicalJson(value) !== json) {
    throw new Error("stored clean Slack state is not canonical");
  }
  return value;
}

/**
 * Resolves the one opaque file-secret reference whose digest is committed by
 * the active clean Slack state. No secret reference or token is persisted in
 * the control database, returned by this seam, or placed in the observer API.
 */
export class SqliteCleanSlackBotTokenReaderV1 implements CleanSlackBotTokenReaderV1 {
  constructor(
    private readonly database: Database.Database,
    private readonly secrets: CleanSlackSecretReaderV1,
  ) {}

  readBotToken(input: {
    readonly connection_id: string;
    readonly connection_state_sha256: ApprovalContractSha256;
  }): string {
    const row = this.database
      .prepare(
        `SELECT state_json, state_sha256, current_status
         FROM organization_tool_connection_current_state
         WHERE connection_id = ?`,
      )
      .get(input.connection_id) as
      | { state_json: string; state_sha256: string; current_status: string }
      | undefined;
    if (
      row === undefined ||
      row.current_status !== "active" ||
      row.state_sha256 !== input.connection_state_sha256
    ) {
      throw new Error("clean Slack bot connection state is not active");
    }
    const state = validateOrganizationToolConnectionStateV2(
      parseCanonical(row.state_json),
    );
    if (
      canonicalSha256(state) !== row.state_sha256 ||
      state.connection_status !== "active"
    ) {
      throw new Error(
        "clean Slack bot connection state digest is invalid",
      );
    }
    const references = this.secrets
      .listReferences()
      .filter(
        (reference) =>
          canonicalSha256(reference) === state.credential_reference_sha256,
      );
    if (references.length !== 1 || references[0] === undefined) {
      throw new Error(
        "clean Slack bot credential reference is unavailable",
      );
    }
    return this.secrets.read(references[0]);
  }
}
